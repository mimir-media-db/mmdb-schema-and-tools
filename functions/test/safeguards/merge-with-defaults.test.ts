/**
 * Tests for the state migration / merge-with-defaults safeguard.
 * Verifies that old state files missing new fields get properly merged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mergeStateWithDefaults } from '../../src/ingestion/safeguards.js';
import { IngestionState } from '../../src/ingestion/state.js';

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

describe('Merge With Defaults', () => {
  describe('mergeStateWithDefaults', () => {
    it('should return full defaults when given empty state', () => {
      const result = mergeStateWithDefaults({}, DEFAULT_STATE);

      assert.strictEqual(result.backlog_offset, 0);
      assert.strictEqual(result.backlog_current_year, 2010);
      assert.strictEqual(result.consecutive_empty_runs, 0);
      assert.deepStrictEqual(result.lock, {
        running: false,
        started_at: null,
        run_id: null,
      });
      assert.deepStrictEqual(result.total_ingested, {
        movies: 0,
        series: 0,
        people: 0,
      });
    });

    it('should preserve existing fields from raw state', () => {
      const raw: Partial<IngestionState> = {
        backlog_offset: 42,
        backlog_current_year: 2015,
        last_run: '2026-06-01T12:00:00Z',
      };

      const result = mergeStateWithDefaults(raw, DEFAULT_STATE);

      assert.strictEqual(result.backlog_offset, 42);
      assert.strictEqual(result.backlog_current_year, 2015);
      assert.strictEqual(result.last_run, '2026-06-01T12:00:00Z');
    });

    it('should add lock fields to old state without them', () => {
      // Simulate old state that doesn't have lock fields
      const oldState: Partial<IngestionState> = {
        backlog_offset: 10,
        backlog_current_year: 2012,
        last_recent_timestamp: '2026-03-15T00:00:00Z',
        last_run: '2026-03-15T10:00:00Z',
        total_ingested: {
          movies: 150,
          series: 30,
          people: 200,
        },
      };

      const result = mergeStateWithDefaults(oldState, DEFAULT_STATE);

      // Lock fields should come from defaults
      assert.deepStrictEqual(result.lock, {
        running: false,
        started_at: null,
        run_id: null,
      });
      // Existing fields preserved
      assert.strictEqual(result.backlog_offset, 10);
      assert.strictEqual(result.total_ingested.movies, 150);
    });

    it('should add consecutive_empty_runs to old state without it', () => {
      const oldState: Partial<IngestionState> = {
        backlog_offset: 5,
        backlog_current_year: 2011,
        total_ingested: { movies: 50, series: 10, people: 80 },
      };

      const result = mergeStateWithDefaults(oldState, DEFAULT_STATE);

      assert.strictEqual(result.consecutive_empty_runs, 0);
    });

    it('should pass through complete state unchanged', () => {
      const completeState: IngestionState = {
        backlog_offset: 25,
        backlog_current_year: 2014,
        backward_year: 2005,
        backward_offset: 10,
        last_recent_timestamp: '2026-07-01T00:00:00Z',
        last_run: '2026-07-10T08:00:00Z',
        total_ingested: {
          movies: 300,
          series: 75,
          people: 450,
        },
        lock: {
          running: true,
          started_at: '2026-07-10T08:00:00Z',
          run_id: 'abc-123',
        },
        consecutive_empty_runs: 1,
        current_year_offset_movies: 200,
        current_year_offset_series: 100,
        current_year: 2026,
      };

      const result = mergeStateWithDefaults(completeState, DEFAULT_STATE);

      assert.deepStrictEqual(result, completeState);
    });

    it('should deep merge total_ingested fields', () => {
      const partial: Partial<IngestionState> = {
        total_ingested: {
          movies: 100,
          series: 0,
          people: 0,
        },
      };

      const result = mergeStateWithDefaults(partial, DEFAULT_STATE);

      assert.strictEqual(result.total_ingested.movies, 100);
      assert.strictEqual(result.total_ingested.series, 0);
      assert.strictEqual(result.total_ingested.people, 0);
    });

    it('should deep merge lock fields', () => {
      const partial: Partial<IngestionState> = {
        lock: {
          running: true,
          started_at: '2026-08-01T00:00:00Z',
          run_id: 'test-run',
        },
      };

      const result = mergeStateWithDefaults(partial, DEFAULT_STATE);

      assert.strictEqual(result.lock.running, true);
      assert.strictEqual(result.lock.started_at, '2026-08-01T00:00:00Z');
      assert.strictEqual(result.lock.run_id, 'test-run');
    });

    it('should handle missing total_ingested gracefully', () => {
      const raw: Partial<IngestionState> = {
        backlog_offset: 5,
      };

      const result = mergeStateWithDefaults(raw, DEFAULT_STATE);

      assert.deepStrictEqual(result.total_ingested, {
        movies: 0,
        series: 0,
        people: 0,
      });
    });

    it('should handle missing lock gracefully', () => {
      const raw: Partial<IngestionState> = {
        backlog_offset: 5,
      };

      const result = mergeStateWithDefaults(raw, DEFAULT_STATE);

      assert.deepStrictEqual(result.lock, {
        running: false,
        started_at: null,
        run_id: null,
      });
    });
  });
});
