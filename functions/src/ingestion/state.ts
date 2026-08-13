/**
 * Ingestion state management via GitHub (mmdb-meta repo).
 * State is stored as a JSON file at ingestion/state.json in the mmdb-meta repo.
 */

import crypto from 'crypto';
import { logger } from 'firebase-functions/v2';
import { Octokit } from '@octokit/rest';
import { GITHUB_ORG, DEFAULT_START_YEAR } from '../config.js';
import { mergeStateWithDefaults, shouldAcquireLock } from './safeguards.js';

const META_REPO = 'mmdb-meta';
const STATE_PATH = 'ingestion/state.json';

export interface IngestionState {
  backlog_offset: number;
  backlog_current_year: number;
  backward_year: number;
  backward_offset: number;
  last_recent_timestamp: string;
  last_run: string;
  total_ingested: {
    movies: number;
    series: number;
    people: number;
  };
  lock: {
    running: boolean;
    started_at: string | null;
    run_id: string | null;
  };
  consecutive_empty_runs: number;
  repos_created_this_run?: number;
  last_repo_created?: string | null;
  last_repo_created_at?: string | null;
  current_year_offset_movies: number;
  current_year_offset_series: number;
  current_year: number;
}

const DEFAULT_STATE: IngestionState = {
  backlog_offset: 0,
  backlog_current_year: DEFAULT_START_YEAR,
  backward_year: DEFAULT_START_YEAR - 1,
  backward_offset: 0,
  last_recent_timestamp: '2026-01-01T00:00:00Z',
  last_run: new Date().toISOString(),
  total_ingested: {
    movies: 0,
    series: 0,
    people: 0,
  },
  lock: {
    running: false,
    started_at: null,
    run_id: null,
  },
  consecutive_empty_runs: 0,
  repos_created_this_run: 0,
  last_repo_created: null,
  last_repo_created_at: null,
  current_year_offset_movies: 0,
  current_year_offset_series: 0,
  current_year: new Date().getFullYear(),
};

let octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set');
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

/**
 * Merge fetched state with defaults to handle old state files missing new fields.
 */
function mergeWithDefaults(raw: Partial<IngestionState>): IngestionState {
  return mergeStateWithDefaults(raw, DEFAULT_STATE);
}

export async function getState(): Promise<IngestionState> {
  const gh = getOctokit();

  try {
    const { data } = await gh.repos.getContent({
      owner: GITHUB_ORG,
      repo: META_REPO,
      path: STATE_PATH,
      ref: 'master',
    });

    if ('content' in data) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const raw = JSON.parse(content) as Partial<IngestionState>;
      return mergeWithDefaults(raw);
    }
  } catch (error: any) {
    if (error.status === 404) {
      logger.info('No existing state found, initializing with defaults');
      await saveState(DEFAULT_STATE);
      return { ...DEFAULT_STATE };
    }
    throw error;
  }

  return { ...DEFAULT_STATE };
}

async function saveState(state: IngestionState): Promise<void> {
  const gh = getOctokit();
  const content = Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64');

  // Always fetch fresh sha to avoid stale sha errors
  let currentSha: string | undefined;
  try {
    const { data } = await gh.repos.getContent({
      owner: GITHUB_ORG,
      repo: META_REPO,
      path: STATE_PATH,
      ref: 'master',
    });
    if ('sha' in data) {
      currentSha = data.sha;
    }
  } catch (error: any) {
    if (error.status !== 404) throw error;
    // File doesn't exist yet, no sha needed
  }

  try {
    await gh.repos.createOrUpdateFileContents({
      owner: GITHUB_ORG,
      repo: META_REPO,
      path: STATE_PATH,
      message: `chore: update ingestion state`,
      content,
      branch: 'master',
      ...(currentSha && { sha: currentSha }),
    });

    // sha cached implicitly by always fetching fresh
  } catch (error: any) {
    // If sha mismatch (race condition), re-fetch and retry once
    if (error.status === 409 || error.status === 422) {
      logger.warn('State file conflict, retrying with fresh sha');
      const { data: freshFile } = await gh.repos.getContent({
        owner: GITHUB_ORG,
        repo: META_REPO,
        path: STATE_PATH,
        ref: 'master',
      });
      const freshSha = 'sha' in freshFile ? freshFile.sha : undefined;

      await gh.repos.createOrUpdateFileContents({
        owner: GITHUB_ORG,
        repo: META_REPO,
        path: STATE_PATH,
        message: `chore: update ingestion state`,
        content,
        branch: 'master',
        ...(freshSha && { sha: freshSha }),
      });
      return;
    }
    throw error;
  }

  logger.info('State saved to GitHub');
}

export async function updateState(updates: Partial<IngestionState>): Promise<void> {
  const current = await getState();
  const updated: IngestionState = {
    ...current,
    ...updates,
    last_run: new Date().toISOString(),
  };
  await saveState(updated);
  logger.info('State updated', { updates });
}

export async function incrementIngested(
  movies: number,
  series: number,
  people: number
): Promise<void> {
  const current = await getState();
  const updated: IngestionState = {
    ...current,
    last_run: new Date().toISOString(),
    total_ingested: {
      movies: current.total_ingested.movies + movies,
      series: current.total_ingested.series + series,
      people: current.total_ingested.people + people,
    },
  };
  await saveState(updated);
}

export async function advanceBacklog(
  newOffset: number,
  yearExhausted: boolean,
  currentYear: number
): Promise<void> {
  if (yearExhausted) {
    await updateState({
      backlog_offset: 0,
      backlog_current_year: currentYear + 1,
    });
    logger.info(`Year ${currentYear} exhausted, advancing to ${currentYear + 1}`);
  } else {
    await updateState({
      backlog_offset: newOffset,
    });
    logger.info(`Backlog offset advanced to ${newOffset}`);
  }
}

export async function advanceBackwardBacklog(
  newOffset: number,
  yearExhausted: boolean,
  currentYear: number
): Promise<void> {
  if (yearExhausted) {
    await updateState({
      backward_offset: 0,
      backward_year: currentYear - 1,
    });
    logger.info(`Backward year ${currentYear} exhausted, advancing to ${currentYear - 1}`);
  } else {
    await updateState({
      backward_offset: newOffset,
    });
    logger.info(`Backward offset advanced to ${newOffset}`);
  }
}

/**
 * Acquire a concurrency lock for the ingestion run.
 * Returns { acquired: true } if lock was obtained, or { acquired: false, reason } if not.
 * Stale locks (older than LOCK_TIMEOUT_MS) are automatically broken.
 */
export async function acquireLock(): Promise<{ acquired: boolean; reason?: string }> {
  const state = await getState();

  const decision = shouldAcquireLock(state.lock);

  if (!decision.canAcquire) {
    return {
      acquired: false,
      reason: decision.reason,
    };
  }

  if (decision.isStale) {
    logger.warn('Breaking stale lock', {
      run_id: state.lock.run_id,
      started_at: state.lock.started_at,
    });
  }

  const runId = crypto.randomUUID();
  await updateState({
    lock: {
      running: true,
      started_at: new Date().toISOString(),
      run_id: runId,
    },
  });

  logger.info('Lock acquired', { run_id: runId });
  return { acquired: true };
}

/**
 * Release the concurrency lock after a run completes.
 */
export async function releaseLock(): Promise<void> {
  await updateState({
    lock: {
      running: false,
      started_at: null,
      run_id: null,
    },
  });
  logger.info('Lock released');
}
