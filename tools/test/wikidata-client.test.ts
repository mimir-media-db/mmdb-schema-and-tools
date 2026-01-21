import { test } from 'node:test';
import assert from 'node:assert';
import { buildMovieQuery, parseMovieResults, buildPersonQueryFromMovies, parsePersonResults } from '../src/ingestion/wikidata-client.js';

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

test('buildPersonQueryFromMovies - generates valid SPARQL with single movie', () => {
  const query = buildPersonQueryFromMovies(['Q43320'], 10);
  
  assert.ok(query.includes('VALUES ?movie { wd:Q43320 }'));
  assert.ok(query.includes('?movie wdt:P161 ?person'));  // cast member
  assert.ok(query.includes('?movie wdt:P57 ?person'));   // director
  assert.ok(query.includes('?movie wdt:P162 ?person'));  // producer
  assert.ok(query.includes('?person wdt:P31 wd:Q5'));    // human
  assert.ok(query.includes('?person wdt:P345 ?imdb'));   // IMDb ID
  assert.ok(query.includes('FILTER(LANG(?personLabel) = "en")'));
  assert.ok(query.includes('LIMIT 10'));
});

test('buildPersonQueryFromMovies - generates valid SPARQL with multiple movies', () => {
  const query = buildPersonQueryFromMovies(['Q43320', 'Q49903', 'Q105825'], 50);
  
  assert.ok(query.includes('VALUES ?movie { wd:Q43320 wd:Q49903 wd:Q105825 }'));
  assert.ok(query.includes('LIMIT 50'));
});

test('buildPersonQueryFromMovies - includes UNION for cast, directors, and producers', () => {
  const query = buildPersonQueryFromMovies(['Q43320'], 10);
  
  assert.ok(query.includes('UNION'));
  assert.ok(query.includes('wdt:P161'));  // cast
  assert.ok(query.includes('wdt:P57'));   // director
  assert.ok(query.includes('wdt:P162'));  // producer
});

test('parsePersonResults - parses Wikidata person response', () => {
  const mockResponse = {
    results: {
      bindings: [
        {
          person: { value: 'http://www.wikidata.org/entity/Q25191' },
          personLabel: { value: 'Christopher Nolan' },
          birthDate: { value: '1970-07-30T00:00:00Z' },
          imdb: { value: 'nm0634240' }
        }
      ]
    }
  };
  
  const people = parsePersonResults(mockResponse);
  
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].label, 'Christopher Nolan');
  assert.strictEqual(people[0].wikidataId, 'Q25191');
  assert.strictEqual(people[0].imdbId, 'nm0634240');
  assert.strictEqual(people[0].birthYear, 1970);
  assert.strictEqual(people[0].deathYear, undefined);
});

test('parsePersonResults - handles missing optional fields', () => {
  const mockResponse = {
    results: {
      bindings: [
        {
          person: { value: 'http://www.wikidata.org/entity/Q12345' },
          personLabel: { value: 'Test Person' },
          imdb: { value: 'nm1234567' }
        }
      ]
    }
  };
  
  const people = parsePersonResults(mockResponse);
  
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].label, 'Test Person');
  assert.strictEqual(people[0].birthYear, undefined);
  assert.strictEqual(people[0].deathYear, undefined);
});

test('parsePersonResults - handles death date', () => {
  const mockResponse = {
    results: {
      bindings: [
        {
          person: { value: 'http://www.wikidata.org/entity/Q123' },
          personLabel: { value: 'Historical Person' },
          birthDate: { value: '1920-06-15T00:00:00Z' },
          deathDate: { value: '2000-12-31T00:00:00Z' },
          imdb: { value: 'nm0000001' }
        }
      ]
    }
  };
  
  const people = parsePersonResults(mockResponse);
  
  assert.strictEqual(people.length, 1);
  assert.strictEqual(people[0].birthYear, 1920);
  assert.strictEqual(people[0].deathYear, 2000);
});

test('parsePersonResults - handles multiple people', () => {
  const mockResponse = {
    results: {
      bindings: [
        {
          person: { value: 'http://www.wikidata.org/entity/Q1' },
          personLabel: { value: 'Person One' },
          imdb: { value: 'nm0000001' }
        },
        {
          person: { value: 'http://www.wikidata.org/entity/Q2' },
          personLabel: { value: 'Person Two' },
          imdb: { value: 'nm0000002' }
        }
      ]
    }
  };
  
  const people = parsePersonResults(mockResponse);
  
  assert.strictEqual(people.length, 2);
  assert.strictEqual(people[0].label, 'Person One');
  assert.strictEqual(people[1].label, 'Person Two');
});
