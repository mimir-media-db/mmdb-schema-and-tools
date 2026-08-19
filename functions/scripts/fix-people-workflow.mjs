#!/usr/bin/env node

/**
 * Fix validate.yml workflow on mmdb-people-* repos.
 *
 * Problem: The checkout step uses `path: data`, creating double-nesting
 * (data/data/people/) when the validator scans for `data/` from CWD.
 *
 * Fix: Checkout data repo to workspace root (no path), remove all `cd data`.
 *
 * Usage:
 *   node scripts/fix-people-workflow.mjs --letter=q         # Fix one repo
 *   node scripts/fix-people-workflow.mjs --letter=q,z       # Fix multiple
 *   node scripts/fix-people-workflow.mjs --all              # Fix all 26
 *   node scripts/fix-people-workflow.mjs --letter=q --dry-run
 *
 * Flags:
 *   --letter=a,b,c   Comma-separated letters to fix
 *   --all            Fix all existing people repos
 *   --dry-run        Show what would be done without pushing
 *   --direct         Push directly to master (no PR)
 */

import { dirname } from 'path';
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
  commitBatch,
} from './lib/rescan-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fixed workflow content ──────────────────────────────────────────────────

const FIXED_WORKFLOW = `name: Validate and Build Indexes

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
          persist-credentials: false

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
        run: node tools/dist/validate-repo.js

      - name: Build indexes
        run: node tools/dist/build-indexes.js

      - name: Check for index changes
        id: check_changes
        run: |
          git diff --exit-code data/*/index.json || echo "changed=true" >> \$GITHUB_OUTPUT

      - name: Generate App token
        if: steps.check_changes.outputs.changed == 'true' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
        id: app-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: \${{ secrets.MMDB_BOT_APP_ID }}
          private-key: \${{ secrets.MMDB_BOT_PRIVATE_KEY }}

      - name: Commit and push index updates
        if: steps.check_changes.outputs.changed == 'true' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
        run: |
          git add data/*/index.json 2>/dev/null || true
          git config user.name "mmdb-bot[bot]"
          git config user.email "mmdb-bot[bot]@users.noreply.github.com"
          git remote set-url origin "https://x-access-token:\${{ steps.app-token.outputs.token }}@github.com/\${{ github.repository }}.git"
          git commit -m "chore: update indexes [skip ci]" || echo "Nothing to commit"
          git push
`;

// ─── Parse arguments ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const directPush = args.includes('--direct');
const allRepos = args.includes('--all');
const letterArg = args.find(a => a.startsWith('--letter='));
const letters = letterArg
  ? letterArg.split('=')[1].split(',').map(l => l.trim().toLowerCase())
  : null;

if (!allRepos && !letters) {
  console.error('Usage: node scripts/fix-people-workflow.mjs --letter=q,z | --all [--dry-run] [--direct]');
  process.exit(1);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const envPath = new URL('../.env', import.meta.url).pathname;
  const auth = await loadGitHubAuth(envPath);
  if (!auth.token) {
    console.error('❌ No GitHub auth available. Check .env file.');
    process.exit(1);
  }
  console.log(`🔑 Auth: ${auth.method}`);

  const { ghApi, ghGraphQL } = createGitHubClient(auth.manager || auth.token);

  // Determine which repos to fix
  let targetLetters;
  if (allRepos) {
    targetLetters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  } else {
    targetLetters = letters;
  }

  const results = { success: [], skipped: [], failed: [] };
  const repoProgress = createProgress(targetLetters.length, 'Repos');

  for (const letter of targetLetters) {
    const repo = `mmdb-people-${letter}`;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📦 Processing: ${repo}`);

    try {
      // Check if repo exists
      const exists = await repoExists(ghApi, repo);
      if (!exists) {
        console.log(`  ⊘ Repo does not exist — skipping`);
        results.skipped.push({ letter, reason: 'not found' });
        continue;
      }

      // Check current workflow content
      const { ok: hasWorkflow, data: workflowData } = await retryOnServerError(
        () => ghApi('GET', `/repos/${ORG}/${repo}/contents/.github/workflows/validate.yml?ref=master`)
      );

      if (!hasWorkflow) {
        console.log(`  ⊘ No validate.yml found — skipping`);
        results.skipped.push({ letter, reason: 'no workflow' });
        continue;
      }

      // Check if already fixed (no `path: data` in first checkout)
      const currentContent = Buffer.from(workflowData.content, 'base64').toString('utf-8');
      if (!currentContent.includes('path: data\n')) {
        console.log(`  ✓ Already fixed — skipping`);
        results.skipped.push({ letter, reason: 'already fixed' });
        continue;
      }

      if (dryRun) {
        console.log(`  🔍 Would fix workflow (dry-run)`);
        results.success.push({ letter, action: 'dry-run' });
        continue;
      }

      // Get default branch SHA
      const sha = await getDefaultBranchSha(ghApi, repo);
      if (!sha) {
        console.log(`  ❌ Could not get default branch SHA`);
        results.failed.push({ letter, error: 'no default branch' });
        continue;
      }

      const files = [{
        path: '.github/workflows/validate.yml',
        content: FIXED_WORKFLOW,
      }];

      if (directPush) {
        // Push directly to master
        console.log(`  📝 Pushing fix directly to master...`);
        await commitBatch(ghApi, repo, 'master', files, 'fix(ci): remove path nesting in validate workflow');
        console.log(`  ✓ Pushed to master`);
        results.success.push({ letter, action: 'direct push' });
      } else {
        // Create branch + PR
        const branchName = 'fix/validate-workflow-nesting';
        console.log(`  🌿 Creating branch: ${branchName}`);

        const { ok: branchOk } = await createBranch(ghApi, repo, branchName, sha);
        if (!branchOk) {
          // Branch might already exist, try to delete and recreate
          await retryOnServerError(
            () => ghApi('DELETE', `/repos/${ORG}/${repo}/git/refs/heads/${branchName}`)
          );
          await createBranch(ghApi, repo, branchName, sha);
        }

        console.log(`  📝 Committing fixed workflow...`);
        await commitBatch(ghApi, repo, branchName, files, 'fix(ci): remove path nesting in validate workflow');

        console.log(`  🔀 Creating PR...`);
        const { ok: prOk, data: prData } = await createPR(
          ghApi, repo,
          'fix(ci): remove path nesting in validate workflow',
          branchName,
          [
            '## Problem',
            '',
            'The validate workflow checks out the data repo into `path: data`, then does `cd data`.',
            'The validator scans for `data/` from CWD, creating double-nesting: `data/data/people/`.',
            '',
            '## Fix',
            '',
            '- Checkout data repo to workspace root (no `path:` override)',
            '- Remove all `cd data` — CWD is now the repo root',
            '- Validator finds `data/people/` correctly from workspace root',
            '',
            '## Changes',
            '',
            '- Removed `path: data` from data repo checkout',
            '- Added `persist-credentials: false` (credentials set explicitly in push step)',
            '- Removed `cd data` from validate, build-indexes, check-changes, and push steps',
            '- Removed `--schema=person` flag (unused by validator)',
          ].join('\n'),
        );

        if (prOk && prData.number) {
          console.log(`  ✓ PR #${prData.number} created: ${prData.html_url}`);

          // Merge immediately — auto-merge won't work because CI only triggers
          // on data/** paths and this PR only changes .github/workflows/
          const { ok: mergeOk } = await retryOnServerError(
            () => ghApi('PUT', `/repos/${ORG}/${repo}/pulls/${prData.number}/merge`, {
              merge_method: 'squash',
            })
          );
          if (mergeOk) {
            console.log(`  ✓ PR merged (squash)`);
          } else {
            // Fall back to auto-merge
            const autoMerged = await enableAutoMerge(ghApi, ghGraphQL, repo, prData.number);
            if (autoMerged) {
              console.log(`  🤖 Auto-merge enabled (will merge when checks pass)`);
            } else {
              console.log(`  ⚠️  Could not merge — may need manual intervention`);
            }
          }

          results.success.push({ letter, action: `PR #${prData.number} merged`, url: prData.html_url });
        } else {
          console.log(`  ❌ PR creation failed: ${JSON.stringify(prData)}`);
          results.failed.push({ letter, error: 'PR creation failed' });
        }
      }

      // Rate limit
      repoProgress.tick(`${letter.toUpperCase()}`);
      await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
      results.failed.push({ letter, error: err.message });
      repoProgress.tick(`${letter.toUpperCase()} (error)`);
    }
  }

  repoProgress.done();

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 RESULTS SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✓ Success: ${results.success.length}`);
  results.success.forEach(r => console.log(`    - ${r.letter}: ${r.action}${r.url ? ` (${r.url})` : ''}`));
  console.log(`  ⊘ Skipped: ${results.skipped.length}`);
  results.skipped.forEach(r => console.log(`    - ${r.letter}: ${r.reason}`));
  console.log(`  ❌ Failed: ${results.failed.length}`);
  results.failed.forEach(r => console.log(`    - ${r.letter}: ${r.error}`));

  if (results.failed.length > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
