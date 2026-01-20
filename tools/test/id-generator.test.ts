import { test } from 'node:test';
import assert from 'node:assert';
import { generateSlug, generateMovieId, generatePersonId } from '../src/ingestion/id-generator.js';

test('generateSlug - basic title', () => {
  assert.strictEqual(generateSlug('Inception'), 'inception');
});

test('generateSlug - title with spaces', () => {
  assert.strictEqual(generateSlug('The Dark Knight'), 'dark_knight');
});

test('generateSlug - title with special characters', () => {
  assert.strictEqual(generateSlug('Spider-Man: No Way Home'), 'spiderman_no_way_home');
});

test('generateSlug - title with accents', () => {
  assert.strictEqual(generateSlug('Amélie'), 'amelie');
});

test('generateSlug - title with articles', () => {
  assert.strictEqual(generateSlug('The Matrix'), 'matrix');
  assert.strictEqual(generateSlug('A Beautiful Mind'), 'beautiful_mind');
  assert.strictEqual(generateSlug('An Education'), 'education');
});

test('generateSlug - title with multiple spaces', () => {
  assert.strictEqual(generateSlug('The  Social   Network'), 'social_network');
});

test('generateMovieId - standard movie', () => {
  assert.strictEqual(generateMovieId('Inception', 2010), 'm_inception_2010');
});

test('generateMovieId - movie with spaces', () => {
  assert.strictEqual(generateMovieId('The Dark Knight', 2008), 'm_dark_knight_2008');
});

test('generatePersonId - standard name', () => {
  assert.strictEqual(generatePersonId('Christopher Nolan'), 'p_christopher_nolan');
});

test('generatePersonId - name with accents', () => {
  assert.strictEqual(generatePersonId('François Truffaut'), 'p_francois_truffaut');
});
