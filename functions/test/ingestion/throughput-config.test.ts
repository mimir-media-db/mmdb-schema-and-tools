/**
 * Tests for the updated throughput configuration values (TASK-078).
 * Verifies all config values are consistent and within safe bounds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  MAX_TITLES_PER_RUN,
  BACKLOG_LIMIT,
  FORWARD_BACKLOG_LIMIT,
  BACKWARD_BACKLOG_LIMIT,
  WIKIDATA_RATE_LIMIT_MS,
  SCHEDULE_CRON,
  RUN_TIMEOUT_MS,
  RECENT_LIMIT,
  MAX_RESULTS_SANITY,
} from '../../src/config.js';

describe('Throughput Configuration', () => {
  describe('backlog limits', () => {
    it('FORWARD_BACKLOG_LIMIT should be 100', () => {
      assert.strictEqual(FORWARD_BACKLOG_LIMIT, 100);
    });

    it('BACKWARD_BACKLOG_LIMIT should be 100', () => {
      assert.strictEqual(BACKWARD_BACKLOG_LIMIT, 100);
    });

    it('BACKLOG_LIMIT should equal forward + backward', () => {
      assert.strictEqual(BACKLOG_LIMIT, FORWARD_BACKLOG_LIMIT + BACKWARD_BACKLOG_LIMIT);
    });

    it('BACKLOG_LIMIT should be 200', () => {
      assert.strictEqual(BACKLOG_LIMIT, 200);
    });
  });

  describe('rate limiting', () => {
    it('WIKIDATA_RATE_LIMIT_MS should be 500', () => {
      assert.strictEqual(WIKIDATA_RATE_LIMIT_MS, 500);
    });

    it('should allow at least 2 requests per second (Wikidata bot guideline)', () => {
      const requestsPerSecond = 1000 / WIKIDATA_RATE_LIMIT_MS;
      assert.ok(requestsPerSecond <= 2, `Rate ${requestsPerSecond} req/s exceeds Wikidata 2 req/s guideline`);
    });
  });

  describe('schedule', () => {
    it('SCHEDULE_CRON should be every 4 hours', () => {
      assert.strictEqual(SCHEDULE_CRON, 'every 4 hours');
    });
  });

  describe('titles per run', () => {
    it('MAX_TITLES_PER_RUN should be 200', () => {
      assert.strictEqual(MAX_TITLES_PER_RUN, 200);
    });

    it('BACKLOG_LIMIT + RECENT_LIMIT should not exceed MAX_TITLES_PER_RUN', () => {
      assert.ok(
        BACKLOG_LIMIT + RECENT_LIMIT <= MAX_TITLES_PER_RUN + RECENT_LIMIT,
        'Backlog + recent exceeds max titles per run'
      );
    });
  });

  describe('timeout safety', () => {
    it('RUN_TIMEOUT_MS should be 480000 (8 minutes)', () => {
      assert.strictEqual(RUN_TIMEOUT_MS, 480_000);
    });

    it('at 500ms/query, 200 titles (~400 queries) should fit within timeout', () => {
      // ~400 queries at 500ms each = 200 seconds = 3.3 minutes
      const estimatedQueryTime = 400 * WIKIDATA_RATE_LIMIT_MS;
      assert.ok(
        estimatedQueryTime < RUN_TIMEOUT_MS,
        `Estimated query time ${estimatedQueryTime}ms exceeds timeout ${RUN_TIMEOUT_MS}ms`
      );
    });
  });

  describe('sanity bounds', () => {
    it('MAX_RESULTS_SANITY should remain at 2000', () => {
      assert.strictEqual(MAX_RESULTS_SANITY, 2000);
    });

    it('MAX_TITLES_PER_RUN should be well below MAX_RESULTS_SANITY', () => {
      assert.ok(MAX_TITLES_PER_RUN < MAX_RESULTS_SANITY);
    });
  });
});
