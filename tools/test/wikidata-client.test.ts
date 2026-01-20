import { test } from 'node:test';
import assert from 'node:assert';
import { buildMovieQuery, parseMovieResults } from '../src/ingestion/wikidata-client.js';

test('buildMovieQuery - generates valid SPARQL', () => {
  const query = buildMovieQuery(2010, 10, 0);
  
  assert.ok(query.includes('?film wdt:P31 wd:Q11424'));
  assert.ok(query.includes('FILTER(?year = 2010)'));
  assert.ok(query.includes('LIMIT 10'));
  assert.ok(query.includes('OFFSET 0'));
});

test('buildMovieQuery - with custom limit and offset', () => {
  const query = buildMovieQuery(2015, 50, 100);
  
  assert.ok(query.includes('FILTER(?year = 2015)'));
  assert.ok(query.includes('LIMIT 50'));
  assert.ok(query.includes('OFFSET 100'));
});

test('parseMovieResults - parses Wikidata response', () => {
  const mockResponse = {
    results: {
      bindings: [
        {
          film: { value: 'http://www.wikidata.org/entity/Q43320' },
          filmLabel: { value: 'Inception' },
          year: { value: '2010' },
          imdb: { value: 'tt1375666' },
          tmdb: { value: '27205' },
          releaseDate: { value: '2010-07-16T00:00:00Z' },
          runtime: { value: '148' }
        }
      ]
    }
  };
  
  const movies = parseMovieResults(mockResponse);
  
  assert.strictEqual(movies.length, 1);
  assert.strictEqual(movies[0].label, 'Inception');
  assert.strictEqual(movies[0].year, 2010);
  assert.strictEqual(movies[0].wikidataId, 'Q43320');
  assert.strictEqual(movies[0].imdbId, 'tt1375666');
  assert.strictEqual(movies[0].tmdbId, 27205);
  assert.strictEqual(movies[0].releaseDate, '2010-07-16');
  assert.strictEqual(movies[0].runtime, 148);
});

test('parseMovieResults - handles missing optional fields', () => {
  const mockResponse = {
    results: {
      bindings: [
        {
          film: { value: 'http://www.wikidata.org/entity/Q12345' },
          filmLabel: { value: 'Test Movie' },
          year: { value: '2020' }
        }
      ]
    }
  };
  
  const movies = parseMovieResults(mockResponse);
  
  assert.strictEqual(movies.length, 1);
  assert.strictEqual(movies[0].label, 'Test Movie');
  assert.strictEqual(movies[0].imdbId, undefined);
  assert.strictEqual(movies[0].tmdbId, undefined);
});
