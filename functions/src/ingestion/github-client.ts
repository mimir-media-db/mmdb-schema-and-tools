/**
 * GitHub API client for MMDB ingestion PRs.
 * Self-contained copy adapted from tools/src/ingestion/github-client.ts
 * with additions for series support and repo existence checks.
 */

import { Octokit } from '@octokit/rest';
import { logger } from 'firebase-functions/v2';
import { MMDBMovie, MMDBPerson, MMDBSeries } from './normalizer.js';
import { GITHUB_ORG } from '../config.js';
import { getMovieFilePath, getSeriesFilePath, getPersonFilePath, serializeEntity } from './github-helpers.js';
import { createOctokit } from './auth.js';

/** Maximum files per Git Trees API call (GitHub soft limit) */
const MAX_TREE_BATCH_SIZE = 400;

/** Delay between successive GitHub API calls in ms */
const API_CALL_DELAY_MS = 200;

/**
 * Group items by the first letter of their slug (after stripping m_, s_, p_ prefix).
 * Useful for batching commits alphabetically.
 */
export function groupByFirstLetter<T extends { id: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const slug = item.id.replace(/^[msp]_/, '');
    const letter = (slug[0] || '#').toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter)!.push(item);
  }
  return groups;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;

  constructor(owner: string = GITHUB_ORG) {
    this.octokit = createOctokit();
    this.owner = owner;
  }

  /**
   * Commit a batch of files in a single commit using the Git Trees API.
   * If the batch exceeds MAX_TREE_BATCH_SIZE, it is split into sub-batches
   * with one commit per sub-batch.
   */
  async commitBatch(
    repo: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string
  ): Promise<void> {
    if (files.length === 0) return;

    // Split into sub-batches if too large
    if (files.length > MAX_TREE_BATCH_SIZE) {
      const subBatches: Array<Array<{ path: string; content: string }>> = [];
      for (let i = 0; i < files.length; i += MAX_TREE_BATCH_SIZE) {
        subBatches.push(files.slice(i, i + MAX_TREE_BATCH_SIZE));
      }
      for (let i = 0; i < subBatches.length; i++) {
        const batchMsg = subBatches.length > 1 ? `${message} (${i + 1}/${subBatches.length})` : message;
        await this.commitBatchInternal(repo, branch, subBatches[i], batchMsg);
        if (i < subBatches.length - 1) {
          await this.delay(API_CALL_DELAY_MS);
        }
      }
      return;
    }

    await this.commitBatchInternal(repo, branch, files, message);
  }

  /**
   * Delete a batch of files in a single commit using the Git Trees API.
   * Sets sha to null for each path to remove it from the tree.
   */
  async deleteBatch(
    repo: string,
    branch: string,
    paths: string[],
    message: string
  ): Promise<void> {
    if (paths.length === 0) return;

    // Split into sub-batches if too large
    if (paths.length > MAX_TREE_BATCH_SIZE) {
      const subBatches: string[][] = [];
      for (let i = 0; i < paths.length; i += MAX_TREE_BATCH_SIZE) {
        subBatches.push(paths.slice(i, i + MAX_TREE_BATCH_SIZE));
      }
      for (let i = 0; i < subBatches.length; i++) {
        const batchMsg = subBatches.length > 1 ? `${message} (${i + 1}/${subBatches.length})` : message;
        await this.deleteBatchInternal(repo, branch, subBatches[i], batchMsg);
        if (i < subBatches.length - 1) {
          await this.delay(API_CALL_DELAY_MS);
        }
      }
      return;
    }

    await this.deleteBatchInternal(repo, branch, paths, message);
  }

  private async commitBatchInternal(
    repo: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string
  ): Promise<void> {
    // 1. Get branch ref → commit SHA
    const { data: refData } = await this.octokit.git.getRef({
      owner: this.owner,
      repo,
      ref: `heads/${branch}`,
    });
    const commitSha = refData.object.sha;
    await this.delay(API_CALL_DELAY_MS);

    // 2. Get commit → tree SHA
    const { data: commitData } = await this.octokit.git.getCommit({
      owner: this.owner,
      repo,
      commit_sha: commitSha,
    });
    const baseTreeSha = commitData.tree.sha;
    await this.delay(API_CALL_DELAY_MS);

    // 3. POST /git/trees with base_tree + all files
    const tree = files.map(f => ({
      path: f.path,
      mode: '100644' as const,
      type: 'blob' as const,
      content: f.content,
    }));

    const { data: treeData } = await this.octokit.git.createTree({
      owner: this.owner,
      repo,
      base_tree: baseTreeSha,
      tree,
    });
    await this.delay(API_CALL_DELAY_MS);

    // 4. POST /git/commits with new tree + parent
    const { data: newCommit } = await this.octokit.git.createCommit({
      owner: this.owner,
      repo,
      message,
      tree: treeData.sha,
      parents: [commitSha],
    });
    await this.delay(API_CALL_DELAY_MS);

    // 5. PATCH /git/refs to update branch
    await this.octokit.git.updateRef({
      owner: this.owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });
    await this.delay(API_CALL_DELAY_MS);
  }

  private async deleteBatchInternal(
    repo: string,
    branch: string,
    paths: string[],
    message: string
  ): Promise<void> {
    // 1. Get branch ref → commit SHA
    const { data: refData } = await this.octokit.git.getRef({
      owner: this.owner,
      repo,
      ref: `heads/${branch}`,
    });
    const commitSha = refData.object.sha;
    await this.delay(API_CALL_DELAY_MS);

    // 2. Get commit → tree SHA
    const { data: commitData } = await this.octokit.git.getCommit({
      owner: this.owner,
      repo,
      commit_sha: commitSha,
    });
    const baseTreeSha = commitData.tree.sha;
    await this.delay(API_CALL_DELAY_MS);

    // 3. POST /git/trees with base_tree + deletions (sha: null)
    const tree = paths.map(p => ({
      path: p,
      mode: '100644' as const,
      type: 'blob' as const,
      sha: null,
    }));

    const { data: treeData } = await this.octokit.git.createTree({
      owner: this.owner,
      repo,
      base_tree: baseTreeSha,
      tree,
    });
    await this.delay(API_CALL_DELAY_MS);

    // 4. POST /git/commits with new tree + parent
    const { data: newCommit } = await this.octokit.git.createCommit({
      owner: this.owner,
      repo,
      message,
      tree: treeData.sha,
      parents: [commitSha],
    });
    await this.delay(API_CALL_DELAY_MS);

    // 5. PATCH /git/refs to update branch
    await this.octokit.git.updateRef({
      owner: this.owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });
    await this.delay(API_CALL_DELAY_MS);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async repoExists(repo: string): Promise<boolean> {
    try {
      await this.octokit.repos.get({ owner: this.owner, repo });
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async createBranch(repo: string, branchName: string, baseBranch: string = 'master'): Promise<void> {
    const { data: ref } = await this.octokit.git.getRef({
      owner: this.owner,
      repo,
      ref: `heads/${baseBranch}`,
    });

    await this.octokit.git.createRef({
      owner: this.owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });
  }

  async branchExists(repo: string, branchName: string): Promise<boolean> {
    try {
      await this.octokit.git.getRef({
        owner: this.owner,
        repo,
        ref: `heads/${branchName}`,
      });
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async getExistingMovieIds(repo: string, branch: string = 'master'): Promise<Set<string>> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: 'data/movies/index.json',
        ref: branch,
      });

      if ('content' in data) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const index = JSON.parse(content);
        return new Set(index.map((entry: any) => entry.id));
      }
    } catch (error: any) {
      if (error.status === 404) {
        return new Set();
      }
      throw error;
    }

    return new Set();
  }

  async getExistingSeriesIds(repo: string, branch: string = 'master'): Promise<Set<string>> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: 'data/series/index.json',
        ref: branch,
      });

      if ('content' in data) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const index = JSON.parse(content);
        return new Set(index.map((entry: any) => entry.id));
      }
    } catch (error: any) {
      if (error.status === 404) {
        return new Set();
      }
      throw error;
    }

    return new Set();
  }

  async getExistingPeopleIds(repo: string = 'mmdb-people', branch: string = 'master'): Promise<Set<string>> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: 'data/people/index.json',
        ref: branch,
      });

      if ('content' in data) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const index = JSON.parse(content);
        return new Set(index.map((entry: any) => entry.id));
      }
    } catch (error: any) {
      if (error.status === 404) {
        return new Set();
      }
      throw error;
    }

    return new Set();
  }

  async getMoviesInPendingPRs(repo: string): Promise<Set<string>> {
    const movieIds = new Set<string>();

    try {
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner,
        repo,
        state: 'open',
      });

      for (const pr of prs) {
        const { data: files } = await this.octokit.pulls.listFiles({
          owner: this.owner,
          repo,
          pull_number: pr.number,
        });

        for (const file of files) {
          if (
            file.filename.startsWith('data/movies/') &&
            file.filename.endsWith('.json') &&
            file.filename !== 'data/movies/index.json'
          ) {
            try {
              const { data: content } = await this.octokit.repos.getContent({
                owner: this.owner,
                repo,
                path: file.filename,
                ref: pr.head.ref,
              });

              if ('content' in content) {
                const movieData = JSON.parse(
                  Buffer.from(content.content, 'base64').toString('utf-8')
                );
                if (movieData.id) {
                  movieIds.add(movieData.id);
                }
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn('Could not fetch pending movie PRs', { error: error.message });
    }

    return movieIds;
  }

  async getSeriesInPendingPRs(repo: string): Promise<Set<string>> {
    const seriesIds = new Set<string>();

    try {
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner,
        repo,
        state: 'open',
      });

      for (const pr of prs) {
        const { data: files } = await this.octokit.pulls.listFiles({
          owner: this.owner,
          repo,
          pull_number: pr.number,
        });

        for (const file of files) {
          if (
            file.filename.startsWith('data/series/') &&
            file.filename.endsWith('.json') &&
            file.filename !== 'data/series/index.json'
          ) {
            try {
              const { data: content } = await this.octokit.repos.getContent({
                owner: this.owner,
                repo,
                path: file.filename,
                ref: pr.head.ref,
              });

              if ('content' in content) {
                const seriesData = JSON.parse(
                  Buffer.from(content.content, 'base64').toString('utf-8')
                );
                if (seriesData.id) {
                  seriesIds.add(seriesData.id);
                }
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn('Could not fetch pending series PRs', { error: error.message });
    }

    return seriesIds;
  }

  async getPeopleInPendingPRs(repo: string = 'mmdb-people'): Promise<Set<string>> {
    const peopleIds = new Set<string>();

    try {
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner,
        repo,
        state: 'open',
      });

      for (const pr of prs) {
        const { data: files } = await this.octokit.pulls.listFiles({
          owner: this.owner,
          repo,
          pull_number: pr.number,
        });

        for (const file of files) {
          if (
            file.filename.startsWith('data/people/') &&
            file.filename.endsWith('.json') &&
            file.filename !== 'data/people/index.json'
          ) {
            try {
              const { data: content } = await this.octokit.repos.getContent({
                owner: this.owner,
                repo,
                path: file.filename,
                ref: pr.head.ref,
              });

              if ('content' in content) {
                const personData = JSON.parse(
                  Buffer.from(content.content, 'base64').toString('utf-8')
                );
                if (personData.id) {
                  peopleIds.add(personData.id);
                }
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch (error: any) {
      logger.warn('Could not fetch pending people PRs', { error: error.message });
    }

    return peopleIds;
  }

  async createOrUpdateFile(
    repo: string,
    branch: string,
    path: string,
    content: string,
    message: string
  ): Promise<void> {
    let sha: string | undefined;

    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path,
        ref: branch,
      });

      if ('sha' in data) {
        sha = data.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) throw error;
    }

    await this.octokit.repos.createOrUpdateFileContents({
      owner: this.owner,
      repo,
      path,
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha && { sha }),
    });
  }

  async createPullRequest(
    repo: string,
    title: string,
    head: string,
    base: string = 'master',
    body?: string
  ): Promise<number> {
    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo,
      title,
      head,
      base,
      body,
    });

    return data.number;
  }

  async enableAutoMerge(repo: string, pullNumber: number): Promise<void> {
    // First get the PR node ID (needed for GraphQL)
    const { data: pr } = await this.octokit.pulls.get({
      owner: this.owner,
      repo,
      pull_number: pullNumber,
    });

    // Enable auto-merge via GraphQL
    await this.octokit.graphql(`
      mutation EnableAutoMerge($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: SQUASH
        }) {
          pullRequest {
            autoMergeRequest {
              enabledAt
            }
          }
        }
      }
    `, {
      pullRequestId: pr.node_id,
    });
  }

  async addMovieToPR(repo: string, branch: string, movie: MMDBMovie): Promise<void> {
    const path = getMovieFilePath(movie);
    const content = serializeEntity(movie);

    await this.createOrUpdateFile(
      repo,
      branch,
      path,
      content,
      `Add ${movie.title} (${movie.year})`
    );
  }

  async addSeriesToPR(repo: string, branch: string, series: MMDBSeries): Promise<void> {
    const path = getSeriesFilePath(series);
    const content = serializeEntity(series);

    await this.createOrUpdateFile(
      repo,
      branch,
      path,
      content,
      `Add series: ${series.title}`
    );
  }

  async addPersonToPR(repo: string, branch: string, person: MMDBPerson): Promise<void> {
    const path = getPersonFilePath(person);
    const content = serializeEntity(person);

    await this.createOrUpdateFile(
      repo,
      branch,
      path,
      content,
      `Add ${person.name}`
    );
  }

  async listDirectoryFiles(repo: string, dir: string, branch: string = 'master'): Promise<Array<{ name: string; path: string }>> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: dir,
        ref: branch,
      });

      if (Array.isArray(data)) {
        return data
          .filter((item: any) => item.type === 'file' && item.name.endsWith('.json'))
          .map((item: any) => ({ name: item.name, path: item.path }));
      }
    } catch (error: any) {
      if (error.status === 404) {
        return [];
      }
      throw error;
    }

    return [];
  }

  async getFileContent(repo: string, path: string, branch: string = 'master'): Promise<string> {
    const { data } = await this.octokit.repos.getContent({
      owner: this.owner,
      repo,
      path,
      ref: branch,
    });

    if ('content' in data) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    throw new Error(`Could not read file content: ${path}`);
  }

  /**
   * Download a repo tarball (gzipped tar archive) as a Buffer.
   * Uses the authenticated Octokit instance to follow redirects.
   */
  async downloadTarball(repo: string, ref: string = 'master'): Promise<Buffer> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
      owner: this.owner,
      repo,
      ref,
      request: {
        parseSuccessResponseBody: false,
      },
    });

    const stream = response.data as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = Buffer.alloc(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  async deleteFile(repo: string, branch: string, path: string, message: string): Promise<void> {
    // Get file SHA first
    const { data } = await this.octokit.repos.getContent({
      owner: this.owner,
      repo,
      path,
      ref: branch,
    });

    if (!('sha' in data)) {
      throw new Error(`Could not get SHA for file: ${path}`);
    }

    await this.octokit.repos.deleteFile({
      owner: this.owner,
      repo,
      path,
      message,
      sha: data.sha,
      branch,
    });
  }
}
