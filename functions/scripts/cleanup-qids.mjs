#!/usr/bin/env node

/**
 * MMDB Q-ID Cleanup Script
 *
 * Removes entries from year repos where the title is a Wikidata Q-ID
 * (e.g., Q140513842) instead of a real movie/series name.
 *
 * Usage:
 *   node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026 --dry-run
 *   node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 *   GITHUB_TOKEN — Personal access token fallback
 *
 * Behavior:
 *   - Scans data/movies/ and data/series/ for files matching q\d+-YYYY.json
 *   - Reads each file and checks if title matches /^Q\d+$/i
 *   - Entries with no external IDs (IMDb/TMDB): marked for deletion
 *   - Entries with external IDs: logged for future re-resolution (not deleted)
 *   - Creates a PR to delete the Q-ID entries (unless --dry-run)
 */

const ORG = 'mimir-media-db';
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

const repoFlag = process.argv.find(a => a.startsWith('--repo='));
const dryRun = process.argv.includes('--dry-run');

if (!repoFlag) {
  console.error(`
Usage: node functions/scripts/cleanup-qids.mjs --repo=<repo-name> [--dry-run]

Options:
  --repo=mmdb-YYYY   Target year repo to clean
  --dry-run          Show what would be deleted without making changes

Example:
  node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026 --dry-run
  node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026
`);
  process.exit(1);
}

const repo = repoFlag.split('=')[1];

// ─── Authentication ──────────────────────────────────────────────────────────

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadGitHubAuth } from './lib/github-app-auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

let token;
let authMethod;

try {
  const auth = await loadGitHubAuth(envPath);
  token = auth.token;
  authMethod = auth.method;
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

console.log(`Auth: ${authMethod}`);

const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function listDirectory(dir) {
  const { ok, data } = await api('GET', `/repos/${ORG}/${repo}/contents/${dir}?ref=master`);
  if (!ok) return [];
  if (!Array.isArray(data)) return [];
  return data.filter(f => f.type === 'file' && f.name.endsWith('.json') && f.name !== 'index.json');
}

async function getFileContent(path) {
  const { ok, data } = await api('GET', `/repos/${ORG}/${repo}/contents/${path}?ref=master`);
  if (!ok) throw new Error(`Could not read ${path}: ${data.message}`);
  return {
    content: JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8')),
    sha: data.sha,
  };
}

async function getDefaultBranchSha() {
  const { data } = await api('GET', `/repos/${ORG}/${repo}/git/ref/heads/master`);
  return data.object.sha;
}

async function createBranch(branchName, sha) {
  return api('POST', `/repos/${ORG}/${repo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha,
  });
}

async function deleteFile(path, sha, branch, message) {
  return api('DELETE', `/repos/${ORG}/${repo}/contents/${path}`, {
    message,
    sha,
    branch,
  });
}

async function createPR(title, head, body) {
  return api('POST', `/repos/${ORG}/${repo}/pulls`, {
    title,
    head,
    base: 'master',
    body,
  });
}

// ─── Batch Delete (Git Trees API) ────────────────────────────────────────────

const MAX_TREE_BATCH_SIZE = 400;

/**
 * Delete a batch of files in a single commit using the Git Trees API.
 */
async function deleteBatchCommit(branch, paths, message) {
  if (paths.length === 0) return;

  // Sub-batch if too large
  if (paths.length > MAX_TREE_BATCH_SIZE) {
    const subBatches = [];
    for (let i = 0; i < paths.length; i += MAX_TREE_BATCH_SIZE) {
      subBatches.push(paths.slice(i, i + MAX_TREE_BATCH_SIZE));
    }
    for (let i = 0; i < subBatches.length; i++) {
      const batchMsg = subBatches.length > 1 ? `${message} (${i + 1}/${subBatches.length})` : message;
      await deleteBatchInternal(branch, subBatches[i], batchMsg);
      if (i < subBatches.length - 1) await new Promise(r => setTimeout(r, 200));
    }
    return;
  }

  await deleteBatchInternal(branch, paths, message);
}

async function deleteBatchInternal(branch, paths, message) {
  // 1. Get branch ref → commit SHA
  const { data: refData } = await api('GET', `/repos/${ORG}/${repo}/git/ref/heads/${branch}`);
  const commitSha = refData.object.sha;
  await new Promise(r => setTimeout(r, 200));

  // 2. Get commit → tree SHA
  const { data: commitData } = await api('GET', `/repos/${ORG}/${repo}/git/commits/${commitSha}`);
  const baseTreeSha = commitData.tree.sha;
  await new Promise(r => setTimeout(r, 200));

  // 3. Create tree with deletions (sha: null)
  const tree = paths.map(p => ({
    path: p,
    mode: '100644',
    type: 'blob',
    sha: null,
  }));

  const { data: treeData } = await api('POST', `/repos/${ORG}/${repo}/git/trees`, {
    base_tree: baseTreeSha,
    tree,
  });
  await new Promise(r => setTimeout(r, 200));

  // 4. Create commit
  const { data: newCommit } = await api('POST', `/repos/${ORG}/${repo}/git/commits`, {
    message,
    tree: treeData.sha,
    parents: [commitSha],
  });
  await new Promise(r => setTimeout(r, 200));

  // 5. Update branch ref
  await api('PATCH', `/repos/${ORG}/${repo}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
  });
  await new Promise(r => setTimeout(r, 200));
}

// ─── Main cleanup logic ─────────────────────────────────────────────────────

console.log(`\nMMDB Q-ID Cleanup${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`Repo: ${ORG}/${repo}\n`);

const toDelete = [];
const toLog = [];

for (const dir of ['data/movies', 'data/series']) {
  console.log(`Scanning ${dir}/...`);
  const files = await listDirectory(dir);

  for (const file of files) {
    // Check all JSON files — not just Q-ID-named ones — for unusable titles
    try {
      const { content, sha } = await getFileContent(file.path);

      if (!isUsableTitle(content.title)) {
        const hasExternalIds = !!(content.external_ids?.imdb || content.external_ids?.tmdb);

        if (hasExternalIds) {
          toLog.push({
            path: file.path,
            title: content.title,
            imdb: content.external_ids?.imdb,
            tmdb: content.external_ids?.tmdb,
            sha,
          });
        } else {
          toDelete.push({
            path: file.path,
            title: content.title,
            wikidataId: content.external_ids?.wikidata,
            sha,
          });
        }
      }
    } catch (error) {
      console.warn(`  Warning: could not read ${file.path}: ${error.message}`);
    }
  }
}

console.log(`\nResults:`);
console.log(`  Total unusable entries found: ${toDelete.length + toLog.length}`);
console.log(`  Deletable (no external IDs): ${toDelete.length}`);
console.log(`  Has external IDs (logged only): ${toLog.length}`);

if (toLog.length > 0) {
  console.log(`\n  Entries with external IDs (NOT deleted, needs re-resolution):`);
  for (const entry of toLog) {
    console.log(`    - ${entry.path} (${entry.title}) — IMDb: ${entry.imdb || 'none'}, TMDB: ${entry.tmdb || 'none'}`);
  }
}

if (toDelete.length === 0) {
  console.log('\nNo entries to delete. Done.');
  process.exit(0);
}

if (dryRun) {
  console.log(`\n  Would delete:`);
  for (const entry of toDelete) {
    console.log(`    - ${entry.path} (${entry.title})`);
  }
  console.log('\n[DRY RUN] No changes made.');
  process.exit(0);
}

// ─── Create branch and PR ────────────────────────────────────────────────────

const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
const branchName = `mmdb-ingest/cleanup-qids-${runDate}`;

console.log(`\nCreating branch: ${branchName}`);
const masterSha = await getDefaultBranchSha();
const { ok: branchOk } = await createBranch(branchName, masterSha);
if (!branchOk) {
  console.error('Failed to create branch');
  process.exit(1);
}

console.log(`Deleting ${toDelete.length} files in batch...`);
const pathsToDelete = toDelete.map(e => e.path);
try {
  await deleteBatchCommit(branchName, pathsToDelete, `cleanup: remove ${toDelete.length} unusable entries`);
  console.log(`Deleted ${toDelete.length} files in ${Math.ceil(toDelete.length / MAX_TREE_BATCH_SIZE)} commit(s).`);
} catch (err) {
  console.error(`Batch delete failed: ${err.message}`);
  process.exit(1);
}
const deleted = toDelete.length;

if (deleted > 0) {
  console.log('Creating pull request...');
  const prBody = [
    `Cleanup: removed ${deleted} entries with unusable titles (Q-IDs, non-Latin only, etc.).`,
    '',
    'These entries have no external IDs (IMDb/TMDB) and no useful metadata.',
    '',
    toLog.length > 0 ? `**${toLog.length} entries with external IDs were NOT deleted** (needs future re-resolution).` : '',
    '',
    '**Deleted files:**',
    ...toDelete.slice(0, 50).map(e => `- \`${e.path}\` (${e.title})`),
    toDelete.length > 50 ? `- ... and ${toDelete.length - 50} more` : '',
  ].filter(Boolean).join('\n');

  const { ok: prOk, data: prData } = await createPR(
    `cleanup: remove ${deleted} unusable entries`,
    branchName,
    prBody
  );

  if (prOk) {
    console.log(`✅ PR created: ${prData.html_url}`);

    // Enable auto-merge (squash) — bot PRs are trusted
    try {
      const nodeId = prData.node_id;
      const mergeRes = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: `mutation EnableAutoMerge($pullRequestId: ID!) {
            enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
              pullRequest { autoMergeRequest { enabledAt } }
            }
          }`,
          variables: { pullRequestId: nodeId },
        }),
      });
      if (mergeRes.ok) {
        console.log('✅ Auto-merge enabled (squash)');
      } else {
        console.warn('⚠️  Could not enable auto-merge (check repo settings)');
      }
    } catch {
      console.warn('⚠️  Could not enable auto-merge');
    }
  } else {
    console.error(`Failed to create PR: ${prData.message}`);
  }
}

console.log('\nDone.');
