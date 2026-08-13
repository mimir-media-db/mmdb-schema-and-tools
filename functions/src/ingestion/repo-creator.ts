/**
 * Automated year repo creation with safeguards.
 * Creates mmdb-YYYY repos when the ingestion pipeline encounters a missing year.
 */

import { Octokit } from '@octokit/rest';
import { logger } from 'firebase-functions/v2';
import { GITHUB_ORG, MIN_YEAR } from '../config.js';

const MAX_YEAR_REPO = new Date().getFullYear();

const META_REPO = 'mmdb-meta';
const META_REPOS_PATH = 'repos.json';

// ─── Full hardened CI workflow (from TASK-058) ─────────────────────────────────

const VALIDATE_WORKFLOW = `name: Validate and Build Indexes

on:
  pull_request:
    branches: [master]
    paths: ['data/**']
  push:
    branches: [master]
    paths: ['data/**']

jobs:
  validate:
    runs-on: ubuntu-latest
    if: github.actor != 'github-actions[bot]'
    steps:
      - name: Checkout data repo
        uses: actions/checkout@v4
        with:
          path: data

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
        run: |
          cd data
          node ../tools/dist/validate-repo.js

      - name: Build indexes
        run: |
          cd data
          node ../tools/dist/build-indexes.js

      - name: Check for index changes
        id: check_changes
        run: |
          cd data
          git diff --exit-code data/*/index.json || echo "changed=true" >> \$GITHUB_OUTPUT

      - name: Verify only index files changed
        if: steps.check_changes.outputs.changed == 'true' && github.event_name == 'push'
        run: |
          cd data
          git add data/movies/index.json data/series/index.json data/people/index.json 2>/dev/null || true
          STAGED=\$(git diff --cached --name-only)
          for f in \$STAGED; do
            if [[ ! "\$f" == *index.json ]]; then
              echo "ERROR: Unexpected file staged: \$f"
              exit 1
            fi
          done

      - name: Commit index updates
        if: steps.check_changes.outputs.changed == 'true' && github.event_name == 'push'
        run: |
          cd data
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -m "chore: update indexes [skip ci]" || echo "Nothing to commit"
          git push
`;

// ─── MIT License ──────────────────────────────────────────────────────────────

const LICENSE_TEXT = `MIT License

Copyright (c) ${new Date().getFullYear()} mimir-media-db

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepoCreationResult {
  created: boolean;
  repo?: string;
  reason?: string;
}

// ─── Validation (exported for testing) ────────────────────────────────────────

export interface YearValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Pure validation logic for year repo creation.
 * Exported separately so unit tests can verify without mocking APIs.
 */
export function validateYearForRepoCreation(year: number): YearValidationResult {
  if (!Number.isInteger(year)) {
    return { valid: false, reason: `Year ${year} is not an integer` };
  }

  if (year < MIN_YEAR || year > MAX_YEAR_REPO) {
    return { valid: false, reason: `Year ${year} outside bounds (${MIN_YEAR}-${MAX_YEAR_REPO})` };
  }

  const repoName = `mmdb-${year}`;
  if (!/^mmdb-\d{4}$/.test(repoName)) {
    return { valid: false, reason: `Invalid repo name: ${repoName}` };
  }

  return { valid: true };
}

// ─── Main creation function ───────────────────────────────────────────────────

export async function createYearRepo(
  octokit: Octokit,
  year: number,
  dryRun: boolean = false
): Promise<RepoCreationResult> {
  const repoName = `mmdb-${year}`;

  // Safeguard 1 & 2: Year bounds + name validation
  const validation = validateYearForRepoCreation(year);
  if (!validation.valid) {
    return { created: false, reason: validation.reason };
  }

  // Safeguard 3: Existence check
  try {
    await octokit.repos.get({ owner: GITHUB_ORG, repo: repoName });
    return { created: false, reason: `Repo ${repoName} already exists` };
  } catch (error: any) {
    if (error.status !== 404) throw error;
    // 404 means it doesn't exist — good, we can create it
  }

  if (dryRun) {
    logger.info(`[DRY RUN] Would create repo: ${repoName}`);
    return { created: true, repo: repoName, reason: 'dry run' };
  }

  // Create the repo
  logger.info(`Creating repo: ${repoName}`, { year });

  await octokit.repos.createInOrg({
    org: GITHUB_ORG,
    name: repoName,
    description: `MMDB ${year} — Movies and series from ${year}`,
    visibility: 'public',
    auto_init: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_auto_merge: true,
    delete_branch_on_merge: true,
  });

  // Wait for GitHub to propagate
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Push template files (first file creates the master branch implicitly)
  const files = [
    { path: 'data/movies/index.json', content: '[]\n' },
    { path: 'data/series/index.json', content: '[]\n' },
    { path: '.github/workflows/validate.yml', content: VALIDATE_WORKFLOW },
    { path: 'package.json', content: generatePackageJson(year) },
    { path: 'README.md', content: generateReadme(year) },
    { path: 'LICENSE', content: LICENSE_TEXT },
  ];

  for (const file of files) {
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_ORG,
      repo: repoName,
      path: file.path,
      message: `chore: initialize ${file.path}`,
      content: Buffer.from(file.content).toString('base64'),
      branch: 'master',
    });
  }

  // Update mmdb-meta/repos.json
  await updateMetaRepos(octokit, repoName, year);

  logger.info(`Repo created successfully: ${repoName}`, {
    year,
    timestamp: new Date().toISOString(),
    rollback: `To delete: gh repo delete ${GITHUB_ORG}/${repoName} --yes`,
  });

  return { created: true, repo: repoName };
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

function generatePackageJson(year: number): string {
  const pkg = {
    name: `mmdb-${year}`,
    version: '1.0.0',
    description: `MMDB data for movies and series from ${year}`,
    license: 'MIT',
    private: true,
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function generateReadme(year: number): string {
  return `# mmdb-${year}

Movies and series released in ${year}, part of the [Mimir Media Database](https://github.com/mimir-media-db).

## Structure

\`\`\`
data/
├── movies/
│   ├── index.json
│   └── {title}-${year}.json
└── series/
    ├── index.json
    └── {title}.json
\`\`\`

## License

MIT
`;
}

async function updateMetaRepos(octokit: Octokit, repoName: string, year: number): Promise<void> {
  let repos: Array<{ name: string; year: number; created_at: string }> = [];
  let sha: string | undefined;

  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_ORG,
      repo: META_REPO,
      path: META_REPOS_PATH,
      ref: 'master',
    });

    if ('content' in data) {
      sha = data.sha;
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      repos = JSON.parse(content);
    }
  } catch (error: any) {
    if (error.status !== 404) throw error;
    // File doesn't exist yet — we'll create it
  }

  repos.push({
    name: repoName,
    year,
    created_at: new Date().toISOString(),
  });

  // Sort by year
  repos.sort((a, b) => a.year - b.year);

  const content = Buffer.from(JSON.stringify(repos, null, 2) + '\n').toString('base64');

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_ORG,
    repo: META_REPO,
    path: META_REPOS_PATH,
    message: `chore: add ${repoName} to registry`,
    content,
    branch: 'master',
    ...(sha && { sha }),
  });

  logger.info(`Updated ${META_REPO}/${META_REPOS_PATH}`, { added: repoName });
}
