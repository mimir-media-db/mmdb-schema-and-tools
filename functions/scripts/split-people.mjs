#!/usr/bin/env node

/**
 * MMDB People Split — Alphabetical Repo Migration
 *
 * Downloads the current mmdb-people repo, parses all person files, and
 * distributes them into 26 alphabetical repos (mmdb-people-a through mmdb-people-z).
 * Routing key: first character of the person slug after the p_ prefix.
 *
 * Usage:
 *   node scripts/split-people.mjs --dry-run
 *   node scripts/split-people.mjs
 *   node scripts/split-people.mjs --letters=a,b,c
 *
 * Flags:
 *   --dry-run          Show distribution counts without executing
 *   --letters=a,b,c    Only process specific letters (comma-separated)
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
  enableAutoMerge,
  repoExists,
  getPeopleRepo,
  createPeopleRepo,
  GITHUB_RATE_LIMIT_MS,
} from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const SOURCE_REPO = 'mmdb-people';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

// ─── Parse arguments ─────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');
const lettersFlag = process.argv.find(a => a.startsWith('--letters='));
const targetLetters = lettersFlag
  ? lettersFlag.split('=')[1].split(',').map(l => l.toLowerCase().trim())
  : ALPHABET;

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

// ─── Tarball extraction ──────────────────────────────────────────────────────

/**
 * Download and extract all person JSON files from mmdb-people tarball.
 * Returns a Map<string, object> of personId → parsed person data.
 */
async function extractPeopleFromTarball(tokenOrManager) {
  const currentToken = (typeof tokenOrManager === 'object' && tokenOrManager !== null && typeof tokenOrManager.getToken === 'function')
    ? await tokenOrManager.getToken()
    : tokenOrManager;
  const url = `https://api.github.com/repos/${ORG}/${SOURCE_REPO}/tarball/master`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${currentToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download tarball for ${SOURCE_REPO}: ${response.status}`);
  }

  const buffer = await trackDownload(response, `Downloading ${SOURCE_REPO}`);
  const tarData = gunzipSync(buffer);

  const people = new Map();
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
      const isPersonFile = name.includes('/data/people/') &&
        name.endsWith('.json') &&
        !name.endsWith('index.json');

      if (isPersonFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          const person = JSON.parse(content);
          if (person.id) {
            people.set(person.id, person);
          }
        } catch {
          // Skip unparseable files
        }
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return people;
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
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
const options = [];
if (dryRun) options.push('dry-run');
if (lettersFlag) options.push(`letters=${targetLetters.join(',')}`);

log('═══════════════════════════════════════════');
log(`MMDB People Split: ${SOURCE_REPO} → mmdb-people-{a-z}`);
log(`Options: ${options.length > 0 ? options.join(', ') : 'none'}`);
log(`Target letters: ${targetLetters.join(', ')}`);
if (authMethod) log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════');

// ─── Download and parse source repo ──────────────────────────────────────────

log('');
log('Downloading mmdb-people tarball...');

let allPeople;
if (dryRun && !token) {
  // In dry-run without auth, we can't actually download — show usage
  console.error('Note: --dry-run without auth cannot download tarball.');
  console.error('Set auth environment vars or run without --dry-run.');
  process.exit(1);
}

// Even dry-run needs auth to download the tarball for counting
if (!token) {
  try {
    const auth = await loadGitHubAuth(envPath);
    token = auth.token;
    authMethod = auth.method;
    tokenManager = auth.manager;
  } catch (err) {
    console.error(`Auth error: ${err.message}`);
    process.exit(1);
  }
}

allPeople = await extractPeopleFromTarball(tokenManager || token);
log(`Extracted ${allPeople.size} people from ${SOURCE_REPO}`);

// ─── Route people to alphabetical repos ──────────────────────────────────────

const VALID_PERSON_ID = /^p_[a-z][a-z0-9_]+$/;
const distribution = new Map(); // letter → person[]
let skippedInvalid = 0;

for (const [personId, person] of allPeople) {
  // Skip people with empty or invalid slugs
  if (!personId || personId === 'p_' || !VALID_PERSON_ID.test(personId)) {
    skippedInvalid++;
    log(`  Skipping invalid person: id="${personId}", name="${person.name || '?'}"`);
    continue;
  }

  const targetRepo = getPeopleRepo(personId);
  const letter = targetRepo.replace('mmdb-people-', '');

  if (!distribution.has(letter)) {
    distribution.set(letter, []);
  }
  distribution.get(letter).push(person);
}

if (skippedInvalid > 0) {
  log(`Skipped ${skippedInvalid} people with invalid IDs`);
}

// ─── Show distribution ───────────────────────────────────────────────────────

log('');
log('Distribution:');
log('─────────────────────────────────');

const sortedLetters = [...distribution.keys()].sort();
for (const letter of sortedLetters) {
  const count = distribution.get(letter).length;
  const bar = '█'.repeat(Math.min(50, Math.round(count / Math.max(1, allPeople.size) * 200)));
  log(`  ${letter.toUpperCase()}: ${String(count).padStart(5)} ${bar}`);
}

log('─────────────────────────────────');
log(`Total: ${allPeople.size} people across ${sortedLetters.length} letters`);

if (dryRun) {
  log('');
  log('DRY RUN — no repos created or files committed.');
  const summaryPath = resolve(__dirname, 'split-people-results.json');
  const summary = {
    mode: 'dry-run',
    timestamp: new Date().toISOString(),
    source: SOURCE_REPO,
    totalPeople: allPeople.size,
    distribution: Object.fromEntries(
      sortedLetters.map(l => [l, distribution.get(l).length])
    ),
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  log(`Summary written to: ${summaryPath}`);
  process.exit(0);
}

// ─── Process each letter ─────────────────────────────────────────────────────

const { ghApi, ghGraphQL } = createGitHubClient(tokenManager || token);
const results = [];
const letterProgress = createProgress(targetLetters.length, 'Letters');

for (const letter of targetLetters) {
  const people = distribution.get(letter);
  if (!people || people.length === 0) {
    log(`\n── Letter ${letter.toUpperCase()} ── (no people, skipping)`);
    results.push({ letter, status: 'skipped', reason: 'no people', count: 0 });
    continue;
  }

  const repoName = `mmdb-people-${letter}`;
  log(`\n── Letter ${letter.toUpperCase()} ── ${people.length} people → ${repoName}`);

  try {
    // ─── Check/create repo ───────────────────────────────────────────────────

    const exists = await repoExists(ghApi, repoName);
    if (!exists) {
      log(`  Creating repo ${repoName}...`);
      await createPeopleRepo(ghApi, letter);
    } else {
      log(`  Repo ${repoName} already exists`);
    }

    // ─── Create branch ───────────────────────────────────────────────────────

    const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const branchName = `mmdb-ingest/split-people-${letter}-${runDate}`;

    const masterSha = await getDefaultBranchSha(ghApi, repoName);
    if (!masterSha) {
      throw new Error(`Could not get master SHA for ${repoName}`);
    }

    const { ok: branchOk } = await createBranch(ghApi, repoName, branchName, masterSha);
    if (!branchOk) {
      throw new Error(`Failed to create branch ${branchName} — may already exist`);
    }

    log(`  Branch created: ${branchName}`);

    // ─── Commit people in batches ────────────────────────────────────────────

    // Group by sub-letter for commit messages
    const subGroups = new Map();
    for (const person of people) {
      const slug = person.id.replace(/^p_/, '');
      const subKey = (slug.slice(0, 2) || letter).toLowerCase();
      if (!subGroups.has(subKey)) subGroups.set(subKey, []);
      subGroups.get(subKey).push(person);
    }

    let committedCount = 0;
    const batchSize = 200; // Commit in groups to avoid tree API limits
    const allFiles = people.map(person => ({
      path: `data/people/${person.id}.json`,
      content: JSON.stringify(person, null, 2) + '\n',
    }));

    // Commit in batches of batchSize
    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(allFiles.length / batchSize);
      const msg = totalBatches > 1
        ? `ingest: add ${batch.length} people (${letter}, batch ${batchNum}/${totalBatches})`
        : `ingest: add ${batch.length} people (${letter})`;

      await commitBatch(ghApi, repoName, branchName, batch, msg);
      committedCount += batch.length;
      process.stdout.write(`  [batch ${batchNum}/${totalBatches}: ${batch.length} files] `);
    }
    process.stdout.write('\n');
    log(`  Committed ${committedCount} people`);

    // ─── Create PR ───────────────────────────────────────────────────────────

    const prTitle = `ingest: migrate ${people.length} people (${letter.toUpperCase()})`;
    const prBody = [
      `## People Split Migration — ${letter.toUpperCase()}`,
      '',
      `Migrated ${people.length} people from \`${SOURCE_REPO}\` to \`${repoName}\`.`,
      '',
      `Routing key: first character of slug after \`p_\` prefix.`,
    ].join('\n');

    const { ok: prOk, data: prData } = await createPR(ghApi, repoName, prTitle, branchName, prBody);
    if (!prOk) {
      throw new Error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
    }

    log(`  PR created: ${repoName}#${prData.number}`);

    // ─── Squash merge ────────────────────────────────────────────────────────

    await new Promise(r => setTimeout(r, 1000));
    const { ok: mergeOk } = await retryOnServerError(
      () => ghApi('PUT', `/repos/${ORG}/${repoName}/pulls/${prData.number}/merge`, {
        merge_method: 'squash',
        commit_title: prTitle,
      }),
    );

    if (mergeOk) {
      log(`  Merge: ✓ squash merged`);
      // Dispatch workflow for index rebuild
      await new Promise(r => setTimeout(r, 1000));
      const { ok: dispatchOk } = await retryOnServerError(
        () => ghApi('POST', `/repos/${ORG}/${repoName}/actions/workflows/validate.yml/dispatches`, {
          ref: 'master',
        }),
      );
      log(`  CI: ${dispatchOk ? '✓ index build dispatched' : '⚠ could not dispatch'}`);
    } else {
      const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, repoName, prData.number);
      log(`  Merge: ⚠ direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
    }

    results.push({
      letter,
      status: 'success',
      count: people.length,
      repo: repoName,
      pr: `${repoName}#${prData.number}`,
    });

  } catch (err) {
    log(`  ⚠ ERROR: ${err.message}`);
    results.push({ letter, status: 'error', count: people.length, error: err.message });
  }

  // Brief delay between letter repos
  letterProgress.tick(`Letter ${letter.toUpperCase()}`);
  await new Promise(r => setTimeout(r, 2000));
}

// ─── Final summary ───────────────────────────────────────────────────────────

letterProgress.done();

const totalDuration = Date.now() - startedAt;
const successCount = results.filter(r => r.status === 'success').length;
const errorCount = results.filter(r => r.status === 'error').length;
const skippedCount = results.filter(r => r.status === 'skipped').length;
const peopleMigrated = results
  .filter(r => r.status === 'success')
  .reduce((sum, r) => sum + r.count, 0);

log('');
log('═══════════════════════════════════════════');
log('PEOPLE SPLIT COMPLETE');
log('───────────────────────────────────────────');
log(`Letters processed: ${successCount} success, ${errorCount} errors, ${skippedCount} skipped`);
log(`People migrated: ${peopleMigrated.toLocaleString()} / ${allPeople.size.toLocaleString()}`);
log(`Duration: ${formatDuration(totalDuration)}`);
log('═══════════════════════════════════════════');

if (errorCount > 0) {
  log('');
  log('Failed letters (re-run with --letters= to retry):');
  for (const r of results.filter(r => r.status === 'error')) {
    log(`  ${r.letter.toUpperCase()} — ${r.error}`);
  }
}

// ─── Write summary JSON ──────────────────────────────────────────────────────

const summaryPath = resolve(__dirname, 'split-people-results.json');
const summary = {
  mode: 'execute',
  startedAt: new Date(startedAt).toISOString(),
  completedAt: new Date().toISOString(),
  source: SOURCE_REPO,
  totalPeople: allPeople.size,
  peopleMigrated,
  targetLetters,
  totals: {
    success: successCount,
    errors: errorCount,
    skipped: skippedCount,
    duration: formatDuration(totalDuration),
  },
  distribution: Object.fromEntries(
    sortedLetters.map(l => [l, distribution.get(l).length])
  ),
  results,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
log(`\nSummary written to: ${summaryPath}`);
