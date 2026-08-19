#!/usr/bin/env node

/**
 * MMDB Bulk People Enrichment Script
 *
 * Iterates year repos (mmdb-2000 through mmdb-2026), extracts Wikidata Q-IDs
 * from movie entries, queries Wikidata for cast/directors/producers, and commits
 * new people to mmdb-people.
 *
 * Uses the tarball API to efficiently download and parse all movie files from
 * each year repo (one HTTP call per year).
 *
 * Usage:
 *   node scripts/bulk-people.mjs --from=2000 --to=2026
 *   node scripts/bulk-people.mjs --year=2024
 *   node scripts/bulk-people.mjs --from=2000 --to=2026 --dry-run
 *   node scripts/bulk-people.mjs --from=2000 --to=2026 --resume
 *   node scripts/bulk-people.mjs --from=2000 --to=2010 --max-queries=50
 *
 * Flags:
 *   --from=YYYY       Start year (required unless --year)
 *   --to=YYYY         End year (required unless --year)
 *   --year=YYYY       Single year (shorthand for --from=YYYY --to=YYYY)
 *   --dry-run         Show plan without executing commits
 *   --resume          Skip years with existing people branches
 *   --max-queries=N   Cap total Wikidata queries per run (default: unlimited)
 *   --batch-size=N    Movies per Wikidata query (default: 30)
 *   --delay=N         Seconds between Wikidata queries (default: 2)
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 */

import { resolve, dirname } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';
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
Usage: node scripts/bulk-people.mjs --from=<YYYY> --to=<YYYY> [options]
       node scripts/bulk-people.mjs --year=<YYYY> [options]

Options:
  --from=YYYY        Start year (required unless --year)
  --to=YYYY          End year (required unless --year)
  --year=YYYY        Single year shortcut
  --dry-run          Show plan without executing commits
  --resume           Skip years that already have a people ingest branch
  --max-queries=N    Cap total Wikidata queries per run (default: unlimited)
  --batch-size=N     Movies per Wikidata query batch (default: 30)
  --delay=N          Seconds between Wikidata queries (default: 2)

Examples:
  node scripts/bulk-people.mjs --from=2000 --to=2026
  node scripts/bulk-people.mjs --year=2024 --dry-run
  node scripts/bulk-people.mjs --from=2000 --to=2010 --max-queries=50
`);
  process.exit(1);
}

const delay = delayFlag ? parseInt(delayFlag.split('=')[1]) : 2;
const batchSize = batchSizeFlag ? parseInt(batchSizeFlag.split('=')[1]) : 30;
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
  if (wikiPerson.birthYear && wikiPerson.birthYear < 1800) {
    log(`Skipping ${wikiPerson.label}: birth_year ${wikiPerson.birthYear} < 1800`);
    return null;
  }
  if (wikiPerson.deathYear && wikiPerson.deathYear < 1800) {
    log(`Skipping ${wikiPerson.label}: death_year ${wikiPerson.deathYear} < 1800`);
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

  // Final fallback: strip leading non-alpha if still unroutable
  let slug = generatePersonSlug(nameForSlug);
  if (/^[^a-z]/.test(slug)) {
    slug = slug.replace(/^[^a-z]+/, '');
  }

  // Reject if slug is empty or too short (would produce invalid ID like "p_" or "p_x")
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

// ─── SPARQL query builder ────────────────────────────────────────────────────

function buildPeopleQuery(movieQIds, limit = 500) {
  const values = movieQIds.map(id => `wd:${id}`).join(' ');
  return `
SELECT DISTINCT ?person ?personLabel ?birthDate ?deathDate ?imdb ?birthName
WHERE {
  VALUES ?movie { ${values} }
  { ?movie wdt:P161 ?person. }
  UNION { ?movie wdt:P57 ?person. }
  UNION { ?movie wdt:P162 ?person. }
  ?person wdt:P31 wd:Q5.
  OPTIONAL { ?person wdt:P345 ?imdb. }
  OPTIONAL { ?person wdt:P569 ?birthDate. }
  OPTIONAL { ?person wdt:P570 ?deathDate. }
  OPTIONAL { ?person wdt:P1477 ?birthName. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}". }
}
ORDER BY ?personLabel
LIMIT ${limit}
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
        retryDelay *= 2; // Exponential backoff
        continue;
      }
    }

    const text = await response.text().catch(() => '');
    throw new Error(`Wikidata query failed: ${status} ${response.statusText}\n${text.slice(0, 500)}`);
  }
}

// ─── Parse SPARQL person results ─────────────────────────────────────────────

function parsePersonResults(results) {
  const people = new Map(); // Dedup by wikidata ID within batch

  for (const binding of results.results?.bindings || []) {
    const wikidataId = binding.person?.value?.split('/').pop();
    if (!wikidataId) continue;

    // Skip if already seen (dedup within batch)
    if (people.has(wikidataId)) continue;

    const label = binding.personLabel?.value;
    if (!label || /^Q\d+$/i.test(label)) continue; // Skip unlabeled or Q-ID-only labels

    const birthDate = binding.birthDate?.value;
    const deathDate = binding.deathDate?.value;
    const imdbId = binding.imdb?.value;
    const birthName = binding.birthName?.value;

    people.set(wikidataId, {
      wikidataId,
      label,
      birthYear: birthDate ? new Date(birthDate).getFullYear() : undefined,
      deathYear: deathDate ? new Date(deathDate).getFullYear() : undefined,
      imdbId,
      birthName,
    });
  }

  return [...people.values()];
}

// ─── Tarball extraction ──────────────────────────────────────────────────────

/**
 * Download and extract a GitHub repo tarball, parsing all movie JSON files.
 * Returns an array of wikidata Q-IDs found in movie entries.
 */
async function extractMovieQIds(tokenOrManager, yearRepo) {
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

  // GitHub serves gzipped tarballs — decompress
  const tarData = gunzipSync(buffer);

  // Parse tar format (simple implementation for reading file contents)
  const qIds = [];
  let offset = 0;

  while (offset < tarData.length - 512) {
    // Read header (512 bytes)
    const header = tarData.subarray(offset, offset + 512);

    // Check for end of archive (two zero blocks)
    if (header.every(b => b === 0)) break;

    // Get filename (first 100 bytes, null-terminated)
    const nameEnd = header.indexOf(0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf8');

    // Get file size (octal, bytes 124-135)
    const sizeStr = header.subarray(124, 136).toString('utf8').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // Get type flag (byte 156)
    const typeFlag = header[156];

    offset += 512; // Move past header

    // Only process regular files in data/movies/ that are .json and not index.json
    if (typeFlag === 48 || typeFlag === 0) { // '0' or null = regular file
      const isMovieFile = name.includes('/data/movies/') &&
        name.endsWith('.json') &&
        !name.endsWith('index.json');

      if (isMovieFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          const movie = JSON.parse(content);
          const wikidataId = movie.external_ids?.wikidata;
          if (wikidataId && /^Q\d+$/i.test(wikidataId)) {
            qIds.push(wikidataId);
          }
        } catch {
          // Skip unparseable files
        }
      }
    }

    // Move to next entry (file data padded to 512 byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }

  return qIds;
}

// ─── Resume check for people branches ────────────────────────────────────────

async function hasRecentPeopleBranch(ghApi, year) {
  // Check all 26 letter repos for existing people branches (check a few representative ones)
  const letters = ['a', 'm', 's'];
  for (const letter of letters) {
    const repo = `mmdb-people-${letter}`;
    const { ok, data } = await retryOnServerError(
      () => ghApi('GET', `/repos/${ORG}/${repo}/git/matching-refs/heads/mmdb-ingest/people-${year}-`),
    );
    if (ok && Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}

// ─── Progress tracking ───────────────────────────────────────────────────────

const progressPath = resolve(__dirname, 'bulk-people-progress.json');

function saveProgress(progress) {
  writeFileSync(progressPath, JSON.stringify(progress, null, 2) + '\n');
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
log(`MMDB Bulk People Enrichment: ${fromYear} → ${toYear} (${totalYears} years)`);
log(`Options: ${options.join(', ')}`);
if (authMethod) log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════');

const results = [];
let totalPeopleAdded = 0;
let totalQueriesMade = 0;
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
      const hasBranch = await hasRecentPeopleBranch(ghApi, year);
      if (hasBranch) {
        log(`Skipped: recent people branch exists`);
        skippedYears.push(year);
        results.push({ year, status: 'skipped', reason: 'recent people branch exists' });
        continue;
      }
    }

    // ─── Dry run mode ──────────────────────────────────────────────────────

    if (dryRun) {
      log(`Would process: ${yearRepo} → extract Q-IDs → query Wikidata → commit to mmdb-people-{a-z}`);
      results.push({ year, status: 'dry-run' });
      continue;
    }

    // ─── Extract movie Q-IDs from year repo tarball ────────────────────────

    log(`Downloading tarball for ${yearRepo}...`);
    const qIds = await extractMovieQIds(tokenManager || token, yearRepo);
    log(`Found ${qIds.length} movies with Wikidata IDs`);

    if (qIds.length === 0) {
      log(`Skipped: no Wikidata IDs found in ${yearRepo}`);
      results.push({ year, status: 'skipped', reason: 'no wikidata IDs' });
      continue;
    }

    // ─── Batch Wikidata queries ────────────────────────────────────────────

    const batches = [];
    for (let j = 0; j < qIds.length; j += batchSize) {
      batches.push(qIds.slice(j, j + batchSize));
    }

    log(`Processing ${batches.length} batches (${batchSize} movies/batch)...`);

    const allPeople = new Map(); // Dedup by wikidata ID across batches
    const batchProgress = createProgress(batches.length, 'Batches');

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      // Check query cap
      if (totalQueriesMade >= maxQueries) {
        log(`  ⚠ Query cap reached (${maxQueries}). Stopping.`);
        queryCapped = true;
        break;
      }

      const batch = batches[bIdx];
      const sparql = buildPeopleQuery(batch);

      // Rate limiting: wait between queries
      if (bIdx > 0) {
        await new Promise(r => setTimeout(r, delay * 1000));
      }

      try {
        const result = await queryWikidataWithBackoff(sparql);
        totalQueriesMade++;
        const people = parsePersonResults(result);

        for (const person of people) {
          if (!allPeople.has(person.wikidataId)) {
            allPeople.set(person.wikidataId, person);
          }
        }

        batchProgress.tick(`${allPeople.size} people`);

        if ((bIdx + 1) % 10 === 0 || bIdx === batches.length - 1) {
          batchProgress.log(`  Batch ${bIdx + 1}/${batches.length}: ${allPeople.size} unique people so far`);
        }
      } catch (err) {
        batchProgress.tick(`failed`);
        batchProgress.log(`  ⚠ Batch ${bIdx + 1} failed: ${err.message}`);
        // Continue with remaining batches
      }
    }

    log(`Wikidata returned ${allPeople.size} unique people for year ${year}`);
    batchProgress.done();

    if (allPeople.size === 0) {
      results.push({ year, status: 'success', people: 0 });
      continue;
    }

    // ─── Normalize people ──────────────────────────────────────────────────

    const normalizedPeople = [];
    let skippedBadSlug = 0;
    for (const wikiPerson of allPeople.values()) {
      const person = normalizePerson(wikiPerson);
      // Skip people whose names produce empty or invalid slugs
      if (!person) {
        skippedBadSlug++;
        log(`  Skipped bad slug: "${wikiPerson.label}" (wikidata: ${wikiPerson.wikidataId})`);
        continue;
      }
      normalizedPeople.push(person);
    }
    if (skippedBadSlug > 0) {
      log(`Skipped ${skippedBadSlug} people with invalid slugs`);
    }

    // ─── Dedup against existing people in target repos ───────────────────────

    log(`Grouping ${normalizedPeople.length} people by target repo...`);

    // Group people by their target alphabetical repo
    const peopleByRepo = new Map();
    for (const person of normalizedPeople) {
      const targetRepo = getPeopleRepo(person.id);
      if (!peopleByRepo.has(targetRepo)) peopleByRepo.set(targetRepo, []);
      peopleByRepo.get(targetRepo).push(person);
    }

    let totalNewPeople = 0;
    let totalDuplicates = 0;

    for (const [targetRepo, repoPeople] of peopleByRepo) {
      log(`Checking dedup for ${targetRepo} (${repoPeople.length} people)...`);
      const existingIds = await getExistingIds(ghApi, targetRepo, 'data/people');

      const newPeople = repoPeople.filter(p => !existingIds.has(p.id));
      const duplicateCount = repoPeople.length - newPeople.length;
      totalDuplicates += duplicateCount;

      if (newPeople.length === 0) {
        log(`  ${targetRepo}: no new people (${duplicateCount} duplicates)`);
        continue;
      }

      log(`  ${targetRepo}: ${newPeople.length} new, ${duplicateCount} duplicates`);

      // ─── Auto-create repo if it doesn't exist ───────────────────────────────

      const exists = await repoExists(ghApi, targetRepo);
      if (!exists) {
        const letter = targetRepo.replace('mmdb-people-', '');
        log(`  Repo ${targetRepo} does not exist — creating...`);
        await createPeopleRepo(ghApi, letter);
        log(`  Repo ${targetRepo} ✓ created`);
      }

      // ─── Create branch and commit to target repo ───────────────────────────

      const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const branchName = `mmdb-ingest/people-${year}-${runDate}`;

      const masterSha = await getDefaultBranchSha(ghApi, targetRepo);
      if (!masterSha) {
        log(`  ⚠ Could not get master SHA for ${targetRepo}, skipping`);
        continue;
      }

      const { ok: branchOk } = await createBranch(ghApi, targetRepo, branchName, masterSha);
      if (!branchOk) {
        log(`  ⚠ Failed to create branch ${branchName} on ${targetRepo} — may already exist, skipping`);
        continue;
      }

      log(`  Branch created: ${branchName}`);
      log(`  Committing ${newPeople.length} people in batches...`);

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

      // ─── Create PR ─────────────────────────────────────────────────────────

      const prTitle = `ingest: add ${newPeople.length} people (${year} movies)`;
      const prBody = [
        `## People from ${year} Movies`,
        '',
        `Extracted cast, directors, and producers from movies in \`mmdb-${year}\`.`,
        '',
        '### Summary',
        '',
        '| Metric | Count |',
        '|--------|-------|',
        `| New people added | ${newPeople.length} |`,
        `| Duplicates skipped | ${duplicateCount} |`,
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
          await new Promise(r => setTimeout(r, 1000));
          const { ok: dispatchOk } = await ghApi('POST', `/repos/${ORG}/${targetRepo}/actions/workflows/validate.yml/dispatches`, {
            ref: 'master',
          });
          log(`  CI: ${dispatchOk ? '✓ index build dispatched' : '⚠ could not dispatch'}`);
        } else {
          const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, targetRepo, prData.number);
          log(`  Merge: ⚠ direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
        }
      } catch (err) {
        log(`  Merge: ⚠ ${err.message}`);
      }

      totalNewPeople += newPeople.length;
    }

    totalPeopleAdded += totalNewPeople;
    const duration = Date.now() - yearStart;
    log(`Year ${year} complete: ${totalNewPeople} people added across ${peopleByRepo.size} repos (${formatDuration(duration)})`);

    results.push({
      year,
      status: 'success',
      people: totalNewPeople,
      duplicates: totalDuplicates,
      moviesProcessed: qIds.length,
      repos: [...peopleByRepo.keys()],
    });

    // Save progress after each year
    saveProgress({
      lastCompletedYear: year,
      totalQueriesMade,
      totalPeopleAdded,
      queryCapped,
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
log('BULK PEOPLE ENRICHMENT COMPLETE');
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
log(`Total people added: ${totalPeopleAdded.toLocaleString()}`);
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

const summaryPath = resolve(__dirname, 'bulk-people-results.json');
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
    peopleAdded: totalPeopleAdded,
    duration: formatDuration(totalDuration),
  },
  results,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
log('');
log(`Summary written to: ${summaryPath}`);
