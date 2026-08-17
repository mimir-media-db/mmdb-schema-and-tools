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

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const ORG = 'mimir-media-db';
const LABEL_LANGUAGES = 'en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru';
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_RATE_LIMIT_MS = 500;
const MAX_RESULTS_SANITY = 3000;
const QID_PATTERN = /^Q\d+$/i;

/**
 * Determines whether a title is usable for ingestion.
 * Rejects Wikidata Q-IDs and titles that would produce an empty/unusable slug.
 */
function isUsableTitle(title) {
  if (!title) return false;
  if (QID_PATTERN.test(title)) return false;
  const slug = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').trim();
  return slug.length >= 2;
}

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

try {
  const auth = await loadGitHubAuth(envPath);
  token = auth.token;
  authMethod = auth.method;
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

const headers = token ? {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} : {};

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function ghApi(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function ghGraphQL(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function getDefaultBranchSha(repo) {
  const { data } = await ghApi('GET', `/repos/${ORG}/${repo}/git/ref/heads/master`);
  return data.object.sha;
}

async function createBranch(repo, branchName, sha) {
  return ghApi('POST', `/repos/${ORG}/${repo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha,
  });
}

async function createOrUpdateFile(repo, branch, path, content, message) {
  // Check if file already exists on branch
  let sha;
  try {
    const { ok, data } = await ghApi('GET', `/repos/${ORG}/${repo}/contents/${path}?ref=${branch}`);
    if (ok && data.sha) sha = data.sha;
  } catch { /* file doesn't exist */ }

  return ghApi('PUT', `/repos/${ORG}/${repo}/contents/${path}`, {
    message,
    content: Buffer.from(content).toString('base64'),
    branch,
    ...(sha && { sha }),
  });
}

async function createPR(repo, title, head, body) {
  return ghApi('POST', `/repos/${ORG}/${repo}/pulls`, {
    title,
    head,
    base: 'master',
    body,
  });
}

async function enableAutoMerge(repo, prNumber) {
  // Get PR node_id for GraphQL
  const { data: pr } = await ghApi('GET', `/repos/${ORG}/${repo}/pulls/${prNumber}`);
  if (!pr.node_id) return false;

  const result = await ghGraphQL(`
    mutation EnableAutoMerge($pullRequestId: ID!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $pullRequestId
        mergeMethod: SQUASH
      }) {
        pullRequest {
          autoMergeRequest {
            enabledAt
          }
        }
      }
    }
  `, { pullRequestId: pr.node_id });

  return !result.errors;
}

async function getExistingIds(repo, dir) {
  const { ok, data } = await ghApi('GET', `/repos/${ORG}/${repo}/contents/${dir}/index.json?ref=master`);
  if (!ok || !data.content) return new Set();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  const index = JSON.parse(content);
  return new Set(index.map(entry => entry.id));
}

async function getIdsInPendingPRs(repo, dir) {
  const ids = new Set();
  try {
    const { ok, data: prs } = await ghApi('GET', `/repos/${ORG}/${repo}/pulls?state=open`);
    if (!ok || !Array.isArray(prs)) return ids;

    for (const pr of prs) {
      const { ok: filesOk, data: files } = await ghApi('GET', `/repos/${ORG}/${repo}/pulls/${pr.number}/files`);
      if (!filesOk || !Array.isArray(files)) continue;

      for (const file of files) {
        if (file.filename.startsWith(`${dir}/`) && file.filename.endsWith('.json') && !file.filename.endsWith('index.json')) {
          // Extract ID from file content on the PR branch
          try {
            const { ok: contentOk, data: contentData } = await ghApi(
              'GET', `/repos/${ORG}/${repo}/contents/${file.filename}?ref=${pr.head.ref}`
            );
            if (contentOk && contentData.content) {
              const parsed = JSON.parse(Buffer.from(contentData.content, 'base64').toString('utf-8'));
              if (parsed.id) ids.add(parsed.id);
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }
  } catch { /* ignore PR listing errors */ }
  return ids;
}

// ─── Wikidata helpers ────────────────────────────────────────────────────────

function buildMovieQuery(targetYear, queryLimit) {
  return `
SELECT DISTINCT ?film ?filmLabel ?year ?imdb ?tmdb ?releaseDate ?runtime
WHERE {
  ?film wdt:P31 wd:Q11424.
  ?film wdt:P577 ?releaseDate.
  BIND(YEAR(?releaseDate) AS ?year)
  FILTER(?year = ${targetYear})

  OPTIONAL { ?film wdt:P345 ?imdb. }
  OPTIONAL { ?film wdt:P4947 ?tmdb. }
  OPTIONAL { ?film wdt:P2047 ?runtime. }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}". }
}
ORDER BY ?releaseDate
LIMIT ${queryLimit}
`.trim();
}

function buildSeriesQuery(targetYear, queryLimit) {
  return `
SELECT DISTINCT ?series ?seriesLabel ?startDate ?endDate ?imdb ?tmdb ?seasons ?episodes
WHERE {
  ?series wdt:P31 wd:Q5398426.
  ?series wdt:P580 ?startDate.

  BIND(YEAR(?startDate) as ?startYear)
  FILTER(?startYear = ${targetYear})

  OPTIONAL { ?series wdt:P582 ?endDate. }
  OPTIONAL { ?series wdt:P345 ?imdb. }
  OPTIONAL { ?series wdt:P4983 ?tmdb. }
  OPTIONAL { ?series wdt:P2437 ?seasons. }
  OPTIONAL { ?series wdt:P1113 ?episodes. }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}". }
}
ORDER BY ?seriesLabel
LIMIT ${queryLimit}
`.trim();
}

async function queryWikidata(sparql) {
  await new Promise(r => setTimeout(r, WIKIDATA_RATE_LIMIT_MS));

  const response = await fetch(WIKIDATA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MMDB-Ingestion/1.0.0 (https://github.com/mimir-media-db)',
    },
    body: `query=${encodeURIComponent(sparql)}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Wikidata query failed: ${response.status} ${response.statusText}\n${text.slice(0, 500)}`);
  }

  return response.json();
}

function parseMovieResults(results) {
  const movies = [];
  for (const binding of results.results.bindings) {
    const wikidataId = binding.film.value.split('/').pop();
    movies.push({
      label: binding.filmLabel?.value || 'Unknown',
      year: parseInt(binding.year?.value || '0'),
      imdbId: binding.imdb?.value,
      tmdbId: binding.tmdb?.value ? parseInt(binding.tmdb.value) : undefined,
      wikidataId,
      releaseDate: binding.releaseDate?.value?.split('T')[0],
      runtime: binding.runtime?.value ? parseInt(binding.runtime.value) : undefined,
    });
  }
  return movies;
}

function parseSeriesResults(results) {
  const series = [];
  for (const binding of results.results.bindings) {
    const wikidataId = binding.series.value.split('/').pop();
    series.push({
      label: binding.seriesLabel?.value || 'Unknown',
      startYear: binding.startDate?.value ? new Date(binding.startDate.value).getFullYear() : 0,
      endYear: binding.endDate?.value ? new Date(binding.endDate.value).getFullYear() : undefined,
      imdbId: binding.imdb?.value,
      tmdbId: binding.tmdb?.value ? parseInt(binding.tmdb.value) : undefined,
      wikidataId,
      totalSeasons: binding.seasons?.value ? parseInt(binding.seasons.value) : undefined,
      totalEpisodes: binding.episodes?.value ? parseInt(binding.episodes.value) : undefined,
    });
  }
  return series;
}

// ─── Normalization (mirrors functions/src/ingestion/normalizer.ts) ───────────

function generateSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim()
    .replace(/\s+/g, '_');
}

function generateMovieId(title, movieYear) {
  return `m_${generateSlug(title)}_${movieYear}`;
}

function generateSeriesId(title) {
  return `s_${generateSlug(title)}`;
}

function normalizeMovie(wikiMovie) {
  const id = generateMovieId(wikiMovie.label, wikiMovie.year);
  const today = new Date().toISOString().split('T')[0];

  const movie = {
    schema_version: 1,
    id,
    title: wikiMovie.label,
    year: wikiMovie.year,
    type: 'movie',
    external_ids: {
      wikidata: wikiMovie.wikidataId,
    },
    last_updated: today,
  };

  if (wikiMovie.releaseDate) movie.release_date = wikiMovie.releaseDate;
  if (wikiMovie.runtime) movie.runtime_minutes = wikiMovie.runtime;
  if (wikiMovie.imdbId) movie.external_ids.imdb = wikiMovie.imdbId;
  if (wikiMovie.tmdbId) movie.external_ids.tmdb = wikiMovie.tmdbId;

  return movie;
}

function normalizeSeries(wikiSeries) {
  const id = generateSeriesId(wikiSeries.label);
  const today = new Date().toISOString().split('T')[0];

  const series = {
    schema_version: 1,
    id,
    title: wikiSeries.label,
    start_year: wikiSeries.startYear,
    end_year: wikiSeries.endYear || null,
    external_ids: {
      wikidata: wikiSeries.wikidataId,
    },
    last_updated: today,
  };

  if (wikiSeries.totalSeasons) series.total_seasons = wikiSeries.totalSeasons;
  if (wikiSeries.totalEpisodes) series.total_episodes = wikiSeries.totalEpisodes;
  if (wikiSeries.imdbId) series.external_ids.imdb = wikiSeries.imdbId;
  if (wikiSeries.tmdbId) series.external_ids.tmdb = wikiSeries.tmdbId;

  return series;
}

function getMovieFilePath(movie) {
  const slug = generateSlug(movie.title);
  return `data/movies/${slug}-${movie.year}.json`;
}

function getSeriesFilePath(series) {
  const slug = generateSlug(series.title);
  return `data/series/${slug}.json`;
}

// ─── Batch Commit (Git Trees API) ────────────────────────────────────────────

const MAX_TREE_BATCH_SIZE = 400;

/**
 * Commit a batch of files in a single commit using the Git Trees API.
 */
async function commitBatch(targetRepo, branch, files, message) {
  if (files.length === 0) return;

  // Sub-batch if too large
  if (files.length > MAX_TREE_BATCH_SIZE) {
    const subBatches = [];
    for (let i = 0; i < files.length; i += MAX_TREE_BATCH_SIZE) {
      subBatches.push(files.slice(i, i + MAX_TREE_BATCH_SIZE));
    }
    for (let i = 0; i < subBatches.length; i++) {
      const batchMsg = subBatches.length > 1 ? `${message} (${i + 1}/${subBatches.length})` : message;
      await commitBatchInternal(targetRepo, branch, subBatches[i], batchMsg);
      if (i < subBatches.length - 1) await new Promise(r => setTimeout(r, 200));
    }
    return;
  }

  await commitBatchInternal(targetRepo, branch, files, message);
}

async function commitBatchInternal(targetRepo, branch, files, message) {
  // 1. Get branch ref → commit SHA
  const { data: refData } = await ghApi('GET', `/repos/${ORG}/${targetRepo}/git/ref/heads/${branch}`);
  const commitSha = refData.object.sha;
  await new Promise(r => setTimeout(r, 200));

  // 2. Get commit → tree SHA
  const { data: commitData } = await ghApi('GET', `/repos/${ORG}/${targetRepo}/git/commits/${commitSha}`);
  const baseTreeSha = commitData.tree.sha;
  await new Promise(r => setTimeout(r, 200));

  // 3. Create tree with all files
  const tree = files.map(f => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    content: f.content,
  }));

  const { data: treeData } = await ghApi('POST', `/repos/${ORG}/${targetRepo}/git/trees`, {
    base_tree: baseTreeSha,
    tree,
  });
  await new Promise(r => setTimeout(r, 200));

  // 4. Create commit
  const { data: newCommit } = await ghApi('POST', `/repos/${ORG}/${targetRepo}/git/commits`, {
    message,
    tree: treeData.sha,
    parents: [commitSha],
  });
  await new Promise(r => setTimeout(r, 200));

  // 5. Update branch ref
  await ghApi('PATCH', `/repos/${ORG}/${targetRepo}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
  });
  await new Promise(r => setTimeout(r, 200));
}

/**
 * Group items by first letter of their slug (after stripping m_, s_ prefix).
 */
function groupByFirstLetter(items) {
  const groups = new Map();
  for (const item of items) {
    const slug = item.id.replace(/^[msp]_/, '');
    const letter = (slug[0] || '#').toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(item);
  }
  return groups;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const repo = `mmdb-${year}`;
const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

console.log(`\nRescanning year ${year}${dryRun ? ' (DRY RUN)' : ''}...`);

// ─── Query Wikidata for films ────────────────────────────────────────────────

console.log(`Querying Wikidata for films (year=${year}, limit=${limit})...`);
const movieSparql = buildMovieQuery(year, limit);
const movieResults = await queryWikidata(movieSparql);
const rawMovies = parseMovieResults(movieResults);

if (rawMovies.length >= MAX_RESULTS_SANITY) {
  console.error(`\n⚠ ABORT: Got ${rawMovies.length} results — exceeds sanity limit of ${MAX_RESULTS_SANITY}.`);
  console.error('This likely indicates a bad query. Try reducing --limit.');
  process.exit(1);
}

console.log(`Found ${rawMovies.length} films in Wikidata`);

// Filter unusable entries (Q-IDs, non-Latin only, etc.)
const unusableMovies = rawMovies.filter(m => !isUsableTitle(m.label));
const validMovies = rawMovies.filter(m => isUsableTitle(m.label));
console.log(`Rejected ${unusableMovies.length} unusable entries (Q-IDs, non-Latin titles, etc.)`);

// ─── Query Wikidata for series (optional) ────────────────────────────────────

let rawSeries = [];
let qidSeries = [];
let validSeries = [];

if (includeSeries) {
  console.log(`Querying Wikidata for series (year=${year}, limit=${limit})...`);
  const seriesSparql = buildSeriesQuery(year, limit);
  const seriesResults = await queryWikidata(seriesSparql);
  rawSeries = parseSeriesResults(seriesResults);

  if (rawSeries.length >= MAX_RESULTS_SANITY) {
    console.error(`\n⚠ ABORT: Got ${rawSeries.length} series results — exceeds sanity limit of ${MAX_RESULTS_SANITY}.`);
    process.exit(1);
  }

  console.log(`Found ${rawSeries.length} series in Wikidata`);

  qidSeries = rawSeries.filter(s => !isUsableTitle(s.label));
  validSeries = rawSeries.filter(s => isUsableTitle(s.label));
  console.log(`Rejected ${qidSeries.length} unusable series entries`);
}

// ─── Deduplicate against existing ────────────────────────────────────────────

console.log(`Checking existing in ${repo} (master + pending PRs)...`);

// Get existing movie IDs from master index + pending PRs
const existingMovieIds = await getExistingIds(repo, 'data/movies');
const pendingMovieIds = await getIdsInPendingPRs(repo, 'data/movies');
const allKnownMovieIds = new Set([...existingMovieIds, ...pendingMovieIds]);

// Normalize valid movies and deduplicate
const newMovies = [];
const duplicateMovieCount = { value: 0 };

for (const wikiMovie of validMovies) {
  const normalized = normalizeMovie(wikiMovie);
  if (allKnownMovieIds.has(normalized.id)) {
    duplicateMovieCount.value++;
  } else {
    newMovies.push(normalized);
    allKnownMovieIds.add(normalized.id); // prevent intra-batch duplicates
  }
}

console.log(`Already stored: ${duplicateMovieCount.value}`);
console.log(`New films to add: ${newMovies.length}`);

// Deduplicate series
let newSeries = [];
let duplicateSeriesCount = 0;

if (includeSeries) {
  const existingSeriesIds = await getExistingIds(repo, 'data/series');
  const pendingSeriesIds = await getIdsInPendingPRs(repo, 'data/series');
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

  console.log(`Already stored series: ${duplicateSeriesCount}`);
  console.log(`New series to add: ${newSeries.length}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────

const totalNew = newMovies.length + newSeries.length;

if (totalNew === 0) {
  console.log('\nNo new entries to add. Everything is up to date.');
  process.exit(0);
}

if (newMovies.length > 0) {
  console.log(`\nNew films:`);
  for (const movie of newMovies.slice(0, 50)) {
    console.log(`  - ${movie.title} (${movie.id})`);
  }
  if (newMovies.length > 50) {
    console.log(`  ... and ${newMovies.length - 50} more`);
  }
}

if (newSeries.length > 0) {
  console.log(`\nNew series:`);
  for (const s of newSeries.slice(0, 50)) {
    console.log(`  - ${s.title} (${s.id})`);
  }
  if (newSeries.length > 50) {
    console.log(`  ... and ${newSeries.length - 50} more`);
  }
}

// ─── Dry run exit ────────────────────────────────────────────────────────────

if (dryRun) {
  const parts = [];
  if (newMovies.length > 0) parts.push(`${newMovies.length} new movies`);
  if (newSeries.length > 0) parts.push(`${newSeries.length} new series`);
  console.log(`\n[DRY RUN] Would create PR with ${parts.join(' and ')}`);
  process.exit(0);
}

// ─── Create branch and PR ────────────────────────────────────────────────────

const branchName = `mmdb-ingest/rescan-${year}-${runDate}`;
console.log(`\nCreating branch: ${branchName}`);

const masterSha = await getDefaultBranchSha(repo);
const { ok: branchOk } = await createBranch(repo, branchName, masterSha);
if (!branchOk) {
  console.error('Failed to create branch. It may already exist.');
  process.exit(1);
}

// Add movies in batches by first letter
if (newMovies.length > 0) {
  console.log(`Adding ${newMovies.length} movies in batches...`);
  const movieGroups = groupByFirstLetter(newMovies);
  let movieCount = 0;
  for (const [letter, group] of movieGroups) {
    try {
      const files = group.map(movie => ({
        path: getMovieFilePath(movie),
        content: JSON.stringify(movie, null, 2) + '\n',
      }));
      await commitBatch(repo, branchName, files, `ingest: add ${group.length} movies (${letter})`);
      movieCount += group.length;
      process.stdout.write(`[${letter}:${group.length}] `);
    } catch (err) {
      console.warn(`\n  Warning: batch ${letter} failed: ${err.message}`);
    }
  }
  console.log(`\nAdded ${movieCount} movies in ${movieGroups.size} commits`);
}

// Add series in batches by first letter
if (newSeries.length > 0) {
  console.log(`Adding ${newSeries.length} series in batches...`);
  const seriesGroups = groupByFirstLetter(newSeries);
  let seriesCount = 0;
  for (const [letter, group] of seriesGroups) {
    try {
      const files = group.map(s => ({
        path: getSeriesFilePath(s),
        content: JSON.stringify(s, null, 2) + '\n',
      }));
      await commitBatch(repo, branchName, files, `ingest: add ${group.length} series (${letter})`);
      seriesCount += group.length;
      process.stdout.write(`[${letter}:${group.length}] `);
    } catch (err) {
      console.warn(`\n  Warning: series batch ${letter} failed: ${err.message}`);
    }
  }
  console.log(`\nAdded ${seriesCount} series in ${seriesGroups.size} commits`);
}

// Create PR
console.log('Creating pull request...');

const prParts = [];
if (newMovies.length > 0) prParts.push(`${newMovies.length} movies`);
if (newSeries.length > 0) prParts.push(`${newSeries.length} series`);
const prTitle = `ingest: add ${prParts.join(' + ')} (${year} rescan)`;

const prBody = [
  `## Year ${year} Rescan`,
  '',
  `Re-scanned Wikidata for films${includeSeries ? '/series' : ''} released in ${year} that were missed during the original backlog ingestion.`,
  '',
  '### Summary',
  '',
  `| Metric | Count |`,
  `|--------|-------|`,
  `| Films found in Wikidata | ${rawMovies.length} |`,
  includeSeries ? `| Series found in Wikidata | ${rawSeries.length} |` : null,
  `| Q-ID entries rejected | ${unusableMovies.length + qidSeries.length} |`,
  `| Already stored | ${duplicateMovieCount.value + duplicateSeriesCount} |`,
  `| New movies added | ${newMovies.length} |`,
  includeSeries ? `| New series added | ${newSeries.length} |` : null,
  '',
  '### New entries',
  '',
  ...newMovies.slice(0, 30).map(m => `- ${m.title} (${m.year}) — \`${m.id}\``),
  newMovies.length > 30 ? `- ... and ${newMovies.length - 30} more movies` : null,
  ...newSeries.slice(0, 20).map(s => `- ${s.title} — \`${s.id}\``),
  newSeries.length > 20 ? `- ... and ${newSeries.length - 20} more series` : null,
].filter(line => line !== null).join('\n');

const { ok: prOk, data: prData } = await createPR(repo, prTitle, branchName, prBody);

if (!prOk) {
  console.error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
  process.exit(1);
}

console.log(`✓ PR created: ${repo}#${prData.number}`);

// Enable auto-merge
const autoMergeOk = await enableAutoMerge(repo, prData.number);
if (autoMergeOk) {
  console.log('✓ Auto-merge enabled');
} else {
  console.log('⚠ Could not enable auto-merge (may need manual merge)');
}

// ─── Final summary ───────────────────────────────────────────────────────────

const totalRejected = qidMovies.length + qidSeries.length;
const totalDuplicates = duplicateMovieCount.value + duplicateSeriesCount;
console.log(`\nDone. ${totalNew} entries added, ${totalRejected} Q-IDs rejected, ${totalDuplicates} duplicates skipped.`);
