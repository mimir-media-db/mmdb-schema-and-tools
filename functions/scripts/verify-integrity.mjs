#!/usr/bin/env node

/**
 * Verify data integrity across all mmdb year repos (2000–2026).
 *
 * For each repo mimir-media-db/mmdb-YYYY:
 *   - Compare index.json entry count vs actual .json file count for movies and series
 *   - Report mismatches
 */

import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createProgress } from './lib/progress.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = resolve(__dirname, '..', '.env');

const ORG = 'mimir-media-db';
const START_YEAR = 2000;
const END_YEAR = 2026;
const DELAY_MS = 500; // delay between repos to avoid rate limits

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function ghFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return res;
}

/**
 * Get index.json content from a repo path, return parsed array length.
 * Handles large files (>1MB) by falling back to the Blob API.
 * Returns null if file doesn't exist.
 */
async function getIndexCount(token, repo, path) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/contents/${path}?ref=master`;
  const res = await ghFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  let content;
  if (data.content && data.encoding === 'base64') {
    // Small file — content is inline
    content = Buffer.from(data.content, 'base64').toString('utf8');
  } else if (data.sha) {
    // Large file (>1MB) — fetch via Blob API with raw media type
    const blobUrl = `https://api.github.com/repos/${ORG}/${repo}/git/blobs/${data.sha}`;
    const blobRes = await fetch(blobUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!blobRes.ok) {
      const text = await blobRes.text();
      throw new Error(`GET blob ${data.sha} failed: ${blobRes.status} ${text}`);
    }
    content = await blobRes.text();
  } else {
    throw new Error(`Cannot read ${path}: no content and no sha`);
  }

  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
}

/**
 * Get tree for a repo, count .json files in a specific directory (excluding index.json).
 */
async function getFileCount(token, repo, dir) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/git/trees/master?recursive=1`;
  const res = await ghFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET tree failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const prefix = dir.endsWith('/') ? dir : dir + '/';
  const files = data.tree.filter(item => {
    if (item.type !== 'blob') return false;
    if (!item.path.startsWith(prefix)) return false;
    if (!item.path.endsWith('.json')) return false;
    // Exclude index.json
    const filename = item.path.slice(prefix.length);
    if (filename === 'index.json') return false;
    // Only direct children (no subdirectories)
    if (filename.includes('/')) return false;
    return true;
  });
  return files.length;
}

async function main() {
  console.log('🔐 Authenticating with GitHub...');
  const { token, method } = await loadGitHubAuth(ENV_PATH);
  if (!token) {
    console.error('❌ No GitHub auth available. Check .env file.');
    process.exit(1);
  }
  console.log(`✅ Auth: ${method}\n`);

  const results = [];
  const mismatches = [];
  const totalYears = END_YEAR - START_YEAR + 1;
  const repoProgress = createProgress(totalYears, 'Repos');

  for (let year = START_YEAR; year <= END_YEAR; year++) {
    const repo = `mmdb-${year}`;
    process.stdout.write(`Checking ${repo}...`);

    try {
      const [moviesIndexCount, moviesFileCount, seriesIndexCount, seriesFileCount] =
        await Promise.all([
          getIndexCount(token, repo, 'data/movies/index.json'),
          getFileCount(token, repo, 'data/movies'),
          getIndexCount(token, repo, 'data/series/index.json'),
          getFileCount(token, repo, 'data/series'),
        ]);

      const entry = {
        year,
        repo,
        moviesIndex: moviesIndexCount,
        moviesFiles: moviesFileCount,
        moviesMatch: moviesIndexCount === moviesFileCount,
        seriesIndex: seriesIndexCount,
        seriesFiles: seriesFileCount,
        seriesMatch: seriesIndexCount === seriesFileCount,
      };

      results.push(entry);

      if (!entry.moviesMatch || !entry.seriesMatch) {
        mismatches.push(entry);
      }

      const moviesStatus = entry.moviesMatch ? '✓' : `✗ (idx:${moviesIndexCount} files:${moviesFileCount})`;
      const seriesStatus = entry.seriesMatch ? '✓' : `✗ (idx:${seriesIndexCount} files:${seriesFileCount})`;
      console.log(` movies:${moviesStatus} series:${seriesStatus}`);
    } catch (err) {
      console.log(` ❌ ERROR: ${err.message}`);
      results.push({ year, repo, error: err.message });
    }

    repoProgress.tick(`mmdb-${year}`);
    await sleep(DELAY_MS);
  }

  repoProgress.done();

  // Summary table
  console.log('\n' + '='.repeat(80));
  console.log('INTEGRITY VERIFICATION SUMMARY');
  console.log('='.repeat(80));
  console.log(
    'Year'.padEnd(6) +
    'Movies(idx)'.padEnd(14) +
    'Movies(files)'.padEnd(16) +
    'M-OK'.padEnd(6) +
    'Series(idx)'.padEnd(14) +
    'Series(files)'.padEnd(16) +
    'S-OK'
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.year}  ERROR: ${r.error}`);
      continue;
    }
    const mOk = r.moviesMatch ? '✓' : '✗';
    const sOk = r.seriesMatch ? '✓' : '✗';
    console.log(
      String(r.year).padEnd(6) +
      String(r.moviesIndex ?? 'N/A').padEnd(14) +
      String(r.moviesFiles ?? 'N/A').padEnd(16) +
      mOk.padEnd(6) +
      String(r.seriesIndex ?? 'N/A').padEnd(14) +
      String(r.seriesFiles ?? 'N/A').padEnd(16) +
      sOk
    );
  }

  console.log('-'.repeat(80));

  // Totals
  const validResults = results.filter(r => !r.error);
  const totalMoviesIndex = validResults.reduce((s, r) => s + (r.moviesIndex || 0), 0);
  const totalMoviesFiles = validResults.reduce((s, r) => s + (r.moviesFiles || 0), 0);
  const totalSeriesIndex = validResults.reduce((s, r) => s + (r.seriesIndex || 0), 0);
  const totalSeriesFiles = validResults.reduce((s, r) => s + (r.seriesFiles || 0), 0);
  console.log(
    'TOTAL'.padEnd(6) +
    String(totalMoviesIndex).padEnd(14) +
    String(totalMoviesFiles).padEnd(16) +
    (totalMoviesIndex === totalMoviesFiles ? '✓' : '✗').padEnd(6) +
    String(totalSeriesIndex).padEnd(14) +
    String(totalSeriesFiles).padEnd(16) +
    (totalSeriesIndex === totalSeriesFiles ? '✓' : '✗')
  );

  // Mismatches
  if (mismatches.length > 0) {
    console.log(`\n⚠️  MISMATCHES FOUND: ${mismatches.length} repos`);
    for (const m of mismatches) {
      const issues = [];
      if (!m.moviesMatch) issues.push(`movies(idx:${m.moviesIndex} vs files:${m.moviesFiles})`);
      if (!m.seriesMatch) issues.push(`series(idx:${m.seriesIndex} vs files:${m.seriesFiles})`);
      console.log(`  ${m.repo}: ${issues.join(', ')}`);
    }
  } else {
    console.log('\n✅ All repos pass integrity check — indexes match file counts.');
  }

  console.log(`\nChecked ${results.length} repos (${validResults.length} valid, ${results.length - validResults.length} errors)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
