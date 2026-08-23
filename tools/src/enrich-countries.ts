#!/usr/bin/env node
/**
 * enrich-countries.ts — MMDB Country of Origin Enrichment from Wikidata P495
 *
 * Queries Wikidata for country of origin (P495) for all MMDB titles,
 * maps results to ISO alpha-2 country codes, and updates title JSON files.
 *
 * Usage:
 *   npx tsx tools/src/enrich-countries.ts --year=2026          # sample single year
 *   npx tsx tools/src/enrich-countries.ts --all                # all year repos
 *   npx tsx tools/src/enrich-countries.ts --year=2026 --dry-run  # preview only
 *   npx tsx tools/src/enrich-countries.ts --year=2026 --commit   # commit changes
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

// --- Types ---

interface TitleFile {
  path: string;
  data: any;
}

interface EnrichmentStats {
  totalFiles: number;
  enrichedWithCountries: number;
  noCountryFound: number;
  alreadyHasCountries: number;
  noWikidataId: number;
  errors: number;
}

// --- Constants ---

const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const WIKIDATA_RATE_LIMIT_MS = 500;
const WIKIDATA_BATCH_SIZE = 400;
const REPOS_BASE = resolve(process.env.HOME || '~', 'repos');
const BRANCH_NAME = 'enrichment/countries';

// --- CLI args ---

function parseArgs() {
  const args = process.argv.slice(2);
  const yearArg = args.find(a => a.startsWith('--year='));
  const allFlag = args.includes('--all');
  const dryRun = args.includes('--dry-run');
  const commit = args.includes('--commit');

  const year = yearArg ? parseInt(yearArg.split('=')[1]) : undefined;

  if (!year && !allFlag) {
    console.error('Usage: enrich-countries.ts --year=YYYY | --all [--dry-run] [--commit]');
    process.exit(1);
  }

  return { year, allFlag, dryRun, commit };
}

// --- Wikidata SPARQL ---

async function queryWikidataCountries(qids: string[]): Promise<Map<string, string[]>> {
  const values = qids.map(q => `wd:${q}`).join(' ');
  const sparql = `SELECT ?film ?countryCode WHERE {
  VALUES ?film { ${values} }
  OPTIONAL {
    ?film wdt:P495 ?country.
    ?country wdt:P297 ?countryCode.
  }
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
  const results = new Map<string, string[]>();

  for (const binding of data.results.bindings) {
    const qid = binding.film.value.split('/').pop()!;

    if (!results.has(qid)) {
      results.set(qid, []);
    }

    // countryCode may be absent if OPTIONAL didn't match
    if (binding.countryCode?.value) {
      const code = binding.countryCode.value.toUpperCase();
      const entry = results.get(qid)!;
      if (!entry.includes(code)) {
        entry.push(code);
      }
    }
  }

  return results;
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
      } catch {
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
      } catch {
        // Skip malformed files
      }
    }
  }

  return titles;
}

// --- Git operations ---

function commitRepoChanges(repoPath: string, repoName: string): void {
  const botName = 'mmdb-bot[bot]';
  const botEmail = 'mmdb-bot[bot]@users.noreply.github.com';

  try {
    // Create branch if it doesn't exist
    try {
      execSync(`git rev-parse --verify ${BRANCH_NAME}`, { cwd: repoPath, stdio: 'pipe' });
      execSync(`git checkout ${BRANCH_NAME}`, { cwd: repoPath, stdio: 'pipe' });
    } catch {
      execSync(`git checkout -b ${BRANCH_NAME}`, { cwd: repoPath, stdio: 'pipe' });
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

    // Commit with bot identity
    execSync(
      `git commit --author="${botName} <${botEmail}>" -m "feat: add countries from Wikidata P495"`,
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
    execSync(`git push -u origin ${BRANCH_NAME}`, { cwd: repoPath, stdio: 'pipe' });
    console.log(`  ✓ Committed and pushed ${repoName} → ${BRANCH_NAME}`);

    // Switch back to master
    execSync('git checkout master', { cwd: repoPath, stdio: 'pipe' });
  } catch (error: any) {
    console.error(`  ✗ Git operations failed for ${repoName}:`, error.message);
    // Try to get back to master
    try {
      execSync('git checkout master', { cwd: repoPath, stdio: 'pipe' });
    } catch {}
  }
}

// --- Main ---

async function main() {
  const { year, allFlag, dryRun, commit } = parseArgs();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MMDB Country of Origin Enrichment from Wikidata P495');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode: ${year ? `single year (${year})` : 'all repos'}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Commit: ${commit}`);
  console.log('');

  const repos = getYearRepos(year);
  console.log(`Loading title files from ${repos.length} year repo(s)...`);

  // Step 1: Load all title files and collect Wikidata QIDs
  const repoTitles = new Map<string, TitleFile[]>();
  const allQids: string[] = [];
  const qidSet = new Set<string>();

  for (const repoPath of repos) {
    const titles = loadTitleFiles(repoPath);
    repoTitles.set(repoPath, titles);

    for (const title of titles) {
      const qid = title.data.external_ids?.wikidata;
      if (qid && !qidSet.has(qid)) {
        // Skip titles that already have countries
        if (!title.data.countries || title.data.countries.length === 0) {
          allQids.push(qid);
          qidSet.add(qid);
        }
      }
    }
  }

  const totalTitles = Array.from(repoTitles.values()).reduce((sum, t) => sum + t.length, 0);
  console.log(`  Total titles loaded: ${totalTitles}`);
  console.log(`  QIDs to query: ${allQids.length}`);

  // Step 2: Query Wikidata in batches
  const totalBatches = Math.ceil(allQids.length / WIKIDATA_BATCH_SIZE);
  console.log(`\nQuerying Wikidata (${totalBatches} batches of ${WIKIDATA_BATCH_SIZE})...\n`);

  const countryMap = new Map<string, string[]>(); // QID → country codes

  for (let i = 0; i < allQids.length; i += WIKIDATA_BATCH_SIZE) {
    const batch = allQids.slice(i, i + WIKIDATA_BATCH_SIZE);
    const batchNum = Math.floor(i / WIKIDATA_BATCH_SIZE) + 1;

    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} QIDs)...`);

    try {
      const batchResults = await queryWikidataCountries(batch);
      let withCountry = 0;
      for (const [qid, countries] of batchResults) {
        countryMap.set(qid, countries);
        if (countries.length > 0) withCountry++;
      }
      console.log(` ✓ (${withCountry} with countries)`);
    } catch (error) {
      console.log(` ✗ (${(error as Error).message})`);
      // For failed batches, retry once after longer wait
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        const batchResults = await queryWikidataCountries(batch);
        for (const [qid, countries] of batchResults) {
          countryMap.set(qid, countries);
        }
        console.log(`    ↻ Retry succeeded`);
      } catch (retryError) {
        console.error(`    ↻ Retry also failed, skipping batch`);
      }
    }

    // Rate limit
    if (i + WIKIDATA_BATCH_SIZE < allQids.length) {
      await new Promise(resolve => setTimeout(resolve, WIKIDATA_RATE_LIMIT_MS));
    }
  }

  console.log(`\n  Country data collected for ${countryMap.size} QIDs`);

  // Step 3: Update title files per repo
  console.log(`\nUpdating title files...\n`);

  const totalStats: EnrichmentStats = {
    totalFiles: 0,
    enrichedWithCountries: 0,
    noCountryFound: 0,
    alreadyHasCountries: 0,
    noWikidataId: 0,
    errors: 0,
  };

  for (const repoPath of repos) {
    const repoName = repoPath.split('/').pop()!;
    console.log(`\n── ${repoName} ${'─'.repeat(50 - repoName.length)}`);

    const titles = repoTitles.get(repoPath)!;
    const stats: EnrichmentStats = {
      totalFiles: titles.length,
      enrichedWithCountries: 0,
      noCountryFound: 0,
      alreadyHasCountries: 0,
      noWikidataId: 0,
      errors: 0,
    };

    for (const title of titles) {
      // Skip if already has countries
      if (title.data.countries && title.data.countries.length > 0) {
        stats.alreadyHasCountries++;
        continue;
      }

      const qid = title.data.external_ids?.wikidata;
      if (!qid) {
        stats.noWikidataId++;
        // Still set empty array for consistency
        if (!dryRun) {
          title.data.countries = [];
          title.data.last_updated = new Date().toISOString().split('T')[0];
          writeFileSync(title.path, JSON.stringify(title.data, null, 2) + '\n');
        }
        continue;
      }

      const countries = countryMap.get(qid);
      if (countries && countries.length > 0) {
        // Sort country codes for deterministic output
        const sortedCountries = [...countries].sort();
        if (!dryRun) {
          title.data.countries = sortedCountries;
          title.data.last_updated = new Date().toISOString().split('T')[0];
          writeFileSync(title.path, JSON.stringify(title.data, null, 2) + '\n');
        }
        stats.enrichedWithCountries++;
      } else {
        // No P495 data — set empty array
        if (!dryRun) {
          title.data.countries = [];
          title.data.last_updated = new Date().toISOString().split('T')[0];
          writeFileSync(title.path, JSON.stringify(title.data, null, 2) + '\n');
        }
        stats.noCountryFound++;
      }
    }

    console.log(`  Results:`);
    console.log(`    Enriched (has countries): ${stats.enrichedWithCountries}`);
    console.log(`    No country found:        ${stats.noCountryFound}`);
    console.log(`    Already had countries:    ${stats.alreadyHasCountries}`);
    console.log(`    No Wikidata ID:          ${stats.noWikidataId}`);
    console.log(`    Total files:             ${stats.totalFiles}`);

    // Accumulate
    totalStats.totalFiles += stats.totalFiles;
    totalStats.enrichedWithCountries += stats.enrichedWithCountries;
    totalStats.noCountryFound += stats.noCountryFound;
    totalStats.alreadyHasCountries += stats.alreadyHasCountries;
    totalStats.noWikidataId += stats.noWikidataId;
    totalStats.errors += stats.errors;

    // Commit if requested
    if (commit && !dryRun) {
      commitRepoChanges(repoPath, repoName);
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total files processed:     ${totalStats.totalFiles}`);
  console.log(`  Enriched (has countries):  ${totalStats.enrichedWithCountries}`);
  console.log(`  No country found:          ${totalStats.noCountryFound}`);
  console.log(`  Already had countries:     ${totalStats.alreadyHasCountries}`);
  console.log(`  No Wikidata ID:            ${totalStats.noWikidataId}`);
  console.log(`  Errors:                    ${totalStats.errors}`);
  const coverage = totalStats.totalFiles > 0
    ? ((totalStats.enrichedWithCountries / totalStats.totalFiles) * 100).toFixed(1)
    : '0';
  console.log(`  Country coverage:          ${coverage}%`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(error => {
  console.error('Enrichment failed:', error);
  process.exit(1);
});
