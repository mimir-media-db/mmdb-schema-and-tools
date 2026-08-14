/**
 * Tests for the RunTimer timeout safety check.
 * Ensures the orchestrator can detect when it's approaching the
 * Cloud Function hard timeout (9 min) and stop gracefully.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RunTimer } from '../../src/ingestion/run-timer.js';
import { RUN_TIMEOUT_MS } from '../../src/config.js';

describe('RunTimer', () => {
  describe('constructor', () => {
    it('should use RUN_TIMEOUT_MS as default timeout', () => {
      const timer = new RunTimer();
      // Timer just created, should have nearly full remaining time
      assert.ok(timer.remaining() > RUN_TIMEOUT_MS - 100);
      assert.ok(timer.remaining() <= RUN_TIMEOUT_MS);
    });

    it('should accept a custom timeout', () => {
      const timer = new RunTimer(5000);
      assert.ok(timer.remaining() <= 5000);
      assert.ok(timer.remaining() > 4900);
    });
  });

  describe('elapsed', () => {
    it('should return 0 (or near 0) immediately after creation', () => {
      const timer = new RunTimer();
      assert.ok(timer.elapsed() < 50);
    });

    it('should increase over time', async () => {
      const timer = new RunTimer();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(timer.elapsed() >= 50);
    });
  });

  describe('isExpired', () => {
    it('should return false immediately after creation', () => {
      const timer = new RunTimer();
      assert.strictEqual(timer.isExpired(), false);
    });

    it('should return false when within timeout', () => {
      const timer = new RunTimer(10_000);
      assert.strictEqual(timer.isExpired(), false);
    });

    it('should return true when timeout has elapsed', async () => {
      const timer = new RunTimer(50); // 50ms timeout
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.strictEqual(timer.isExpired(), true);
    });

    it('should return true exactly at timeout boundary', async () => {
      const timer = new RunTimer(30);
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.strictEqual(timer.isExpired(), true);
    });
  });

  describe('remaining', () => {
    it('should return full timeout immediately after creation', () => {
      const timer = new RunTimer(10_000);
      assert.ok(timer.remaining() > 9900);
      assert.ok(timer.remaining() <= 10_000);
    });

    it('should decrease over time', async () => {
      const timer = new RunTimer(10_000);
      const initialRemaining = timer.remaining();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(timer.remaining() < initialRemaining);
    });

    it('should return 0 when expired', async () => {
      const timer = new RunTimer(30);
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.strictEqual(timer.remaining(), 0);
    });

    it('should never return negative values', async () => {
      const timer = new RunTimer(10);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(timer.remaining(), 0);
    });
  });

  describe('config integration', () => {
    it('RUN_TIMEOUT_MS should be 480000 (8 minutes)', () => {
      assert.strictEqual(RUN_TIMEOUT_MS, 480_000);
    });

    it('RUN_TIMEOUT_MS should be less than 9-minute Cloud Function hard limit', () => {
      const CLOUD_FUNCTION_TIMEOUT_MS = 540_000; // 9 minutes
      assert.ok(RUN_TIMEOUT_MS < CLOUD_FUNCTION_TIMEOUT_MS);
    });

    it('should leave at least 60 seconds buffer before hard timeout', () => {
      const CLOUD_FUNCTION_TIMEOUT_MS = 540_000;
      const buffer = CLOUD_FUNCTION_TIMEOUT_MS - RUN_TIMEOUT_MS;
      assert.ok(buffer >= 60_000, `Buffer is only ${buffer}ms, need at least 60000ms`);
    });
  });
});
