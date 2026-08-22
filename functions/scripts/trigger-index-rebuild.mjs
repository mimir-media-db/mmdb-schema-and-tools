#!/usr/bin/env node

/**
 * Trigger index rebuild across all mmdb-YYYY repos.
 *
 * Dispatches the CI workflow in each year repo, which runs build-indexes.js
 * and commits updated index.json files.
 *
 * Usage:
 *   node scripts/trigger-index-rebuild.mjs
 *   node scripts/trigger-index-rebuild.mjs --dry-run
 *
 * Environment:
 *   GITHUB_TOKEN or GitHub App auth from .env
 */

import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createGitHubClient, ORG, retryOnServerError, getDefaultBranchSha, GITHUB_RATE_LIMIT_MS } from './lib/rescan-core.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = resolve(__dirname, '..', '.env');

const YEAR_REPO_PATTERN = /^mmdb-\d{4}$/;
const WORKFLOW_FILENAME = 'validate.yml';
const DELAY_BETWEEN_REPOS_MS = 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs() {
  return {
    dryRun: process.argv.includes('--dry-run'),
  };
}

/**
 * List all repos in the org matching mmdb-YYYY pattern.
 * Paginates through all pages.
 */
async function listYearRepos(ghApi) {
  const repos = [];
  let page = 1;

  while (true) {
    const { ok, data } = await retryOnServerError(
      () => ghApi('GET', `/orgs/${ORG}/repos?per_page=100&page=${page}&type=public`),
    );
    if (!ok || !Array.isArray(data) || data.length === 0) break;

    for (const repo of data) {
      if (YEAR_REPO_PATTERN.test(repo.name)) {
        repos.push(repo.name);
      }
    }

    if (data.length < 100) break;
    page++;
    await sleep(GITHUB_RATE_LIMIT_MS);
  }

  // Sort by year (ascending)
  repos.sort((a, b) => {
    const yearA = parseInt(a.replace('mmdb-', ''));
    const yearB = parseInt(b.replace('mmdb-', ''));
    return yearA - yearB;
  });

  return repos;
}

/**
 * Try to dispatch the validate.yml workflow via workflow_dispatch.
 * Returns true if dispatched successfully, false otherwise.
 */
async function tryDispatchWorkflow(ghApi, repo) {
  // First verify the workflow exists and supports workflow_dispatch
  const { ok: listOk, data: workflows } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repo}/actions/workflows`),
  );

  if (!listOk || !workflows.workflows) return false;

  const targetWorkflow = workflows.workflows.find(
    w => w.path === `.github/workflows/${WORKFLOW_FILENAME}` || w.name === 'Validate and Build Indexes',
  );

  if (!targetWorkflow) return false;

  // Dispatch the workflow on master
  const { ok, status } = await retryOnServerError(
    () => ghApi('POST', `/repos/${ORG}/${repo}/actions/workflows/${targetWorkflow.id}/dispatches`, {
      ref: 'master',
    }),
  );

  // 204 = success for workflow dispatch
  return ok || status === 204;
}

/**
 * Fallback: create a trigger file in data/ to trigger push-based CI (path filter: data/**).
 */
async function pushTriggerFile(ghApi, repo) {
  const masterSha = await getDefaultBranchSha(ghApi, repo);
  if (!masterSha) return false;

  await sleep(GITHUB_RATE_LIMIT_MS);

  // Create or update data/.rebuild-trigger with timestamp
  const triggerContent = Buffer.from(
    `Rebuild triggered at ${new Date().toISOString()}\n`
  ).toString('base64');

  // Check if file already exists (to get its SHA for update)
  let fileSha = null;
  const { ok: getOk, data: existingFile } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repo}/contents/data/.rebuild-trigger`),
  );
  if (getOk && existingFile && existingFile.sha) {
    fileSha = existingFile.sha;
  }

  await sleep(GITHUB_RATE_LIMIT_MS);

  // Create/update the trigger file
  const body = {
    message: 'chore: trigger index rebuild\n\nTriggered by trigger-index-rebuild.mjs',
    content: triggerContent,
    branch: 'master',
  };
  if (fileSha) body.sha = fileSha;

  const { ok: putOk } = await retryOnServerError(
    () => ghApi('PUT', `/repos/${ORG}/${repo}/contents/data/.rebuild-trigger`, body),
  );

  return putOk;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun } = parseArgs();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   MMDB — Trigger Index Rebuild (All Year Repos) ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  if (dryRun) {
    console.log('🏃 DRY RUN — will list repos without triggering\n');
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────
  const { token, manager, method } = await loadGitHubAuth(ENV_PATH);
  if (!token) {
    console.error('✗ No GitHub auth configured. Set GITHUB_TOKEN or GitHub App credentials in .env');
    process.exit(1);
  }
  console.log(`Auth: ${method}`);

  const authSource = manager || token;
  const { ghApi } = createGitHubClient(authSource);

  // ─── List repos ──────────────────────────────────────────────────────────────
  console.log(`\nFetching repos from ${ORG}...`);
  const yearRepos = await listYearRepos(ghApi);

  if (yearRepos.length === 0) {
    console.log('No mmdb-YYYY repos found.');
    process.exit(0);
  }

  console.log(`Found ${yearRepos.length} year repos: ${yearRepos[0]} → ${yearRepos[yearRepos.length - 1]}\n`);

  if (dryRun) {
    console.log('Repos that would be triggered:');
    for (const repo of yearRepos) {
      console.log(`  • ${repo}`);
    }
    console.log(`\nTotal: ${yearRepos.length} repos`);
    console.log('\nRe-run without --dry-run to trigger.');
    return;
  }

  // ─── Trigger each repo ───────────────────────────────────────────────────────
  let triggered = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < yearRepos.length; i++) {
    const repo = yearRepos[i];
    const progress = `[${i + 1}/${yearRepos.length}]`;

    process.stdout.write(`${progress} ${repo}... `);

    try {
      // Try workflow_dispatch first
      const dispatched = await tryDispatchWorkflow(ghApi, repo);

      if (dispatched) {
        console.log('✓ workflow dispatched');
        triggered++;
      } else {
        // Fallback: touch data/.rebuild-trigger to trigger push-based CI (path filter)
        process.stdout.write('(no dispatch) → trigger file... ');
        const pushed = await pushTriggerFile(ghApi, repo);

        if (pushed) {
          console.log('✓ trigger file pushed');
          triggered++;
        } else {
          console.log('✗ failed');
          failed++;
          failures.push(repo);
        }
      }
    } catch (err) {
      console.log(`✗ error: ${err.message}`);
      failed++;
      failures.push(repo);
    }

    // Rate limit between repos
    if (i < yearRepos.length - 1) {
      await sleep(DELAY_BETWEEN_REPOS_MS);
    }
  }

  // ─── Report ──────────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────');
  console.log(`Total repos:  ${yearRepos.length}`);
  console.log(`Triggered:    ${triggered}`);
  console.log(`Failed:       ${failed}`);

  if (failures.length > 0) {
    console.log(`\nFailed repos:`);
    for (const repo of failures) {
      console.log(`  • ${repo}`);
    }
  }

  console.log('\nDone.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\n✗ Fatal error: ${err.message}`);
  process.exit(1);
});
