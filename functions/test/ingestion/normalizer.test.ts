/**
 * Tests for Wikidata → MMDB format normalizer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeMovie, normalizePerson, normalizeSeries } from '../../src/ingestion/normalizer.js';
import type { WikidataMovie, WikidataPerson, WikidataSeries } from '../../src/ingestion/wikidata-client.js';

describe('Normalizer', () => {
  describe('normalizeMovie', () => {
    const baseMovie: WikidataMovie = {
      id: '',
      label: 'Inception',
      year: 2010,
      imdbId: 'tt1375666',
      tmdbId: 27205,
      wikidataId: 'Q43320',
      releaseDate: '2010-07-16',
      runtime: 148,
    };

    it('should populate all fields correctly when fully specified', () => {
      const result = normalizeMovie(baseMovie);

      assert.strictEqual(result.schema_version, 1);
      assert.strictEqual(result.id, 'm_inception_2010');
      assert.strictEqual(result.title, 'Inception');
      assert.strictEqual(result.year, 2010);
      assert.strictEqual(result.type, 'movie');
      assert.strictEqual(result.release_date, '2010-07-16');
      assert.strictEqual(result.runtime_minutes, 148);
      assert.strictEqual(result.external_ids.wikidata, 'Q43320');
      assert.strictEqual(result.external_ids.imdb, 'tt1375666');
      assert.strictEqual(result.external_ids.tmdb, 27205);
    });

    it('should omit optional fields when undefined', () => {
      const minimalMovie: WikidataMovie = {
        id: '',
        label: 'Test Movie',
        year: 2020,
        wikidataId: 'Q99999',
      };

      const result = normalizeMovie(minimalMovie);

      assert.strictEqual(result.release_date, undefined);
      assert.strictEqual(result.runtime_minutes, undefined);
      assert.strictEqual(result.external_ids.imdb, undefined);
      assert.strictEqual(result.external_ids.tmdb, undefined);
    });

    it('should always set schema_version to 1', () => {
      const result = normalizeMovie(baseMovie);
      assert.strictEqual(result.schema_version, 1);
    });

    it('should set last_updated to today\'s date', () => {
      const result = normalizeMovie(baseMovie);
      const today = new Date().toISOString().split('T')[0];
      assert.strictEqual(result.last_updated, today);
    });

    it('should always set external_ids.wikidata', () => {
      const result = normalizeMovie(baseMovie);
      assert.strictEqual(result.external_ids.wikidata, 'Q43320');
    });
  });

  describe('normalizePerson', () => {
    it('should map birth_year and death_year correctly', () => {
      const person: WikidataPerson = {
        id: '',
        label: 'Alan Rickman',
        birthYear: 1946,
        deathYear: 2016,
        imdbId: 'nm0000614',
        wikidataId: 'Q48337',
      };

      const result = normalizePerson(person);
      assert.strictEqual(result.birth_year, 1946);
      assert.strictEqual(result.death_year, 2016);
    });

    it('should set death_year to null when person is alive', () => {
      const person: WikidataPerson = {
        id: '',
        label: 'Christopher Nolan',
        birthYear: 1970,
        wikidataId: 'Q25191',
      };

      const result = normalizePerson(person);
      assert.strictEqual(result.death_year, null);
    });

    it('should include IMDb ID when present', () => {
      const person: WikidataPerson = {
        id: '',
        label: 'Tom Hanks',
        birthYear: 1956,
        imdbId: 'nm0000158',
        wikidataId: 'Q2263',
      };

      const result = normalizePerson(person);
      assert.strictEqual(result.external_ids.imdb, 'nm0000158');
    });

    it('should omit IMDb ID when not present', () => {
      const person: WikidataPerson = {
        id: '',
        label: 'Unknown Actor',
        wikidataId: 'Q88888',
      };

      const result = normalizePerson(person);
      assert.strictEqual(result.external_ids.imdb, undefined);
    });

    it('should generate correct person ID', () => {
      const person: WikidataPerson = {
        id: '',
        label: 'Christopher Nolan',
        wikidataId: 'Q25191',
      };

      const result = normalizePerson(person);
      assert.strictEqual(result.id, 'p_christopher_nolan');
    });
  });

  describe('normalizeSeries', () => {
    it('should map start_year and end_year correctly', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Breaking Bad',
        startYear: 2008,
        endYear: 2013,
        imdbId: 'tt0903747',
        tmdbId: 1396,
        wikidataId: 'Q1079',
        totalSeasons: 5,
        totalEpisodes: 62,
      };

      const result = normalizeSeries(series);
      assert.strictEqual(result.start_year, 2008);
      assert.strictEqual(result.end_year, 2013);
    });

    it('should set end_year to null when ongoing', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Ongoing Show',
        startYear: 2020,
        wikidataId: 'Q77777',
      };

      const result = normalizeSeries(series);
      assert.strictEqual(result.end_year, null);
    });

    it('should include total_seasons and total_episodes when present', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Breaking Bad',
        startYear: 2008,
        endYear: 2013,
        wikidataId: 'Q1079',
        totalSeasons: 5,
        totalEpisodes: 62,
      };

      const result = normalizeSeries(series);
      assert.strictEqual(result.total_seasons, 5);
      assert.strictEqual(result.total_episodes, 62);
    });

    it('should omit total_seasons and total_episodes when not present', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Minimal Series',
        startYear: 2015,
        wikidataId: 'Q55555',
      };

      const result = normalizeSeries(series);
      assert.strictEqual(result.total_seasons, undefined);
      assert.strictEqual(result.total_episodes, undefined);
    });

    it('should include IMDb and TMDB IDs when present', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Breaking Bad',
        startYear: 2008,
        imdbId: 'tt0903747',
        tmdbId: 1396,
        wikidataId: 'Q1079',
      };

      const result = normalizeSeries(series);
      assert.strictEqual(result.external_ids.imdb, 'tt0903747');
      assert.strictEqual(result.external_ids.tmdb, 1396);
    });

    it('should set schema_version to 1 and last_updated to today', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Test Show',
        startYear: 2020,
        wikidataId: 'Q11111',
      };

      const result = normalizeSeries(series);
      const today = new Date().toISOString().split('T')[0];
      assert.strictEqual(result.schema_version, 1);
      assert.strictEqual(result.last_updated, today);
    });
  });
});
