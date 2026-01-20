import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeMovie } from '../src/ingestion/normalizer.js';
import { WikidataMovie } from '../src/ingestion/wikidata-client.js';

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
