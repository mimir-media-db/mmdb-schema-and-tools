import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeMovie, normalizeSeries } from '../src/ingestion/normalizer.js';
import { WikidataMovie, WikidataSeries } from '../src/ingestion/wikidata-client.js';

test('normalizeMovie - minimal movie', () => {
  const wikiMovie: WikidataMovie = {
    id: '',
    label: 'Inception',
    year: 2010,
    wikidataId: 'Q43320'
  };
  
  const result = normalizeMovie(wikiMovie);
  
  assert.strictEqual(result.schema_version, 1);
  assert.strictEqual(result.id, 'm_inception_2010');
  assert.strictEqual(result.title, 'Inception');
  assert.strictEqual(result.year, 2010);
  assert.strictEqual(result.type, 'movie');
  assert.strictEqual(result.external_ids.wikidata, 'Q43320');
  assert.ok(result.last_updated);
});

test('normalizeMovie - full movie with all fields', () => {
  const wikiMovie: WikidataMovie = {
    id: '',
    label: 'The Dark Knight',
    year: 2008,
    wikidataId: 'Q166262',
    imdbId: 'tt0468569',
    tmdbId: 155,
    releaseDate: '2008-07-18',
    runtime: 152
  };
  
  const result = normalizeMovie(wikiMovie);
  
  assert.strictEqual(result.id, 'm_dark_knight_2008');
  assert.strictEqual(result.release_date, '2008-07-18');
  assert.strictEqual(result.runtime_minutes, 152);
  assert.strictEqual(result.external_ids.imdb, 'tt0468569');
  assert.strictEqual(result.external_ids.tmdb, 155);
});

test('normalizeMovie - movie with special characters in title', () => {
  const wikiMovie: WikidataMovie = {
    id: '',
    label: 'Spider-Man: No Way Home',
    year: 2021,
    wikidataId: 'Q60315045'
  };
  
  const result = normalizeMovie(wikiMovie);
  
  assert.strictEqual(result.id, 'm_spiderman_no_way_home_2021');
  assert.strictEqual(result.title, 'Spider-Man: No Way Home');
});


test('normalizeSeries - minimal series', () => {
  const wikiSeries: WikidataSeries = {
    id: '',
    label: 'Breaking Bad',
    startYear: 2008,
    wikidataId: 'Q65'
  };
  
  const result = normalizeSeries(wikiSeries);
  
  assert.strictEqual(result.schema_version, 1);
  assert.strictEqual(result.id, 's_breaking_bad');
  assert.strictEqual(result.title, 'Breaking Bad');
  assert.strictEqual(result.start_year, 2008);
  assert.strictEqual(result.end_year, null);
  assert.strictEqual(result.external_ids.wikidata, 'Q65');
  assert.ok(result.last_updated);
});

test('normalizeSeries - full series with all fields', () => {
  const wikiSeries: WikidataSeries = {
    id: '',
    label: 'Game of Thrones',
    startYear: 2011,
    endYear: 2019,
    wikidataId: 'Q23572',
    imdbId: 'tt0944947',
    tmdbId: 1399,
    totalSeasons: 8,
    totalEpisodes: 73
  };
  
  const result = normalizeSeries(wikiSeries);
  
  assert.strictEqual(result.id, 's_game_of_thrones');
  assert.strictEqual(result.start_year, 2011);
  assert.strictEqual(result.end_year, 2019);
  assert.strictEqual(result.total_seasons, 8);
  assert.strictEqual(result.total_episodes, 73);
  assert.strictEqual(result.external_ids.imdb, 'tt0944947');
  assert.strictEqual(result.external_ids.tmdb, 1399);
});

test('normalizeSeries - ongoing series (no end year)', () => {
  const wikiSeries: WikidataSeries = {
    id: '',
    label: 'The Simpsons',
    startYear: 1989,
    wikidataId: 'Q886'
  };
  
  const result = normalizeSeries(wikiSeries);
  
  assert.strictEqual(result.id, 's_simpsons');
  assert.strictEqual(result.start_year, 1989);
  assert.strictEqual(result.end_year, null);
});
