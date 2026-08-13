/**
 * Tests for the kill switch safeguard.
 * Verifies that the INGESTION_PAUSED env var correctly controls ingestion.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { isIngestionPaused } from '../../src/ingestion/safeguards.js';

describe('Kill Switch', () => {
  afterEach(() => {
    delete process.env.INGESTION_PAUSED;
  });

  it('should detect paused state when env var is "true"', () => {
    process.env.INGESTION_PAUSED = 'true';
    assert.strictEqual(isIngestionPaused(), true);
  });

  it('should not be paused when env var is "false"', () => {
    process.env.INGESTION_PAUSED = 'false';
    assert.strictEqual(isIngestionPaused(), false);
  });

  it('should not be paused when env var is unset', () => {
    delete process.env.INGESTION_PAUSED;
    assert.strictEqual(isIngestionPaused(), false);
  });

  it('should not be paused when env var is empty string', () => {
    process.env.INGESTION_PAUSED = '';
    assert.strictEqual(isIngestionPaused(), false);
  });

  it('should not be paused when env var is "TRUE" (case sensitive)', () => {
    process.env.INGESTION_PAUSED = 'TRUE';
    assert.strictEqual(isIngestionPaused(), false);
  });

  it('should not be paused when env var is "1"', () => {
    process.env.INGESTION_PAUSED = '1';
    assert.strictEqual(isIngestionPaused(), false);
  });
});
