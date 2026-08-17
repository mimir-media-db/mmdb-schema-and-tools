/**
 * Q-ID cleanup logic for MMDB year repos.
 *
 * Identifies and removes entries where the title is a Wikidata Q-ID
 * (e.g., Q140513842) instead of a real movie/series name.
 *
 * Conservative approach:
 * - Entries with Q-ID title AND no external IDs → delete
 * - Entries with Q-ID title BUT have IMDb/TMDB → log for future re-resolution
 */

import { logger } from 'firebase-functions/v2';
import { GitHubClient } from './github-client.js';
import { BRANCH_PREFIX, CLEANUP_YEAR_RANGE } from '../config.js';

/** Regex pattern to detect Wikidata Q-ID titles */
export const QID_PATTERN = /^Q\d+$/i;

/** Result of a Q-ID check on a single file */
export interface QIdEntry {
  path: string;
  title: string;
  wikidataId?: string;
  hasExternalIds: boolean;
  imdbId?: string;
  tmdbId?: number;
}

/** Result of a cleanup run for a single repo */
export interface CleanupResult {
  repo: string;
  scanned: number;
  deletable: number;
  hasExternalIds: number;
  deleted: number;
  prCreated?: string;
  errors: string[];
}

/**
 * Checks if a title is a Wikidata Q-ID.
 */
export function isQIdTitle(title: string): boolean {
  return QID_PATTERN.test(title);
}

/**
 * Determines which year repos to check for cleanup.
 * Returns current year + previous N-1 years.
 */
export function getCleanupYearRepos(yearRange: number = CLEANUP_YEAR_RANGE): string[] {
  const currentYear = new Date().getFullYear();
  const repos: string[] = [];
  for (let i = 0; i < yearRange; i++) {
    repos.push(`mmdb-${currentYear - i}`);
  }
  return repos;
}

/**
 * Scans a year repo for Q-ID entries in movies and series directories.
 */
export async function scanRepoForQIds(
  github: GitHubClient,
  repo: string
): Promise<QIdEntry[]> {
  const entries: QIdEntry[] = [];

  for (const dir of ['data/movies', 'data/series']) {
    try {
      const files = await github.listDirectoryFiles(repo, dir);

      for (const file of files) {
        // Skip index files
        if (file.name === 'index.json') continue;

        // Only check files that look like Q-ID names (q\d+-YYYY.json pattern)
        if (!/^q\d+/i.test(file.name)) continue;

        try {
          const content = await github.getFileContent(repo, file.path);
          const data = JSON.parse(content);

          if (isQIdTitle(data.title)) {
            const hasExternalIds = !!(
              data.external_ids?.imdb ||
              data.external_ids?.tmdb
            );

            entries.push({
              path: file.path,
              title: data.title,
              wikidataId: data.external_ids?.wikidata,
              hasExternalIds,
              imdbId: data.external_ids?.imdb,
              tmdbId: data.external_ids?.tmdb,
            });
          }
        } catch (error: any) {
          logger.warn('Could not read file during Q-ID scan', {
            repo,
            path: file.path,
            error: error.message,
          });
        }
      }
    } catch (error: any) {
      logger.warn('Could not list directory during Q-ID scan', {
        repo,
        dir,
        error: error.message,
      });
    }
  }

  return entries;
}

/**
 * Runs cleanup for a single year repo.
 * Deletes entries with Q-ID title and no external IDs.
 * Logs entries with Q-ID title but with external IDs for future re-resolution.
 */
export async function cleanupRepo(
  github: GitHubClient,
  repo: string,
  dryRun: boolean = false
): Promise<CleanupResult> {
  const result: CleanupResult = {
    repo,
    scanned: 0,
    deletable: 0,
    hasExternalIds: 0,
    deleted: 0,
    errors: [],
  };

  try {
    const entries = await scanRepoForQIds(github, repo);
    result.scanned = entries.length;

    const toDelete: QIdEntry[] = [];
    const toLog: QIdEntry[] = [];

    for (const entry of entries) {
      if (entry.hasExternalIds) {
        toLog.push(entry);
        result.hasExternalIds++;
      } else {
        toDelete.push(entry);
        result.deletable++;
      }
    }

    // Log entries with external IDs for future re-resolution
    if (toLog.length > 0) {
      logger.info('Q-ID entries with external IDs (future re-resolution)', {
        repo,
        count: toLog.length,
        entries: toLog.map(e => ({
          path: e.path,
          title: e.title,
          imdb: e.imdbId,
          tmdb: e.tmdbId,
        })),
      });
    }

    if (toDelete.length === 0) {
      logger.info('No deletable Q-ID entries found', { repo });
      return result;
    }

    if (dryRun) {
      logger.info('[DRY RUN] Would delete Q-ID entries', {
        repo,
        count: toDelete.length,
        paths: toDelete.map(e => e.path),
      });
      return result;
    }

    // Create branch and delete files
    const runDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const branchName = `${BRANCH_PREFIX}/cleanup-qids-${runDate}`;

    const branchAlreadyExists = await github.branchExists(repo, branchName);
    if (!branchAlreadyExists) {
      await github.createBranch(repo, branchName);
    }

    for (const entry of toDelete) {
      try {
        await github.deleteFile(repo, branchName, entry.path, `cleanup: remove Q-ID entry ${entry.title}`);
        result.deleted++;
      } catch (error: any) {
        result.errors.push(`Failed to delete ${entry.path}: ${error.message}`);
        logger.error('Failed to delete Q-ID file', {
          repo,
          path: entry.path,
          error: error.message,
        });
      }
    }

    if (result.deleted > 0) {
      const prNumber = await github.createPullRequest(
        repo,
        `cleanup: remove ${result.deleted} Q-ID entries`,
        branchName,
        'master',
        `Automated cleanup: removed ${result.deleted} entries with Wikidata Q-ID titles (no human-readable label).\n\n` +
        `These entries have no external IDs (IMDb/TMDB) and no useful metadata.\n\n` +
        (toLog.length > 0
          ? `**${toLog.length} entries with external IDs were NOT deleted** (logged for future re-resolution).\n`
          : '') +
        `\n**Deleted files:**\n${toDelete.slice(0, 50).map(e => `- \`${e.path}\` (${e.title})`).join('\n')}` +
        (toDelete.length > 50 ? `\n- ... and ${toDelete.length - 50} more` : '')
      );
      result.prCreated = `${repo}#${prNumber}`;

      // Enable auto-merge
      try {
        await github.enableAutoMerge(repo, prNumber);
      } catch (error: any) {
        logger.warn('Could not enable auto-merge for cleanup PR', {
          repo,
          pr: prNumber,
          error: error.message,
        });
      }
    }
  } catch (error: any) {
    result.errors.push(`Cleanup failed for ${repo}: ${error.message}`);
    logger.error('Q-ID cleanup failed', { repo, error: error.message });
  }

  return result;
}

/**
 * Runs Q-ID cleanup across all configured year repos.
 * Called by the scheduled Cloud Function.
 */
export async function runCleanup(dryRun: boolean = false): Promise<CleanupResult[]> {
  const github = new GitHubClient();
  const repos = getCleanupYearRepos();
  const results: CleanupResult[] = [];

  logger.info('Starting Q-ID cleanup', {
    repos,
    dryRun,
  });

  for (const repo of repos) {
    // Verify repo exists before trying to clean it
    const exists = await github.repoExists(repo);
    if (!exists) {
      logger.info('Repo does not exist, skipping cleanup', { repo });
      continue;
    }

    const result = await cleanupRepo(github, repo, dryRun);
    results.push(result);

    logger.info('Repo cleanup complete', {
      repo,
      scanned: result.scanned,
      deletable: result.deletable,
      deleted: result.deleted,
      hasExternalIds: result.hasExternalIds,
      prCreated: result.prCreated,
    });
  }

  return results;
}
