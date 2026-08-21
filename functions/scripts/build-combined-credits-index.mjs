#!/usr/bin/env node

/**
 * MMDB Build Combined Credits Index
 *
 * Downloads tarballs from all year repos (mmdb-2000 through mmdb-2026),
 * extracts `data/credits.json` from each, downloads people indexes from
 * all `mmdb-people-{a-z}` repos to resolve person names, and produces
 * a single gzipped JSON file suitable for distribution as a GitHub Release.
 *
 * Usage:
 *   node scripts/build-combined-credits-index.mjs
 *   node scripts/build-combined-credits-index.mjs --output /tmp/combined-credits-index.json.gz
 *   node scripts/build-combined-credits-index.mjs --from=2010 --to=2020
 *
 * Flags:
 *   --from=YYYY    Start year (default: 2000)
 *   --to=YYYY      End year (default: 2026)
 *   --output=PATH  Output file path (default: ./combined-credits-index.json.gz)
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 *   OR: GITHUB_TOKEN (PAT fallback)
 */

import { resolve, dirname } from 'path';
import { writeFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { gunzipSync, gzipSync } from 'zlib';
import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createProgress, trackDownload } from './lib/progress.mjs';
import { ORG, retryOnServerError, createGitHubClient } from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse arguments ─────────────────────────────────────────────────────────

const fromFlag = process.argv.find(a => a.startsWith('--from='));
const toFlag = process.argv.find(a => a.startsWith('--to='));
const outputFlag = process.argv.find(a => a.startsWith('--output='));
const outputArgIdx = process.argv.indexOf('--output');

const fromYear = fromFlag ? parseInt(fromFlag.split('=')[1]) : 2000;
const toYear = toFlag ? parseInt(toFlag.split('=')[1]) : 2026;
const outputPath = outputFlag
  ? resolve(outputFlag.split('=')[1])
  : outputArgIdx !== -1 && process.argv[outputArgIdx + 1]
    ? resolve(process.argv[outputArgIdx + 1])
    : resolve(__dirname, '..', '..', 'combined-credits-index.json.gz');

if (isNaN(fromYear) || fromYear < 1888 || fromYear > 2100) {
  console.error('Error: Invalid --from year. Must be between 1888 and 2100.');
  process.exit(1);
}

if (isNaN(toYear) || toYear < 1888 || toYear > 2100) {
  console.error('Error: Invalid --to year. Must be between 1888 and 2100.');
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// ─── Tarball extraction (credits.json only) ──────────────────────────────────

/**
 * Download and extract data/credits.json from a year repo tarball.
 * Returns the parsed credits array or null if credits.json doesn't exist.
 */
async function extractCreditsFromTarball(tokenOrManager, yearRepo) {
  const currentToken = (typeof tokenOrManager === 'object' && tokenOrManager !== null && typeof tokenOrManager.getToken === 'function')
    ? await tokenOrManager.getToken()
    : tokenOrManager;

  const url = `https://api.github.com/repos/${ORG}/${yearRepo}/tarball/master`;

  const fetchTarball = async () => {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'follow',
    });
    return { ok: response.ok, status: response.status, data: response };
  };

  const result = await retryOnServerError(fetchTarball);
  if (!result.ok) {
    throw new Error(`Failed to download tarball for ${yearRepo}: ${result.status}`);
  }

  const buffer = await trackDownload(result.data, `  ${yearRepo}`);

  // GitHub serves gzipped tarballs — decompress
  const tarData = gunzipSync(buffer);

  // Parse tar format looking for data/credits.json
  let offset = 0;

  while (offset < tarData.length - 512) {
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

    // Only process regular files matching data/credits.json
    if ((typeFlag === 48 || typeFlag === 0) && name.endsWith('/data/credits.json') && size > 0) {
      try {
        const content = tarData.subarray(offset, offset + size).toString('utf8');
        const creditsData = JSON.parse(content);
        return creditsData.credits || [];
      } catch {
        return null;
      }
    }

    // Move to next entry (file data padded to 512 byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }

  return null; // credits.json not found in tarball
}

/**
 * Download and extract data/people/index.json from a people repo tarball.
 * Returns an array of person entries [{id, name, ...}] or null.
 */
async function extractPeopleIndexFromTarball(tokenOrManager, peopleRepo) {
  const currentToken = (typeof tokenOrManager === 'object' && tokenOrManager !== null && typeof tokenOrManager.getToken === 'function')
    ? await tokenOrManager.getToken()
    : tokenOrManager;

  const url = `https://api.github.com/repos/${ORG}/${peopleRepo}/tarball/master`;

  const fetchTarball = async () => {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${currentToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'follow',
    });
    return { ok: response.ok, status: response.status, data: response };
  };

  const result = await retryOnServerError(fetchTarball);
  if (!result.ok) {
    throw new Error(`Failed to download tarball for ${peopleRepo}: ${result.status}`);
  }

  const buffer = await trackDownload(result.data, `  ${peopleRepo}`);

  // GitHub serves gzipped tarballs — decompress
  const tarData = gunzipSync(buffer);

  // Parse tar format looking for data/people/index.json
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

    if ((typeFlag === 48 || typeFlag === 0) && name.endsWith('/data/people/index.json') && size > 0) {
      try {
        const content = tarData.subarray(offset, offset + size).toString('utf8');
        const indexData = JSON.parse(content);
        // index.json can be an array or an object with entries
        return Array.isArray(indexData) ? indexData : (indexData.people || indexData.entries || []);
      } catch {
        return null;
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return null;
}

// ─── Authentication ──────────────────────────────────────────────────────────

const envPath = resolve(__dirname, '..', '.env');
let token;
let authMethod;
let tokenManager;

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

// ─── Main ────────────────────────────────────────────────────────────────────

const totalYears = toYear - fromYear + 1;
const startTime = Date.now();

log('═══════════════════════════════════════════════════');
log(`MMDB Build Combined Credits Index: ${fromYear} → ${toYear} (${totalYears} years)`);
log(`Output: ${outputPath}`);
log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════════════');

const { ghApi } = createGitHubClient(tokenManager || token);

// ─── Phase 1: Download people indexes ────────────────────────────────────────

log('');
log('Phase 1: Downloading people indexes (a-z)...');

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const peopleMap = new Map(); // personId → { id, name }
const skippedPeopleRepos = [];

const peopleProgress = createProgress(LETTERS.length, 'People repos');

for (const letter of LETTERS) {
  const peopleRepo = `mmdb-people-${letter}`;

  try {
    // Check repo exists
    const { ok } = await retryOnServerError(
      () => ghApi('GET', `/repos/${ORG}/${peopleRepo}`),
    );

    if (!ok) {
      skippedPeopleRepos.push(letter);
      peopleProgress.tick(`${peopleRepo} (skipped)`);
      continue;
    }

    const entries = await extractPeopleIndexFromTarball(tokenManager || token, peopleRepo);

    if (entries && entries.length > 0) {
      for (const person of entries) {
        if (person.id && person.name) {
          peopleMap.set(person.id, { id: person.id, name: person.name });
        }
      }
    }

    peopleProgress.tick(`${peopleRepo} (${entries ? entries.length : 0} people)`);
  } catch (err) {
    log(`  ⚠ ERROR: ${peopleRepo} — ${err.message}`);
    skippedPeopleRepos.push(letter);
    peopleProgress.tick(`${peopleRepo} (failed)`);
  }
}

const peopleDuration = peopleProgress.done();
log(`People loaded: ${peopleMap.size.toLocaleString()} from ${LETTERS.length - skippedPeopleRepos.length} repos (${peopleDuration})`);

// ─── Phase 2: Download credits from year repos ───────────────────────────────

log('');
log('Phase 2: Downloading credits from year repos...');

const allCredits = []; // { movie, person, person_repo, role }
const skippedYears = [];
const failedYears = [];

const yearProgress = createProgress(totalYears, 'Years');

for (let i = 0; i < totalYears; i++) {
  const year = fromYear + i;
  const yearRepo = `mmdb-${year}`;

  try {
    // Check repo exists
    const { ok } = await retryOnServerError(
      () => ghApi('GET', `/repos/${ORG}/${yearRepo}`),
    );

    if (!ok) {
      skippedYears.push(year);
      yearProgress.tick(`${yearRepo} (skipped)`);
      continue;
    }

    const credits = await extractCreditsFromTarball(tokenManager || token, yearRepo);

    if (credits && credits.length > 0) {
      allCredits.push(...credits);
      yearProgress.tick(`${yearRepo} (${credits.length} credits)`);
    } else {
      yearProgress.tick(`${yearRepo} (no credits)`);
    }
  } catch (err) {
    log(`  ⚠ ERROR: ${yearRepo} — ${err.message}`);
    failedYears.push({ year, error: err.message });
    yearProgress.tick(`${yearRepo} (failed)`);
  }
}

const yearDuration = yearProgress.done();
log(`Credits loaded: ${allCredits.length.toLocaleString()} from ${totalYears - skippedYears.length - failedYears.length} repos (${yearDuration})`);

// ─── Phase 3: Build combined structure ───────────────────────────────────────

log('');
log('Phase 3: Building combined credits index...');

const creditsByMovie = {};  // movieId → [{ person, role }]
const creditsByPerson = {}; // personId → [{ movie, role }]
const referencedPeople = new Set();

for (const credit of allCredits) {
  const { movie, person, role } = credit;
  if (!movie || !person || !role) continue;

  // credits_by_movie
  if (!creditsByMovie[movie]) {
    creditsByMovie[movie] = [];
  }
  creditsByMovie[movie].push({ person, role });

  // credits_by_person
  if (!creditsByPerson[person]) {
    creditsByPerson[person] = [];
  }
  creditsByPerson[person].push({ movie, role });

  referencedPeople.add(person);
}

// Build people lookup (only people referenced in credits)
const people = {};
let resolvedCount = 0;
let unresolvedCount = 0;

for (const personId of referencedPeople) {
  const personData = peopleMap.get(personId);
  if (personData) {
    people[personId] = { id: personData.id, name: personData.name };
    resolvedCount++;
  } else {
    // Include with ID only — name couldn't be resolved
    people[personId] = { id: personId, name: personId.replace(/^p_/, '').replace(/_/g, ' ') };
    unresolvedCount++;
  }
}

const combinedCreditsIndex = {
  version: 1,
  built_at: new Date().toISOString(),
  stats: {
    total_credits: allCredits.length,
    total_people: referencedPeople.size,
    year_range: [fromYear, toYear],
  },
  credits_by_movie: creditsByMovie,
  credits_by_person: creditsByPerson,
  people,
};

// ─── Phase 4: Compress and write ─────────────────────────────────────────────

log('');
log('Compressing with gzip...');

const jsonString = JSON.stringify(combinedCreditsIndex);
const compressed = gzipSync(Buffer.from(jsonString), { level: 9 });

writeFileSync(outputPath, compressed);

const fileSize = statSync(outputPath).size;
const uncompressedSize = Buffer.byteLength(jsonString);
const ratio = ((1 - fileSize / uncompressedSize) * 100).toFixed(1);

// ─── Final summary ───────────────────────────────────────────────────────────

const totalDuration = Date.now() - startTime;

log('');
log('═══════════════════════════════════════════════════');
log('COMBINED CREDITS INDEX BUILD COMPLETE');
log('─────────────────────────────────────────────────');
log(`Total credits:      ${allCredits.length.toLocaleString()}`);
log(`Movies with credits: ${Object.keys(creditsByMovie).length.toLocaleString()}`);
log(`Unique people:      ${referencedPeople.size.toLocaleString()}`);
log(`  Resolved names:   ${resolvedCount.toLocaleString()}`);
log(`  Unresolved:       ${unresolvedCount.toLocaleString()}`);
log(`Year range:         ${fromYear} – ${toYear}`);
log(`Uncompressed:       ${formatBytes(uncompressedSize)}`);
log(`Compressed:         ${formatBytes(fileSize)} (${ratio}% reduction)`);
log(`Output:             ${outputPath}`);
log(`Duration:           ${formatDuration(totalDuration)}`);
if (skippedYears.length > 0) {
  log(`Skipped years:      ${skippedYears.join(', ')}`);
}
if (failedYears.length > 0) {
  log(`Failed years:       ${failedYears.map(f => f.year).join(', ')}`);
}
if (skippedPeopleRepos.length > 0) {
  log(`Skipped people:     ${skippedPeopleRepos.map(l => `mmdb-people-${l}`).join(', ')}`);
}
log('═══════════════════════════════════════════════════');
