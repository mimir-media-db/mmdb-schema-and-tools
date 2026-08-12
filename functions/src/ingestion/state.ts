/**
 * Ingestion state management via GitHub (mmdb-meta repo).
 * State is stored as a JSON file at ingestion/state.json in the mmdb-meta repo.
 */

import { logger } from 'firebase-functions/v2';
import { Octokit } from '@octokit/rest';
import { GITHUB_ORG, DEFAULT_START_YEAR } from '../config.js';

const META_REPO = 'mmdb-meta';
const STATE_PATH = 'ingestion/state.json';

export interface IngestionState {
  backlog_offset: number;
  backlog_current_year: number;
  last_recent_timestamp: string;
  last_run: string;
  total_ingested: {
    movies: number;
    series: number;
    people: number;
  };
}

const DEFAULT_STATE: IngestionState = {
  backlog_offset: 0,
  backlog_current_year: DEFAULT_START_YEAR,
  last_recent_timestamp: '2026-01-01T00:00:00Z',
  last_run: new Date().toISOString(),
  total_ingested: {
    movies: 0,
    series: 0,
    people: 0,
  },
};

let octokit: Octokit | null = null;
let fileSha: string | undefined;

function getOctokit(): Octokit {
  if (!octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set');
    octokit = new Octokit({ auth: token });
  }
  return octokit;
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
      fileSha = data.sha;
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return JSON.parse(content) as IngestionState;
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

  try {
    const { data } = await gh.repos.createOrUpdateFileContents({
      owner: GITHUB_ORG,
      repo: META_REPO,
      path: STATE_PATH,
      message: `chore: update ingestion state`,
      content,
      branch: 'master',
      ...(fileSha && { sha: fileSha }),
    });

    fileSha = data.content?.sha;
  } catch (error: any) {
    // If sha mismatch (concurrent update), re-fetch and retry
    if (error.status === 409) {
      logger.warn('State file conflict, re-fetching');
      const freshState = await getState();
      fileSha = undefined;
      await saveState({ ...freshState, ...state });
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
