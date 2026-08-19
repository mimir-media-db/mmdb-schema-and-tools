#!/usr/bin/env node

/**
 * MMDB Build Credits Script
 *
 * Builds data/credits.json for each year repo — a join table mapping movies to
 * people with their roles (director, cast, writer, producer, composer).
 *
 * For each year repo, downloads the tarball, extracts Wikidata Q-IDs from movie
 * entries, queries Wikidata for credits, normalizes person data, creates missing
 * people in the appropriate mmdb-people-{letter} repos, then commits credits.json
 * to the year repo via branch → PR → squash merge.
 *
 * Usage:
 *   node scripts/build-credits.mjs --from=2000 --to=2026
 *   node scripts/build-credits.mjs --year=2014
 *   node scripts/build-credits.mjs --year=2014 --dry-run
 *   node scripts/build-credits.mjs --from=2000 --to=2026 --resume
 *   node scripts/build-credits.mjs --from=2000 --to=2026 --max-queries=500
 *
 * Flags:
 *   --from=YYYY       Start year (required unless --year)
 *   --to=YYYY         End year (required unless --year)
 *   --year=YYYY       Single year (shorthand for --from=YYYY --to=YYYY)
 *   --dry-run         Show plan without executing commits
 *   --resume          Skip years that already have credits.json
 *   --max-queries=N   Cap total Wikidata queries (5 per batch — default: unlimited)
 *   --batch-size=N    Movies per Wikidata query batch (default: 15)
 *   --delay=N         Seconds between batches (default: 2; 1s between role queries)
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 */

import { resolve, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';
import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createProgress, trackDownload } from './lib/progress.mjs';
import {
  ORG,
  retryOnServerError,
  createGitHubClient,
  getDefaultBranchSha,
  createBranch,
  createPR,
  commitBatch,
  groupByFirstLetter,
  enableAutoMerge,
  getExistingIds,
  repoExists,
  getPeopleRepo,
  createPeopleRepo,
  waitForRepo,
  isUsablePersonName,
  isValidPersonYear,
} from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'MMDB-Ingestion/1.0.0 (https://github.com/mimir-media-db)';
const LABEL_LANGUAGES = 'en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru';

// ─── Parse arguments ─────────────────────────────────────────────────────────

const fromFlag = process.argv.find(a => a.startsWith('--from='));
const toFlag = process.argv.find(a => a.startsWith('--to='));
const yearFlag = process.argv.find(a => a.startsWith('--year='));
const delayFlag = process.argv.find(a => a.startsWith('--delay='));
const batchSizeFlag = process.argv.find(a => a.startsWith('--batch-size='));
const maxQueriesFlag = process.argv.find(a => a.startsWith('--max-queries='));
const dryRun = process.argv.includes('--dry-run');
const resume = process.argv.includes('--resume');

let fromYear, toYear;

if (yearFlag) {
  fromYear = toYear = parseInt(yearFlag.split('=')[1]);
} else if (fromFlag && toFlag) {
  fromYear = parseInt(fromFlag.split('=')[1]);
  toYear = parseInt(toFlag.split('=')[1]);
} else {
  console.error(`
Usage: node scripts/build-credits.mjs --from=<YYYY> --to=<YYYY> [options]
       node scripts/build-credits.mjs --year=<YYYY> [options]

Options:
  --from=YYYY        Start year (required unless --year)
  --to=YYYY          End year (required unless --year)
  --year=YYYY        Single year shortcut
  --dry-run          Show plan without executing commits
  --resume           Skip years that already have credits.json
  --max-queries=N    Cap total Wikidata queries per run (5 per batch — default: unlimited)
  --batch-size=N     Movies per Wikidata query batch (default: 15)
  --delay=N          Seconds between batches (default: 2; 1s between role queries within a batch)

Examples:
  node scripts/build-credits.mjs --from=2000 --to=2026
  node scripts/build-credits.mjs --year=2024 --dry-run
  node scripts/build-credits.mjs --from=2000 --to=2010 --max-queries=500
`);
  process.exit(1);
}

const delay = delayFlag ? parseInt(delayFlag.split('=')[1]) : 2;
const batchSize = batchSizeFlag ? parseInt(batchSizeFlag.split('=')[1]) : 15;
const maxQueries = maxQueriesFlag ? parseInt(maxQueriesFlag.split('=')[1]) : Infinity;

if (isNaN(fromYear) || fromYear < 1888 || fromYear > 2100) {
  console.error(`Error: Invalid start year. Must be between 1888 and 2100.`);
  process.exit(1);
}

if (isNaN(toYear) || toYear < 1888 || toYear > 2100) {
  console.error(`Error: Invalid end year. Must be between 1888 and 2100.`);
  process.exit(1);
}

if (fromYear > toYear) {
  console.error(`Error: --from (${fromYear}) cannot be greater than --to (${toYear}).`);
  process.exit(1);
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// ─── Person normalization ────────────────────────────────────────────────────

function generatePersonSlug(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim().replace(/\s+/g, '_');
}

function generatePersonId(name) {
  return `p_${generatePersonSlug(name)}`;
}

function normalizePerson(wikiPerson) {
  // Skip ancient people (pre-1800)
  if (!isValidPersonYear(wikiPerson.birthYear, wikiPerson.deathYear)) {
    return null;
  }

  let nameForSlug = wikiPerson.label;
  const displayName = wikiPerson.label;
  const alsoKnownAs = [];

  // If label starts with non-alpha, try birth name for slug
  const testSlug = generatePersonSlug(nameForSlug);
  if (/^[^a-z]/.test(testSlug) && wikiPerson.birthName) {
    nameForSlug = wikiPerson.birthName;
    alsoKnownAs.push(wikiPerson.birthName);
  }

  // Final validation via isUsablePersonName
  if (!isUsablePersonName(nameForSlug)) {
    return null;
  }

  // Generate slug
  let slug = generatePersonSlug(nameForSlug);
  if (/^[^a-z]/.test(slug)) {
    slug = slug.replace(/^[^a-z]+/, '');
  }

  if (!slug || slug.length < 2) {
    return null;
  }

  const id = `p_${slug}`;
  const today = new Date().toISOString().split('T')[0];

  const person = {
    schema_version: 1,
    id,
    name: displayName,
    external_ids: { wikidata: wikiPerson.wikidataId },
    last_updated: today,
  };
  if (alsoKnownAs.length > 0) person.also_known_as = alsoKnownAs;
  if (wikiPerson.birthYear) person.birth_year = wikiPerson.birthYear;
  if (wikiPerson.deathYear) person.death_year = wikiPerson.deathYear;
  if (wikiPerson.imdbId && /^nm\d+$/.test(wikiPerson.imdbId)) {
    person.external_ids.imdb = wikiPerson.imdbId;
  }
  return person;
}

function getPersonFilePath(person) {
  return `data/people/${person.id}.json`;
}

// ─── Role definitions ─────────────────────────────────────────────────────────

/**
 * Credits are queried per-role to avoid Wikidata 504 timeouts.
 * The old approach used a single UNION query with 5 roles × 30 movies × OPTIONALs
 * which was too complex. Now we run 5 simple queries per batch (one per role).
 *
 * --max-queries counts TOTAL Wikidata queries (5 per batch of movies).
 */
const ROLES = [
  { role: 'director', property: 'wdt:P57' },
  { role: 'cast', property: 'wdt:P161' },
  { role: 'writer', property: 'wdt:P58' },
  { role: 'producer', property: 'wdt:P162' },
  { role: 'composer', property: 'wdt:P86' },
];

// ─── SPARQL query builder (per-role, no UNION) ────────────────────────────────

/**
 * Build a simple SPARQL query for a single role property.
 * Each query is lightweight: one property, no UNION, fast on Wikidata.
 */
function buildRoleQuery(movieQIds, property) {
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

// ─── Wikidata query with exponential backoff ─────────────────────────────────

async function queryWikidataWithBackoff(sparql) {
  const maxRetries = 5;
  let retryDelay = 10000; // Start at 10s

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
        log(`  ⚠ Wikidata ${status} — retrying in ${retryDelay / 1000}s (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay *= 2;
        continue;
      }
    }

    const text = await response.text().catch(() => '');
    throw new Error(`Wikidata query failed: ${status} ${response.statusText}\n${text.slice(0, 500)}`);
  }
}

// ─── Parse SPARQL credit results ─────────────────────────────────────────────

/**
 * Parse Wikidata SPARQL results into credit entries.
 * The role is passed in (not from SPARQL) since we query one role at a time.
 * Returns array of { movieQId, personQId, label, role, birthYear, deathYear, imdbId, birthName }
 */
function parseCreditResults(results, role) {
  const credits = [];

  for (const binding of results.results?.bindings || []) {
    const movieQId = binding.movie?.value?.split('/').pop();
    const personQId = binding.person?.value?.split('/').pop();
    const label = binding.personLabel?.value;

    if (!movieQId || !personQId || !label) continue;
    // Skip unlabeled or Q-ID-only labels
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

// ─── Tarball extraction ──────────────────────────────────────────────────────

/**
 * Download and extract a GitHub repo tarball, parsing all movie JSON files.
 * Returns a Map of wikidataQId → movieId for all movies with Wikidata IDs.
 */
async function extractMovieLookup(tokenOrManager, yearRepo) {
  const currentToken = (typeof tokenOrManager === 'object' && tokenOrManager !== null && typeof tokenOrManager.getToken === 'function')
    ? await tokenOrManager.getToken()
    : tokenOrManager;
  const url = `https://api.github.com/repos/${ORG}/${yearRepo}/tarball/master`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${currentToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download tarball for ${yearRepo}: ${response.status}`);
  }

  const buffer = await trackDownload(response, `Downloading ${yearRepo}`);
  const tarData = gunzipSync(buffer);

  // Parse tar format — build lookup of wikidataQId → movieId
  const lookup = new Map(); // wikidataQId → movieId
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

    if (typeFlag === 48 || typeFlag === 0) {
      const isMovieFile = name.includes('/data/movies/') &&
        name.endsWith('.json') &&
        !name.endsWith('index.json');

      if (isMovieFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          const movie = JSON.parse(content);
          const wikidataId = movie.external_ids?.wikidata;
          const movieId = movie.id;
          if (wikidataId && /^Q\d+$/i.test(wikidataId) && movieId) {
            lookup.set(wikidataId, movieId);
          }
        } catch {
          // Skip unparseable files
        }
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return lookup;
}

// ─── Resume check for credits ────────────────────────────────────────────────

async function hasCreditsFile(ghApi, yearRepo) {
  const { ok } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${yearRepo}/contents/data/credits.json?ref=master`),
  );
  return ok;
}

// ─── Authentication ──────────────────────────────────────────────────────────

const envPath = resolve(__dirname, '..', '.env');
let token;
let authMethod;
let tokenManager;

if (!dryRun) {
  try {
    const auth = await loadGitHubAuth(envPath);
    token = auth.token;
    authMethod = auth.method;
    tokenManager = auth.manager;
  } catch (err) {
    console.error(`Auth error: ${err.message}`);
    process.exit(1);
  }

  if (!token) {
    console.error('Error: No GitHub authentication configured.');
    console.error('Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID in functions/.env');
    console.error('Or set GITHUB_TOKEN as fallback.');
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const totalYears = toYear - fromYear + 1;
const startedAt = new Date().toISOString();
const options = [];
if (resume) options.push('resume');
if (dryRun) options.push('dry-run');
options.push(`batch-size=${batchSize}`);
options.push(`delay=${delay}s`);
if (maxQueries !== Infinity) options.push(`max-queries=${maxQueries}`);

log('═══════════════════════════════════════════');
log(`MMDB Build Credits: ${fromYear} → ${toYear} (${totalYears} years)`);
log(`Options: ${options.join(', ')}`);
if (authMethod) log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════');

const results = [];
let totalCreditsBuilt = 0;
let totalQueriesMade = 0;
let totalPeopleCreated = 0;
let queryCapped = false;
const failedYears = [];
const skippedYears = [];

const { ghApi, ghGraphQL } = token ? createGitHubClient(tokenManager || token) : { ghApi: null, ghGraphQL: null };

const yearProgress = createProgress(totalYears, 'Years');

for (let i = 0; i < totalYears; i++) {
  const year = fromYear + i;
  const yearRepo = `mmdb-${year}`;
  const yearStart = Date.now();

  log('');
  log(`── Year ${year} (${i + 1}/${totalYears}) ──────────────────────`);

  // Check if we've hit the query cap
  if (queryCapped) {
    log(`Skipped: query cap reached (${maxQueries} queries)`);
    skippedYears.push(year);
    results.push({ year, status: 'skipped', reason: 'query cap reached' });
    continue;
  }

  try {
    // ─── Check repo exists ─────────────────────────────────────────────────

    if (!dryRun) {
      const exists = await repoExists(ghApi, yearRepo);
      if (!exists) {
        log(`Skipped: ${yearRepo} does not exist`);
        skippedYears.push(year);
        results.push({ year, status: 'skipped', reason: 'repo not found' });
        continue;
      }
    }

    // ─── Resume check ──────────────────────────────────────────────────────

    if (resume && !dryRun) {
      const hasCredits = await hasCreditsFile(ghApi, yearRepo);
      if (hasCredits) {
        log(`Skipped: credits.json already exists`);
        skippedYears.push(year);
        results.push({ year, status: 'skipped', reason: 'credits.json exists' });
        continue;
      }
    }

    // ─── Dry run mode ──────────────────────────────────────────────────────

    if (dryRun) {
      log(`Would process: ${yearRepo} → extract Q-IDs → query Wikidata → build credits.json`);
      results.push({ year, status: 'dry-run' });
      continue;
    }

    // ─── Extract movie Q-ID → movie_id lookup from tarball ─────────────────

    log(`Downloading tarball for ${yearRepo}...`);
    const movieLookup = await extractMovieLookup(tokenManager || token, yearRepo);
    log(`Found ${movieLookup.size} movies with Wikidata IDs`);

    if (movieLookup.size === 0) {
      log(`Skipped: no Wikidata IDs found in ${yearRepo}`);
      results.push({ year, status: 'skipped', reason: 'no wikidata IDs' });
      continue;
    }

    // ─── Batch Wikidata queries for credits (per-role) ───────────────────────

    const qIds = [...movieLookup.keys()];
    const batches = [];
    for (let j = 0; j < qIds.length; j += batchSize) {
      batches.push(qIds.slice(j, j + batchSize));
    }

    log(`Processing ${batches.length} batches (${batchSize} movies/batch, ${ROLES.length} role queries each)...`);

    const allCreditResults = [];
    const batchProgress = createProgress(batches.length, 'Batches');

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      // Check query cap (each batch uses 5 queries)
      if (totalQueriesMade + ROLES.length > maxQueries) {
        log(`  ⚠ Query cap would be exceeded (${totalQueriesMade}/${maxQueries}). Stopping.`);
        queryCapped = true;
        break;
      }

      const batch = batches[bIdx];

      // Rate limiting between batches (not before the first)
      if (bIdx > 0) {
        await new Promise(r => setTimeout(r, delay * 1000));
      }

      // Query each role separately
      let batchCredits = 0;
      for (let rIdx = 0; rIdx < ROLES.length; rIdx++) {
        const { role, property } = ROLES[rIdx];

        // 1s delay between role queries within a batch (not before first)
        if (rIdx > 0) {
          await new Promise(r => setTimeout(r, 1000));
        }

        const sparql = buildRoleQuery(batch, property);

        try {
          process.stdout.write(`  ${role}s... `);
          const result = await queryWikidataWithBackoff(sparql);
          totalQueriesMade++;
          const credits = parseCreditResults(result, role);
          allCreditResults.push(...credits);
          batchCredits += credits.length;
          process.stdout.write(`${credits.length}\n`);
        } catch (err) {
          totalQueriesMade++;
          process.stdout.write(`failed\n`);
          batchProgress.log(`  ⚠ Batch ${bIdx + 1} ${role} failed: ${err.message}`);
        }
      }

      batchProgress.tick(`${allCreditResults.length} credits`);

      if ((bIdx + 1) % 5 === 0 || bIdx === batches.length - 1) {
        batchProgress.log(`  Batch ${bIdx + 1}/${batches.length}: ${allCreditResults.length} raw credits so far (${totalQueriesMade} queries)`);
      }
    }

    batchProgress.done();
    log(`Wikidata returned ${allCreditResults.length} raw credit entries for year ${year}`);

    if (allCreditResults.length === 0) {
      results.push({ year, status: 'success', credits: 0, peopleCreated: 0 });
      continue;
    }

    // ─── Normalize people and build credit entries ─────────────────────────

    const creditEntries = [];
    const missingPeople = new Map(); // personId → person object (for batch creation)
    const seenCredits = new Set(); // movie+person+role dedup key

    // Collect all unique people for existence checking
    const uniquePeople = new Map(); // personQId → { label, birthYear, deathYear, imdbId, birthName }
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

    // Normalize all unique people
    const normalizedByQId = new Map(); // personQId → { id, person object }
    let skippedBadName = 0;

    for (const [personQId, wikiPerson] of uniquePeople) {
      const person = normalizePerson(wikiPerson);
      if (!person) {
        skippedBadName++;
        continue;
      }
      normalizedByQId.set(personQId, person);
    }

    if (skippedBadName > 0) {
      log(`Skipped ${skippedBadName} people with invalid names/years`);
    }

    // ─── Check which people exist, collect missing ones ────────────────────

    log(`Checking existence of ${normalizedByQId.size} unique people...`);

    // Group by target repo for efficient existence checking
    const peopleByRepo = new Map();
    for (const [personQId, person] of normalizedByQId) {
      const targetRepo = getPeopleRepo(person.id);
      if (!peopleByRepo.has(targetRepo)) peopleByRepo.set(targetRepo, []);
      peopleByRepo.get(targetRepo).push({ personQId, person });
    }

    for (const [targetRepo, repoPeople] of peopleByRepo) {
      const existingIds = await getExistingIds(ghApi, targetRepo, 'data/people');
      for (const { personQId, person } of repoPeople) {
        if (!existingIds.has(person.id)) {
          missingPeople.set(person.id, person);
        }
      }
    }

    log(`Missing people to create: ${missingPeople.size}`);

    // ─── Batch-create missing people (one PR per letter repo) ──────────────

    if (missingPeople.size > 0) {
      log(`Creating ${missingPeople.size} missing people...`);

      // Group missing people by target repo
      const missingByRepo = new Map();
      for (const [personId, person] of missingPeople) {
        const targetRepo = getPeopleRepo(personId);
        if (!missingByRepo.has(targetRepo)) missingByRepo.set(targetRepo, []);
        missingByRepo.get(targetRepo).push(person);
      }

      for (const [targetRepo, newPeople] of missingByRepo) {
        log(`  ${targetRepo}: creating ${newPeople.length} people...`);

        // Auto-create repo if needed
        const exists = await repoExists(ghApi, targetRepo);
        if (!exists) {
          const letter = targetRepo.replace('mmdb-people-', '');
          log(`  Repo ${targetRepo} does not exist — creating...`);
          await createPeopleRepo(ghApi, letter);
          await waitForRepo(ghApi, targetRepo);
          log(`  Repo ${targetRepo} ✓ created`);
        }

        // Create branch and commit
        const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const branchName = `mmdb-ingest/credits-people-${year}-${runDate}`;

        const masterSha = await getDefaultBranchSha(ghApi, targetRepo);
        if (!masterSha) {
          log(`  ⚠ Could not get master SHA for ${targetRepo}, skipping people creation`);
          continue;
        }

        const { ok: branchOk } = await createBranch(ghApi, targetRepo, branchName, masterSha);
        if (!branchOk) {
          log(`  ⚠ Failed to create branch ${branchName} — may already exist, skipping`);
          continue;
        }

        // Commit people in batches grouped by first letter
        const groups = groupByFirstLetter(newPeople);
        for (const [letter, group] of groups) {
          const files = group.map(person => ({
            path: getPersonFilePath(person),
            content: JSON.stringify(person, null, 2) + '\n',
          }));
          await commitBatch(ghApi, targetRepo, branchName, files, `ingest: add ${group.length} people (${letter})`);
          process.stdout.write(`[${letter}:${group.length}] `);
        }
        process.stdout.write('\n');

        // Create PR and squash merge
        const prTitle = `ingest: add ${newPeople.length} people (credits ${year})`;
        const prBody = [
          `## People from ${year} Movie Credits`,
          '',
          `Extracted people for credits index from movies in \`mmdb-${year}\`.`,
          '',
          `| Metric | Count |`,
          `|--------|-------|`,
          `| New people | ${newPeople.length} |`,
        ].join('\n');

        const { ok: prOk, data: prData } = await createPR(ghApi, targetRepo, prTitle, branchName, prBody);
        if (!prOk) {
          log(`  ⚠ Failed to create PR on ${targetRepo}: ${prData.message || JSON.stringify(prData)}`);
          continue;
        }

        log(`  PR created: ${targetRepo}#${prData.number}`);

        // Squash merge
        try {
          await new Promise(r => setTimeout(r, 1000));
          const { ok: mergeOk } = await retryOnServerError(
            () => ghApi('PUT', `/repos/${ORG}/${targetRepo}/pulls/${prData.number}/merge`, {
              merge_method: 'squash',
              commit_title: prTitle,
            }),
          );
          if (mergeOk) {
            log(`  Merge: ✓ squash merged`);
            totalPeopleCreated += newPeople.length;
          } else {
            const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, targetRepo, prData.number);
            log(`  Merge: ⚠ direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
            totalPeopleCreated += newPeople.length;
          }
        } catch (err) {
          log(`  Merge: ⚠ ${err.message}`);
        }
      }
    }

    // ─── Build credit entries (with dedup) ─────────────────────────────────

    for (const credit of allCreditResults) {
      const person = normalizedByQId.get(credit.personQId);
      if (!person) continue; // Skipped person (bad name, ancient, etc.)

      const movieId = movieLookup.get(credit.movieQId);
      if (!movieId) continue; // Q-ID not mapped to movie

      // Dedup: movie+person+role must be unique
      const dedupKey = `${movieId}|${person.id}|${credit.role}`;
      if (seenCredits.has(dedupKey)) continue;
      seenCredits.add(dedupKey);

      const targetRepo = getPeopleRepo(person.id);

      creditEntries.push({
        movie: movieId,
        person: person.id,
        person_repo: targetRepo,
        role: credit.role,
      });
    }

    log(`Built ${creditEntries.length} deduplicated credit entries`);

    // ─── Build and commit credits.json ─────────────────────────────────────

    const today = new Date().toISOString().split('T')[0];
    const creditsJson = {
      schema_version: 1,
      year,
      last_updated: today,
      credits: creditEntries,
    };

    const creditsContent = JSON.stringify(creditsJson, null, 2) + '\n';

    // Commit to year repo via branch → PR → squash merge
    const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const branchName = `mmdb-ingest/credits-${year}-${runDate}`;

    const masterSha = await getDefaultBranchSha(ghApi, yearRepo);
    if (!masterSha) {
      log(`  ⚠ Could not get master SHA for ${yearRepo}`);
      failedYears.push({ year, error: 'no master SHA' });
      results.push({ year, status: 'error', error: 'no master SHA' });
      continue;
    }

    const { ok: branchOk } = await createBranch(ghApi, yearRepo, branchName, masterSha);
    if (!branchOk) {
      log(`  ⚠ Failed to create branch ${branchName} on ${yearRepo}`);
      failedYears.push({ year, error: 'branch creation failed' });
      results.push({ year, status: 'error', error: 'branch creation failed' });
      continue;
    }

    await commitBatch(ghApi, yearRepo, branchName, [{
      path: 'data/credits.json',
      content: creditsContent,
    }], `ingest: add credits index (${creditEntries.length} entries)`);

    // Create PR
    const prTitle = `ingest: add credits index (${creditEntries.length} entries)`;
    const prBody = [
      `## Credits Index for ${year}`,
      '',
      `Movie-to-person role mappings built from Wikidata.`,
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Credit entries | ${creditEntries.length} |`,
      `| Unique movies | ${new Set(creditEntries.map(c => c.movie)).size} |`,
      `| Unique people | ${new Set(creditEntries.map(c => c.person)).size} |`,
      `| Directors | ${creditEntries.filter(c => c.role === 'director').length} |`,
      `| Cast | ${creditEntries.filter(c => c.role === 'cast').length} |`,
      `| Writers | ${creditEntries.filter(c => c.role === 'writer').length} |`,
      `| Producers | ${creditEntries.filter(c => c.role === 'producer').length} |`,
      `| Composers | ${creditEntries.filter(c => c.role === 'composer').length} |`,
    ].join('\n');

    const { ok: prOk, data: prData } = await createPR(ghApi, yearRepo, prTitle, branchName, prBody);
    if (!prOk) {
      log(`  ⚠ Failed to create PR on ${yearRepo}: ${prData.message || JSON.stringify(prData)}`);
      failedYears.push({ year, error: `PR creation failed: ${prData.message}` });
      results.push({ year, status: 'error', error: 'PR creation failed' });
      continue;
    }

    log(`PR created: ${yearRepo}#${prData.number}`);

    // Squash merge
    try {
      await new Promise(r => setTimeout(r, 1000));
      const { ok: mergeOk } = await retryOnServerError(
        () => ghApi('PUT', `/repos/${ORG}/${yearRepo}/pulls/${prData.number}/merge`, {
          merge_method: 'squash',
          commit_title: prTitle,
        }),
      );
      if (mergeOk) {
        log(`Merge: ✓ squash merged`);
      } else {
        const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, yearRepo, prData.number);
        log(`Merge: ⚠ direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
      }
    } catch (err) {
      log(`Merge: ⚠ ${err.message}`);
    }

    totalCreditsBuilt += creditEntries.length;
    const duration = Date.now() - yearStart;
    log(`Year ${year} complete: ${creditEntries.length} credits (${formatDuration(duration)})`);

    results.push({
      year,
      status: 'success',
      credits: creditEntries.length,
      peopleCreated: missingPeople.size,
      moviesProcessed: movieLookup.size,
    });

  } catch (err) {
    const duration = Date.now() - yearStart;
    log(`⚠ ERROR: ${err.message}`);
    log(`Skipping year ${year} (${formatDuration(duration)})`);
    failedYears.push({ year, error: err.message });
    results.push({ year, status: 'error', error: err.message });
  }

  // ─── Delay between years ───────────────────────────────────────────────────

  yearProgress.tick(`Year ${year}`);

  if (i < totalYears - 1 && !dryRun) {
    log(`Waiting 10s between years...`);
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ─── Final summary ───────────────────────────────────────────────────────────

yearProgress.done();

const completedAt = new Date().toISOString();
const totalDuration = Date.now() - new Date(startedAt).getTime();
const successCount = results.filter(r => r.status === 'success').length;
const errorCount = results.filter(r => r.status === 'error').length;
const skipCount = results.filter(r => r.status === 'skipped').length;

log('');
log('═══════════════════════════════════════════');
log('MMDB BUILD CREDITS COMPLETE');
log('───────────────────────────────────────────');
log(`Years processed: ${successCount}/${totalYears}`);
if (skipCount > 0) {
  log(`Years skipped: ${skipCount} [${skippedYears.join(', ')}]`);
}
if (errorCount > 0) {
  log(`Years failed: ${errorCount} [${failedYears.map(f => f.year).join(', ')}]`);
}
log(`Wikidata queries made: ${totalQueriesMade}`);
if (queryCapped) {
  log(`⚠ Query cap reached (${maxQueries})`);
}
log(`Total credit entries: ${totalCreditsBuilt.toLocaleString()}`);
log(`Total people created: ${totalPeopleCreated.toLocaleString()}`);
log(`Total duration: ${formatDuration(totalDuration)}`);
log('═══════════════════════════════════════════');

if (failedYears.length > 0) {
  log('');
  log('Failed years (re-run with --from/--to to retry):');
  for (const { year, error } of failedYears) {
    log(`  ${year} — ${error}`);
  }
}

// ─── Write summary JSON ──────────────────────────────────────────────────────

const summaryPath = resolve(__dirname, 'build-credits-results.json');
const summary = {
  startedAt,
  completedAt,
  range: { from: fromYear, to: toYear },
  options: { resume, dryRun, batchSize, delay, maxQueries: maxQueries === Infinity ? null : maxQueries },
  totals: {
    years: totalYears,
    success: successCount,
    errors: errorCount,
    skipped: skipCount,
    queriesMade: totalQueriesMade,
    queryCapped,
    creditsBuilt: totalCreditsBuilt,
    peopleCreated: totalPeopleCreated,
    duration: formatDuration(totalDuration),
  },
  results,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
log('');
log(`Summary written to: ${summaryPath}`);
