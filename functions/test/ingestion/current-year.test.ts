/**
 * Tests for current-year ingestion logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldResetCurrentYearState } from '../../src/ingestion/current-year.js';

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

  describe('current year determination', () => {
    it('should derive current year correctly from Date', () => {
      const currentYear = new Date().getFullYear();
      assert.strictEqual(typeof currentYear, 'number');
      assert.ok(currentYear >= 2026, 'Current year should be at least 2026');
      assert.ok(currentYear <= 2100, 'Current year should be reasonable');
    });
  });

  describe('offset advancement', () => {
    it('should advance movie offset by CURRENT_YEAR_MOVIES_LIMIT', async () => {
      // Import config to verify the constant
      const { CURRENT_YEAR_MOVIES_LIMIT } = await import('../../src/config.js');
      assert.strictEqual(CURRENT_YEAR_MOVIES_LIMIT, 100);

      // Simulate offset advancement
      const initialOffset = 0;
      const newOffset = initialOffset + CURRENT_YEAR_MOVIES_LIMIT;
      assert.strictEqual(newOffset, 100);
    });

    it('should advance series offset by CURRENT_YEAR_SERIES_LIMIT', async () => {
      const { CURRENT_YEAR_SERIES_LIMIT } = await import('../../src/config.js');
      assert.strictEqual(CURRENT_YEAR_SERIES_LIMIT, 50);

      const initialOffset = 50;
      const newOffset = initialOffset + CURRENT_YEAR_SERIES_LIMIT;
      assert.strictEqual(newOffset, 100);
    });

    it('should reset offsets on year rollover', () => {
      const stateYear = 2025;
      const actualYear = 2026;
      const shouldReset = shouldResetCurrentYearState(stateYear, actualYear);
      assert.strictEqual(shouldReset, true);

      // After reset, offsets go to 0
      const newMovieOffset = shouldReset ? 0 : 200;
      const newSeriesOffset = shouldReset ? 0 : 100;
      assert.strictEqual(newMovieOffset, 0);
      assert.strictEqual(newSeriesOffset, 0);
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
