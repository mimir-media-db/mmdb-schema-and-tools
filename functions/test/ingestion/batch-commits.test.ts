/**
 * Tests for Git Trees API batch commit functions and groupByFirstLetter helper.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupByFirstLetter } from '../../src/ingestion/github-client.js';

describe('groupByFirstLetter', () => {
  it('should group items by the first letter of slug (after stripping m_ prefix)', () => {
    const items = [
      { id: 'm_inception_2010', title: 'Inception' },
      { id: 'm_interstellar_2014', title: 'Interstellar' },
      { id: 'm_avatar_2009', title: 'Avatar' },
      { id: 'm_batman_begins_2005', title: 'Batman Begins' },
    ];

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 3);
    assert.strictEqual(groups.get('I')!.length, 2);
    assert.strictEqual(groups.get('A')!.length, 1);
    assert.strictEqual(groups.get('B')!.length, 1);
  });

  it('should strip s_ prefix for series', () => {
    const items = [
      { id: 's_breaking_bad', title: 'Breaking Bad' },
      { id: 's_better_call_saul', title: 'Better Call Saul' },
      { id: 's_the_wire', title: 'The Wire' },
    ];

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get('B')!.length, 2);
    assert.strictEqual(groups.get('T')!.length, 1);
  });

  it('should strip p_ prefix for people', () => {
    const items = [
      { id: 'p_christopher_nolan', name: 'Christopher Nolan' },
      { id: 'p_christian_bale', name: 'Christian Bale' },
      { id: 'p_tom_hanks', name: 'Tom Hanks' },
    ];

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get('C')!.length, 2);
    assert.strictEqual(groups.get('T')!.length, 1);
  });

  it('should uppercase the letter', () => {
    const items = [
      { id: 'm_test_2020', title: 'Test' },
    ];

    const groups = groupByFirstLetter(items);

    assert.ok(groups.has('T'));
    assert.ok(!groups.has('t'));
  });

  it('should handle empty array', () => {
    const groups = groupByFirstLetter([]);
    assert.strictEqual(groups.size, 0);
  });

  it('should use # for items with empty slug after prefix stripping', () => {
    const items = [
      { id: 'm_', title: '' },
    ];

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 1);
    assert.ok(groups.has('#'));
  });

  it('should handle numeric first characters', () => {
    const items = [
      { id: 'm_2001_a_space_odyssey_1968', title: '2001: A Space Odyssey' },
      { id: 'm_300_2006', title: '300' },
    ];

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get('2')!.length, 1);
    assert.strictEqual(groups.get('3')!.length, 1);
  });

  it('should group all items with same letter together regardless of order', () => {
    const items = [
      { id: 'm_alpha_2020', title: 'Alpha' },
      { id: 'm_beta_2020', title: 'Beta' },
      { id: 'm_apple_2020', title: 'Apple' },
      { id: 'm_banana_2020', title: 'Banana' },
      { id: 'm_avocado_2020', title: 'Avocado' },
    ];

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 2);
    assert.strictEqual(groups.get('A')!.length, 3);
    assert.strictEqual(groups.get('B')!.length, 2);
  });

  it('should produce about 26 groups for a diverse set', () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const items = letters.split('').map(l => ({
      id: `m_${l.toLowerCase()}movie_2020`,
      title: `${l}Movie`,
    }));

    const groups = groupByFirstLetter(items);

    assert.strictEqual(groups.size, 26);
    for (const letter of letters) {
      assert.strictEqual(groups.get(letter)!.length, 1);
    }
  });
});
