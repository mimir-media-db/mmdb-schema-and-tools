import { test } from 'node:test';
import assert from 'node:assert';

// Simulate duplicate detection logic (GitHub-based, no local state)
function checkForDuplicates(
  movies: Array<{ id: string; title: string }>,
  existingIds: Set<string>,
  pendingIds: Set<string>,
  limit: number
): { moviesToAdd: any[]; skipped: number } {
  const moviesToAdd: any[] = [];
  let skipped = 0;

  for (const movie of movies) {
    // Stop if we have enough movies
    if (moviesToAdd.length >= limit) {
      break;
    }

    if (existingIds.has(movie.id)) {
      skipped++;
      continue;
    }

    if (pendingIds.has(movie.id)) {
      skipped++;
      continue;
    }

    moviesToAdd.push(movie);
  }

  return { moviesToAdd, skipped };
}

test('should skip movies in master branch', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' },
    { id: 'm_movie_b_2010', title: 'Movie B' },
    { id: 'm_movie_c_2010', title: 'Movie C' }
  ];
  const existingIds = new Set(['m_movie_a_2010', 'm_movie_b_2010']);
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 1);
  assert.strictEqual(result.moviesToAdd[0].id, 'm_movie_c_2010');
  assert.strictEqual(result.skipped, 2);
});

test('should skip movies in pending PRs', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' },
    { id: 'm_movie_b_2010', title: 'Movie B' },
    { id: 'm_movie_c_2010', title: 'Movie C' }
  ];
  const existingIds = new Set<string>();
  const pendingIds = new Set(['m_movie_a_2010', 'm_movie_b_2010']);

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 1);
  assert.strictEqual(result.moviesToAdd[0].id, 'm_movie_c_2010');
  assert.strictEqual(result.skipped, 2);
});

test('should skip movies from both master and pending PRs', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' }, // in master
    { id: 'm_movie_b_2010', title: 'Movie B' }, // in pending PR
    { id: 'm_movie_c_2010', title: 'Movie C' }, // new
    { id: 'm_movie_d_2010', title: 'Movie D' }  // new
  ];
  const existingIds = new Set(['m_movie_a_2010']);
  const pendingIds = new Set(['m_movie_b_2010']);

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 2);
  assert.strictEqual(result.skipped, 2);
});

test('should collect exactly limit movies when enough available', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' }, // duplicate
    { id: 'm_movie_b_2010', title: 'Movie B' }, // new
    { id: 'm_movie_c_2010', title: 'Movie C' }, // new
    { id: 'm_movie_d_2010', title: 'Movie D' }, // new
    { id: 'm_movie_e_2010', title: 'Movie E' }  // new (but over limit)
  ];
  const existingIds = new Set(['m_movie_a_2010']);
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 3);

  assert.strictEqual(result.moviesToAdd.length, 3); // Exactly 3
  assert.strictEqual(result.skipped, 1);
});

test('should handle case where not enough unique movies available', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' }, // duplicate
    { id: 'm_movie_b_2010', title: 'Movie B' }, // duplicate
    { id: 'm_movie_c_2010', title: 'Movie C' }  // new
  ];
  const existingIds = new Set(['m_movie_a_2010', 'm_movie_b_2010']);
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 5);

  assert.strictEqual(result.moviesToAdd.length, 1); // Only 1 available
  assert.strictEqual(result.skipped, 2);
});

test('should return empty when all movies are duplicates', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' },
    { id: 'm_movie_b_2010', title: 'Movie B' }
  ];
  const existingIds = new Set(['m_movie_a_2010']);
  const pendingIds = new Set(['m_movie_b_2010']);

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 0);
  assert.strictEqual(result.skipped, 2);
});

test('should process all movies when no duplicates', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' },
    { id: 'm_movie_b_2010', title: 'Movie B' },
    { id: 'm_movie_c_2010', title: 'Movie C' }
  ];
  const existingIds = new Set<string>();
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 3);
  assert.strictEqual(result.skipped, 0);
});

test('should handle empty movie list', () => {
  const movies: any[] = [];
  const existingIds = new Set<string>();
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 0);
  assert.strictEqual(result.skipped, 0);
});

test('should handle empty existing and pending sets', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' }
  ];
  const existingIds = new Set<string>();
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 10);

  assert.strictEqual(result.moviesToAdd.length, 1);
  assert.strictEqual(result.skipped, 0);
});

test('should stop collecting after reaching limit even with more available', () => {
  const movies = [
    { id: 'm_movie_a_2010', title: 'Movie A' },
    { id: 'm_movie_b_2010', title: 'Movie B' },
    { id: 'm_movie_c_2010', title: 'Movie C' },
    { id: 'm_movie_d_2010', title: 'Movie D' },
    { id: 'm_movie_e_2010', title: 'Movie E' }
  ];
  const existingIds = new Set<string>();
  const pendingIds = new Set<string>();

  const result = checkForDuplicates(movies, existingIds, pendingIds, 2);

  assert.strictEqual(result.moviesToAdd.length, 2);
  assert.strictEqual(result.moviesToAdd[0].id, 'm_movie_a_2010');
  assert.strictEqual(result.moviesToAdd[1].id, 'm_movie_b_2010');
  assert.strictEqual(result.skipped, 0);
});
