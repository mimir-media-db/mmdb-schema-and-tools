/**
 * Tests for current-year ingestion logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldResetCurrentYearState, computeModifiedAfter } from '../../src/ingestion/current-year.js';

describe('Current Year Ingestion', () => {
  describe('shouldResetCurrentYearState', () => {
    it('should return true when state year differs from actual year', () => {
      assert.strictEqual(shouldResetCurrentYearState(2025, 2026), true);
    });

    it('should return false when state year matches actual year', () => {
      assert.strictEqual(shouldResetCurrentYearState(2026, 2026), false);
    });

    it('should detect rollover from December to January', () => {
      // Simulates: state was saved in 2025, now it's 2026
      assert.strictEqual(shouldResetCurrentYearState(2025, 2026), true);
    });

    it('should handle state year being ahead of actual (clock skew edge case)', () => {
      // Unlikely but should still trigger reset
      assert.strictEqual(shouldResetCurrentYearState(2027, 2026), true);
    });

    it('should return false when both years are zero (edge case)', () => {
      assert.strictEqual(shouldResetCurrentYearState(0, 0), false);
    });

    it('should return true for large year difference', () => {
      assert.strictEqual(shouldResetCurrentYearState(2020, 2026), true);
    });
  });

  describe('computeModifiedAfter', () => {
    it('should compute timestamp N hours in the past', () => {
      const now = new Date('2026-08-16T12:00:00Z');
      const result = computeModifiedAfter(48, now);
      assert.strictEqual(result, '2026-08-14T12:00:00.000Z');
    });

    it('should handle zero hours (returns current time)', () => {
      const now = new Date('2026-08-16T12:00:00Z');
      const result = computeModifiedAfter(0, now);
      assert.strictEqual(result, '2026-08-16T12:00:00.000Z');
    });

    it('should handle 24 hours (one day back)', () => {
      const now = new Date('2026-08-16T00:00:00Z');
      const result = computeModifiedAfter(24, now);
      assert.strictEqual(result, '2026-08-15T00:00:00.000Z');
    });

    it('should cross month boundary correctly', () => {
      const now = new Date('2026-09-01T06:00:00Z');
      const result = computeModifiedAfter(48, now);
      assert.strictEqual(result, '2026-08-30T06:00:00.000Z');
    });

    it('should return valid ISO string', () => {
      const result = computeModifiedAfter(48);
      // Should be a valid ISO date string
      assert.ok(!isNaN(Date.parse(result)), 'Should be a parseable date');
      assert.ok(result.endsWith('Z'), 'Should be UTC');
    });
  });

  describe('current year determination', () => {
    it('should derive current year correctly from Date', () => {
      const currentYear = new Date().getFullYear();
      assert.strictEqual(typeof currentYear, 'number');
      assert.ok(currentYear >= 2026, 'Current year should be at least 2026');
      assert.ok(currentYear <= 2100, 'Current year should be reasonable');
    });
  });

  describe('full scan configuration', () => {
    it('should use CURRENT_YEAR_FULL_SCAN_LIMIT instead of offset-based pagination', async () => {
      const { CURRENT_YEAR_FULL_SCAN_LIMIT } = await import('../../src/config.js');
      assert.strictEqual(CURRENT_YEAR_FULL_SCAN_LIMIT, 2000);
    });

    it('should have RECENT_MODIFIED_HOURS set to 48', async () => {
      const { RECENT_MODIFIED_HOURS } = await import('../../src/config.js');
      assert.strictEqual(RECENT_MODIFIED_HOURS, 48);
    });

    it('should have RECENT_MODIFIED_LIMIT set to 200', async () => {
      const { RECENT_MODIFIED_LIMIT } = await import('../../src/config.js');
      assert.strictEqual(RECENT_MODIFIED_LIMIT, 200);
    });

    it('should keep CURRENT_YEAR_MOVIES_LIMIT for backward compat but not use it for pagination', async () => {
      // The constant still exists for backward compatibility
      const { CURRENT_YEAR_MOVIES_LIMIT } = await import('../../src/config.js');
      assert.strictEqual(typeof CURRENT_YEAR_MOVIES_LIMIT, 'number');
    });

    it('should have increased RECENT_LIMIT to 100', async () => {
      const { RECENT_LIMIT } = await import('../../src/config.js');
      assert.strictEqual(RECENT_LIMIT, 100);
    });
  });

  describe('safeguards integration', () => {
    it('should respect kill switch check', async () => {
      const { isIngestionPaused } = await import('../../src/ingestion/safeguards.js');
      // With no env var set, should not be paused
      const originalValue = process.env.INGESTION_PAUSED;
      delete process.env.INGESTION_PAUSED;
      assert.strictEqual(isIngestionPaused(), false);

      // With env var set to 'true', should be paused
      process.env.INGESTION_PAUSED = 'true';
      assert.strictEqual(isIngestionPaused(), true);

      // Restore
      if (originalValue !== undefined) {
        process.env.INGESTION_PAUSED = originalValue;
      } else {
        delete process.env.INGESTION_PAUSED;
      }
    });

    it('should respect auto-pause on consecutive empty runs', async () => {
      const { shouldAutoPause } = await import('../../src/ingestion/safeguards.js');
      const { MAX_EMPTY_RUNS } = await import('../../src/config.js');

      assert.strictEqual(shouldAutoPause(0), false);
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS - 1), false);
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS), true);
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS + 1), true);
    });

    it('should share lock with main orchestrator', async () => {
      const { shouldAcquireLock } = await import('../../src/ingestion/safeguards.js');

      // Free lock
      const freeLock = { running: false, started_at: null, run_id: null };
      assert.strictEqual(shouldAcquireLock(freeLock).canAcquire, true);

      // Active lock
      const activeLock = {
        running: true,
        started_at: new Date().toISOString(),
        run_id: 'test-run-id',
      };
      assert.strictEqual(shouldAcquireLock(activeLock).canAcquire, false);
    });

    it('should detect anomalous result counts', async () => {
      const { isResultCountSane } = await import('../../src/ingestion/safeguards.js');
      const { MAX_RESULTS_SANITY } = await import('../../src/config.js');

      assert.strictEqual(isResultCountSane(100), true);
      assert.strictEqual(isResultCountSane(MAX_RESULTS_SANITY), true);
      assert.strictEqual(isResultCountSane(MAX_RESULTS_SANITY + 1), false);
    });
  });
});
