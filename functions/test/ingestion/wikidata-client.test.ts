/**
 * Tests for Wikidata SPARQL query builders and result parsers.
 * Only tests pure functions — no network calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildMovieQuery,
  buildSeriesQuery,
  buildPersonQueryFromMovies,
  buildRecentMovieQuery,
  buildRecentSeriesQuery,
  parseMovieResults,
  parseSeriesResults,
  parsePersonResults,
} from '../../src/ingestion/wikidata-client.js';

describe('Wikidata Client', () => {
  describe('Query Builders', () => {
    describe('buildMovieQuery', () => {
      it('should include year, limit, and offset', () => {
        const query = buildMovieQuery(2010, 50, 100);
        assert.ok(query.includes('FILTER(?year = 2010)'), 'should filter by year');
        assert.ok(query.includes('LIMIT 50'), 'should set limit');
        assert.ok(query.includes('OFFSET 100'), 'should set offset');
      });

      it('should query for instances of film (Q11424)', () => {
        const query = buildMovieQuery(2010, 50, 0);
        assert.ok(query.includes('wd:Q11424'), 'should reference film entity');
      });
    });

    describe('buildSeriesQuery', () => {
      it('should include correct year filter, limit, and offset', () => {
        const query = buildSeriesQuery(2020, 30, 0);
        assert.ok(query.includes('FILTER(?startYear = 2020)'), 'should filter by start year');
        assert.ok(query.includes('LIMIT 30'), 'should set limit');
        assert.ok(query.includes('OFFSET 0'), 'should set offset');
      });

      it('should query for TV series (Q5398426)', () => {
        const query = buildSeriesQuery(2020, 30, 0);
        assert.ok(query.includes('wd:Q5398426'), 'should reference TV series entity');
      });
    });

    describe('buildPersonQueryFromMovies', () => {
      it('should include VALUES clause with movie IDs', () => {
        const query = buildPersonQueryFromMovies(['Q123', 'Q456'], 100);
        assert.ok(query.includes('VALUES ?movie { wd:Q123 wd:Q456 }'), 'should include VALUES clause');
        assert.ok(query.includes('LIMIT 100'), 'should set limit');
      });

      it('should handle a single movie ID', () => {
        const query = buildPersonQueryFromMovies(['Q789'], 50);
        assert.ok(query.includes('VALUES ?movie { wd:Q789 }'), 'should handle single ID');
      });
    });

    describe('buildRecentMovieQuery', () => {
      it('should include dateModified filter and limit', () => {
        const query = buildRecentMovieQuery('2026-08-01T00:00:00Z', 40);
        assert.ok(
          query.includes('"2026-08-01T00:00:00Z"^^xsd:dateTime'),
          'should include dateModified filter'
        );
        assert.ok(query.includes('LIMIT 40'), 'should set limit');
      });

      it('should order by modified date descending', () => {
        const query = buildRecentMovieQuery('2026-08-01T00:00:00Z', 40);
        assert.ok(query.includes('ORDER BY DESC(?modified)'), 'should order descending');
      });
    });

    describe('buildRecentSeriesQuery', () => {
      it('should include dateModified filter and limit', () => {
        const query = buildRecentSeriesQuery('2026-08-01T00:00:00Z', 20);
        assert.ok(
          query.includes('"2026-08-01T00:00:00Z"^^xsd:dateTime'),
          'should include dateModified filter'
        );
        assert.ok(query.includes('LIMIT 20'), 'should set limit');
      });

      it('should order by modified date descending', () => {
        const query = buildRecentSeriesQuery('2026-08-01T00:00:00Z', 20);
        assert.ok(query.includes('ORDER BY DESC(?modified)'), 'should order descending');
      });
    });
  });

  describe('Result Parsers', () => {
    describe('parseMovieResults', () => {
      const mockFullResponse = {
        results: {
          bindings: [
            {
              film: { value: 'http://www.wikidata.org/entity/Q43320' },
              filmLabel: { value: 'Inception' },
              year: { value: '2010' },
              imdb: { value: 'tt1375666' },
              tmdb: { value: '27205' },
              releaseDate: { value: '2010-07-16T00:00:00Z' },
              runtime: { value: '148' },
            },
          ],
        },
      };

      it('should parse full binding data into WikidataMovie array', () => {
        const movies = parseMovieResults(mockFullResponse);
        assert.strictEqual(movies.length, 1);
        assert.strictEqual(movies[0].wikidataId, 'Q43320');
        assert.strictEqual(movies[0].label, 'Inception');
        assert.strictEqual(movies[0].year, 2010);
        assert.strictEqual(movies[0].imdbId, 'tt1375666');
        assert.strictEqual(movies[0].tmdbId, 27205);
        assert.strictEqual(movies[0].releaseDate, '2010-07-16');
        assert.strictEqual(movies[0].runtime, 148);
      });

      it('should handle missing optional fields gracefully', () => {
        const minimalResponse = {
          results: {
            bindings: [
              {
                film: { value: 'http://www.wikidata.org/entity/Q99999' },
                filmLabel: { value: 'Minimal Movie' },
                year: { value: '2015' },
              },
            ],
          },
        };

        const movies = parseMovieResults(minimalResponse);
        assert.strictEqual(movies.length, 1);
        assert.strictEqual(movies[0].wikidataId, 'Q99999');
        assert.strictEqual(movies[0].label, 'Minimal Movie');
        assert.strictEqual(movies[0].year, 2015);
        assert.strictEqual(movies[0].imdbId, undefined);
        assert.strictEqual(movies[0].tmdbId, undefined);
        assert.strictEqual(movies[0].releaseDate, undefined);
        assert.strictEqual(movies[0].runtime, undefined);
      });

      it('should return empty array for empty results', () => {
        const emptyResponse = { results: { bindings: [] } };
        const movies = parseMovieResults(emptyResponse);
        assert.deepStrictEqual(movies, []);
      });
    });

    describe('parseSeriesResults', () => {
      it('should parse full data into WikidataSeries array', () => {
        const response = {
          results: {
            bindings: [
              {
                series: { value: 'http://www.wikidata.org/entity/Q1079' },
                seriesLabel: { value: 'Breaking Bad' },
                startDate: { value: '2008-01-20T00:00:00Z' },
                endDate: { value: '2013-09-29T00:00:00Z' },
                imdb: { value: 'tt0903747' },
                tmdb: { value: '1396' },
                seasons: { value: '5' },
                episodes: { value: '62' },
              },
            ],
          },
        };

        const result = parseSeriesResults(response);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].wikidataId, 'Q1079');
        assert.strictEqual(result[0].label, 'Breaking Bad');
        assert.strictEqual(result[0].startYear, 2008);
        assert.strictEqual(result[0].endYear, 2013);
        assert.strictEqual(result[0].imdbId, 'tt0903747');
        assert.strictEqual(result[0].tmdbId, 1396);
        assert.strictEqual(result[0].totalSeasons, 5);
        assert.strictEqual(result[0].totalEpisodes, 62);
      });

      it('should set endYear to undefined when endDate is missing', () => {
        const response = {
          results: {
            bindings: [
              {
                series: { value: 'http://www.wikidata.org/entity/Q55555' },
                seriesLabel: { value: 'Ongoing Show' },
                startDate: { value: '2020-03-01T00:00:00Z' },
              },
            ],
          },
        };

        const result = parseSeriesResults(response);
        assert.strictEqual(result[0].endYear, undefined);
      });
    });

    describe('parsePersonResults', () => {
      it('should parse full data into WikidataPerson array', () => {
        const response = {
          results: {
            bindings: [
              {
                person: { value: 'http://www.wikidata.org/entity/Q25191' },
                personLabel: { value: 'Christopher Nolan' },
                birthDate: { value: '1970-07-30T00:00:00Z' },
                deathDate: { value: '2070-06-15T00:00:00Z' },
                imdb: { value: 'nm0634240' },
              },
            ],
          },
        };

        const result = parsePersonResults(response);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].wikidataId, 'Q25191');
        assert.strictEqual(result[0].label, 'Christopher Nolan');
        assert.strictEqual(result[0].birthYear, 1970);
        assert.strictEqual(result[0].deathYear, 2070);
        assert.strictEqual(result[0].imdbId, 'nm0634240');
      });

      it('should set birthYear to undefined when birthDate is missing', () => {
        const response = {
          results: {
            bindings: [
              {
                person: { value: 'http://www.wikidata.org/entity/Q88888' },
                personLabel: { value: 'Unknown Person' },
                imdb: { value: 'nm9999999' },
              },
            ],
          },
        };

        const result = parsePersonResults(response);
        assert.strictEqual(result[0].birthYear, undefined);
        assert.strictEqual(result[0].deathYear, undefined);
      });
    });
  });
});
