/**
 * Tests for the credits_lock concurrency safeguard.
 * Verifies that the credits lock is independent from the main ingestion lock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldAcquireLock } from '../../src/ingestion/safeguards.js';
import { LOCK_TIMEOUT_MS } from '../../src/config.js';
import { LockState } from '../../src/ingestion/state.js';

describe('Credits Lock', () => {
  describe('shouldAcquireLock with credits_lock', () => {
    it('should allow acquisition when credits lock is not running', () => {
      const creditsLock: LockState = {
        running: false,
        started_at: null,
        run_id: null,
      };

      const result = shouldAcquireLock(creditsLock);
      assert.strictEqual(result.canAcquire, true);
    });

    it('should deny acquisition when credits lock is held and recent', () => {
      const now = Date.now();
      const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString();
      const creditsLock: LockState = {
        running: true,
        started_at: fiveMinutesAgo,
        run_id: 'credits-run-123',
      };

      const result = shouldAcquireLock(creditsLock, now);
      assert.strictEqual(result.canAcquire, false);
      assert.ok(result.reason);
      assert.ok(result.reason!.includes('credits-run-123'));
    });

    it('should allow acquisition when credits lock is stale (>10 min)', () => {
      const now = Date.now();
      const fifteenMinutesAgo = new Date(now - 15 * 60 * 1000).toISOString();
      const creditsLock: LockState = {
        running: true,
        started_at: fifteenMinutesAgo,
        run_id: 'stale-credits-run',
      };

      const result = shouldAcquireLock(creditsLock, now);
      assert.strictEqual(result.canAcquire, true);
      assert.strictEqual(result.isStale, true);
    });

    it('credits lock and main lock are independent (both can be held)', () => {
      const now = Date.now();
      const recentTime = new Date(now - 3 * 60 * 1000).toISOString();

      const mainLock: LockState = {
        running: true,
        started_at: recentTime,
        run_id: 'main-run-abc',
      };

      const creditsLock: LockState = {
        running: false,
        started_at: null,
        run_id: null,
      };

      // Main lock is held, but credits lock is free
      const mainResult = shouldAcquireLock(mainLock, now);
      const creditsResult = shouldAcquireLock(creditsLock, now);

      assert.strictEqual(mainResult.canAcquire, false);
      assert.strictEqual(creditsResult.canAcquire, true);
    });

    it('credits lock allows acquisition when lock has no started_at', () => {
      const creditsLock: LockState = {
        running: true,
        started_at: null,
        run_id: 'orphaned-run',
      };

      const result = shouldAcquireLock(creditsLock);
      assert.strictEqual(result.canAcquire, true);
    });

    it('lock timeout uses LOCK_TIMEOUT_MS correctly', () => {
      const now = Date.now();
      // Just under 10 min — should NOT be stale
      const justUnder = new Date(now - LOCK_TIMEOUT_MS + 1000).toISOString();
      const creditsLock: LockState = {
        running: true,
        started_at: justUnder,
        run_id: 'almost-stale',
      };

      const result = shouldAcquireLock(creditsLock, now);
      assert.strictEqual(result.canAcquire, false);

      // Just over 10 min — SHOULD be stale
      const justOver = new Date(now - LOCK_TIMEOUT_MS - 1000).toISOString();
      const staleLock: LockState = {
        running: true,
        started_at: justOver,
        run_id: 'now-stale',
      };

      const staleResult = shouldAcquireLock(staleLock, now);
      assert.strictEqual(staleResult.canAcquire, true);
      assert.strictEqual(staleResult.isStale, true);
    });
  });
});
