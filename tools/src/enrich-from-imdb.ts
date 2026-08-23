#!/usr/bin/env node
/**
 * enrich-from-imdb.ts — MMDB Genre + isAdult Enrichment from IMDB Bulk Data
 *
 * Downloads title.basics.tsv.gz from IMDB, parses it into a lookup map,
 * and enriches MMDB title JSON files with genres and is_adult fields.
 *
 * For titles without IMDB IDs, falls back to Wikidata SPARQL batch queries.
 *
 * Usage:
 *   npx tsx tools/src/enrich-from-imdb.ts --year=2026          # sample single year
 *   npx tsx tools/src/enrich-from-imdb.ts --all                # all year repos
 *   npx tsx tools/src/enrich-from-imdb.ts --year=2026 --dry-run  # preview only
 *   npx tsx tools/src/enrich-from-imdb.ts --year=2026 --create-pr  # commit + PR
 */

import { createReadStream, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

// --- Types ---

interface ImdbEntry {
  isAdult: boolean;
  genres: string[];
  runtimeMinutes?: number;
}

interface EnrichmentStats {
  totalFiles: number;
  enrichedFromImdb: number;
  enrichedFromWikidata: number;
  noImdbMatch: number;
  noWikidataMatch: number;
  alreadyHasGenres: number;
  errors: number;
}

interface TitleFile {
  path: string;
  data: any;
}

// --- Constants ---

const IMDB_DATASET_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz';
const IMDB_CACHE_PATH = '/tmp/title.basics.tsv.gz';
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const WIKIDATA_RATE_LIMIT_MS = 2000;
const WIKIDATA_BATCH_SIZE = 400;
const REPOS_BASE = resolve(process.env.HOME || '~', 'repos');
const GITHUB_ORG = 'mimir-media-db';

// Adult genre QIDs from Wikidata
const ADULT_GENRE_QIDS = new Set(['Q235340', 'Q3521577', 'Q2421031']);

// Wikidata genre QID → label mapping (common genres)
const GENRE_QID_MAP: Record<string, string> = {
  'Q130232': 'Drama',
  'Q157443': 'Comedy',
  'Q200092': 'Horror',
  'Q188473': 'Action',
  'Q319221': 'Adventure',
  'Q471839': 'Science Fiction',
  'Q157394': 'Fantasy',
  'Q959790': 'Crime',
  'Q182015': 'Thriller',
  'Q586250': 'Romance',
  'Q842256': 'Mystery',
  'Q93204': 'Documentary',
  'Q859369': 'Western',
  'Q487914': 'Animation',
  'Q599558': 'Musical',
  'Q188451': 'War',
  'Q1535153': 'Biography',
  'Q369747': 'Historical',
  'Q83440': 'Family',
  'Q21010853': 'Sport',
  'Q235340': 'Adult',
  'Q3521577': 'Adult',
  'Q2421031': 'Adult',
  'Q52207399': 'Psychological Thriller',
  'Q2484376': 'Romantic Comedy',
  'Q1200678': 'Martial Arts',
  'Q2975633': 'Slasher',
  'Q20656232': 'Superhero',
  'Q11366': 'Music',
  'Q336144': 'Noir',
  'Q185867': 'Fantastique',
  'Q860626': 'Disaster',
  'Q1054574': 'Spy',
  'Q224700': 'Comedy-drama',
  'Q1341051': 'Supernatural',
  'Q46046': 'Anime',
};

// --- CLI args ---

function parseArgs() {
  const args = process.argv.slice(2);
  const yearArg = args.find(a => a.startsWith('--year='));
  const allFlag = args.includes('--all');
  const dryRun = args.includes('--dry-run');
  const createPr = args.includes('--create-pr');
  const skipDownload = args.includes('--skip-download');

  const year = yearArg ? parseInt(yearArg.split('=')[1]) : undefined;

  if (!year && !allFlag) {
    console.error('Usage: enrich-from-imdb.ts --year=YYYY | --all [--dry-run] [--create-pr] [--skip-download]');
    process.exit(1);
  }

  return { year, allFlag, dryRun, createPr, skipDownload };
}

// --- IMDB Download & Parse ---

async function downloadImdbData(): Promise<void> {
  if (existsSync(IMDB_CACHE_PATH)) {
    console.log(`Using cached IMDB data at ${IMDB_CACHE_PATH}`);
    return;
  }

  console.log(`Downloading ${IMDB_DATASET_URL}...`);
  const response = await fetch(IMDB_DATASET_URL);
  if (!response.ok) {
    throw new Error(`Failed to download IMDB data: ${response.status} ${response.statusText}`);
  }

  const fileStream = createWriteStream(IMDB_CACHE_PATH);
  const body = Readable.fromWeb(response.body as any);
  await pipeline(body, fileStream);
  console.log(`Downloaded to ${IMDB_CACHE_PATH}`);
}

async function parseImdbData(neededImdbIds: Set<string>): Promise<Map<string, ImdbEntry>> {
  console.log(`Parsing IMDB title.basics.tsv.gz (filtering for ${neededImdbIds.size} needed IDs)...`);
  const map = new Map<string, ImdbEntry>();

  const fileStream = createReadStream(IMDB_CACHE_PATH);
  const gunzip = createGunzip();
  const rl = createInterface({
    input: fileStream.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  let headerSkipped = false;

  for await (const line of rl) {
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    lineCount++;
    const parts = line.split('\t');
    // tconst, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtimeMinutes, genres
    if (parts.length < 9) continue;

    const tconst = parts[0];

    // Only keep entries we need
    if (!neededImdbIds.has(tconst)) continue;

    const [, , , , isAdultStr, , , runtimeStr, genresStr] = parts;

    const genres = genresStr && genresStr !== '\\N'
      ? genresStr.split(',').map(g => g.trim()).filter(g => g.length > 0)
      : [];

    const isAdult = isAdultStr === '1';
    const runtimeMinutes = runtimeStr && runtimeStr !== '\\N' ? parseInt(runtimeStr) : undefined;

    map.set(tconst, { isAdult, genres, runtimeMinutes });

    // Early exit if we found all
    if (map.size === neededImdbIds.size) {
      console.log(`  Found all ${map.size} needed entries, stopping early`);
      rl.close();
      break;
    }

    if (lineCount % 2_000_000 === 0) {
      console.log(`  Scanned ${(lineCount / 1_000_000).toFixed(1)}M lines, found ${map.size}/${neededImdbIds.size}...`);
    }
  }

  console.log(`  Result: ${map.size}/${neededImdbIds.size} IMDB entries found (scanned ${(lineCount / 1_000_000).toFixed(1)}M lines)`);
  return map;
}

// --- Wikidata SPARQL fallback ---

async function queryWikidataGenres(qids: string[]): Promise<Map<string, { genres: string[]; isAdult: boolean }>> {
  const values = qids.map(q => `wd:${q}`).join(' ');
  const sparql = `
SELECT ?item ?genre ?genreLabel WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P136 ?genre.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

  const response = await fetch(WIKIDATA_SPARQL_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MMDB-Enrichment/1.0 (https://github.com/mimir-media-db)',
    },
    body: `query=${encodeURIComponent(sparql)}`,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`  Wikidata SPARQL failed: ${response.status} — ${text.slice(0, 200)}`);
    throw new Error(`Wikidata SPARQL failed: ${response.status}`);
  }

  const data = await response.json();
  const results = new Map<string, { genres: string[]; isAdult: boolean }>();

  for (const binding of data.results.bindings) {
    const qid = binding.item.value.split('/').pop()!;
    const genreQid = binding.genre.value.split('/').pop()!;
    const genreLabel = binding.genreLabel?.value || GENRE_QID_MAP[genreQid] || genreQid;

    if (!results.has(qid)) {
      results.set(qid, { genres: [], isAdult: false });
    }

    const entry = results.get(qid)!;

    // Check if this is an adult genre
    if (ADULT_GENRE_QIDS.has(genreQid)) {
      entry.isAdult = true;
    }

    // Use mapped label if available, otherwise use Wikidata label
    const label = GENRE_QID_MAP[genreQid] || genreLabel;
    if (!entry.genres.includes(label)) {
      entry.genres.push(label);
    }
  }

  return results;
}

async function enrichFromWikidata(titlesWithoutImdb: TitleFile[]): Promise<Map<string, { genres: string[]; isAdult: boolean }>> {
  console.log(`\nFalling back to Wikidata for ${titlesWithoutImdb.length} titles without IMDB IDs...`);
  const allResults = new Map<string, { genres: string[]; isAdult: boolean }>();

  // Collect QIDs
  const qidToFile = new Map<string, TitleFile>();
  for (const tf of titlesWithoutImdb) {
    const qid = tf.data.external_ids?.wikidata;
    if (qid) {
      qidToFile.set(qid, tf);
    }
  }

  const qids = Array.from(qidToFile.keys());
  console.log(`  ${qids.length} titles have Wikidata QIDs for fallback`);

  // Process in batches of WIKIDATA_BATCH_SIZE
  for (let i = 0; i < qids.length; i += WIKIDATA_BATCH_SIZE) {
    const batch = qids.slice(i, i + WIKIDATA_BATCH_SIZE);
    const batchNum = Math.floor(i / WIKIDATA_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(qids.length / WIKIDATA_BATCH_SIZE);
    console.log(`  Wikidata batch ${batchNum}/${totalBatches} (${batch.length} QIDs)...`);

    try {
      const batchResults = await queryWikidataGenres(batch);
      for (const [qid, data] of batchResults) {
        allResults.set(qid, data);
      }
    } catch (error) {
      console.error(`  Batch ${batchNum} failed, skipping:`, (error as Error).message);
    }

    // Rate limit
    if (i + WIKIDATA_BATCH_SIZE < qids.length) {
      await new Promise(resolve => setTimeout(resolve, WIKIDATA_RATE_LIMIT_MS));
    }
  }

  return allResults;
}

// --- Local file processing ---

function getYearRepos(year?: number): string[] {
  if (year) {
    const repoPath = join(REPOS_BASE, `mmdb-${year}`);
    if (!existsSync(repoPath)) {
      console.error(`Repo not found: ${repoPath}`);
      process.exit(1);
    }
    return [repoPath];
  }

  // All year repos from 2000 to 2026
  const repos: string[] = [];
  for (let y = 2000; y <= 2026; y++) {
    const repoPath = join(REPOS_BASE, `mmdb-${y}`);
    if (existsSync(repoPath)) {
      repos.push(repoPath);
    }
  }
  return repos;
}

function loadTitleFiles(repoPath: string): TitleFile[] {
  const titles: TitleFile[] = [];

  // Load movies
  const moviesDir = join(repoPath, 'data', 'movies');
  if (existsSync(moviesDir)) {
    const files = readdirSync(moviesDir).filter(f => f.endsWith('.json') && f !== 'index.json');
    for (const file of files) {
      const filePath = join(moviesDir, file);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        titles.push({ path: filePath, data });
      } catch (e) {
        // Skip malformed files
      }
    }
  }

  // Load series
  const seriesDir = join(repoPath, 'data', 'series');
  if (existsSync(seriesDir)) {
    const files = readdirSync(seriesDir).filter(f => f.endsWith('.json') && f !== 'index.json');
    for (const file of files) {
      const filePath = join(seriesDir, file);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        titles.push({ path: filePath, data });
      } catch (e) {
        // Skip malformed files
      }
    }
  }

  return titles;
}

function enrichAndSave(title: TitleFile, genres: string[], isAdult: boolean, dryRun: boolean): boolean {
  const data = title.data;

  // Add genres (only if we have them and they aren't already set)
  if (genres.length > 0 && (!data.genres || data.genres.length === 0)) {
    data.genres = genres;
  }

  // Add is_adult
  if (data.is_adult === undefined) {
    data.is_adult = isAdult;
  }

  // Update last_updated
  data.last_updated = new Date().toISOString().split('T')[0];

  if (!dryRun) {
    writeFileSync(title.path, JSON.stringify(data, null, 2) + '\n');
  }

  return true;
}

// --- PR creation (uses git CLI for local repos) ---

async function createPrForRepo(repoPath: string, repoName: string): Promise<void> {
  const { execSync } = await import('child_process');
  const branchName = 'enrichment/genres-isadult';

  try {
    // Check if branch already exists
    try {
      execSync(`git rev-parse --verify ${branchName}`, { cwd: repoPath, stdio: 'pipe' });
      console.log(`  Branch ${branchName} already exists in ${repoName}, using it`);
      execSync(`git checkout ${branchName}`, { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // Branch doesn't exist, create it
      execSync(`git checkout -b ${branchName}`, { cwd: repoPath, stdio: 'pipe' });
    }

    // Stage all changes
    execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });

    // Check if there are changes
    const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8' });
    if (!status.trim()) {
      console.log(`  No changes to commit in ${repoName}`);
      execSync('git checkout master', { cwd: repoPath, stdio: 'pipe' });
      return;
    }

    // Commit as mmdb-bot[bot] so PRs show the correct author.
    // TODO: Long-term, use the GitHub Git Trees API (like commitBatch() in
    // functions/src/ingestion/github-client.ts) to create commits server-side,
    // which automatically attributes them to the GitHub App bot.
    const botName = 'mmdb-bot[bot]';
    const botEmail = 'mmdb-bot[bot]@users.noreply.github.com';
    execSync(
      `git commit --author="${botName} <${botEmail}>" -m "feat: add genres and is_adult from IMDB bulk data"`,
      {
        cwd: repoPath,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_COMMITTER_NAME: botName,
          GIT_COMMITTER_EMAIL: botEmail,
        },
      },
    );

    // Push
    execSync(`git push -u origin ${branchName}`, { cwd: repoPath, stdio: 'pipe' });

    // Create PR using gh CLI
    execSync(
      `gh pr create --title "feat: enrich genres + is_adult from IMDB" --body "Automated enrichment from IMDB title.basics dataset.\n\nAdds:\n- genres (string[]) from IMDB\n- is_adult (boolean) from IMDB\n- Wikidata fallback for titles without IMDB IDs" --base master`,
      { cwd: repoPath, stdio: 'pipe' }
    );

    console.log(`  ✓ PR created for ${repoName}`);

    // Switch back to master
    execSync('git checkout master', { cwd: repoPath, stdio: 'pipe' });
  } catch (error: any) {
    console.error(`  ✗ PR creation failed for ${repoName}:`, error.message);
    // Try to get back to master
    try {
      execSync('git checkout master', { cwd: repoPath, stdio: 'pipe' });
    } catch {}
  }
}

// --- Main ---

async function main() {
  const { year, allFlag, dryRun, createPr, skipDownload } = parseArgs();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MMDB Genre + isAdult Enrichment from IMDB Bulk Data');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode: ${year ? `single year (${year})` : 'all repos'}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Create PR: ${createPr}`);
  console.log('');

  // Step 1: Download IMDB data
  if (!skipDownload) {
    await downloadImdbData();
  }

  // Step 2: Load all title files first to collect IMDB IDs
  const repos = getYearRepos(year);
  console.log(`\nLoading title files from ${repos.length} year repo(s)...`);

  const repoTitles = new Map<string, TitleFile[]>();
  const neededImdbIds = new Set<string>();

  for (const repoPath of repos) {
    const titles = loadTitleFiles(repoPath);
    repoTitles.set(repoPath, titles);

    for (const title of titles) {
      const imdbId = title.data.external_ids?.imdb;
      if (imdbId && (!title.data.genres || title.data.genres.length === 0)) {
        neededImdbIds.add(imdbId);
      }
    }
  }

  const totalTitles = Array.from(repoTitles.values()).reduce((sum, t) => sum + t.length, 0);
  console.log(`  Total titles loaded: ${totalTitles}`);
  console.log(`  IMDB IDs to look up: ${neededImdbIds.size}`);

  // Step 3: Parse IMDB data (filtered to only needed IDs)
  const imdbMap = await parseImdbData(neededImdbIds);

  // Step 4: Process year repos
  console.log(`\nEnriching ${repos.length} year repo(s)...\n`);

  const totalStats: EnrichmentStats = {
    totalFiles: 0,
    enrichedFromImdb: 0,
    enrichedFromWikidata: 0,
    noImdbMatch: 0,
    noWikidataMatch: 0,
    alreadyHasGenres: 0,
    errors: 0,
  };

  for (const repoPath of repos) {
    const repoName = repoPath.split('/').pop()!;
    console.log(`\n── ${repoName} ${'─'.repeat(50 - repoName.length)}`);

    const titles = repoTitles.get(repoPath)!;
    console.log(`  Processing ${titles.length} title files`);

    const stats: EnrichmentStats = {
      totalFiles: titles.length,
      enrichedFromImdb: 0,
      enrichedFromWikidata: 0,
      noImdbMatch: 0,
      noWikidataMatch: 0,
      alreadyHasGenres: 0,
      errors: 0,
    };

    const titlesWithoutImdb: TitleFile[] = [];

    // Step 4a: Enrich from IMDB
    for (const title of titles) {
      const imdbId = title.data.external_ids?.imdb;

      // Skip if already has genres
      if (title.data.genres && title.data.genres.length > 0) {
        stats.alreadyHasGenres++;
        continue;
      }

      if (imdbId) {
        const imdbEntry = imdbMap.get(imdbId);
        if (imdbEntry) {
          enrichAndSave(title, imdbEntry.genres, imdbEntry.isAdult, dryRun);
          stats.enrichedFromImdb++;
        } else {
          stats.noImdbMatch++;
          titlesWithoutImdb.push(title);
        }
      } else {
        titlesWithoutImdb.push(title);
      }
    }

    // Step 4b: Wikidata fallback for titles without IMDB match
    if (titlesWithoutImdb.length > 0) {
      const wikidataResults = await enrichFromWikidata(titlesWithoutImdb);

      for (const title of titlesWithoutImdb) {
        const qid = title.data.external_ids?.wikidata;
        if (qid && wikidataResults.has(qid)) {
          const wd = wikidataResults.get(qid)!;
          if (wd.genres.length > 0) {
            enrichAndSave(title, wd.genres, wd.isAdult, dryRun);
            stats.enrichedFromWikidata++;
          } else {
            stats.noWikidataMatch++;
          }
        } else {
          stats.noWikidataMatch++;
        }
      }
    }

    console.log(`  Results:`);
    console.log(`    Enriched from IMDB:     ${stats.enrichedFromImdb}`);
    console.log(`    Enriched from Wikidata: ${stats.enrichedFromWikidata}`);
    console.log(`    No IMDB match:          ${stats.noImdbMatch}`);
    console.log(`    No Wikidata match:      ${stats.noWikidataMatch}`);
    console.log(`    Already had genres:     ${stats.alreadyHasGenres}`);
    console.log(`    Total files:            ${stats.totalFiles}`);

    // Accumulate
    totalStats.totalFiles += stats.totalFiles;
    totalStats.enrichedFromImdb += stats.enrichedFromImdb;
    totalStats.enrichedFromWikidata += stats.enrichedFromWikidata;
    totalStats.noImdbMatch += stats.noImdbMatch;
    totalStats.noWikidataMatch += stats.noWikidataMatch;
    totalStats.alreadyHasGenres += stats.alreadyHasGenres;
    totalStats.errors += stats.errors;

    // Step 5: Create PR if requested
    if (createPr && !dryRun) {
      await createPrForRepo(repoPath, repoName);
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total files processed:    ${totalStats.totalFiles}`);
  console.log(`  Enriched from IMDB:       ${totalStats.enrichedFromImdb}`);
  console.log(`  Enriched from Wikidata:   ${totalStats.enrichedFromWikidata}`);
  console.log(`  No IMDB match:            ${totalStats.noImdbMatch}`);
  console.log(`  No Wikidata match:        ${totalStats.noWikidataMatch}`);
  console.log(`  Already had genres:       ${totalStats.alreadyHasGenres}`);
  console.log(`  Errors:                   ${totalStats.errors}`);
  const coverage = totalStats.totalFiles > 0
    ? (((totalStats.enrichedFromImdb + totalStats.enrichedFromWikidata + totalStats.alreadyHasGenres) / totalStats.totalFiles) * 100).toFixed(1)
    : '0';
  console.log(`  Genre coverage:           ${coverage}%`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(error => {
  console.error('Enrichment failed:', error);
  process.exit(1);
});
