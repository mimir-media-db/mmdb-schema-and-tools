/**
 * Tests for the anomaly detection safeguard.
 * Verifies auto-pause logic based on consecutive empty runs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldAutoPause } from '../../src/ingestion/safeguards.js';
import { MAX_EMPTY_RUNS } from '../../src/config.js';

describe('Anomaly Detection', () => {
  describe('shouldAutoPause', () => {
    it('should not pause when consecutive_empty_runs is 0', () => {
      assert.strictEqual(shouldAutoPause(0), false);
    });

    it('should not pause when consecutive_empty_runs is below threshold', () => {
      assert.strictEqual(shouldAutoPause(1), false);
      assert.strictEqual(shouldAutoPause(2), false);
    });

    it('should pause when consecutive_empty_runs equals threshold', () => {
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS), true);
    });

    it('should pause when consecutive_empty_runs exceeds threshold', () => {
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS + 1), true);
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS + 100), true);
    });

    it('should not pause at threshold minus 1', () => {
      assert.strictEqual(shouldAutoPause(MAX_EMPTY_RUNS - 1), false);
    });

    it('uses MAX_EMPTY_RUNS=3 as the configured threshold', () => {
      // Verify the config value matches expectations
      assert.strictEqual(MAX_EMPTY_RUNS, 3);
      // 2 empty runs is fine, 3 triggers pause
      assert.strictEqual(shouldAutoPause(2), false);
      assert.strictEqual(shouldAutoPause(3), true);
    });
  });
});
