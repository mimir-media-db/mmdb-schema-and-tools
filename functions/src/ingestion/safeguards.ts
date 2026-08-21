/**
 * Pure safeguard logic — extracted for testability.
 * No side effects, no API calls, no logger usage.
 */

import { LOCK_TIMEOUT_MS, MAX_EMPTY_RUNS, MAX_RESULTS_SANITY } from '../config.js';
import { IngestionState } from './state.js';

/**
 * Kill switch: returns true if ingestion is paused via env var.
 */
export function isIngestionPaused(): boolean {
  return process.env.INGESTION_PAUSED === 'true';
}

/**
 * Anomaly detection: returns true if ingestion should auto-pause
 * due to too many consecutive empty runs.
 */
export function shouldAutoPause(consecutiveEmptyRuns: number): boolean {
  return consecutiveEmptyRuns >= MAX_EMPTY_RUNS;
}

/**
 * Concurrency lock decision: determines whether a lock can be acquired
 * based on current lock state and time.
 */
export function shouldAcquireLock(
  lock: IngestionState['lock'],
  now: number = Date.now()
): { canAcquire: boolean; isStale?: boolean; reason?: string } {
  if (!lock.running) {
    return { canAcquire: true };
  }

  if (!lock.started_at) {
    return { canAcquire: true };
  }

  const lockAge = now - new Date(lock.started_at).getTime();

  if (lockAge >= LOCK_TIMEOUT_MS) {
    return { canAcquire: true, isStale: true };
  }

  return {
    canAcquire: false,
    reason: `Another run is active (run_id: ${lock.run_id}, started: ${lock.started_at})`,
  };
}

/**
 * Sanity check: returns true if the result count is within acceptable bounds.
 */
export function isResultCountSane(count: number): boolean {
  return count <= MAX_RESULTS_SANITY;
}

/**
 * Merge raw (possibly incomplete) state with defaults to ensure all fields exist.
 * Handles state migration for old state files missing new fields.
 */
export function mergeStateWithDefaults(raw: Partial<IngestionState>, defaults: IngestionState): IngestionState {
  return {
    ...defaults,
    ...raw,
    total_ingested: {
      ...defaults.total_ingested,
      ...(raw.total_ingested || {}),
    },
    lock: {
      ...defaults.lock,
      ...(raw.lock || {}),
    },
    credits_lock: {
      ...defaults.credits_lock,
      ...(raw.credits_lock || {}),
    },
  };
}
