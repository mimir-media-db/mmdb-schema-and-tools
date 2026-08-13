/**
 * Tests for the concurrency lock safeguard.
 * Verifies lock acquisition logic including stale lock detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldAcquireLock } from '../../src/ingestion/safeguards.js';
import { LOCK_TIMEOUT_MS } from '../../src/config.js';
import { IngestionState } from '../../src/ingestion/state.js';

type LockState = IngestionState['lock'];

describe('Concurrency Lock', () => {
  describe('shouldAcquireLock', () => {
    it('should allow acquisition when lock is not running', () => {
      const lock: LockState = {
        running: false,
        started_at: null,
        run_id: null,
      };

      const result = shouldAcquireLock(lock);
      assert.strictEqual(result.canAcquire, true);
      assert.strictEqual(result.isStale, undefined);
      assert.strictEqual(result.reason, undefined);
    });

    it('should allow acquisition when lock is running but has no started_at', () => {
      const lock: LockState = {
        running: true,
        started_at: null,
        run_id: 'some-id',
      };

      const result = shouldAcquireLock(lock);
      assert.strictEqual(result.canAcquire, true);
    });

    it('should deny acquisition when lock is held and recent', () => {
      const now = Date.now();
      const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString();
      const lock: LockState = {
        running: true,
        started_at: fiveMinutesAgo,
        run_id: 'active-run-123',
      };

      const result = shouldAcquireLock(lock, now);
      assert.strictEqual(result.canAcquire, false);
      assert.ok(result.reason);
      assert.ok(result.reason!.includes('active-run-123'));
      assert.ok(result.reason!.includes(fiveMinutesAgo));
    });

    it('should allow acquisition when lock is stale (>10 min)', () => {
      const now = Date.now();
      const fifteenMinutesAgo = new Date(now - 15 * 60 * 1000).toISOString();
      const lock: LockState = {
        running: true,
        started_at: fifteenMinutesAgo,
        run_id: 'stale-run-456',
      };

      const result = shouldAcquireLock(lock, now);
      assert.strictEqual(result.canAcquire, true);
      assert.strictEqual(result.isStale, true);
    });

    it('should break lock exactly at timeout boundary', () => {
      const now = Date.now();
      const exactlyAtTimeout = new Date(now - LOCK_TIMEOUT_MS).toISOString();
      const lock: LockState = {
        running: true,
        started_at: exactlyAtTimeout,
        run_id: 'boundary-run',
      };

      const result = shouldAcquireLock(lock, now);
      assert.strictEqual(result.canAcquire, true);
      assert.strictEqual(result.isStale, true);
    });

    it('should deny lock 1ms before timeout', () => {
      const now = Date.now();
      const justBeforeTimeout = new Date(now - LOCK_TIMEOUT_MS + 1).toISOString();
      const lock: LockState = {
        running: true,
        started_at: justBeforeTimeout,
        run_id: 'almost-stale-run',
      };

      const result = shouldAcquireLock(lock, now);
      assert.strictEqual(result.canAcquire, false);
      assert.ok(result.reason);
    });

    it('should include run_id in denial reason', () => {
      const now = Date.now();
      const recentStart = new Date(now - 1000).toISOString();
      const runId = 'specific-uuid-value';
      const lock: LockState = {
        running: true,
        started_at: recentStart,
        run_id: runId,
      };

      const result = shouldAcquireLock(lock, now);
      assert.strictEqual(result.canAcquire, false);
      assert.ok(result.reason!.includes(runId));
    });
  });
});
