#!/usr/bin/env node

/**
 * MMDB Fix People Filenames — Add missing `p_` prefix
 *
 * All person files were created WITHOUT the `p_` prefix in their filename.
 * The internal `id` field IS correct (has `p_` prefix). Only filenames are wrong.
 *
 * Uses the Git Trees API with base_tree + sha:null for deletions:
 * - For each batch of files to rename:
 *   1. Include old path with sha=null (deletion)
 *   2. Include new path (p_ + old) with the blob SHA (addition)
 *   3. POST with base_tree = current root tree SHA
 *   4. Create commit pointing to new tree
 *
 * Batches ~250 renames per commit (500 tree entries) to stay within API limits.
 * Creates a single branch with all batch commits, then opens PR and squash merges.
 *
 * Index.json is NOT rebuilt here — the CI validate workflow rebuilds it
 * automatically after merge via workflow_dispatch.
 *
 * Usage:
 *   node scripts/fix-people-filenames.mjs              # Fix all repos
 *   node scripts/fix-people-filenames.mjs --letter=s   # Fix specific repo
 *   node scripts/fix-people-filenames.mjs --dry-run    # Just show counts
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
  retryOnServerError,
  createGitHubClient,
  getDefaultBranchSha,
  createBranch,
  createPR,
  enableAutoMerge,
  repoExists,
  GITHUB_RATE_LIMIT_MS,
} from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');
const INTER_REPO_DELAY_MS = 10000; // 10s between repos
const LARGE_REPO_DELAY_MS = 60000; // 60s after repos with >2000 files
const BATCH_SIZE = 250; // Renames per commit (= 500 tree entries: 250 deletes + 250 adds)
const RATE_LIMIT_RETRY_DELAY_MS = 60000; // Wait 60s on rate limit, then retry
const MAX_RATE_LIMIT_RETRIES = 3;

// ─── Parse arguments ─────────────────────────────────────────────────────────

const dryRun = process.argv.includes('--dry-run');
const letterFlag = process.argv.find(a => a.startsWith('--letter='));
const targetLetters = letterFlag
  ? [letterFlag.split('=')[1].toLowerCase().trim()]
  : ALPHABET;

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
  process.exit(1);
}

// ─── GitHub client ───────────────────────────────────────────────────────────

const { ghApi, ghGraphQL } = createGitHubClient(tokenManager || token);

// ─── API helpers ─────────────────────────────────────────────────────────────

/**
 * Get the recursive tree for a repo's master branch.
 * Returns the full tree with all paths.
 */
async function getRecursiveTree(repo, treeSha) {
  const { ok, data } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repo}/git/trees/${treeSha}?recursive=1`)
  );
  if (!ok) throw new Error(`Failed to get recursive tree: ${data.message || JSON.stringify(data)}`);
  return data;
}

/**
 * Create a tree with base_tree (only include changed entries).
 * Entries with sha=null are deleted. Others are added/modified.
 */
async function createTreeWithBase(repo, baseSha, entries) {
  const { ok, data } = await retryOnServerError(
    () => ghApi('POST', `/repos/${ORG}/${repo}/git/trees`, {
      base_tree: baseSha,
      tree: entries,
    })
  );
  if (!ok) throw new Error(`Failed to create tree: ${data.message || JSON.stringify(data)}`);
  return data.sha;
}

/**
 * Create a commit.
 */
async function createCommit(repo, message, treeSha, parentSha) {
  const { ok, data } = await retryOnServerError(
    () => ghApi('POST', `/repos/${ORG}/${repo}/git/commits`, {
      message,
      tree: treeSha,
      parents: [parentSha],
    })
  );
  if (!ok) throw new Error(`Failed to create commit: ${data.message || JSON.stringify(data)}`);
  return data.sha;
}

// ─── Process a single repo ───────────────────────────────────────────────────

async function processRepo(letter) {
  const repoName = `mmdb-people-${letter}`;

  // Check repo exists
  const exists = await repoExists(ghApi, repoName);
  if (!exists) {
    return { letter, status: 'skipped', reason: 'repo does not exist', renamed: 0 };
  }

  // Get master SHA
  const masterSha = await getDefaultBranchSha(ghApi, repoName);
  if (!masterSha) {
    return { letter, status: 'error', reason: 'could not get master SHA', renamed: 0 };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Get commit to find root tree SHA
  const { ok: commitOk, data: commitData } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repoName}/git/commits/${masterSha}`)
  );
  if (!commitOk) {
    return { letter, status: 'error', reason: 'could not get commit', renamed: 0 };
  }
  const rootTreeSha = commitData.tree.sha;
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Get full recursive tree to find all people files
  const fullTree = await getRecursiveTree(repoName, rootTreeSha);
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Find people files that need renaming
  const filesToRename = [];
  const alreadyCorrect = [];

  for (const entry of fullTree.tree) {
    if (entry.type !== 'blob') continue;
    if (!entry.path.startsWith('data/people/')) continue;
    if (entry.path === 'data/people/index.json') continue;
    if (!entry.path.endsWith('.json')) continue;

    const filename = entry.path.replace('data/people/', '');
    if (filename.startsWith('p_')) {
      alreadyCorrect.push(entry);
    } else {
      filesToRename.push(entry);
    }
  }

  if (filesToRename.length === 0) {
    log(`  No files need renaming (${alreadyCorrect.length} already correct)`);
    return { letter, status: 'skipped', reason: 'all files already correct', renamed: 0 };
  }

  log(`  Files to rename: ${filesToRename.length}, already correct: ${alreadyCorrect.length}`);

  if (dryRun) {
    return { letter, status: 'dry-run', renamed: filesToRename.length };
  }

  // ─── Batch rename via tree API ─────────────────────────────────────────────

  const totalBatches = Math.ceil(filesToRename.length / BATCH_SIZE);
  let currentParentSha = masterSha;
  let currentTreeSha = rootTreeSha;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = filesToRename.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
    const batchLabel = totalBatches > 1 ? ` (batch ${batchIdx + 1}/${totalBatches})` : '';
    log(`  Renaming ${batch.length} files${batchLabel}...`);

    // Build tree entries: delete old path + add new path for each file
    const treeEntries = [];
    for (const entry of batch) {
      const filename = entry.path.replace('data/people/', '');
      const newPath = `data/people/p_${filename}`;

      // Delete old file
      treeEntries.push({
        path: entry.path,
        mode: entry.mode,
        type: 'blob',
        sha: null,
      });

      // Add new file (same blob SHA, different path)
      treeEntries.push({
        path: newPath,
        mode: entry.mode,
        type: 'blob',
        sha: entry.sha,
      });
    }

    // Create new tree with base_tree
    const newTreeSha = await createTreeWithBase(repoName, currentTreeSha, treeEntries);
    await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

    // Create commit
    const commitMsg = totalBatches > 1
      ? `fix: add p_ prefix to ${batch.length} people filenames (${batchIdx + 1}/${totalBatches})`
      : `fix: add p_ prefix to ${filesToRename.length} people filenames`;

    currentParentSha = await createCommit(repoName, commitMsg, newTreeSha, currentParentSha);
    currentTreeSha = newTreeSha;
    await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

    log(`  ✓ Batch ${batchIdx + 1} committed`);

    // Brief pause between batches
    if (batchIdx < totalBatches - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ─── Create branch pointing to final commit ───────────────────────────────

  const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const branchName = `mmdb-fix/people-filenames-${letter}-${runDate}`;

  const { ok: branchOk } = await createBranch(ghApi, repoName, branchName, currentParentSha);
  if (!branchOk) {
    throw new Error(`Failed to create branch ${branchName}`);
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  log(`  Branch: ${branchName}`);

  // ─── Create PR ────────────────────────────────────────────────────────────

  const prTitle = `fix: add p_ prefix to ${filesToRename.length} people filenames`;
  const prBody = [
    '## Filename Fix',
    '',
    `Adds missing \`p_\` prefix to ${filesToRename.length} people filenames.`,
    '',
    '**Problem:** Files were created as `{slug}.json` instead of `p_{slug}.json`.',
    '**Fix:** Rename all affected files. CI will rebuild index.json on merge.',
    '',
    `- Files renamed: ${filesToRename.length}`,
    `- Already correct: ${alreadyCorrect.length}`,
    `- Batches: ${totalBatches}`,
  ].join('\n');

  const { ok: prOk, data: prData } = await createPR(ghApi, repoName, prTitle, branchName, prBody);
  if (!prOk) {
    throw new Error(`Failed to create PR: ${prData.message || JSON.stringify(prData)}`);
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  log(`  PR: ${repoName}#${prData.number}`);

  // ─── Squash merge ─────────────────────────────────────────────────────────

  await new Promise(r => setTimeout(r, 3000)); // Let GitHub process PR

  const { ok: mergeOk } = await retryOnServerError(
    () => ghApi('PUT', `/repos/${ORG}/${repoName}/pulls/${prData.number}/merge`, {
      merge_method: 'squash',
      commit_title: prTitle,
    })
  );

  if (mergeOk) {
    log(`  ✓ Squash merged`);

    // Delete branch
    await retryOnServerError(
      () => ghApi('DELETE', `/repos/${ORG}/${repoName}/git/refs/heads/${branchName}`)
    );

    // Trigger CI to rebuild index
    await new Promise(r => setTimeout(r, 1000));
    const { ok: dispatchOk } = await retryOnServerError(
      () => ghApi('POST', `/repos/${ORG}/${repoName}/actions/workflows/validate.yml/dispatches`, {
        ref: 'master',
      })
    );
    if (dispatchOk) {
      log(`  CI dispatched (will rebuild index.json)`);
    }
  } else {
    // Try auto-merge if direct merge is blocked (status checks pending)
    const autoOk = await enableAutoMerge(ghApi, ghGraphQL, repoName, prData.number);
    log(`  ⚠ Direct merge blocked, auto-merge ${autoOk ? 'enabled' : 'failed'}`);
  }

  return {
    letter,
    status: 'success',
    renamed: filesToRename.length,
    alreadyCorrect: alreadyCorrect.length,
    batches: totalBatches,
    pr: `${repoName}#${prData.number}`,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
const options = [];
if (dryRun) options.push('dry-run');
if (letterFlag) options.push(`letter=${targetLetters[0]}`);

log('═══════════════════════════════════════════');
log('MMDB Fix People Filenames — Add p_ prefix');
log(`Options: ${options.length > 0 ? options.join(', ') : 'none'}`);
log(`Target letters: ${targetLetters.join(', ')}`);
log(`Auth: ${authMethod}`);
log(`Batch size: ${BATCH_SIZE} renames/commit`);
log('═══════════════════════════════════════════');
log('');

const results = [];
const repoProgress = createProgress(targetLetters.length, 'Repos');

for (let i = 0; i < targetLetters.length; i++) {
  const letter = targetLetters[i];
  const repoName = `mmdb-people-${letter}`;
  log(`── ${letter.toUpperCase()} ── (${i + 1}/${targetLetters.length}) ${repoName}`);

  try {
    let result;
    let rateLimitRetries = 0;

    while (rateLimitRetries <= MAX_RATE_LIMIT_RETRIES) {
      try {
        result = await processRepo(letter);
        break; // Success
      } catch (err) {
        if (err.message.includes('403') && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++;
          log(`  ⚠ Rate limited (403) — waiting ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s before retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}...`);
          await new Promise(r => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
        } else {
          throw err;
        }
      }
    }

    results.push(result);

    if (result.status === 'success') {
      log(`  ✓ Done: ${result.renamed} files renamed in ${result.batches} batch(es)`);
      // Longer delay after large repos to avoid secondary rate limits
      if (result.renamed > 2000 && i < targetLetters.length - 1) {
        log(`  Large repo — extra cooling: ${LARGE_REPO_DELAY_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, LARGE_REPO_DELAY_MS));
      }
    } else if (result.status === 'dry-run') {
      log(`  [dry-run] Would rename ${result.renamed} files`);
    } else {
      log(`  ○ ${result.reason}`);
    }
  } catch (err) {
    log(`  ✗ ERROR: ${err.message}`);
    results.push({ letter, status: 'error', reason: err.message, renamed: 0 });
  }

  // Wait between repos (not after last one)
  repoProgress.tick(`${letter.toUpperCase()}`);
  if (i < targetLetters.length - 1 && !dryRun) {
    log(`  Waiting ${INTER_REPO_DELAY_MS / 1000}s...`);
    await new Promise(r => setTimeout(r, INTER_REPO_DELAY_MS));
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

repoProgress.done();

const totalDuration = Date.now() - startedAt;
const successResults = results.filter(r => r.status === 'success');
const errorResults = results.filter(r => r.status === 'error');
const skippedResults = results.filter(r => r.status === 'skipped');
const dryRunResults = results.filter(r => r.status === 'dry-run');
const totalRenamed = successResults.reduce((sum, r) => sum + r.renamed, 0);
const totalWouldRename = dryRunResults.reduce((sum, r) => sum + r.renamed, 0);

log('');
log('═══════════════════════════════════════════');
log('FIX PEOPLE FILENAMES — COMPLETE');
log('───────────────────────────────────────────');
if (dryRun) {
  log(`Would rename: ${totalWouldRename.toLocaleString()} files across ${dryRunResults.length} repos`);
} else {
  log(`Renamed: ${totalRenamed.toLocaleString()} files across ${successResults.length} repos`);
}
log(`Success: ${successResults.length}, Errors: ${errorResults.length}, Skipped: ${skippedResults.length}`);
log(`Duration: ${formatDuration(totalDuration)}`);
log('═══════════════════════════════════════════');

if (errorResults.length > 0) {
  log('');
  log('Errors (retry with --letter=X):');
  for (const r of errorResults) {
    log(`  ${r.letter.toUpperCase()}: ${r.reason}`);
  }
}

// ─── Write results ───────────────────────────────────────────────────────────

const summaryPath = resolve(__dirname, 'fix-people-filenames-results.json');
const summary = {
  mode: dryRun ? 'dry-run' : 'execute',
  startedAt: new Date(startedAt).toISOString(),
  completedAt: new Date().toISOString(),
  duration: formatDuration(totalDuration),
  targetLetters,
  totals: {
    renamed: dryRun ? totalWouldRename : totalRenamed,
    success: successResults.length,
    errors: errorResults.length,
    skipped: skippedResults.length,
  },
  results,
};

writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
log(`\nResults written to: ${summaryPath}`);
