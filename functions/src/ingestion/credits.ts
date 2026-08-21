/**
 * Credits ingestion handler.
 *
 * Builds data/credits.json for the current year repo — a join table mapping
 * movies to people with their roles (director, cast, writer, producer, composer).
 *
 * Downloads the movie index from the year repo, finds movies with Q-IDs that
 * have no entry in the existing credits.json, queries Wikidata for credits,
 * creates missing people in the correct mmdb-people-{letter} repos, then
 * commits the updated credits.json via branch → PR → auto-merge (squash).
 *
 * Uses an independent credits_lock that does NOT conflict with the main
 * ingestion lock — credits and title ingestion can run concurrently.
 */

import { gunzipSync } from 'zlib';
import { logger } from 'firebase-functions/v2';
import { GitHubClient, groupByFirstLetter } from './github-client.js';
import { getPersonFilePath, serializeEntity } from './github-helpers.js';
import { normalizePerson, MMDBPerson } from './normalizer.js';
import { WikidataPerson } from './wikidata-client.js';
import { acquireCreditsLock, releaseCreditsLock } from './state.js';
import { isIngestionPaused } from './safeguards.js';
import { BRANCH_PREFIX, LABEL_LANGUAGES } from '../config.js';
import { IngestionResult } from './orchestrator.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'MMDB-Ingestion/1.0.0 (https://github.com/mimir-media-db)';

/** Movies per Wikidata query batch */
const CREDITS_BATCH_SIZE = 15;

/** Delay between batches in milliseconds */
const DELAY_BETWEEN_BATCHES_MS = 2000;

/** Delay between role queries within a batch in milliseconds */
const DELAY_BETWEEN_ROLES_MS = 1000;

/** Credit role definitions */
const ROLES: Array<{ role: string; property: string }> = [
  { role: 'director', property: 'wdt:P57' },
  { role: 'cast', property: 'wdt:P161' },
  { role: 'writer', property: 'wdt:P58' },
  { role: 'producer', property: 'wdt:P162' },
  { role: 'composer', property: 'wdt:P86' },
];

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface RawCreditResult {
  movieQId: string;
  personQId: string;
  label: string;
  role: string;
  birthYear?: number;
  deathYear?: number;
  imdbId?: string;
  birthName?: string;
}

interface CreditEntry {
  movie: string;
  person: string;
  person_repo: string;
  role: string;
}

interface CreditsJson {
  schema_version: number;
  year: number;
  last_updated: string;
  credits: CreditEntry[];
}

// ─── SPARQL helpers ──────────────────────────────────────────────────────────

/**
 * Build a simple SPARQL query for a single role property.
 */
function buildRoleQuery(movieQIds: string[], property: string): string {
  const values = movieQIds.map(id => `wd:${id}`).join(' ');
  return `
SELECT DISTINCT ?movie ?person ?personLabel ?birthDate ?deathDate ?imdb ?birthName
WHERE {
  VALUES ?movie { ${values} }
  ?movie ${property} ?person.
  ?person wdt:P31 wd:Q5.
  OPTIONAL { ?person wdt:P345 ?imdb. }
  OPTIONAL { ?person wdt:P569 ?birthDate. }
  OPTIONAL { ?person wdt:P570 ?deathDate. }
  OPTIONAL { ?person wdt:P1477 ?birthName. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}". }
}
`.trim();
}

/**
 * Query Wikidata SPARQL endpoint with exponential backoff on 429/5xx errors.
 */
async function queryWikidataWithBackoff(sparql: string): Promise<any> {
  const maxRetries = 5;
  let retryDelay = 10000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(WIKIDATA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: `query=${encodeURIComponent(sparql)}`,
    });

    if (response.ok) {
      return response.json();
    }

    const status = response.status;
    if (status === 429 || status >= 500) {
      if (attempt < maxRetries) {
        logger.warn(`Wikidata ${status} — retrying in ${retryDelay / 1000}s (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay *= 2;
        continue;
      }
    }

    const text = await response.text().catch(() => '');
    throw new Error(`Wikidata query failed: ${status} ${response.statusText} — ${text.slice(0, 300)}`);
  }
}

/**
 * Parse Wikidata SPARQL results into raw credit entries.
 */
function parseCreditResults(results: any, role: string): RawCreditResult[] {
  const credits: RawCreditResult[] = [];

  for (const binding of results.results?.bindings || []) {
    const movieQId = binding.movie?.value?.split('/').pop();
    const personQId = binding.person?.value?.split('/').pop();
    const label = binding.personLabel?.value;

    if (!movieQId || !personQId || !label) continue;
    if (/^Q\d+$/i.test(label)) continue;

    const birthDate = binding.birthDate?.value;
    const deathDate = binding.deathDate?.value;
    const imdbId = binding.imdb?.value;
    const birthName = binding.birthName?.value;

    credits.push({
      movieQId,
      personQId,
      label,
      role,
      birthYear: birthDate ? new Date(birthDate).getFullYear() : undefined,
      deathYear: deathDate ? new Date(deathDate).getFullYear() : undefined,
      imdbId,
      birthName,
    });
  }

  return credits;
}

// ─── Helper: get people repo from person ID ──────────────────────────────────

/**
 * Determine the target mmdb-people-{letter} repo from a person ID.
 */
function getPeopleRepo(personId: string): string {
  const slug = personId.replace(/^p_/, '');
  const letter = (slug[0] || 'z').toLowerCase();
  return `mmdb-people-${letter}`;
}

// ─── Tarball extraction ──────────────────────────────────────────────────────

/**
 * Download the year repo tarball, gunzip it, and parse all individual movie JSON
 * files to extract wikidata Q-IDs. Also extracts data/credits.json if present
 * (avoids the GitHub Contents API 1MB file size limit).
 *
 * Returns:
 * - movieLookup: Map of wikidataQId → movieId
 * - existingCredits: Parsed credits.json or null if not present
 *
 * Uses raw tar parsing (512-byte headers, ustar format) — same approach as
 * functions/scripts/build-credits.mjs extractMovieLookup().
 */
interface TarballExtraction {
  movieLookup: Map<string, string>;
  existingCredits: CreditsJson | null;
}

async function extractFromTarball(github: GitHubClient, yearRepo: string): Promise<TarballExtraction> {
  const gzBuffer = await github.downloadTarball(yearRepo);
  const tarData = gunzipSync(gzBuffer);

  const movieLookup = new Map<string, string>();
  let existingCredits: CreditsJson | null = null;
  let offset = 0;

  while (offset < tarData.length - 512) {
    const header = tarData.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;

    const nameEnd = header.indexOf(0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf8');
    const sizeStr = header.subarray(124, 136).toString('utf8').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = header[156];

    offset += 512;

    // typeFlag 48 = '0' (regular file), 0 = also regular file in some implementations
    if (typeFlag === 48 || typeFlag === 0) {
      const isMovieFile = name.includes('/data/movies/') &&
        name.endsWith('.json') &&
        !name.endsWith('index.json');

      const isCreditsFile = name.endsWith('/data/credits.json');

      if (isMovieFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          const movie = JSON.parse(content);
          const wikidataId = movie.external_ids?.wikidata;
          const movieId = movie.id;
          if (wikidataId && /^Q\d+$/i.test(wikidataId) && movieId) {
            movieLookup.set(wikidataId, movieId);
          }
        } catch {
          // Skip unparseable files
        }
      } else if (isCreditsFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          existingCredits = JSON.parse(content);
          logger.info('Extracted credits.json from tarball', {
            entries: existingCredits?.credits?.length ?? 0,
          });
        } catch {
          logger.warn('Could not parse credits.json from tarball — starting fresh');
        }
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return { movieLookup, existingCredits };
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function runCreditsIngestion(dryRun: boolean = false): Promise<IngestionResult> {
  const result: IngestionResult = {
    moviesIngested: 0,
    seriesIngested: 0,
    peopleIngested: 0,
    prsCreated: [],
    errors: [],
  };

  // ─── Kill switch ───────────────────────────────────────────────────────────
  if (isIngestionPaused()) {
    logger.info('Ingestion is paused — skipping credits run');
    return result;
  }

  // ─── Independent credits lock ──────────────────────────────────────────────
  const lockResult = await acquireCreditsLock();
  if (!lockResult.acquired) {
    logger.warn('Credits ingestion skipped: lock not acquired', { reason: lockResult.reason });
    result.lockBlocked = true;
    result.errors.push(`Credits lock not acquired: ${lockResult.reason}`);
    return result;
  }

  try {
    const github = new GitHubClient();
    const currentYear = new Date().getFullYear();
    const yearRepo = `mmdb-${currentYear}`;
    const runDate = new Date().toISOString().split('T')[0];
    const branchSuffix = `credits-${runDate.replace(/-/g, '')}`;

    logger.info('Starting credits ingestion', { year: currentYear, dryRun });

    // ─── Check year repo exists ──────────────────────────────────────────────
    const repoAvailable = await github.repoExists(yearRepo);
    if (!repoAvailable) {
      logger.warn(`Year repo ${yearRepo} does not exist — skipping credits`);
      result.errors.push(`Year repo ${yearRepo} does not exist`);
      return result;
    }

    // ─── Download tarball and extract Q-IDs + existing credits ─────────────
    let movieLookup: Map<string, string>;
    let existingCredits: CreditsJson | null = null;
    try {
      const extraction = await extractFromTarball(github, yearRepo);
      movieLookup = extraction.movieLookup;
      existingCredits = extraction.existingCredits;
    } catch (error: any) {
      if (error.status === 404 || error.message?.includes('404')) {
        logger.info('Year repo tarball not available — nothing to process');
        return result;
      }
      throw error;
    }

    logger.info(`Movie tarball parsed: ${movieLookup.size} movies with Wikidata IDs`);

    if (movieLookup.size === 0) {
      logger.info('No movies with Wikidata IDs — nothing to process');
      return result;
    }

    // ─── Find movies missing from credits ────────────────────────────────────
    // (existingCredits was already extracted from the tarball above)
    const existingMovieCredits = new Set<string>();
    const existingDedupKeys = new Set<string>();

    if (existingCredits?.credits) {
      for (const entry of existingCredits.credits) {
        existingMovieCredits.add(entry.movie);
        existingDedupKeys.add(`${entry.movie}|${entry.person}|${entry.role}`);
      }
    }

    // Q-IDs for movies that have NO entry in credits.json
    const missingQIds: string[] = [];
    for (const [qId, movieId] of movieLookup) {
      if (!existingMovieCredits.has(movieId)) {
        missingQIds.push(qId);
      }
    }

    logger.info(`Found ${missingQIds.length} movies without credits (${existingMovieCredits.size} already have credits)`);

    if (missingQIds.length === 0) {
      logger.info('All movies already have credits — no-op');
      return result;
    }

    // ─── Query Wikidata for credits in batches ───────────────────────────────
    const batches: string[][] = [];
    for (let j = 0; j < missingQIds.length; j += CREDITS_BATCH_SIZE) {
      batches.push(missingQIds.slice(j, j + CREDITS_BATCH_SIZE));
    }

    logger.info(`Processing ${batches.length} batches (${CREDITS_BATCH_SIZE} movies/batch, ${ROLES.length} role queries each)`);

    const allCreditResults: RawCreditResult[] = [];
    let totalQueriesMade = 0;

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batch = batches[bIdx];

      // Rate limiting between batches (not before the first)
      if (bIdx > 0) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
      }

      // Query each role separately
      for (let rIdx = 0; rIdx < ROLES.length; rIdx++) {
        const { role, property } = ROLES[rIdx];

        // Delay between role queries within a batch (not before first)
        if (rIdx > 0) {
          await new Promise(r => setTimeout(r, DELAY_BETWEEN_ROLES_MS));
        }

        const sparql = buildRoleQuery(batch, property);

        try {
          const queryResult = await queryWikidataWithBackoff(sparql);
          totalQueriesMade++;
          const credits = parseCreditResults(queryResult, role);
          allCreditResults.push(...credits);
        } catch (err: any) {
          totalQueriesMade++;
          result.errors.push(`Batch ${bIdx + 1} ${role} failed: ${err.message}`);
          logger.warn(`Batch ${bIdx + 1} ${role} failed`, { error: err.message });
        }
      }

      if ((bIdx + 1) % 10 === 0 || bIdx === batches.length - 1) {
        logger.info(`Batch progress: ${bIdx + 1}/${batches.length}, ${allCreditResults.length} raw credits, ${totalQueriesMade} queries`);
      }
    }

    logger.info(`Wikidata returned ${allCreditResults.length} raw credit entries (${totalQueriesMade} queries)`);

    if (allCreditResults.length === 0) {
      logger.info('No credits found from Wikidata — movies may have no credit data');
      return result;
    }

    // ─── Normalize people and build credit entries ───────────────────────────
    const uniquePeople = new Map<string, { wikidataId: string; label: string; birthYear?: number; deathYear?: number; imdbId?: string; birthName?: string }>();
    for (const credit of allCreditResults) {
      if (!uniquePeople.has(credit.personQId)) {
        uniquePeople.set(credit.personQId, {
          wikidataId: credit.personQId,
          label: credit.label,
          birthYear: credit.birthYear,
          deathYear: credit.deathYear,
          imdbId: credit.imdbId,
          birthName: credit.birthName,
        });
      }
    }

    const normalizedByQId = new Map<string, MMDBPerson>();
    let skippedBadName = 0;

    for (const [personQId, wikiPerson] of uniquePeople) {
      const person = normalizePerson(wikiPerson as WikidataPerson);
      if (!person) {
        skippedBadName++;
        continue;
      }
      normalizedByQId.set(personQId, person);
    }

    if (skippedBadName > 0) {
      logger.info(`Skipped ${skippedBadName} people with invalid names/years`);
    }

    // ─── Build credit entries with dedup ─────────────────────────────────────
    const newCreditEntries: CreditEntry[] = [];
    const seenCredits = new Set<string>();

    for (const credit of allCreditResults) {
      const person = normalizedByQId.get(credit.personQId);
      if (!person) continue;

      const movieId = movieLookup.get(credit.movieQId);
      if (!movieId) continue;

      const dedupKey = `${movieId}|${person.id}|${credit.role}`;
      if (seenCredits.has(dedupKey) || existingDedupKeys.has(dedupKey)) continue;
      seenCredits.add(dedupKey);

      const targetRepo = getPeopleRepo(person.id);

      newCreditEntries.push({
        movie: movieId,
        person: person.id,
        person_repo: targetRepo,
        role: credit.role,
      });
    }

    logger.info(`Built ${newCreditEntries.length} new deduplicated credit entries`);

    if (newCreditEntries.length === 0) {
      logger.info('No new credit entries after dedup — no-op');
      return result;
    }

    if (dryRun) {
      logger.info('[DRY RUN] Would create credits PR', {
        newCredits: newCreditEntries.length,
        uniquePeopleToCheck: normalizedByQId.size,
      });
      result.moviesIngested = new Set(newCreditEntries.map(c => c.movie)).size;
      result.peopleIngested = normalizedByQId.size;
      return result;
    }

    // ─── Check which people exist, collect missing ones ──────────────────────
    const missingPeople = new Map<string, MMDBPerson>();
    const usedPersonIds = new Set(newCreditEntries.map(c => c.person));

    // Group by target repo for efficient existence checking
    const peopleByRepo = new Map<string, Array<{ personId: string; person: MMDBPerson }>>();
    for (const [, person] of normalizedByQId) {
      if (!usedPersonIds.has(person.id)) continue;
      const targetRepo = getPeopleRepo(person.id);
      if (!peopleByRepo.has(targetRepo)) peopleByRepo.set(targetRepo, []);
      peopleByRepo.get(targetRepo)!.push({ personId: person.id, person });
    }

    for (const [targetRepo, repoPeople] of peopleByRepo) {
      const repoOk = await github.repoExists(targetRepo);
      if (!repoOk) {
        // All people in this repo are missing
        for (const { personId, person } of repoPeople) {
          missingPeople.set(personId, person);
        }
        continue;
      }

      const existingIds = await github.getExistingPeopleIds(targetRepo);
      for (const { personId, person } of repoPeople) {
        if (!existingIds.has(personId)) {
          missingPeople.set(personId, person);
        }
      }
    }

    logger.info(`Missing people to create: ${missingPeople.size}`);

    // ─── Create missing people (one PR per letter repo) ──────────────────────
    if (missingPeople.size > 0) {
      const missingByRepo = new Map<string, MMDBPerson[]>();
      for (const [, person] of missingPeople) {
        const targetRepo = getPeopleRepo(person.id);
        if (!missingByRepo.has(targetRepo)) missingByRepo.set(targetRepo, []);
        missingByRepo.get(targetRepo)!.push(person);
      }

      for (const [targetRepo, newPeople] of missingByRepo) {
        try {
          const repoOk = await github.repoExists(targetRepo);
          if (!repoOk) {
            logger.warn(`People repo ${targetRepo} does not exist — skipping people creation`);
            result.errors.push(`People repo ${targetRepo} does not exist`);
            continue;
          }

          const peopleBranch = `${BRANCH_PREFIX}/credits-people-${currentYear}-${branchSuffix}`;
          const branchExists = await github.branchExists(targetRepo, peopleBranch);

          if (!branchExists) {
            await github.createBranch(targetRepo, peopleBranch);
          }

          // Batch people by first letter
          const peopleGroups = groupByFirstLetter(newPeople);
          let batchPeopleCount = 0;

          for (const [letter, group] of peopleGroups) {
            try {
              const files = group.map(p => ({
                path: getPersonFilePath(p),
                content: serializeEntity(p),
              }));
              await github.commitBatch(targetRepo, peopleBranch, files, `ingest: add ${group.length} people (${letter})`);
              batchPeopleCount += group.length;
            } catch (error: any) {
              result.errors.push(`Failed to add people batch (${letter}) to ${targetRepo}: ${error.message}`);
              logger.error('Failed to add people batch', { letter, repo: targetRepo, error: error.message });
            }
          }

          if (batchPeopleCount > 0) {
            const prTitle = `ingest: add ${batchPeopleCount} people (credits ${currentYear})`;
            const prNumber = await github.createPullRequest(
              targetRepo,
              prTitle,
              peopleBranch,
              'master',
              `People extracted from ${currentYear} movie credits.\n\n` +
              `| Metric | Count |\n|--------|-------|\n| New people | ${batchPeopleCount} |`
            );
            result.prsCreated.push(`${targetRepo}#${prNumber}`);
            result.peopleIngested += batchPeopleCount;

            try {
              await github.enableAutoMerge(targetRepo, prNumber);
              logger.info('People PR auto-merge enabled', { repo: targetRepo, pr: prNumber });
            } catch (error: any) {
              logger.warn('Could not enable auto-merge for people PR', { repo: targetRepo, pr: prNumber, error: error.message });
            }
          }
        } catch (error: any) {
          result.errors.push(`People PR error for ${targetRepo}: ${error.message}`);
          logger.error('People PR creation failed', { repo: targetRepo, error: error.message });
        }
      }
    }

    // ─── Build and commit credits.json ───────────────────────────────────────
    const today = new Date().toISOString().split('T')[0];

    // Merge existing credits with new ones
    const allCredits: CreditEntry[] = [
      ...(existingCredits?.credits || []),
      ...newCreditEntries,
    ];

    const creditsJson: CreditsJson = {
      schema_version: 1,
      year: currentYear,
      last_updated: today,
      credits: allCredits,
    };

    const creditsContent = JSON.stringify(creditsJson, null, 2) + '\n';

    // Commit to year repo via branch → PR → auto-merge
    const creditsBranch = `${BRANCH_PREFIX}/${branchSuffix}`;

    try {
      const branchExists = await github.branchExists(yearRepo, creditsBranch);
      if (!branchExists) {
        await github.createBranch(yearRepo, creditsBranch);
      }

      await github.commitBatch(yearRepo, creditsBranch, [{
        path: 'data/credits.json',
        content: creditsContent,
      }], `ingest: update credits index (+${newCreditEntries.length} entries)`);

      const uniqueMovies = new Set(newCreditEntries.map(c => c.movie)).size;
      const uniquePeopleCount = new Set(newCreditEntries.map(c => c.person)).size;

      const prTitle = `ingest: update credits index (+${newCreditEntries.length} entries)`;
      const prBody = [
        `## Credits Index Update for ${currentYear}`,
        '',
        `Incremental credits built from Wikidata for movies missing credit data.`,
        '',
        `| Metric | Count |`,
        `|--------|-------|`,
        `| New credit entries | ${newCreditEntries.length} |`,
        `| Total credit entries | ${allCredits.length} |`,
        `| New movies covered | ${uniqueMovies} |`,
        `| Unique people | ${uniquePeopleCount} |`,
        `| Directors | ${newCreditEntries.filter(c => c.role === 'director').length} |`,
        `| Cast | ${newCreditEntries.filter(c => c.role === 'cast').length} |`,
        `| Writers | ${newCreditEntries.filter(c => c.role === 'writer').length} |`,
        `| Producers | ${newCreditEntries.filter(c => c.role === 'producer').length} |`,
        `| Composers | ${newCreditEntries.filter(c => c.role === 'composer').length} |`,
      ].join('\n');

      const prNumber = await github.createPullRequest(yearRepo, prTitle, creditsBranch, 'master', prBody);
      result.prsCreated.push(`${yearRepo}#${prNumber}`);
      result.moviesIngested = uniqueMovies;

      logger.info('Credits PR created', { repo: yearRepo, pr: prNumber, entries: newCreditEntries.length });

      try {
        await github.enableAutoMerge(yearRepo, prNumber);
        logger.info('Credits PR auto-merge enabled', { repo: yearRepo, pr: prNumber });
      } catch (error: any) {
        logger.warn('Could not enable auto-merge for credits PR', { repo: yearRepo, pr: prNumber, error: error.message });
      }
    } catch (error: any) {
      result.errors.push(`Credits PR error for ${yearRepo}: ${error.message}`);
      logger.error('Credits PR creation failed', { repo: yearRepo, error: error.message });
    }

    logger.info('Credits ingestion complete', {
      newCredits: newCreditEntries.length,
      totalCredits: allCredits.length,
      peopleCreated: result.peopleIngested,
      prsCreated: result.prsCreated,
      errors: result.errors.length,
    });

    return result;
  } finally {
    await releaseCreditsLock();
  }
}
