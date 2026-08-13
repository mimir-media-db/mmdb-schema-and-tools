/**
 * Tests for ID and slug generation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  generateSlug,
  generateMovieId,
  generatePersonId,
  generateSeriesId,
} from '../../src/ingestion/id-generator.js';

describe('ID Generator', () => {
  describe('generateSlug', () => {
    it('should lowercase a basic title', () => {
      assert.strictEqual(generateSlug('Inception'), 'inception');
    });

    it('should remove leading "The" and convert spaces to underscores', () => {
      assert.strictEqual(generateSlug('The Dark Knight'), 'dark_knight');
    });

    it('should strip accents/diacritics', () => {
      assert.strictEqual(generateSlug('Amélie'), 'amelie');
    });

    it('should remove special characters', () => {
      assert.strictEqual(generateSlug('¡Three Amigos!'), 'three_amigos');
    });

    it('should remove leading article "A"', () => {
      assert.strictEqual(generateSlug('A Beautiful Mind'), 'beautiful_mind');
    });

    it('should remove leading article "An"', () => {
      assert.strictEqual(generateSlug('An Officer'), 'officer');
    });

    it('should collapse multiple spaces into single underscores', () => {
      assert.strictEqual(generateSlug('  hello   world  '), 'hello_world');
    });

    it('should handle commas and mixed punctuation', () => {
      assert.strictEqual(
        generateSlug('Crouching Tiger, Hidden Dragon'),
        'crouching_tiger_hidden_dragon'
      );
    });

    it('should handle empty string', () => {
      assert.strictEqual(generateSlug(''), '');
    });
  });

  describe('generateMovieId', () => {
    it('should produce m_<slug>_<year> format', () => {
      assert.strictEqual(generateMovieId('Inception', 2010), 'm_inception_2010');
    });

    it('should strip articles in the movie ID slug', () => {
      assert.strictEqual(generateMovieId('The Matrix', 1999), 'm_matrix_1999');
    });
  });

  describe('generatePersonId', () => {
    it('should produce p_<slug> format', () => {
      assert.strictEqual(generatePersonId('Christopher Nolan'), 'p_christopher_nolan');
    });

    it('should handle accented names', () => {
      assert.strictEqual(generatePersonId('Penélope Cruz'), 'p_penelope_cruz');
    });
  });

  describe('generateSeriesId', () => {
    it('should produce s_<slug> format', () => {
      assert.strictEqual(generateSeriesId('Breaking Bad'), 's_breaking_bad');
    });

    it('should strip leading articles', () => {
      assert.strictEqual(generateSeriesId('The Wire'), 's_wire');
    });
  });
});
