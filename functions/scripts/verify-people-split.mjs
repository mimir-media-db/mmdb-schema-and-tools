#!/usr/bin/env node

/**
 * Verify data integrity across all 26 alphabetical people repos after the split migration.
 *
 * Checks:
 * 1. Repo exists (was created)
 * 2. Index vs file count — entries in index.json vs actual p_*.json files
 * 3. Routing correctness — all person files start with correct letter
 * 4. Total count — sum across all repos vs original mmdb-people total (~4,452)
 * 5. No orphans — every entry in original mmdb-people exists in a split repo
 */

import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = resolve(__dirname, '..', '.env');

const ORG = 'mimir-media-db';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DELAY_MS = 400; // delay between repo checks for rate limiting

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
 * Get the full recursive tree for a repo.
 * Returns null if repo doesn't exist (404).
 */
async function getRepoTree(token, repo) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/git/trees/master?recursive=1`;
  const res = await ghFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET tree ${repo} failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.tree;
}

/**
 * Get index.json content from a repo. Returns parsed array/object or null if not found.
 * Handles large files via Blob API.
 */
async function getIndexContent(token, repo, path) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/contents/${path}?ref=master`;
  const res = await ghFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} in ${repo} failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  let content;
  if (data.content && data.encoding === 'base64') {
    content = Buffer.from(data.content, 'base64').toString('utf8');
  } else if (data.sha) {
    // Large file — fetch via Blob API
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
    throw new Error(`Cannot read ${path} in ${repo}: no content and no sha`);
  }

  return JSON.parse(content);
}

/**
 * Extract person .json filenames from a tree under data/people/
 * In split repos: files are named like `aad_van_toor.json` (no p_ prefix)
 * In original repo: files are named like `p_aad_van_toor.json` (with p_ prefix)
 */
function getPeopleFiles(tree, { requirePrefix = false } = {}) {
  const prefix = 'data/people/';
  return tree
    .filter(item => {
      if (item.type !== 'blob') return false;
      if (!item.path.startsWith(prefix)) return false;
      const filename = item.path.slice(prefix.length);
      if (filename.includes('/')) return false; // skip subdirs
      if (filename === 'index.json') return false;
      if (!filename.endsWith('.json')) return false;
      if (requirePrefix && !filename.startsWith('p_')) return false;
      return true;
    })
    .map(item => item.path.slice(prefix.length));
}

/**
 * Normalize a person filename to a canonical form (without p_ prefix)
 * e.g. "p_aad_van_toor.json" -> "aad_van_toor.json"
 *      "aad_van_toor.json" -> "aad_van_toor.json"
 */
function normalizeName(filename) {
  return filename.startsWith('p_') ? filename.slice(2) : filename;
}

async function main() {
  console.log('🔐 Authenticating with GitHub...');
  const { token, method } = await loadGitHubAuth(ENV_PATH);
  if (!token) {
    console.error('❌ No GitHub auth available. Check .env file.');
    process.exit(1);
  }
  console.log(`✅ Auth: ${method}\n`);

  // ─── Phase 1: Check each split repo ───────────────────────────────────────────

  console.log('━'.repeat(80));
  console.log('PHASE 1: Checking split repos (mmdb-people-a through mmdb-people-z)');
  console.log('━'.repeat(80));

  const results = [];
  let totalSplitFiles = 0;
  const allSplitFilenames = new Set();

  for (const letter of LETTERS) {
    const repo = `mmdb-people-${letter}`;
    process.stdout.write(`  ${repo.padEnd(18)}`);

    try {
      const tree = await getRepoTree(token, repo);

      if (tree === null) {
        console.log('❌ REPO NOT FOUND');
        results.push({ letter, repo, exists: false, error: 'Repo not found' });
        await sleep(DELAY_MS);
        continue;
      }

      // Get people files from tree
      const peopleFiles = getPeopleFiles(tree);

      // Get index.json
      const index = await getIndexContent(token, repo, 'data/people/index.json');
      const indexCount = index ? (Array.isArray(index) ? index.length : Object.keys(index).length) : 0;

      // Check routing — all files should start with {letter} (no p_ prefix in split repos)
      const misrouted = peopleFiles.filter(f => !f.startsWith(`${letter}`));

      // Track totals
      totalSplitFiles += peopleFiles.length;
      for (const f of peopleFiles) {
        allSplitFilenames.add(normalizeName(f));
      }

      const entry = {
        letter,
        repo,
        exists: true,
        fileCount: peopleFiles.length,
        indexCount,
        indexMatch: indexCount === peopleFiles.length,
        misrouted: misrouted.length,
        misroutedFiles: misrouted.slice(0, 5), // sample
      };
      results.push(entry);

      const matchIcon = entry.indexMatch ? '✓' : '✗';
      const routeIcon = misrouted.length === 0 ? '✓' : '✗';
      console.log(
        `files:${String(entry.fileCount).padEnd(5)} ` +
        `idx:${String(indexCount).padEnd(5)} ` +
        `match:${matchIcon}  route:${routeIcon}` +
        (misrouted.length > 0 ? `  (${misrouted.length} misrouted!)` : '')
      );
    } catch (err) {
      console.log(`❌ ERROR: ${err.message}`);
      results.push({ letter, repo, exists: false, error: err.message });
    }

    await sleep(DELAY_MS);
  }

  // ─── Phase 2: Get original mmdb-people total ──────────────────────────────────

  console.log('\n' + '━'.repeat(80));
  console.log('PHASE 2: Checking original mmdb-people repo');
  console.log('━'.repeat(80));

  let originalTotal = 0;
  const originalFilenames = new Set();

  try {
    const originalTree = await getRepoTree(token, 'mmdb-people');
    if (originalTree === null) {
      console.log('  ❌ Original mmdb-people repo not found!');
    } else {
      const originalFiles = getPeopleFiles(originalTree, { requirePrefix: true });
      originalTotal = originalFiles.length;
      for (const f of originalFiles) {
        originalFilenames.add(normalizeName(f));
      }
      console.log(`  Original mmdb-people: ${originalTotal} people files`);
    }
  } catch (err) {
    console.log(`  ❌ Error reading mmdb-people: ${err.message}`);
  }

  // ─── Phase 3: Orphan check ────────────────────────────────────────────────────

  console.log('\n' + '━'.repeat(80));
  console.log('PHASE 3: Orphan check (files in original NOT in any split repo)');
  console.log('━'.repeat(80));

  const orphans = [];
  for (const f of originalFilenames) {
    if (!allSplitFilenames.has(f)) {
      orphans.push(f);
    }
  }

  if (orphans.length === 0) {
    console.log('  ✅ No orphans — all original files exist in split repos');
  } else {
    console.log(`  ⚠️  ${orphans.length} orphan(s) found:`);
    for (const o of orphans.slice(0, 20)) {
      console.log(`    - ${o}`);
    }
    if (orphans.length > 20) {
      console.log(`    ... and ${orphans.length - 20} more`);
    }
  }

  // ─── Summary Table ────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(80));
  console.log('VERIFICATION SUMMARY');
  console.log('═'.repeat(80));
  console.log(
    'Letter'.padEnd(8) +
    'Repo'.padEnd(20) +
    'Exists'.padEnd(8) +
    'Files'.padEnd(8) +
    'Index'.padEnd(8) +
    'Match'.padEnd(8) +
    'Route'
  );
  console.log('─'.repeat(80));

  for (const r of results) {
    if (r.error && !r.exists) {
      console.log(
        r.letter.padEnd(8) +
        r.repo.padEnd(20) +
        '❌'.padEnd(8) +
        '-'.padEnd(8) +
        '-'.padEnd(8) +
        '-'.padEnd(8) +
        '-'
      );
    } else {
      console.log(
        r.letter.padEnd(8) +
        r.repo.padEnd(20) +
        '✓'.padEnd(8) +
        String(r.fileCount).padEnd(8) +
        String(r.indexCount).padEnd(8) +
        (r.indexMatch ? '✓' : '✗').padEnd(8) +
        (r.misrouted === 0 ? '✓' : `✗(${r.misrouted})`)
      );
    }
  }

  console.log('─'.repeat(80));

  // Totals
  const existingRepos = results.filter(r => r.exists);
  const mismatches = results.filter(r => r.exists && !r.indexMatch);
  const misroutedRepos = results.filter(r => r.exists && r.misrouted > 0);
  const missingRepos = results.filter(r => !r.exists);

  console.log(`\n📊 TOTALS:`);
  console.log(`  Repos existing:       ${existingRepos.length}/26`);
  console.log(`  Repos missing:        ${missingRepos.length} ${missingRepos.length > 0 ? '(' + missingRepos.map(r => r.letter).join(', ') + ')' : ''}`);
  console.log(`  Total files (split):  ${totalSplitFiles}`);
  console.log(`  Total files (orig):   ${originalTotal}`);
  console.log(`  Coverage:             ${totalSplitFiles}/${originalTotal} (${originalTotal ? ((totalSplitFiles / originalTotal) * 100).toFixed(1) : 0}%)`);
  console.log(`  Index mismatches:     ${mismatches.length}`);
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.log(`    ${m.repo}: index=${m.indexCount} files=${m.fileCount}`);
    }
  }
  console.log(`  Routing errors:       ${misroutedRepos.length}`);
  if (misroutedRepos.length > 0) {
    for (const m of misroutedRepos) {
      console.log(`    ${m.repo}: ${m.misrouted} misrouted files (e.g., ${m.misroutedFiles.join(', ')})`);
    }
  }
  console.log(`  Orphans:              ${orphans.length}`);
  if (orphans.length > 0) {
    console.log(`    Examples: ${orphans.slice(0, 5).join(', ')}`);
  }

  // Final verdict
  console.log('\n' + '═'.repeat(80));
  const allGood = missingRepos.length === 0 && mismatches.length === 0 &&
    misroutedRepos.length === 0 && orphans.length === 0 &&
    totalSplitFiles >= originalTotal;

  if (allGood) {
    console.log('✅ VERIFICATION PASSED — All data integrity checks pass!');
  } else {
    console.log('⚠️  VERIFICATION COMPLETE — Issues found (see above)');
    if (missingRepos.length > 0) console.log(`   • ${missingRepos.length} repos not created`);
    if (mismatches.length > 0) console.log(`   • ${mismatches.length} index/file count mismatches`);
    if (misroutedRepos.length > 0) console.log(`   • ${misroutedRepos.length} repos with misrouted files`);
    if (orphans.length > 0) console.log(`   • ${orphans.length} orphaned files from original`);
    if (totalSplitFiles < originalTotal) console.log(`   • Split total (${totalSplitFiles}) < original (${originalTotal})`);
  }
  console.log('═'.repeat(80));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
