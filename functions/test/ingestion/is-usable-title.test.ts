/**
 * Tests for isUsableTitle — rejects Q-IDs and non-Latin/unusable titles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isUsableTitle } from '../../src/ingestion/normalizer.js';

describe('isUsableTitle', () => {
  it('should accept normal Latin titles', () => {
    assert.strictEqual(isUsableTitle('The Matrix'), true);
  });

  it('should reject Wikidata Q-IDs', () => {
    assert.strictEqual(isUsableTitle('Q140513842'), false);
  });

  it('should reject Arabic-only titles', () => {
    assert.strictEqual(isUsableTitle('آخر صفقة حب'), false);
  });

  it('should reject Japanese-only titles', () => {
    assert.strictEqual(isUsableTitle('君の名は'), false);
  });

  it('should accept Latin titles with diacritics', () => {
    assert.strictEqual(isUsableTitle('Amélie'), true);
  });

  it('should accept purely numeric titles (4+ digits)', () => {
    assert.strictEqual(isUsableTitle('2001'), true);
  });

  it('should accept numeric titles like year-based films', () => {
    assert.strictEqual(isUsableTitle('1917'), true);
  });

  it('should reject single-char titles (too short after slug)', () => {
    assert.strictEqual(isUsableTitle('A'), false);
  });

  it('should accept multi-word Latin titles', () => {
    assert.strictEqual(isUsableTitle('Crouching Tiger, Hidden Dragon'), true);
  });

  it('should accept mixed Latin + non-Latin titles', () => {
    assert.strictEqual(isUsableTitle('Parasite 기생충'), true);
  });

  it('should reject empty strings', () => {
    assert.strictEqual(isUsableTitle(''), false);
  });

  it('should reject lowercase Q-IDs', () => {
    assert.strictEqual(isUsableTitle('q12345'), false);
  });

  it('should accept titles with numbers and Latin', () => {
    assert.strictEqual(isUsableTitle('Ocean\'s 11'), true);
  });

  it('should accept two-letter titles that produce valid slugs', () => {
    assert.strictEqual(isUsableTitle('Up'), true);
  });

  it('should reject titles that are only special characters', () => {
    assert.strictEqual(isUsableTitle('!!!'), false);
  });
});
