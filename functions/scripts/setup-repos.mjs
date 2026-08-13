#!/usr/bin/env node

/**
 * MMDB Repo Setup Script
 * 
 * Configures branch protection and repo settings for all mmdb-* data repos.
 * Run this after creating new repos or when changing org-wide settings.
 *
 * Usage:
 *   node scripts/setup-repos.mjs <GITHUB_TOKEN>
 *   node scripts/setup-repos.mjs <GITHUB_TOKEN> --dry-run
 *   node scripts/setup-repos.mjs <GITHUB_TOKEN> --repos mmdb-2010,mmdb-2026
 *
 * What it does:
 *   1. Lists all mmdb-* repos in the org
 *   2. Enables auto-merge and squash-only merge
 *   3. Sets branch protection (requires 'validate' status check)
 *   4. Enables delete-branch-on-merge
 *
 * Requirements:
 *   - GitHub PAT with 'Administration: Read and write' on the org repos
 *   - Node.js 20+
 */

const ORG = 'mimir-media-db';
const BRANCH = 'master';

const token = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const reposFlag = process.argv.find(a => a.startsWith('--repos='));
const specificRepos = reposFlag ? reposFlag.split('=')[1].split(',') : null;

if (!token || token.startsWith('--')) {
  console.error(`
Usage: node scripts/setup-repos.mjs <GITHUB_TOKEN> [options]

Options:
  --dry-run             Show what would be done without making changes
  --repos=a,b,c        Only configure specific repos (comma-separated)

Example:
  node scripts/setup-repos.mjs ghp_xxxx
  node scripts/setup-repos.mjs ghp_xxxx --dry-run
  node scripts/setup-repos.mjs ghp_xxxx --repos=mmdb-2010,mmdb-2026
`);
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function getDataRepos() {
  if (specificRepos) return specificRepos;

  const repos = [];
  let page = 1;
  while (true) {
    const { data } = await api('GET', `/orgs/${ORG}/repos?per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const repo of data) {
      if (/^mmdb-([\d]{4}|people)$/.test(repo.name)) {
        repos.push(repo.name);
      }
    }
    page++;
  }
  return repos.sort();
}

async function configureRepo(repo) {
  console.log(`\n📦 ${repo}`);

  // 1. Repo settings
  const repoSettings = {
    allow_auto_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    delete_branch_on_merge: true,
  };

  if (dryRun) {
    console.log(`  [dry-run] Would set: auto-merge, squash-only, delete-branch-on-merge`);
  } else {
    const { ok, data } = await api('PATCH', `/repos/${ORG}/${repo}`, repoSettings);
    if (ok) {
      console.log(`  ✓ Repo settings: auto-merge, squash-only, delete-branch-on-merge`);
    } else {
      console.log(`  ✗ Repo settings failed: ${data.message || 'unknown error'}`);
    }
  }

  // 2. Branch protection
  const protection = {
    required_status_checks: {
      strict: false,
      contexts: ['validate'],
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
  };

  if (dryRun) {
    console.log(`  [dry-run] Would set branch protection: require 'validate' check`);
  } else {
    const { ok, data } = await api('PUT', `/repos/${ORG}/${repo}/branches/${BRANCH}/protection`, protection);
    if (ok) {
      console.log(`  ✓ Branch protection: require 'validate' status check on ${BRANCH}`);
    } else {
      console.log(`  ✗ Branch protection failed: ${data.message || 'unknown error'}`);
    }
  }

  // 3. Workflow permissions
  const workflowPerms = {
    default_workflow_permissions: 'write',
    can_approve_pull_request_reviews: true,
  };

  if (dryRun) {
    console.log(`  [dry-run] Would set workflow permissions: read-write`);
  } else {
    const { ok, data } = await api('PUT', `/repos/${ORG}/${repo}/actions/permissions/workflow`, workflowPerms);
    if (ok) {
      console.log(`  ✓ Workflow permissions: read-write`);
    } else {
      console.log(`  ✗ Workflow permissions failed: ${data.message || 'unknown error'}`);
    }
  }
}

// Main
console.log(`MMDB Repo Setup${dryRun ? ' (DRY RUN)' : ''}`);
console.log(`Org: ${ORG}`);
console.log(`Branch: ${BRANCH}`);

const repos = await getDataRepos();
console.log(`\nFound ${repos.length} data repos: ${repos.join(', ')}`);

for (const repo of repos) {
  await configureRepo(repo);
}

console.log(`\n✅ Done. ${repos.length} repos configured.`);
