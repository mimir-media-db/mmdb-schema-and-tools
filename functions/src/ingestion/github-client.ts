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

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;

  constructor(owner: string = GITHUB_ORG) {
    this.octokit = createOctokit();
    this.owner = owner;
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
