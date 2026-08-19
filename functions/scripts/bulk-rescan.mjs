#!/usr/bin/env node

/**
 * MMDB Bulk Rescan Script (Paginated)
 *
 * Rescans Wikidata for all movies/series across a year range using paginated
 * queries. Unlike bulk-fill.mjs, this script:
 * - Uses OFFSET pagination to fetch ALL results (not just first 2000)
 * - Assumes repos already exist (does not create them)
 * - Reports gaps found per year
 *
 * Usage:
 *   node scripts/bulk-rescan.mjs --from=2010 --to=2026 --include-series
 *   node scripts/bulk-rescan.mjs --year=2020
 *   node scripts/bulk-rescan.mjs --from=2010 --to=2026 --dry-run
 *   node scripts/bulk-rescan.mjs --from=2010 --to=2026 --include-series --resume
 *
 * Flags:
 *   --from=YYYY       Start year (required unless --year)
 *   --to=YYYY         End year (required unless --year)
 *   --year=YYYY       Single year shorthand (sets from=to=year)
 *   --include-series  Include series in rescan
 *   --dry-run         Show plan without executing
 *   --resume          Skip years with existing rescan branches
 *   --delay=N         Seconds between years (default: 10)
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
  ORG,
  buildMovieQuery,
  buildSeriesQuery,
  queryWikidataPaginated,
  parseMovieResults,
  parseSeriesResults,
  isUsableTitle,
  normalizeMovie,
  normalizeSeries,
  getMovieFilePath,
  getSeriesFilePath,
  getExistingIds,
  getIdsInPendingPRs,
  getDefaultBranchSha,
  createBranch,
  createPR,
  enableAutoMerge,
  commitBatch,
  groupByFirstLetter,
  repoExists,
  hasRecentRescanBranch,
  createGitHubClient,
  retryOnServerError,
  GITHUB_RATE_LIMIT_MS,
} from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Parse arguments ─────────────────────────────────────────────────────────

const yearFlag = process.argv.find(a => a.startsWith('--year='));
const fromFlag = process.argv.find(a => a.startsWith('--from='));
const toFlag = process.argv.find(a => a.startsWith('--to='));
const delayFlag = process.argv.find(a => a.startsWith('--delay='));
const dryRun = process.argv.includes('--dry-run');
const includeSeries = process.argv.includes('--include-series');
const resume = process.argv.includes('--resume');

let fromYear, toYear;

if (yearFlag) {
  fromYear = toYear = parseInt(yearFlag.split('=')[1]);
} else if (fromFlag && toFlag) {
  fromYear = parseInt(fromFlag.split('=')[1]);
  toYear = parseInt(toFlag.split('=')[1]);
} else {
  console.error(`
Usage: node scripts/bulk-rescan.mjs --from=<YYYY> --to=<YYYY> [options]
       node scripts/bulk-rescan.mjs --year=<YYYY> [options]

Options:
  --from=YYYY        Start year (required unless --year)
  --to=YYYY          End year (required unless --year)
  --year=YYYY        Single year shorthand (sets from=to=year)
  --include-series   Also rescan series for each year
  --dry-run          Show plan without executing
  --resume           Skip years that already have a recent rescan branch
  --delay=N          Seconds to wait between years (default: 10)

Examples:
  node scripts/bulk-rescan.mjs --from=2010 --to=2026 --include-series
  node scripts/bulk-rescan.mjs --year=2020
  node scripts/bulk-rescan.mjs --from=2010 --to=2026 --dry-run
  node scripts/bulk-rescan.mjs --from=2010 --to=2026 --include-series --resume
`);
  process.exit(1);
}

const delay = delayFlag ? parseInt(delayFlag.split('=')[1]) : 10;

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

// ─── Paginated rescan for a single year ──────────────────────────────────────

const PAGE_SIZE = 2000;

async function rescanYearPaginated({ year, repo, ghApi, ghGraphQL, dryRun: isDryRun, includeSeries: doSeries, log: yearLog }) {
  const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

  // ─── Paginated movie query ─────────────────────────────────────────────────

  yearLog(`Querying Wikidata for movies (paginated, pageSize=${PAGE_SIZE})...`);
  const movieQueryBuilder = (offset, limit) => buildMovieQuery(year, limit, offset);
  const movieData = await queryWikidataPaginated(movieQueryBuilder, PAGE_SIZE, yearLog);
  const rawMovies = parseMovieResults(movieData);

  yearLog(`Movies: ${movieData.total} total across ${movieData.pages} page(s)`);

  const unusableMovies = rawMovies.filter(m => !isUsableTitle(m.label));
  const validMovies = rawMovies.filter(m => isUsableTitle(m.label));

  // ─── Paginated series query (optional) ─────────────────────────────────────

  let rawSeries = [];
  let qidSeries = [];
  let validSeries = [];
  let seriesPages = 0;

  if (doSeries) {
    yearLog(`Querying Wikidata for series (paginated, pageSize=${PAGE_SIZE})...`);
    const seriesQueryBuilder = (offset, limit) => buildSeriesQuery(year, limit, offset);
    const seriesData = await queryWikidataPaginated(seriesQueryBuilder, PAGE_SIZE, yearLog);
    rawSeries = parseSeriesResults(seriesData);
    seriesPages = seriesData.pages;

    yearLog(`Series: ${seriesData.total} total across ${seriesData.pages} page(s)`);

    qidSeries = rawSeries.filter(s => !isUsableTitle(s.label));
    validSeries = rawSeries.filter(s => isUsableTitle(s.label));
  }

  // ─── Deduplicate against existing ──────────────────────────────────────────

  const existingMovieIds = await getExistingIds(ghApi, repo, 'data/movies');
  const pendingMovieIds = await getIdsInPendingPRs(ghApi, repo, 'data/movies');
  const allKnownMovieIds = new Set([...existingMovieIds, ...pendingMovieIds]);

  const newMovies = [];
  let duplicateMovieCount = 0;

  for (const wikiMovie of validMovies) {
    const normalized = normalizeMovie(wikiMovie);
    if (allKnownMovieIds.has(normalized.id)) {
      duplicateMovieCount++;
    } else {
      newMovies.push(normalized);
      allKnownMovieIds.add(normalized.id);
    }
  }

  let newSeries = [];
  let duplicateSeriesCount = 0;

  if (doSeries) {
    const existingSeriesIds = await getExistingIds(ghApi, repo, 'data/series');
    const pendingSeriesIds = await getIdsInPendingPRs(ghApi, repo, 'data/series');
    const allKnownSeriesIds = new Set([...existingSeriesIds, ...pendingSeriesIds]);

    for (const wikiS of validSeries) {
      const normalized = normalizeSeries(wikiS);
      if (allKnownSeriesIds.has(normalized.id)) {
        duplicateSeriesCount++;
      } else {
        newSeries.push(normalized);
        allKnownSeriesIds.add(normalized.id);
      }
    }
  }

  const totalRejected = unusableMovies.length + qidSeries.length;
  const totalDuplicates = duplicateMovieCount + duplicateSeriesCount;
  const totalNew = newMovies.length + newSeries.length;

  yearLog(`Filtered: ${totalRejected} unusable rejected`);
  yearLog(`Dedup: ${totalDuplicates} existing, ${totalNew} new`);

  const result = {
    year,
    totalFound: rawMovies.length + rawSeries.length,
    moviePages: movieData.pages,
    seriesPages,
    moviesFound: rawMovies.length,
    seriesFound: rawSeries.length,
    rejected: totalRejected,
    duplicates: totalDuplicates,
    newMovies: newMovies.length,
    newSeries: newSeries.length,
  };

  if (totalNew === 0) {
    yearLog(`No new entries to add.`);
    return { ...result, status: 'success', pr: null };
  }

  if (isDryRun) {
    yearLog(`[DRY RUN] Would add ${newMovies.length} movies + ${newSeries.length} series`);
    return { ...result, status: 'dry-run', pr: null };
  }

  // ─── Create branch and commit ──────────────────────────────────────────────

  const branchName = `mmdb-ingest/rescan-${year}-${runDate}`;
  const masterSha = await getDefaultBranchSha(ghApi, repo);
  if (!masterSha) {
    throw new Error(`Could not get master SHA for ${repo}`);
  }

  const { ok: branchOk } = await createBranch(ghApi, repo, branchName, masterSha);
  if (!branchOk) {
    throw new Error(`Failed to create branch ${branchName} — may already exist`);
  }

  // Add movies in batches by first letter
  if (newMovies.length > 0) {
    yearLog(`Adding ${newMovies.length} movies in batches...`);
    const movieGroups = groupByFirstLetter(newMovies);
    let movieCount = 0;
    for (const [letter, group] of movieGroups) {
      const files = group.map(movie => ({
        path: getMovieFilePath(movie),
        content: JSON.stringify(movie, null, 2) + '\n',
      }));
      await commitBatch(ghApi, repo, branchName, files, `ingest: add ${group.length} movies (${letter})`);
      movieCount += group.length;
      process.stdout.write(`[${letter}:${group.length}] `);
    }
    process.stdout.write('\n');
    yearLog(`Added ${movieCount} movies in ${movieGroups.size} commits`);
  }

  // Add series in batches by first letter
  if (newSeries.length > 0) {
    yearLog(`Adding ${newSeries.length} series in batches...`);
    const seriesGroups = groupByFirstLetter(newSeries);
    let seriesCount = 0;
    for (const [letter, group] of seriesGroups) {
      const files = group.map(s => ({
        path: getSeriesFilePath(s),
        content: JSON.stringify(s, null, 2) + '\n',
      }));
      await commitBatch(ghApi, repo, branchName, files, `ingest: add ${group.length} series (${letter})`);
      seriesCount += group.length;
      process.stdout.write(`[${letter}:${group.length}] `);
    }
    process.stdout.write('\n');
    yearLog(`Added ${seriesCount} series in ${seriesGroups.size} commits`);
  }

  // ─── Create PR ─────────────────────────────────────────────────────────────

  const prParts = [];
  if (newMovies.length > 0) prParts.push(`${newMovies.length} movies`);
  if (newSeries.length > 0) prParts.push(`${newSeries.length} series`);
  const prTitle = `ingest: add ${prParts.join(' + ')} (${year} paginated rescan)`;

  const prBody = [
    `## Year ${year} Paginated Rescan`,
    '',
    `Re-scanned Wikidata with pagination for films${doSeries ? '/series' : ''} released in ${year}.`,
    '',
    '### Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Films found in Wikidata | ${rawMovies.length} |`,
    `| Movie pages fetched | ${movieData.pages} |`,
    doSeries ? `| Series found in Wikidata | ${rawSeries.length} |` : null,
    doSeries ? `| Series pages fetched | ${seriesPages} |` : null,
    `| Unusable entries rejected | ${totalRejected} |`,
    `| Already stored | ${totalDuplicates} |`,
    `| New movies added | ${newMovies.length} |`,
    doSeries ? `| New series added | ${newSeries.length} |` : null,
  ].filter(line => line !== null).join('\n');

  const { ok: prOk, data: prData } = await createPR(ghApi, repo, prTitle, branchName, prBody);
  if (!prOk) {
    throw new Error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
  }

  yearLog(`PR created: ${repo}#${prData.number} (${prParts.join(' + ')})`);

  // Merge directly (squash)
  try {
    await new Promise(r => setTimeout(r, 1000));
    const { ok: mergeOk } = await retryOnServerError(
      () => ghApi('PUT', `/repos/${ORG}/${repo}/pulls/${prData.number}/merge`, {
        merge_method: 'squash',
        commit_title: prTitle,
      }),
    );
    if (mergeOk) {
      yearLog(`Merge: ✓ squash merged`);
      await new Promise(r => setTimeout(r, 1000));
      const { ok: dispatchOk } = await ghApi('POST', `/repos/${ORG}/${repo}/actions/workflows/validate.yml/dispatches`, {
        ref: 'master',
      });
      yearLog(`CI: ${dispatchOk ? '✓ index build dispatched' : '⚠ could not dispatch'}`);
    } else {
      const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, repo, prData.number);
      yearLog(`Merge: ⚠ direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
    }
  } catch (err) {
    yearLog(`Merge: ⚠ ${err.message}`);
  }

  return { ...result, status: 'success', pr: `${repo}#${prData.number}` };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const totalYears = toYear - fromYear + 1;
const startedAt = new Date().toISOString();
const options = [];
if (includeSeries) options.push('include-series');
if (resume) options.push('resume');
if (dryRun) options.push('dry-run');
options.push(`delay=${delay}s`);
options.push(`pageSize=${PAGE_SIZE}`);

log('═══════════════════════════════════════════════════');
log(`MMDB Bulk Rescan (Paginated): ${fromYear} → ${toYear} (${totalYears} years)`);
log(`Options: ${options.join(', ')}`);
if (authMethod) log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════════════');

const results = [];
let prsCreated = 0;
let totalMoviesAdded = 0;
let totalSeriesAdded = 0;
let totalMoviesFound = 0;
let totalSeriesFound = 0;
let totalPagesMovie = 0;
let totalPagesSeries = 0;
const failedYears = [];
const skippedYears = [];

const { ghApi, ghGraphQL } = token ? createGitHubClient(tokenManager || token) : { ghApi: null, ghGraphQL: null };

const yearProgress = createProgress(totalYears, 'Years');

for (let i = 0; i < totalYears; i++) {
  const year = fromYear + i;
  const repo = `mmdb-${year}`;
  const yearStart = Date.now();

  log('');
  log(`── Year ${year} (${i + 1}/${totalYears}) ──────────────────────`);

  try {
    // ─── Check repo exists ───────────────────────────────────────────────────

    if (!dryRun) {
      const exists = await repoExists(ghApi, repo);
      if (!exists) {
        log(`⚠ Repo ${repo} does not exist — skipping (bulk-rescan assumes repos exist)`);
        skippedYears.push(year);
        results.push({ year, status: 'skipped', reason: 'repo does not exist' });
        continue;
      }
    }

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
      log(`Repo: ${repo} (would rescan with pagination)`);
      log(`Would paginate movies${includeSeries ? ' + series' : ''} for year ${year}`);
      results.push({ year, status: 'dry-run' });
      continue;
    }

    // ─── Run paginated rescan ────────────────────────────────────────────────

    const result = await rescanYearPaginated({
      year,
      repo,
      ghApi,
      ghGraphQL,
      dryRun: false,
      includeSeries,
      log,
    });

    const duration = Date.now() - yearStart;
    log(`Duration: ${formatDuration(duration)}`);

    if (result.pr) prsCreated++;
    totalMoviesAdded += result.newMovies;
    totalSeriesAdded += result.newSeries;
    totalMoviesFound += result.moviesFound;
    totalSeriesFound += result.seriesFound;
    totalPagesMovie += result.moviePages;
    totalPagesSeries += result.seriesPages;

    results.push(result);

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
log('═══════════════════════════════════════════════════');
log('BULK RESCAN (PAGINATED) COMPLETE');
log('───────────────────────────────────────────────────');
log(`Years processed: ${successCount}/${totalYears}`);
if (skipCount > 0) {
  log(`Years skipped: ${skipCount} [${skippedYears.join(', ')}]`);
}
if (errorCount > 0) {
  log(`Years failed: ${errorCount} [${failedYears.map(f => f.year).join(', ')}]`);
}
log(`PRs created: ${prsCreated}`);
log(`Total movies found (all pages): ${totalMoviesFound.toLocaleString()}`);
log(`Total series found (all pages): ${totalSeriesFound.toLocaleString()}`);
log(`Total movie pages fetched: ${totalPagesMovie}`);
log(`Total series pages fetched: ${totalPagesSeries}`);
log(`New movies added: ${totalMoviesAdded.toLocaleString()}`);
log(`New series added: ${totalSeriesAdded.toLocaleString()}`);
log(`Total duration: ${formatDuration(totalDuration)}`);
log('═══════════════════════════════════════════════════');

if (failedYears.length > 0) {
  log('');
  log('Failed years (re-run with --from/--to to retry):');
  for (const { year, error } of failedYears) {
    log(`  ${year} — ${error}`);
  }
}

// ─── Write summary JSON ──────────────────────────────────────────────────────

const summaryPath = resolve(__dirname, 'bulk-rescan-results.json');
const summary = {
  startedAt,
  completedAt,
  range: { from: fromYear, to: toYear },
  options: { includeSeries, resume, delay, pageSize: PAGE_SIZE, dryRun },
  totals: {
    years: totalYears,
    success: successCount,
    errors: errorCount,
    skipped: skipCount,
    prsCreated,
    moviesFound: totalMoviesFound,
    seriesFound: totalSeriesFound,
    moviePagesFetched: totalPagesMovie,
    seriesPagesFetched: totalPagesSeries,
    moviesAdded: totalMoviesAdded,
    seriesAdded: totalSeriesAdded,
    duration: formatDuration(totalDuration),
  },
  results,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
log('');
log(`Summary written to: ${summaryPath}`);
