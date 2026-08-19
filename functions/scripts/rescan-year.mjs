#!/usr/bin/env node

/**
 * MMDB Year Rescan Script
 *
 * Re-scans a specific historical year for films/series that were missed
 * during the original backlog ingestion. This catches films that were
 * added to Wikidata after the offset-based pagination already passed them.
 *
 * Usage:
 *   node functions/scripts/rescan-year.mjs --year=2010 --dry-run
 *   node functions/scripts/rescan-year.mjs --year=2010 --limit=2000
 *   node functions/scripts/rescan-year.mjs --year=2010 --include-series
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env or environment — authenticates as mimir-media-db[bot])
 *   GITHUB_TOKEN — Personal access token fallback
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { rescanYear } from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse arguments ─────────────────────────────────────────────────────────

const yearFlag = process.argv.find(a => a.startsWith('--year='));
const limitFlag = process.argv.find(a => a.startsWith('--limit='));
const dryRun = process.argv.includes('--dry-run');
const includeSeries = process.argv.includes('--include-series');

if (!yearFlag) {
  console.error(`
Usage: node functions/scripts/rescan-year.mjs --year=<YYYY> [options]

Options:
  --year=YYYY        Target year to rescan (required)
  --dry-run          Show what would be added without creating a PR
  --limit=N          Max results from Wikidata (default: 2000)
  --include-series   Also rescan series for the given year

Examples:
  node functions/scripts/rescan-year.mjs --year=2010 --dry-run
  node functions/scripts/rescan-year.mjs --year=2010 --limit=3000
  node functions/scripts/rescan-year.mjs --year=2010 --include-series
`);
  process.exit(1);
}

const year = parseInt(yearFlag.split('=')[1]);
const limit = limitFlag ? parseInt(limitFlag.split('=')[1]) : 2000;

if (isNaN(year) || year < 1888 || year > new Date().getFullYear()) {
  console.error(`Error: Invalid year "${yearFlag.split('=')[1]}". Must be between 1888 and ${new Date().getFullYear()}.`);
  process.exit(1);
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
  if (!dryRun) {
    console.error(`Auth error: ${err.message}`);
    process.exit(1);
  }
}

if (!token && !dryRun) {
  console.error('Error: No GitHub authentication configured.');
  console.error('Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID in functions/.env');
  console.error('Or set GITHUB_TOKEN as fallback.');
  process.exit(1);
}

console.log(`Auth: ${authMethod || 'none (dry-run)'}`);

// ─── Run rescan ──────────────────────────────────────────────────────────────

const repo = `mmdb-${year}`;

console.log(`\nRescanning year ${year}${dryRun ? ' (DRY RUN)' : ''}...`);
console.log(`Repo: ${repo}, Limit: ${limit}${includeSeries ? ', Include series' : ''}\n`);

try {
  const result = await rescanYear({
    year,
    repo,
    token: tokenManager || token,
    limit,
    includeSeries,
    dryRun,
    log: console.log,
  });

  const totalNew = result.movies + result.series;

  if (totalNew === 0 && !dryRun) {
    console.log('\nNo new entries to add. Everything is up to date.');
  } else if (dryRun) {
    const parts = [];
    if (result.movies > 0) parts.push(`${result.movies} new movies`);
    if (result.series > 0) parts.push(`${result.series} new series`);
    console.log(`\n[DRY RUN] Would create PR with ${parts.join(' and ')}`);
  } else {
    console.log(`\nDone. ${totalNew} entries added, ${result.rejected} rejected, ${result.duplicates} duplicates skipped.`);
  }
} catch (err) {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
