#!/usr/bin/env node

/**
 * MMDB Bulk Fill Script
 *
 * Bulk-fills the entire MMDB by running rescan-year for every year from a
 * start to end range. Creates year repos if they don't exist. Provides
 * detailed logging and error recovery.
 *
 * Usage:
 *   node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series
 *   node scripts/bulk-fill.mjs --from=2000 --to=2010
 *   node scripts/bulk-fill.mjs --from=1920 --to=2026 --dry-run
 *   node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series --resume
 *
 * Flags:
 *   --from=YYYY       Start year (required)
 *   --to=YYYY         End year (required)
 *   --include-series  Include series (passed to rescan)
 *   --dry-run         Show plan without executing
 *   --resume          Skip years with existing rescan branches
 *   --delay=N         Seconds between years (default: 10)
 *   --limit=N         Page size for paginated Wikidata queries (default: 2000)
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 */

import { resolve, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createProgress } from './lib/progress.mjs';
import {
  rescanYear,
  repoExists,
  hasRecentRescanBranch,
  createYearRepo,
  createGitHubClient,
} from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse arguments ─────────────────────────────────────────────────────────

const fromFlag = process.argv.find(a => a.startsWith('--from='));
const toFlag = process.argv.find(a => a.startsWith('--to='));
const delayFlag = process.argv.find(a => a.startsWith('--delay='));
const limitFlag = process.argv.find(a => a.startsWith('--limit='));
const dryRun = process.argv.includes('--dry-run');
const includeSeries = process.argv.includes('--include-series');
const resume = process.argv.includes('--resume');

if (!fromFlag || !toFlag) {
  console.error(`
Usage: node scripts/bulk-fill.mjs --from=<YYYY> --to=<YYYY> [options]

Options:
  --from=YYYY        Start year (required)
  --to=YYYY          End year (required)
  --include-series   Also rescan series for each year
  --dry-run          Show plan without executing
  --resume           Skip years that already have a recent rescan branch
  --delay=N          Seconds to wait between years (default: 10)
  --limit=N          Page size for paginated Wikidata queries (default: 2000)

Examples:
  node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series
  node scripts/bulk-fill.mjs --from=2000 --to=2010
  node scripts/bulk-fill.mjs --from=1920 --to=2026 --dry-run
  node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series --resume
`);
  process.exit(1);
}

const fromYear = parseInt(fromFlag.split('=')[1]);
const toYear = parseInt(toFlag.split('=')[1]);
const delay = delayFlag ? parseInt(delayFlag.split('=')[1]) : 10;
const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : 2000;

if (isNaN(fromYear) || fromYear < 1888 || fromYear > 2100) {
  console.error(`Error: Invalid --from year. Must be between 1888 and 2100.`);
  process.exit(1);
}

if (isNaN(toYear) || toYear < 1888 || toYear > 2100) {
  console.error(`Error: Invalid --to year. Must be between 1888 and 2100.`);
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
if (includeSeries) options.push('include-series');
if (resume) options.push('resume');
if (dryRun) options.push('dry-run');
options.push(`delay=${delay}s`);
options.push(`limit=${limit}`);

log('═══════════════════════════════════════════');
log(`MMDB Bulk Fill: ${fromYear} → ${toYear} (${totalYears} years)`);
log(`Options: ${options.join(', ')}`);
if (authMethod) log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════');

const results = [];
let reposCreated = 0;
let prsCreated = 0;
let totalMovies = 0;
let totalSeries = 0;
const failedYears = [];
const skippedYears = [];

const { ghApi } = token ? createGitHubClient(tokenManager || token) : { ghApi: null };

const yearProgress = createProgress(totalYears, 'Years');

for (let i = 0; i < totalYears; i++) {
  const year = fromYear + i;
  const repo = `mmdb-${year}`;
  const yearStart = Date.now();

  log('');
  log(`── Year ${year} (${i + 1}/${totalYears}) ──────────────────────`);

  try {
    // ─── Resume check ────────────────────────────────────────────────────────

    if (resume && !dryRun && ghApi) {
      const hasBranch = await hasRecentRescanBranch(ghApi, repo, year);
      if (hasBranch) {
        log(`Skipped: recent rescan branch exists`);
        skippedYears.push(year);
        results.push({ year, status: 'skipped', reason: 'recent rescan branch exists' });
        continue;
      }
    }

    // ─── Dry run mode ────────────────────────────────────────────────────────

    if (dryRun) {
      log(`Repo: ${repo} (would check/create)`);
      log(`Would rescan year ${year} (limit=${limit}${includeSeries ? ', include-series' : ''})`);
      results.push({ year, status: 'dry-run' });
      continue;
    }

    // ─── Check/create repo ───────────────────────────────────────────────────

    const exists = await repoExists(ghApi, repo);
    if (exists) {
      log(`Repo: ${repo} ✓ exists`);
    } else {
      log(`Repo: ${repo} ✗ not found → creating...`);
      await createYearRepo(ghApi, year);
      log(`Repo: ${repo} ✓ created`);
      reposCreated++;
    }

    // ─── Run rescan ──────────────────────────────────────────────────────────

    const result = await rescanYear({
      year,
      repo,
      token: tokenManager || token,
      limit,
      includeSeries,
      dryRun: false,
      log,
    });

    const duration = Date.now() - yearStart;
    log(`Duration: ${formatDuration(duration)}`);

    if (result.pr) {
      prsCreated++;
    }
    totalMovies += result.movies;
    totalSeries += result.series;

    results.push({
      year,
      status: 'success',
      movies: result.movies,
      series: result.series,
      pr: result.pr,
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
    log(`Waiting ${delay}s...`);
    await new Promise(r => setTimeout(r, delay * 1000));
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
log('BULK FILL COMPLETE');
log('───────────────────────────────────────────');
log(`Years processed: ${successCount}/${totalYears}`);
if (skipCount > 0) {
  log(`Years skipped (resume): ${skipCount} [${skippedYears.join(', ')}]`);
}
if (errorCount > 0) {
  log(`Years skipped (error): ${errorCount} [${failedYears.map(f => f.year).join(', ')}]`);
}
log(`Repos created: ${reposCreated}`);
log(`PRs created: ${prsCreated}`);
log(`Total movies added: ${totalMovies.toLocaleString()}`);
log(`Total series added: ${totalSeries.toLocaleString()}`);
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

const summaryPath = resolve(__dirname, 'bulk-fill-results.json');
const summary = {
  startedAt,
  completedAt,
  range: { from: fromYear, to: toYear },
  options: { includeSeries, resume, delay, limit, dryRun },
  totals: {
    years: totalYears,
    success: successCount,
    errors: errorCount,
    skipped: skipCount,
    reposCreated,
    prsCreated,
    moviesAdded: totalMovies,
    seriesAdded: totalSeries,
    duration: formatDuration(totalDuration),
  },
  results,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
log('');
log(`Summary written to: ${summaryPath}`);
