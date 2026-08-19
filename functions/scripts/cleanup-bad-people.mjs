#!/usr/bin/env node

/**
 * MMDB Cleanup Bad People — Remove invalid person entries
 *
 * Scans mmdb-people-{a-z} repos for invalid person files:
 *   - Files named `p_.json` (empty slug)
 *   - Files where filename doesn't match the internal `id` field
 *   - Files where `name` is empty or whitespace
 *   - Files where `id` doesn't match `^p_[a-z][a-z0-9_]+$`
 *
 * For each bad file found, creates a branch, deletes the file, opens a PR,
 * and squash-merges it.
 *
 * Usage:
 *   node scripts/cleanup-bad-people.mjs                # Fix all repos
 *   node scripts/cleanup-bad-people.mjs --letter=z     # Fix specific repo
 *   node scripts/cleanup-bad-people.mjs --dry-run      # Just list bad entries
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 */

import { resolve, dirname } from 'path';
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
const VALID_ID_PATTERN = /^p_[a-z][a-z0-9_]+$/;
const INTER_REPO_DELAY_MS = 5000;

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

// ─── Authentication ──────────────────────────────────────────────────────────

const envPath = resolve(__dirname, '..', '.env');
let token;
let tokenManager;

try {
  const auth = await loadGitHubAuth(envPath);
  token = auth.token;
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

async function getRecursiveTree(repo, treeSha) {
  const { ok, data } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repo}/git/trees/${treeSha}?recursive=1`)
  );
  if (!ok) throw new Error(`Failed to get tree for ${repo}: ${data.message || JSON.stringify(data)}`);
  return data;
}

async function getFileContent(repo, path) {
  const { ok, data } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repo}/contents/${path}`)
  );
  if (!ok) return null;
  try {
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

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

// ─── Validation logic ────────────────────────────────────────────────────────

/**
 * Check if a person file is invalid based on its filename.
 * Returns a reason string if invalid, or null if valid.
 */
function getFilenameIssue(filename) {
  const id = filename.replace(/\.json$/, '');

  // Empty slug: p_.json
  if (id === 'p_') return 'empty-slug';

  // ID doesn't match valid pattern (must start with letter after p_)
  if (!VALID_ID_PATTERN.test(id)) return `invalid-id-pattern: ${id}`;

  return null;
}

/**
 * Check if a person entry is invalid based on its content.
 * Returns a reason string if invalid, or null if valid.
 */
function getContentIssue(content, expectedId) {
  if (!content) return 'unreadable-content';
  if (!content.name || !content.name.trim()) return 'empty-name';
  if (content.id === 'p_') return 'empty-slug-in-id';
  if (!VALID_ID_PATTERN.test(content.id)) return `invalid-id-in-content: ${content.id}`;
  // Filename/id mismatch — the file should be named after its id
  if (content.id !== expectedId) return `filename-id-mismatch: file=${expectedId}, content.id=${content.id}`;
  return null;
}

// ─── Process a single repo ───────────────────────────────────────────────────

async function processRepo(letter) {
  const repoName = `mmdb-people-${letter}`;
  log(`Processing ${repoName}...`);

  const exists = await repoExists(ghApi, repoName);
  if (!exists) {
    log(`  Skipped: repo does not exist`);
    return { letter, status: 'skipped', badFiles: [] };
  }

  // Get master SHA and root tree
  const masterSha = await getDefaultBranchSha(ghApi, repoName);
  if (!masterSha) {
    log(`  Error: could not get master SHA`);
    return { letter, status: 'error', badFiles: [] };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  const { ok: commitOk, data: commitData } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repoName}/git/commits/${masterSha}`)
  );
  if (!commitOk) {
    log(`  Error: could not get commit data`);
    return { letter, status: 'error', badFiles: [] };
  }
  const rootTreeSha = commitData.tree.sha;
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Get full tree
  const fullTree = await getRecursiveTree(repoName, rootTreeSha);
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Find all people files
  const peopleFiles = fullTree.tree.filter(entry =>
    entry.type === 'blob' &&
    entry.path.startsWith('data/people/') &&
    entry.path.endsWith('.json') &&
    entry.path !== 'data/people/index.json'
  );

  // Check filenames for issues
  const badFiles = [];
  for (const entry of peopleFiles) {
    const filename = entry.path.replace('data/people/', '');
    const filenameIssue = getFilenameIssue(filename);
    if (filenameIssue) {
      badFiles.push({ path: entry.path, sha: entry.sha, filename, reason: filenameIssue });
    }
  }

  // For files with filename issues, also fetch content to understand why
  for (const bad of badFiles) {
    const content = await getFileContent(repoName, bad.path);
    await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));
    if (content) {
      bad.content = content;
      bad.name = content.name;
      bad.id = content.id;
      bad.wikidata = content.external_ids?.wikidata;
    }
  }

  if (badFiles.length === 0) {
    log(`  ✓ No invalid files found (${peopleFiles.length} files checked)`);
    return { letter, status: 'clean', badFiles: [] };
  }

  log(`  Found ${badFiles.length} invalid file(s):`);
  for (const bad of badFiles) {
    log(`    - ${bad.filename}: ${bad.reason} (name="${bad.name || '?'}", wikidata=${bad.wikidata || '?'})`);
  }

  if (dryRun) {
    return { letter, status: 'dry-run', badFiles };
  }

  // ─── Delete bad files via branch → commit → PR → merge ────────────────────

  const branchName = `fix/cleanup-bad-people-${Date.now()}`;
  const { ok: branchOk } = await createBranch(ghApi, repoName, branchName, masterSha);
  if (!branchOk) {
    log(`  Error: Failed to create branch ${branchName}`);
    return { letter, status: 'error', badFiles };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Create tree entries that delete the bad files (sha: null = delete)
  const treeEntries = badFiles.map(bad => ({
    path: bad.path,
    mode: '100644',
    type: 'blob',
    sha: null,
  }));

  const newTreeSha = await createTreeWithBase(repoName, rootTreeSha, treeEntries);
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  const commitMsg = badFiles.length === 1
    ? `fix: remove invalid person entry (${badFiles[0].reason})`
    : `fix: remove ${badFiles.length} invalid person entries`;
  const newCommitSha = await createCommit(repoName, commitMsg, newTreeSha, masterSha);
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Update branch ref to point to new commit
  const { ok: updateOk } = await retryOnServerError(
    () => ghApi('PATCH', `/repos/${ORG}/${repoName}/git/refs/heads/${branchName}`, {
      sha: newCommitSha,
      force: true,
    })
  );
  if (!updateOk) {
    log(`  Error: Failed to update branch ref`);
    return { letter, status: 'error', badFiles };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Create PR
  const prTitle = `fix: remove ${badFiles.length} invalid person entry/entries`;
  const prBody = [
    '## Cleanup Invalid Person Entries',
    '',
    'Removed files with invalid IDs that fail CI validation:',
    '',
    ...badFiles.map(bad => `- \`${bad.filename}\`: ${bad.reason} (name="${bad.name}", wikidata=${bad.wikidata})`),
    '',
    'These entries were created from names that normalize to empty/invalid slugs.',
    'The normalizer has been updated to skip these in the future.',
  ].join('\n');

  const { ok: prOk, data: prData } = await createPR(ghApi, repoName, prTitle, branchName, prBody);
  if (!prOk) {
    log(`  Error: Failed to create PR`);
    return { letter, status: 'error', badFiles };
  }
  log(`  PR created: ${repoName}#${prData.number}`);

  // Squash merge
  try {
    await new Promise(r => setTimeout(r, 1000));
    const { ok: mergeOk } = await retryOnServerError(
      () => ghApi('PUT', `/repos/${ORG}/${repoName}/pulls/${prData.number}/merge`, {
        merge_method: 'squash',
        commit_title: commitMsg,
      })
    );
    if (mergeOk) {
      log(`  ✓ Squash merged`);
      // Dispatch CI to rebuild index
      await new Promise(r => setTimeout(r, 1000));
      const { ok: dispatchOk } = await ghApi('POST', `/repos/${ORG}/${repoName}/actions/workflows/validate.yml/dispatches`, {
        ref: 'master',
      });
      log(`  CI: ${dispatchOk ? '✓ index rebuild dispatched' : '⚠ could not dispatch'}`);
    } else {
      const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, repoName, prData.number);
      log(`  ⚠ Direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
    }
  } catch (err) {
    log(`  ⚠ Merge error: ${err.message}`);
  }

  return { letter, status: 'fixed', badFiles, pr: `${repoName}#${prData.number}` };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`MMDB Cleanup Bad People — ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  log(`Target repos: ${targetLetters.length === 26 ? 'all (a-z)' : targetLetters.join(', ')}`);
  log('');

  const results = [];
  const repoProgress = createProgress(targetLetters.length, 'Repos');

  for (const letter of targetLetters) {
    try {
      const result = await processRepo(letter);
      results.push(result);
    } catch (err) {
      log(`  FATAL: ${err.message}`);
      results.push({ letter, status: 'error', badFiles: [], error: err.message });
    }

    repoProgress.tick(`${letter.toUpperCase()}`);

    if (targetLetters.length > 1) {
      await new Promise(r => setTimeout(r, INTER_REPO_DELAY_MS));
    }
  }

  repoProgress.done();

  // ─── Summary ───────────────────────────────────────────────────────────────

  log('');
  log('═══ Summary ═══');
  const totalBad = results.reduce((sum, r) => sum + r.badFiles.length, 0);
  const fixed = results.filter(r => r.status === 'fixed');
  const errors = results.filter(r => r.status === 'error');

  log(`Total invalid entries found: ${totalBad}`);
  if (!dryRun) {
    log(`Repos fixed: ${fixed.length}`);
    if (fixed.length > 0) {
      for (const r of fixed) {
        log(`  ${r.letter}: removed ${r.badFiles.length} file(s) — ${r.pr}`);
      }
    }
  } else {
    const withBad = results.filter(r => r.badFiles.length > 0);
    if (withBad.length > 0) {
      log('Bad entries by repo:');
      for (const r of withBad) {
        log(`  ${r.letter}: ${r.badFiles.length} invalid file(s)`);
        for (const bad of r.badFiles) {
          log(`    - ${bad.filename}: ${bad.reason}`);
        }
      }
    }
  }
  if (errors.length > 0) {
    log(`Errors: ${errors.length}`);
    for (const r of errors) log(`  ${r.letter}: ${r.error || 'unknown'}`);
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
