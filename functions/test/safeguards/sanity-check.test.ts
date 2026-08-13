/**
 * Tests for the result count sanity check safeguard.
 * Verifies that Wikidata query results are validated before processing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isResultCountSane } from '../../src/ingestion/safeguards.js';
import { MAX_RESULTS_SANITY } from '../../src/config.js';

describe('Sanity Check', () => {
  describe('isResultCountSane', () => {
    it('should pass when count is 0', () => {
      assert.strictEqual(isResultCountSane(0), true);
    });

    it('should pass when count is well within bounds', () => {
      assert.strictEqual(isResultCountSane(100), true);
      assert.strictEqual(isResultCountSane(500), true);
      assert.strictEqual(isResultCountSane(1000), true);
    });

    it('should pass when count equals the maximum', () => {
      assert.strictEqual(isResultCountSane(MAX_RESULTS_SANITY), true);
    });

    it('should fail when count exceeds the maximum by 1', () => {
      assert.strictEqual(isResultCountSane(MAX_RESULTS_SANITY + 1), false);
    });

    it('should fail when count is far above the maximum', () => {
      assert.strictEqual(isResultCountSane(10000), false);
      assert.strictEqual(isResultCountSane(1000000), false);
    });

    it('uses MAX_RESULTS_SANITY=2000 as the configured threshold', () => {
      // Verify the config value matches expectations
      assert.strictEqual(MAX_RESULTS_SANITY, 2000);
      // 2000 results is fine, 2001 is not
      assert.strictEqual(isResultCountSane(2000), true);
      assert.strictEqual(isResultCountSane(2001), false);
    });
  });
});
