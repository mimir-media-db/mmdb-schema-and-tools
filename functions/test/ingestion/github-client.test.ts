/**
 * Tests for GitHub client helper functions (path generation and serialization).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getMovieFilePath,
  getSeriesFilePath,
  getPersonFilePath,
  serializeEntity,
} from '../../src/ingestion/github-helpers.js';
import type { MMDBMovie, MMDBPerson, MMDBSeries } from '../../src/ingestion/normalizer.js';

describe('GitHub Helpers', () => {
  describe('getMovieFilePath', () => {
    it('should generate correct path with slug and year', () => {
      const movie: MMDBMovie = {
        schema_version: 1,
        id: 'm_inception_2010',
        title: 'Inception',
        year: 2010,
        type: 'movie',
        external_ids: { wikidata: 'Q43320' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getMovieFilePath(movie), 'data/movies/inception-2010.json');
    });

    it('should strip articles from movie title in path', () => {
      const movie: MMDBMovie = {
        schema_version: 1,
        id: 'm_dark_knight_2008',
        title: 'The Dark Knight',
        year: 2008,
        type: 'movie',
        external_ids: { wikidata: 'Q163872' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getMovieFilePath(movie), 'data/movies/dark_knight-2008.json');
    });

    it('should handle accented titles', () => {
      const movie: MMDBMovie = {
        schema_version: 1,
        id: 'm_amelie_2001',
        title: 'Amélie',
        year: 2001,
        type: 'movie',
        external_ids: { wikidata: 'Q484048' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getMovieFilePath(movie), 'data/movies/amelie-2001.json');
    });
  });

  describe('getSeriesFilePath', () => {
    it('should generate correct path with slug', () => {
      const series: MMDBSeries = {
        schema_version: 1,
        id: 's_breaking_bad',
        title: 'Breaking Bad',
        start_year: 2008,
        external_ids: { wikidata: 'Q1079' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getSeriesFilePath(series), 'data/series/breaking_bad.json');
    });

    it('should strip articles from series title in path', () => {
      const series: MMDBSeries = {
        schema_version: 1,
        id: 's_wire',
        title: 'The Wire',
        start_year: 2002,
        external_ids: { wikidata: 'Q23572' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getSeriesFilePath(series), 'data/series/wire.json');
    });
  });

  describe('getPersonFilePath', () => {
    it('should use person.id directly in path', () => {
      const person: MMDBPerson = {
        schema_version: 1,
        id: 'p_christopher_nolan',
        name: 'Christopher Nolan',
        death_year: null,
        external_ids: { wikidata: 'Q25191' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getPersonFilePath(person), 'data/people/p_christopher_nolan.json');
    });

    it('should handle IDs with accented name slugs', () => {
      const person: MMDBPerson = {
        schema_version: 1,
        id: 'p_penelope_cruz',
        name: 'Penélope Cruz',
        death_year: null,
        external_ids: { wikidata: 'Q47163' },
        last_updated: '2026-08-12',
      };

      assert.strictEqual(getPersonFilePath(person), 'data/people/p_penelope_cruz.json');
    });
  });

  describe('serializeEntity', () => {
    it('should produce JSON with 2-space indent and trailing newline', () => {
      const entity = { id: 'test', name: 'Test' };
      const result = serializeEntity(entity);
      const expected = '{\n  "id": "test",\n  "name": "Test"\n}\n';
      assert.strictEqual(result, expected);
    });

    it('should serialize nested objects correctly', () => {
      const entity = { external_ids: { wikidata: 'Q123', imdb: 'tt000' } };
      const result = serializeEntity(entity);
      assert.ok(result.endsWith('\n'), 'should end with newline');
      assert.ok(result.includes('  "external_ids"'), 'should have 2-space indent');
      // Verify it's valid JSON (minus trailing newline)
      const parsed = JSON.parse(result.trim());
      assert.deepStrictEqual(parsed, entity);
    });

    it('should handle empty objects', () => {
      const result = serializeEntity({});
      assert.strictEqual(result, '{}\n');
    });

    it('should handle arrays', () => {
      const entity = [1, 2, 3];
      const result = serializeEntity(entity);
      const expected = '[\n  1,\n  2,\n  3\n]\n';
      assert.strictEqual(result, expected);
    });
  });
});
