#!/usr/bin/env node

/**
 * MMDB Remove Ancient People — Delete entries with birth_year < 1800 or death_year < 1800
 *
 * Scans all mmdb-people-{a-z} repos for person files where:
 *   - birth_year < 1800 OR
 *   - death_year < 1800
 *
 * Uses the Git Trees API (same approach as fix-people-filenames.mjs):
 * - Get recursive tree for the repo
 * - Download tarball to read person JSON content
 * - Build a new tree without the offending files (sha: null = delete)
 * - Create commit, branch, PR, squash merge
 *
 * Groups all deletions per repo into a single PR.
 *
 * Usage:
 *   node scripts/remove-ancient-people.mjs              # Fix all repos
 *   node scripts/remove-ancient-people.mjs --letter=z   # Fix specific repo
 *   node scripts/remove-ancient-people.mjs --dry-run    # Just list entries
 *
 * Environment:
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID
 *   (loaded from functions/.env — authenticates as mimir-media-db[bot])
 */

import { resolve, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createProgress, trackDownload } from './lib/progress.mjs';
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
const INTER_REPO_DELAY_MS = 5000;
const YEAR_CUTOFF = 1800;

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
  log(`Auth: ${auth.method}`);
} catch (err) {
  console.error(`Auth error: ${err.message}`);
  process.exit(1);
}

if (!token) {
  console.error('Error: No GitHub authentication configured.');
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

async function getBlobContent(repo, blobSha) {
  const { ok, data } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repo}/git/blobs/${blobSha}`)
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

// ─── Tarball approach: download and parse all people files at once ────────────

async function downloadAndParseRepo(repoName) {
  const currentToken = tokenManager ? await tokenManager.getToken() : token;
  const url = `https://api.github.com/repos/${ORG}/${repoName}/tarball/master`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${currentToken}`,
      Accept: 'application/vnd.github+json',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download tarball for ${repoName}: ${response.status}`);
  }

  const { execSync } = await import('child_process');
  const { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  // Save tarball to temp file and extract
  const tmpDir = mkdtempSync(join(tmpdir(), `mmdb-${repoName}-`));
  const tarPath = join(tmpDir, 'repo.tar.gz');

  try {
    const buffer = await trackDownload(response, `Downloading ${repoName}`);
    writeFileSync(tarPath, buffer);
    execSync(`tar -xzf ${tarPath} -C ${tmpDir}`, { stdio: 'pipe' });

    // Find the extracted directory (GitHub adds a prefix)
    const entries = readdirSync(tmpDir).filter(e => e !== 'repo.tar.gz');
    if (entries.length === 0) throw new Error('Empty tarball');
    const repoDir = join(tmpDir, entries[0]);

    // Read all person JSON files
    const peopleDir = join(repoDir, 'data', 'people');
    if (!existsSync(peopleDir)) return [];

    const files = readdirSync(peopleDir).filter(f => f.endsWith('.json') && f !== 'index.json');
    const people = [];

    for (const file of files) {
      try {
        const content = JSON.parse(readFileSync(join(peopleDir, file), 'utf8'));
        people.push({ filename: file, path: `data/people/${file}`, content });
      } catch {
        // Skip unreadable files
      }
    }

    return people;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Check if a person is "ancient" ─────────────────────────────────────────

function isAncientPerson(content) {
  if (content.birth_year && content.birth_year < YEAR_CUTOFF) {
    return `birth_year ${content.birth_year} < ${YEAR_CUTOFF}`;
  }
  if (content.death_year && content.death_year < YEAR_CUTOFF) {
    return `death_year ${content.death_year} < ${YEAR_CUTOFF}`;
  }
  return null;
}

// ─── Process a single repo ───────────────────────────────────────────────────

async function processRepo(letter) {
  const repoName = `mmdb-people-${letter}`;
  log(`Processing ${repoName}...`);

  const exists = await repoExists(ghApi, repoName);
  if (!exists) {
    log(`  Skipped: repo does not exist`);
    return { letter, status: 'skipped', removed: [] };
  }

  // Download and parse all people files via tarball
  log(`  Downloading tarball...`);
  let people;
  try {
    people = await downloadAndParseRepo(repoName);
  } catch (err) {
    log(`  Error downloading tarball: ${err.message}`);
    return { letter, status: 'error', removed: [], error: err.message };
  }
  log(`  Parsed ${people.length} person files`);

  // Find ancient people
  const ancientPeople = [];
  for (const person of people) {
    const reason = isAncientPerson(person.content);
    if (reason) {
      ancientPeople.push({
        path: person.path,
        filename: person.filename,
        name: person.content.name,
        reason,
        wikidata: person.content.external_ids?.wikidata,
      });
    }
  }

  if (ancientPeople.length === 0) {
    log(`  ✓ No ancient people found`);
    return { letter, status: 'clean', removed: [] };
  }

  log(`  Found ${ancientPeople.length} ancient person entries:`);
  for (const ap of ancientPeople) {
    log(`    - ${ap.name} (${ap.reason}) [${ap.wikidata || '?'}]`);
  }

  if (dryRun) {
    return { letter, status: 'dry-run', removed: ancientPeople };
  }

  // ─── Delete via branch → tree → commit → PR → merge ───────────────────────

  const masterSha = await getDefaultBranchSha(ghApi, repoName);
  if (!masterSha) {
    log(`  Error: could not get master SHA`);
    return { letter, status: 'error', removed: ancientPeople };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Get commit to find tree SHA
  const { ok: commitOk, data: commitData } = await retryOnServerError(
    () => ghApi('GET', `/repos/${ORG}/${repoName}/git/commits/${masterSha}`)
  );
  if (!commitOk) {
    log(`  Error: could not get commit data`);
    return { letter, status: 'error', removed: ancientPeople };
  }
  const rootTreeSha = commitData.tree.sha;
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Create branch
  const branchName = `fix/remove-ancient-people-${Date.now()}`;
  const { ok: branchOk } = await createBranch(ghApi, repoName, branchName, masterSha);
  if (!branchOk) {
    log(`  Error: Failed to create branch ${branchName}`);
    return { letter, status: 'error', removed: ancientPeople };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Create tree entries that delete the ancient people files (sha: null = delete)
  const treeEntries = ancientPeople.map(ap => ({
    path: ap.path,
    mode: '100644',
    type: 'blob',
    sha: null,
  }));

  const newTreeSha = await createTreeWithBase(repoName, rootTreeSha, treeEntries);
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  const commitMsg = `fix: remove ${ancientPeople.length} ancient person entries (pre-1800)`;
  const newCommitSha = await createCommit(repoName, commitMsg, newTreeSha, masterSha);
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Update branch ref
  const { ok: updateOk } = await retryOnServerError(
    () => ghApi('PATCH', `/repos/${ORG}/${repoName}/git/refs/heads/${branchName}`, {
      sha: newCommitSha,
      force: true,
    })
  );
  if (!updateOk) {
    log(`  Error: Failed to update branch ref`);
    return { letter, status: 'error', removed: ancientPeople };
  }
  await new Promise(r => setTimeout(r, GITHUB_RATE_LIMIT_MS));

  // Create PR
  const prTitle = `fix: remove ${ancientPeople.length} ancient person entries (pre-1800)`;
  const prBody = [
    '## Remove Ancient People (birth_year/death_year < 1800)',
    '',
    'These entries are from historical/ancient figures that should not be in the modern media database.',
    '',
    '| Name | Reason | Wikidata |',
    '|------|--------|----------|',
    ...ancientPeople.map(ap => `| ${ap.name} | ${ap.reason} | ${ap.wikidata || 'N/A'} |`),
    '',
    'The normalizer has been updated to reject these entries on future ingestion.',
  ].join('\n');

  const { ok: prOk, data: prData } = await createPR(ghApi, repoName, prTitle, branchName, prBody);
  if (!prOk) {
    log(`  Error: Failed to create PR`);
    return { letter, status: 'error', removed: ancientPeople };
  }
  log(`  PR created: ${repoName}#${prData.number}`);

  // Squash merge
  try {
    await new Promise(r => setTimeout(r, 2000));
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
      await ghApi('POST', `/repos/${ORG}/${repoName}/actions/workflows/validate.yml/dispatches`, {
        ref: 'master',
      });
      log(`  CI: index rebuild dispatched`);
    } else {
      const autoMergeOk = await enableAutoMerge(ghApi, ghGraphQL, repoName, prData.number);
      log(`  ⚠ Direct merge blocked, auto-merge ${autoMergeOk ? 'enabled' : 'failed'}`);
    }
  } catch (err) {
    log(`  ⚠ Merge error: ${err.message}`);
  }

  return { letter, status: 'fixed', removed: ancientPeople, pr: `${repoName}#${prData.number}` };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`MMDB Remove Ancient People — ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  log(`Year cutoff: < ${YEAR_CUTOFF}`);
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
      results.push({ letter, status: 'error', removed: [], error: err.message });
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
  const totalRemoved = results.reduce((sum, r) => sum + r.removed.length, 0);
  const fixed = results.filter(r => r.status === 'fixed');
  const errors = results.filter(r => r.status === 'error');
  const withAncient = results.filter(r => r.removed.length > 0);

  log(`Total ancient entries found: ${totalRemoved}`);

  if (!dryRun) {
    log(`Repos fixed: ${fixed.length}`);
    if (fixed.length > 0) {
      for (const r of fixed) {
        log(`  ${r.letter}: removed ${r.removed.length} entries — ${r.pr}`);
        for (const ap of r.removed) {
          log(`    - ${ap.name} (${ap.reason})`);
        }
      }
    }
  } else {
    if (withAncient.length > 0) {
      log('Ancient entries by repo:');
      for (const r of withAncient) {
        log(`  ${r.letter}: ${r.removed.length} entries`);
        for (const ap of r.removed) {
          log(`    - ${ap.name} (${ap.reason})`);
        }
      }
    }
  }

  if (errors.length > 0) {
    log(`Errors: ${errors.length}`);
    for (const r of errors) log(`  ${r.letter}: ${r.error || 'unknown'}`);
  }

  // Save results to file
  const resultsPath = resolve(__dirname, 'remove-ancient-people-results.json');
  writeFileSync(resultsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    dryRun,
    yearCutoff: YEAR_CUTOFF,
    totalRemoved,
    repos: results.map(r => ({
      letter: r.letter,
      status: r.status,
      count: r.removed.length,
      pr: r.pr || null,
      people: r.removed.map(ap => ({ name: ap.name, reason: ap.reason, wikidata: ap.wikidata })),
    })),
  }, null, 2));
  log(`Results saved to: ${resultsPath}`);
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
