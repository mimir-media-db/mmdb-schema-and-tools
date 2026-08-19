#!/usr/bin/env node
/**
 * fix-people-indexes.mjs
 *
 * Rebuilds and pushes correct data/people/index.json for specified people repos.
 * Uses tarball download to avoid per-file API calls.
 *
 * Usage: node fix-people-indexes.mjs [letters...]
 * Default: s t
 */

import { loadGitHubAuth } from './lib/github-app-auth.mjs';
import { createReadStream, mkdtempSync, rmSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { execSync } from 'child_process';

const ORG = 'mimir-media-db';
const ENV_PATH = join(import.meta.dirname, '..', '.env');

async function main() {
  const letters = process.argv.slice(2);
  if (letters.length === 0) letters.push('s', 't');

  console.log(`🔧 Rebuilding index.json for: ${letters.map(l => `mmdb-people-${l}`).join(', ')}`);

  // Load auth
  const { token, manager, method } = await loadGitHubAuth(ENV_PATH);
  if (!token) {
    console.error('❌ No GitHub token found in .env');
    process.exit(1);
  }
  console.log(`🔑 Auth: ${method}`);

  const getToken = manager ? () => manager.getToken() : () => token;

  for (const letter of letters) {
    await rebuildIndex(letter, getToken);
  }

  console.log('\n✅ All done!');
}

async function rebuildIndex(letter, getToken) {
  const repo = `mmdb-people-${letter}`;
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📦 Processing ${repo}...`);

  const tok = await getToken();
  const headers = {
    Authorization: `Bearer ${tok}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Step 1: Download tarball
  const tmpDir = mkdtempSync(join(tmpdir(), `mmdb-people-${letter}-`));
  const tarPath = join(tmpDir, 'repo.tar.gz');

  try {
    console.log(`  ⬇️  Downloading tarball...`);
    const tarballUrl = `https://api.github.com/repos/${ORG}/${repo}/tarball/master`;
    const res = await fetch(tarballUrl, {
      headers: { ...headers, Accept: 'application/vnd.github+json' },
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Failed to download tarball: ${res.status} ${res.statusText}`);
    }

    // Write tarball to disk
    const fileStream = createWriteStream(tarPath);
    await pipeline(res.body, fileStream);

    // Step 2: Extract tarball
    console.log(`  📂 Extracting...`);
    const extractDir = join(tmpDir, 'extracted');
    execSync(`mkdir -p "${extractDir}" && tar -xzf "${tarPath}" -C "${extractDir}"`, {
      stdio: 'pipe',
    });

    // Find the extracted directory (GitHub adds a prefix like org-repo-sha/)
    const extractedContents = execSync(`ls "${extractDir}"`, { encoding: 'utf8' }).trim();
    const repoDir = join(extractDir, extractedContents.split('\n')[0]);

    // Step 3: Parse all person JSONs
    console.log(`  🔍 Parsing person files...`);
    const peopleDir = join(repoDir, 'data', 'people');
    const files = await readdir(peopleDir);
    const personFiles = files.filter(f => f.startsWith('p_') && f.endsWith('.json') && f !== 'index.json');

    console.log(`  📊 Found ${personFiles.length} person files`);

    const index = [];
    let errors = 0;

    for (const file of personFiles) {
      try {
        const content = await readFile(join(peopleDir, file), 'utf8');
        const person = JSON.parse(content);
        if (person.id && person.name) {
          index.push({ id: person.id, name: person.name });
        } else {
          console.warn(`  ⚠️  Missing id/name in ${file}`);
          errors++;
        }
      } catch (e) {
        console.warn(`  ⚠️  Failed to parse ${file}: ${e.message}`);
        errors++;
      }
    }

    // Sort by id
    index.sort((a, b) => a.id.localeCompare(b.id));

    console.log(`  ✅ Built index: ${index.length} entries (${errors} errors)`);

    // Step 4: Get current index.json SHA
    console.log(`  🔄 Getting current index.json SHA...`);
    const currentToken = await getToken();
    const indexUrl = `https://api.github.com/repos/${ORG}/${repo}/contents/data/people/index.json`;
    const shaRes = await fetch(indexUrl, {
      headers: {
        Authorization: `Bearer ${currentToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    let currentSha = null;
    if (shaRes.ok) {
      const shaData = await shaRes.json();
      currentSha = shaData.sha;
      console.log(`  📋 Current SHA: ${currentSha}`);
    } else if (shaRes.status === 404) {
      console.log(`  📋 index.json doesn't exist yet, will create`);
    } else {
      throw new Error(`Failed to get index.json: ${shaRes.status}`);
    }

    // Step 5: PUT the new index.json
    console.log(`  ⬆️  Pushing updated index.json...`);
    const indexContent = JSON.stringify(index, null, 2) + '\n';
    const encodedContent = Buffer.from(indexContent).toString('base64');

    const putBody = {
      message: 'chore: rebuild people index [skip ci]',
      content: encodedContent,
      branch: 'master',
    };
    if (currentSha) {
      putBody.sha = currentSha;
    }

    const pushToken = await getToken();
    const putRes = await fetch(indexUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pushToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(putBody),
    });

    if (!putRes.ok) {
      const errBody = await putRes.text();
      throw new Error(`Failed to push index.json: ${putRes.status} ${putRes.statusText}\n${errBody}`);
    }

    const putData = await putRes.json();
    console.log(`  ✅ Pushed! New SHA: ${putData.content.sha}`);
    console.log(`  📝 Commit: ${putData.commit.sha.slice(0, 7)} - ${putData.commit.message}`);

  } finally {
    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
