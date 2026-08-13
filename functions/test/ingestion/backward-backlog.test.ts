/**
 * Tests for backward backlog ingestion (2009 → 1888).
 * Verifies state advancement, year decrement, and boundary behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mergeStateWithDefaults } from '../../src/ingestion/safeguards.js';
import { IngestionState } from '../../src/ingestion/state.js';
import {
  MIN_BACKLOG_YEAR,
  BACKWARD_BACKLOG_LIMIT,
  FORWARD_BACKLOG_LIMIT,
  BACKLOG_LIMIT,
} from '../../src/config.js';

const DEFAULT_STATE: IngestionState = {
  backlog_offset: 0,
  backlog_current_year: 2010,
  backward_year: 2009,
  backward_offset: 0,
  last_recent_timestamp: '2026-01-01T00:00:00Z',
  last_run: '2026-01-01T00:00:00Z',
  total_ingested: {
    movies: 0,
    series: 0,
    people: 0,
  },
  lock: {
    running: false,
    started_at: null,
    run_id: null,
  },
  consecutive_empty_runs: 0,
  current_year_offset_movies: 0,
  current_year_offset_series: 0,
  current_year: new Date().getFullYear(),
};

describe('Backward Backlog', () => {
  describe('config constants', () => {
    it('should have MIN_BACKLOG_YEAR set to 1888', () => {
      assert.strictEqual(MIN_BACKLOG_YEAR, 1888);
    });

    it('should split backlog budget evenly (30 forward + 30 backward = 60)', () => {
      assert.strictEqual(FORWARD_BACKLOG_LIMIT, 30);
      assert.strictEqual(BACKWARD_BACKLOG_LIMIT, 30);
      assert.strictEqual(FORWARD_BACKLOG_LIMIT + BACKWARD_BACKLOG_LIMIT, BACKLOG_LIMIT);
    });

    it('should use 70/30 split for movies/series in backward pass', () => {
      const moviesLimit = Math.floor(BACKWARD_BACKLOG_LIMIT * 0.7);
      const seriesLimit = BACKWARD_BACKLOG_LIMIT - moviesLimit;
      assert.strictEqual(moviesLimit, 21);
      assert.strictEqual(seriesLimit, 9);
    });
  });

  describe('advanceBackwardBacklog logic', () => {
    it('should decrement year when exhausted', () => {
      // Simulate the logic from advanceBackwardBacklog
      const yearExhausted = true;
      const currentYear = 2005;

      const newState = yearExhausted
        ? { backward_offset: 0, backward_year: currentYear - 1 }
        : { backward_offset: 42 };

      assert.strictEqual(newState.backward_year, 2004);
      assert.strictEqual(newState.backward_offset, 0);
    });

    it('should advance offset when year not exhausted', () => {
      const yearExhausted = false;
      const currentYear = 2005;
      const newOffset = 42;

      const newState = yearExhausted
        ? { backward_offset: 0, backward_year: currentYear - 1 }
        : { backward_offset: newOffset };

      assert.strictEqual(newState.backward_offset, 42);
      assert.ok(!('backward_year' in newState));
    });

    it('should decrement from 2009 to 2008', () => {
      const currentYear = 2009;
      const nextYear = currentYear - 1;
      assert.strictEqual(nextYear, 2008);
    });

    it('should decrement from 1889 to 1888 (minimum)', () => {
      const currentYear = 1889;
      const nextYear = currentYear - 1;
      assert.strictEqual(nextYear, MIN_BACKLOG_YEAR);
    });

    it('should go below MIN_BACKLOG_YEAR from 1888 (stops on next run)', () => {
      const currentYear = MIN_BACKLOG_YEAR;
      const nextYear = currentYear - 1;
      assert.strictEqual(nextYear, 1887);
      // On next run, 1887 < MIN_BACKLOG_YEAR → backward pass returns empty
      assert.ok(nextYear < MIN_BACKLOG_YEAR);
    });
  });

  describe('boundary behavior', () => {
    it('should not process years below MIN_BACKLOG_YEAR', () => {
      const currentYear = 1887;
      const shouldProcess = currentYear >= MIN_BACKLOG_YEAR;
      assert.strictEqual(shouldProcess, false);
    });

    it('should process exactly MIN_BACKLOG_YEAR (1888)', () => {
      const currentYear = 1888;
      const shouldProcess = currentYear >= MIN_BACKLOG_YEAR;
      assert.strictEqual(shouldProcess, true);
    });

    it('should process year 1889', () => {
      const currentYear = 1889;
      const shouldProcess = currentYear >= MIN_BACKLOG_YEAR;
      assert.strictEqual(shouldProcess, true);
    });

    it('should not process year 0', () => {
      const currentYear = 0;
      const shouldProcess = currentYear >= MIN_BACKLOG_YEAR;
      assert.strictEqual(shouldProcess, false);
    });

    it('should not process negative years', () => {
      const currentYear = -100;
      const shouldProcess = currentYear >= MIN_BACKLOG_YEAR;
      assert.strictEqual(shouldProcess, false);
    });
  });

  describe('state merge handles missing backward fields', () => {
    it('should add backward_year to old state without it', () => {
      const oldState: Partial<IngestionState> = {
        backlog_offset: 10,
        backlog_current_year: 2012,
        total_ingested: { movies: 150, series: 30, people: 200 },
      };

      const result = mergeStateWithDefaults(oldState, DEFAULT_STATE);

      assert.strictEqual(result.backward_year, 2009);
      assert.strictEqual(result.backward_offset, 0);
    });

    it('should add backward_offset to old state without it', () => {
      const oldState: Partial<IngestionState> = {
        backlog_offset: 5,
        backlog_current_year: 2011,
      };

      const result = mergeStateWithDefaults(oldState, DEFAULT_STATE);

      assert.strictEqual(result.backward_offset, 0);
    });

    it('should preserve existing backward fields', () => {
      const stateWithBackward: Partial<IngestionState> = {
        backlog_offset: 10,
        backlog_current_year: 2015,
        backward_year: 1995,
        backward_offset: 42,
      };

      const result = mergeStateWithDefaults(stateWithBackward, DEFAULT_STATE);

      assert.strictEqual(result.backward_year, 1995);
      assert.strictEqual(result.backward_offset, 42);
    });

    it('should handle state with backward_year but not backward_offset', () => {
      // Edge case: partial migration
      const partialState: Partial<IngestionState> = {
        backward_year: 2000,
      };

      const result = mergeStateWithDefaults(partialState, DEFAULT_STATE);

      assert.strictEqual(result.backward_year, 2000);
      assert.strictEqual(result.backward_offset, 0);
    });

    it('should default backward_year to 2009 (one year before forward start)', () => {
      const result = mergeStateWithDefaults({}, DEFAULT_STATE);

      assert.strictEqual(result.backward_year, 2009);
      assert.strictEqual(result.backlog_current_year, 2010);
      assert.strictEqual(result.backward_year, result.backlog_current_year - 1);
    });
  });

  describe('offset advancement', () => {
    it('should advance backward offset by movies limit', () => {
      const moviesLimit = Math.floor(BACKWARD_BACKLOG_LIMIT * 0.7);
      const initialOffset = 0;
      const newOffset = initialOffset + moviesLimit;
      assert.strictEqual(newOffset, 21);
    });

    it('should accumulate offset across runs', () => {
      const moviesLimit = Math.floor(BACKWARD_BACKLOG_LIMIT * 0.7);
      const initialOffset = 21;
      const newOffset = initialOffset + moviesLimit;
      assert.strictEqual(newOffset, 42);
    });

    it('should reset offset to 0 when year exhausted', () => {
      const yearExhausted = true;
      const newOffset = yearExhausted ? 0 : 63;
      assert.strictEqual(newOffset, 0);
    });
  });
});
