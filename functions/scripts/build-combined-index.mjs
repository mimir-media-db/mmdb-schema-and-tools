#!/usr/bin/env node

/**
 * MMDB Build Combined Index
 *
 * Downloads tarballs from all year repos (mmdb-2000 through mmdb-2026),
 * parses every movie and series JSON, extracts key fields, and produces
 * a single gzipped JSON file suitable for distribution as a GitHub Release.
 *
 * Usage:
 *   node scripts/build-combined-index.mjs
 *   node scripts/build-combined-index.mjs --output /tmp/combined-index.json.gz
 *   node scripts/build-combined-index.mjs --from=2010 --to=2020
 *
 * Flags:
 *   --from=YYYY    Start year (default: 2000)
 *   --to=YYYY      End year (default: 2026)
 *   --output=PATH  Output file path (default: ./combined-index.json.gz)
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
    : resolve(__dirname, '..', '..', 'combined-index.json.gz');

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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Tarball extraction ──────────────────────────────────────────────────────

/**
 * Download and extract a GitHub repo tarball, parsing all movie and series JSONs.
 * Returns { movies: [...], series: [...] } with extracted fields.
 */
async function extractEntriesFromTarball(tokenOrManager, yearRepo) {
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

  // Parse tar format
  const movies = [];
  const series = [];
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

    // Only process regular files that are .json and not index.json
    if (typeFlag === 48 || typeFlag === 0) { // '0' or null = regular file
      const isMovieFile = name.includes('/data/movies/') &&
        name.endsWith('.json') &&
        !name.endsWith('index.json');

      const isSeriesFile = name.includes('/data/series/') &&
        name.endsWith('.json') &&
        !name.endsWith('index.json');

      if (isMovieFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          const movie = JSON.parse(content);
          movies.push({
            id: movie.id,
            title: movie.title,
            year: movie.year ?? null,
            type: 'movie',
            release_date: movie.release_date ?? null,
            runtime_minutes: movie.runtime_minutes ?? null,
            external_ids: movie.external_ids ?? {},
          });
        } catch {
          // Skip unparseable files
        }
      }

      if (isSeriesFile && size > 0) {
        try {
          const content = tarData.subarray(offset, offset + size).toString('utf8');
          const show = JSON.parse(content);
          series.push({
            id: show.id,
            title: show.title || show.name,
            start_year: show.start_year ?? null,
            end_year: show.end_year ?? null,
            total_seasons: show.total_seasons ?? null,
            total_episodes: show.total_episodes ?? null,
            external_ids: show.external_ids ?? {},
          });
        } catch {
          // Skip unparseable files
        }
      }
    }

    // Move to next entry (file data padded to 512 byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }

  return { movies, series };
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

log('═══════════════════════════════════════════');
log(`MMDB Build Combined Index: ${fromYear} → ${toYear} (${totalYears} years)`);
log(`Output: ${outputPath}`);
log(`Auth: ${authMethod}`);
log('═══════════════════════════════════════════');

const allMovies = [];
const allSeries = [];
const skippedYears = [];
const failedYears = [];

const { ghApi } = createGitHubClient(tokenManager || token);
const progress = createProgress(totalYears, 'Years');

for (let i = 0; i < totalYears; i++) {
  const year = fromYear + i;
  const yearRepo = `mmdb-${year}`;

  try {
    // Check repo exists
    const { ok } = await retryOnServerError(
      () => ghApi('GET', `/repos/${ORG}/${yearRepo}`),
    );

    if (!ok) {
      log(`  Skipped: ${yearRepo} does not exist`);
      skippedYears.push(year);
      progress.tick(`${yearRepo} (skipped)`);
      continue;
    }

    // Download and parse tarball
    const { movies, series } = await extractEntriesFromTarball(tokenManager || token, yearRepo);

    allMovies.push(...movies);
    allSeries.push(...series);

    progress.tick(`${yearRepo} (${movies.length}m, ${series.length}s)`);
  } catch (err) {
    log(`  ⚠ ERROR: ${yearRepo} — ${err.message}`);
    failedYears.push({ year, error: err.message });
    progress.tick(`${yearRepo} (failed)`);
  }
}

const duration = progress.done();

// ─── Build combined structure ────────────────────────────────────────────────

log('');
log('Building combined index...');

// Sort movies by year (desc), then title (asc)
allMovies.sort((a, b) => {
  if ((b.year || 0) !== (a.year || 0)) return (b.year || 0) - (a.year || 0);
  return (a.title || '').localeCompare(b.title || '');
});

// Sort series by start_year (desc), then title (asc)
allSeries.sort((a, b) => {
  if ((b.start_year || 0) !== (a.start_year || 0)) return (b.start_year || 0) - (a.start_year || 0);
  return (a.title || '').localeCompare(b.title || '');
});

const combinedIndex = {
  version: 1,
  built_at: new Date().toISOString(),
  stats: {
    total_movies: allMovies.length,
    total_series: allSeries.length,
    year_range: [fromYear, toYear],
  },
  movies: allMovies,
  series: allSeries,
};

// ─── Compress and write ──────────────────────────────────────────────────────

log('Compressing with gzip...');

const jsonString = JSON.stringify(combinedIndex);
const compressed = gzipSync(Buffer.from(jsonString), { level: 9 });

writeFileSync(outputPath, compressed);

const fileSize = statSync(outputPath).size;
const uncompressedSize = Buffer.byteLength(jsonString);
const ratio = ((1 - fileSize / uncompressedSize) * 100).toFixed(1);

// ─── Final summary ───────────────────────────────────────────────────────────

const totalDuration = Date.now() - startTime;

log('');
log('═══════════════════════════════════════════');
log('COMBINED INDEX BUILD COMPLETE');
log('───────────────────────────────────────────');
log(`Movies:         ${allMovies.length.toLocaleString()}`);
log(`Series:         ${allSeries.length.toLocaleString()}`);
log(`Year range:     ${fromYear} – ${toYear}`);
log(`Uncompressed:   ${formatBytes(uncompressedSize)}`);
log(`Compressed:     ${formatBytes(fileSize)} (${ratio}% reduction)`);
log(`Output:         ${outputPath}`);
log(`Duration:       ${formatDuration(totalDuration)}`);
if (skippedYears.length > 0) {
  log(`Skipped repos:  ${skippedYears.join(', ')}`);
}
if (failedYears.length > 0) {
  log(`Failed repos:   ${failedYears.map(f => f.year).join(', ')}`);
}
log('═══════════════════════════════════════════');
