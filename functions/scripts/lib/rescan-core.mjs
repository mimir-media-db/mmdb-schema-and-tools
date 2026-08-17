/**
 * MMDB Rescan Core — Shared logic for year rescanning
 *
 * Extracted from rescan-year.mjs so both rescan-year.mjs and bulk-fill.mjs
 * can reuse the same Wikidata querying, normalization, deduplication, and
 * batch commit logic.
 *
 * @module rescan-core
 */

// ─── Constants ───────────────────────────────────────────────────────────────

export const ORG = 'mimir-media-db';
export const LABEL_LANGUAGES = 'en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru';
export const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
export const WIKIDATA_RATE_LIMIT_MS = 500;
export const GITHUB_RATE_LIMIT_MS = 200;
export const MAX_RESULTS_SANITY = 3000;
export const MAX_TREE_BATCH_SIZE = 400;

const QID_PATTERN = /^Q\d+$/i;

// ─── Title Validation ────────────────────────────────────────────────────────

/**
 * Determines whether a title is usable for ingestion.
 * Rejects Wikidata Q-IDs and titles that would produce an empty/unusable slug.
 */
export function isUsableTitle(title) {
  if (!title) return false;
  if (QID_PATTERN.test(title)) return false;
  const slug = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').trim();
  return slug.length >= 2;
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

export function createGitHubClient(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

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

  return { ghApi, ghGraphQL };
}

export async function getDefaultBranchSha(ghApi, repo) {
  // Retry up to 5 times with 2s delay — handles newly created repos where ref propagation is slow
  for (let attempt = 0; attempt < 5; attempt++) {
    const { ok, data } = await ghApi('GET', `/repos/${ORG}/${repo}/git/ref/heads/master`);
    if (ok && data.object?.sha) {
      return data.object.sha;
    }
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

export async function createBranch(ghApi, repo, branchName, sha) {
  return ghApi('POST', `/repos/${ORG}/${repo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha,
  });
}

export async function createPR(ghApi, repo, title, head, body) {
  return ghApi('POST', `/repos/${ORG}/${repo}/pulls`, {
    title,
    head,
    base: 'master',
    body,
  });
}

export async function enableAutoMerge(ghApi, ghGraphQL, repo, prNumber) {
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

export async function getExistingIds(ghApi, repo, dir) {
  const { ok, data } = await ghApi('GET', `/repos/${ORG}/${repo}/contents/${dir}/index.json?ref=master`);
  if (!ok || !data.content) return new Set();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  const index = JSON.parse(content);
  return new Set(index.map(entry => entry.id));
}

export async function getIdsInPendingPRs(ghApi, repo, dir) {
  const ids = new Set();
  try {
    const { ok, data: prs } = await ghApi('GET', `/repos/${ORG}/${repo}/pulls?state=open`);
    if (!ok || !Array.isArray(prs)) return ids;

    for (const pr of prs) {
      const { ok: filesOk, data: files } = await ghApi('GET', `/repos/${ORG}/${repo}/pulls/${pr.number}/files`);
      if (!filesOk || !Array.isArray(files)) continue;

      for (const file of files) {
        if (file.filename.startsWith(`${dir}/`) && file.filename.endsWith('.json') && !file.filename.endsWith('index.json')) {
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

export function buildMovieQuery(targetYear, queryLimit) {
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

export function buildSeriesQuery(targetYear, queryLimit) {
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

export async function queryWikidata(sparql) {
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

export function parseMovieResults(results) {
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

export function parseSeriesResults(results) {
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

// ─── Normalization ───────────────────────────────────────────────────────────

export function generateSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim()
    .replace(/\s+/g, '_');
}

export function generateMovieId(title, movieYear) {
  return `m_${generateSlug(title)}_${movieYear}`;
}

export function generateSeriesId(title) {
  return `s_${generateSlug(title)}`;
}

export function normalizeMovie(wikiMovie) {
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
  if (wikiMovie.imdbId && /^tt\d+$/.test(wikiMovie.imdbId)) movie.external_ids.imdb = wikiMovie.imdbId;
  if (wikiMovie.tmdbId) movie.external_ids.tmdb = wikiMovie.tmdbId;

  return movie;
}

export function normalizeSeries(wikiSeries) {
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
  if (wikiSeries.imdbId && /^tt\d+$/.test(wikiSeries.imdbId)) series.external_ids.imdb = wikiSeries.imdbId;
  if (wikiSeries.tmdbId) series.external_ids.tmdb = wikiSeries.tmdbId;

  return series;
}

export function getMovieFilePath(movie) {
  const slug = generateSlug(movie.title);
  return `data/movies/${slug}-${movie.year}.json`;
}

export function getSeriesFilePath(series) {
  const slug = generateSlug(series.title);
  return `data/series/${slug}.json`;
}

// ─── Batch Commit (Git Trees API) ────────────────────────────────────────────

async function commitBatchInternal(ghApi, targetRepo, branch, files, message) {
  const { data: refData } = await ghApi('GET', `/repos/${ORG}/${targetRepo}/git/ref/heads/${branch}`);
  const commitSha = refData.object.sha;
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  const { data: commitData } = await ghApi('GET', `/repos/${ORG}/${targetRepo}/git/commits/${commitSha}`);
  const baseTreeSha = commitData.tree.sha;
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

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
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  const { data: newCommit } = await ghApi('POST', `/repos/${ORG}/${targetRepo}/git/commits`, {
    message,
    tree: treeData.sha,
    parents: [commitSha],
  });
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  await ghApi('PATCH', `/repos/${ORG}/${targetRepo}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
  });
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));
}

export async function commitBatch(ghApi, targetRepo, branch, files, message) {
  if (files.length === 0) return;

  if (files.length > MAX_TREE_BATCH_SIZE) {
    const subBatches = [];
    for (let i = 0; i < files.length; i += MAX_TREE_BATCH_SIZE) {
      subBatches.push(files.slice(i, i + MAX_TREE_BATCH_SIZE));
    }
    for (let i = 0; i < subBatches.length; i++) {
      const batchMsg = subBatches.length > 1 ? `${message} (${i + 1}/${subBatches.length})` : message;
      await commitBatchInternal(ghApi, targetRepo, branch, subBatches[i], batchMsg);
      if (i < subBatches.length - 1) await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));
    }
    return;
  }

  await commitBatchInternal(ghApi, targetRepo, branch, files, message);
}

/**
 * Group items by first letter of their slug (after stripping m_, s_ prefix).
 */
export function groupByFirstLetter(items) {
  const groups = new Map();
  for (const item of items) {
    const slug = item.id.replace(/^[msp]_/, '');
    const letter = (slug[0] || '#').toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(item);
  }
  return groups;
}

// ─── Main rescan function ────────────────────────────────────────────────────

/**
 * Rescan a single year for movies (and optionally series).
 *
 * @param {object} options
 * @param {number} options.year - Target year to rescan
 * @param {string} options.repo - Target repo name (e.g. 'mmdb-2010')
 * @param {string} options.token - GitHub auth token
 * @param {number} [options.limit=2000] - Max Wikidata results per query
 * @param {boolean} [options.includeSeries=false] - Also rescan series
 * @param {boolean} [options.dryRun=false] - Don't create PR, just report
 * @param {function} [options.log] - Log function (default: console.log)
 * @returns {Promise<{movies: number, series: number, rejected: number, duplicates: number, pr?: string}>}
 */
export async function rescanYear(options) {
  const {
    year,
    repo,
    token,
    limit = 2000,
    includeSeries = false,
    dryRun = false,
    log = console.log,
  } = options;

  const { ghApi, ghGraphQL } = createGitHubClient(token);
  const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');

  // ─── Query Wikidata for films ──────────────────────────────────────────────

  const movieSparql = buildMovieQuery(year, limit);
  const movieResults = await queryWikidata(movieSparql);
  const rawMovies = parseMovieResults(movieResults);

  if (rawMovies.length >= MAX_RESULTS_SANITY) {
    throw new Error(`Got ${rawMovies.length} results — exceeds sanity limit of ${MAX_RESULTS_SANITY}`);
  }

  const unusableMovies = rawMovies.filter(m => !isUsableTitle(m.label));
  const validMovies = rawMovies.filter(m => isUsableTitle(m.label));

  // ─── Query Wikidata for series (optional) ──────────────────────────────────

  let rawSeries = [];
  let qidSeries = [];
  let validSeries = [];

  if (includeSeries) {
    const seriesSparql = buildSeriesQuery(year, limit);
    const seriesResults = await queryWikidata(seriesSparql);
    rawSeries = parseSeriesResults(seriesResults);

    if (rawSeries.length >= MAX_RESULTS_SANITY) {
      throw new Error(`Got ${rawSeries.length} series results — exceeds sanity limit of ${MAX_RESULTS_SANITY}`);
    }

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

  if (includeSeries) {
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

  log(`Wikidata: ${rawMovies.length} movies${includeSeries ? `, ${rawSeries.length} series` : ''}`);
  log(`Filtered: ${totalRejected} unusable rejected`);
  log(`Dedup: ${totalDuplicates} existing, ${totalNew} new`);

  if (totalNew === 0) {
    return { movies: 0, series: 0, rejected: totalRejected, duplicates: totalDuplicates, pr: null };
  }

  if (dryRun) {
    return { movies: newMovies.length, series: newSeries.length, rejected: totalRejected, duplicates: totalDuplicates, pr: null };
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
    log(`Adding ${newMovies.length} movies in batches...`);
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
    log(`Added ${movieCount} movies in ${movieGroups.size} commits`);
  }

  // Add series in batches by first letter
  if (newSeries.length > 0) {
    log(`Adding ${newSeries.length} series in batches...`);
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
    log(`Added ${seriesCount} series in ${seriesGroups.size} commits`);
  }

  // ─── Create PR ─────────────────────────────────────────────────────────────

  const prParts = [];
  if (newMovies.length > 0) prParts.push(`${newMovies.length} movies`);
  if (newSeries.length > 0) prParts.push(`${newSeries.length} series`);
  const prTitle = `ingest: add ${prParts.join(' + ')} (${year} rescan)`;

  const prBody = [
    `## Year ${year} Rescan`,
    '',
    `Re-scanned Wikidata for films${includeSeries ? '/series' : ''} released in ${year}.`,
    '',
    '### Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Films found in Wikidata | ${rawMovies.length} |`,
    includeSeries ? `| Series found in Wikidata | ${rawSeries.length} |` : null,
    `| Unusable entries rejected | ${totalRejected} |`,
    `| Already stored | ${totalDuplicates} |`,
    `| New movies added | ${newMovies.length} |`,
    includeSeries ? `| New series added | ${newSeries.length} |` : null,
  ].filter(line => line !== null).join('\n');

  const { ok: prOk, data: prData } = await createPR(ghApi, repo, prTitle, branchName, prBody);
  if (!prOk) {
    throw new Error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
  }

  // Merge directly (squash) — bot trusts its own PRs
  log(`PR created: ${repo}#${prData.number} (${prParts.join(' + ')})`);
  try {
    await new Promise(r => setTimeout(r, 1000)); // Brief pause before merge
    const { ok: mergeOk } = await ghApi('PUT', `/repos/${ORG}/${repo}/pulls/${prData.number}/merge`, {
      merge_method: 'squash',
      commit_title: prTitle,
    });
    if (mergeOk) {
      log(`Merge: ✓ squash merged`);
      // Dispatch workflow to build indexes (push from App token doesn't trigger workflows)
      await new Promise(r => setTimeout(r, 1000));
      const { ok: dispatchOk } = await ghApi('POST', `/repos/${ORG}/${repo}/actions/workflows/validate.yml/dispatches`, {
        ref: 'master',
      });
      log(`CI: ${dispatchOk ? '✓ index build dispatched' : '⚠ could not dispatch (workflow_dispatch may not be configured)'}`);
    } else {
      // Fallback to auto-merge if direct merge is blocked
      const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, repo, prData.number);
      log(`Merge: ⚠ direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
    }
  } catch (err) {
    log(`Merge: ⚠ ${err.message}`);
  }
  return {
    movies: newMovies.length,
    series: newSeries.length,
    rejected: totalRejected,
    duplicates: totalDuplicates,
    pr: `${repo}#${prData.number}`,
  };
}

// ─── Repo existence check ────────────────────────────────────────────────────

/**
 * Check if a repo exists in the org.
 */
export async function repoExists(ghApi, repo) {
  const { ok } = await ghApi('GET', `/repos/${ORG}/${repo}`);
  return ok;
}

/**
 * Check if a recent rescan branch exists (for --resume).
 */
export async function hasRecentRescanBranch(ghApi, repo, year) {
  const { ok, data } = await ghApi('GET', `/repos/${ORG}/${repo}/git/matching-refs/heads/mmdb-ingest/rescan-${year}-`);
  if (!ok || !Array.isArray(data)) return false;
  return data.length > 0;
}

/**
 * Create a new year repo with standard structure.
 */
export async function createYearRepo(ghApi, year) {
  const repoName = `mmdb-${year}`;

  // 1. Create the repo with auto_init (creates 'main' branch with README)
  const { ok, data } = await ghApi('POST', `/orgs/${ORG}/repos`, {
    name: repoName,
    description: `MMDB ${year} — Movies and series from ${year}`,
    visibility: 'public',
    auto_init: true,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
    allow_auto_merge: true,
  });

  if (!ok) {
    throw new Error(`Failed to create repo ${repoName}: ${data.message || JSON.stringify(data)}`);
  }

  // Wait for GitHub to propagate
  await new Promise(r => setTimeout(r, 5000));

  // 2. Rename default branch from 'main' to 'master'
  await ghApi('POST', `/repos/${ORG}/${repoName}/branches/main/rename`, {
    new_name: 'master',
  });

  // Wait for rename to propagate
  await new Promise(r => setTimeout(r, 3000));

  // 3. Push template files (one by one, getting sha for existing README)

  // 3. Commit the initial structure
  const packageJson = {
    name: `mmdb-${year}`,
    version: '1.0.0',
    description: `MMDB data for ${year}`,
    private: true,
    devDependencies: {
      'mmdb-validate': '^1.0.0',
    },
  };

  const validateWorkflow = `name: Validate and Build Indexes

on:
  pull_request:
    branches: [master]
    paths: ['data/**']
  push:
    branches: [master]
    paths: ['data/**']
  workflow_dispatch:

permissions:
  contents: write

jobs:
  validate:
    runs-on: ubuntu-latest
    if: github.actor != 'github-actions[bot]'
    steps:
      - name: Checkout data repo
        uses: actions/checkout@v4
        with:
          path: data

      - name: Checkout tools repo
        uses: actions/checkout@v4
        with:
          repository: mimir-media-db/mmdb-schema-and-tools
          ref: master
          path: tools

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Build tools
        run: |
          cd tools
          npm install
          npm run build

      - name: Validate data
        run: |
          cd data
          node ../tools/dist/validate-repo.js

      - name: Build indexes
        run: |
          cd data
          node ../tools/dist/build-indexes.js

      - name: Check for index changes
        id: check_changes
        run: |
          cd data
          git diff --exit-code data/*/index.json || echo "changed=true" >> $GITHUB_OUTPUT

      - name: Verify only index files changed
        if: steps.check_changes.outputs.changed == 'true' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
        run: |
          cd data
          git add data/movies/index.json data/series/index.json data/people/index.json 2>/dev/null || true
          STAGED=$(git diff --cached --name-only)
          for f in $STAGED; do
            if [[ ! "$f" == *index.json ]]; then
              echo "ERROR: Unexpected file staged: $f"
              exit 1
            fi
          done

      - name: Commit index updates
        if: steps.check_changes.outputs.changed == 'true' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
        run: |
          cd data
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -m "chore: update indexes [skip ci]" || echo "Nothing to commit"
          git push
`;

  const files = [
    { path: 'README.md', content: `# MMDB — ${year}\n\nMovies and series released in ${year}.\n` },
    { path: 'package.json', content: JSON.stringify(packageJson, null, 2) + '\n' },
    { path: 'data/movies/index.json', content: '[]\n' },
    { path: 'data/series/index.json', content: '[]\n' },
    { path: '.github/workflows/validate.yml', content: validateWorkflow },
  ];

  // Push files (get sha for existing ones like README from auto_init)
  for (const file of files) {
    let sha;
    try {
      const { ok: getOk, data: getData } = await ghApi('GET', `/repos/${ORG}/${repoName}/contents/${file.path}?ref=master`);
      if (getOk && getData.sha) {
        sha = getData.sha;
      }
    } catch { /* file doesn't exist yet */ }

    const { ok: putOk, data: putData } = await ghApi('PUT', `/repos/${ORG}/${repoName}/contents/${file.path}`, {
      message: `chore: initialize ${file.path}`,
      content: Buffer.from(file.content).toString('base64'),
      branch: 'master',
      ...(sha && { sha }),
    });
    if (!putOk) {
      console.warn(`  ⚠ Failed to push ${file.path}: ${putData.message || JSON.stringify(putData)}`);
    }
    await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));
  }

  // 4. Set up branch protection
  await ghApi('PUT', `/repos/${ORG}/${repoName}/branches/master/protection`, {
    required_status_checks: {
      strict: false,
      contexts: ['validate'],
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
  });

  // 5. Set workflow permissions
  await ghApi('PUT', `/repos/${ORG}/${repoName}/actions/permissions/workflow`, {
    default_workflow_permissions: 'write',
    can_approve_pull_request_reviews: true,
  });

  return repoName;
}
