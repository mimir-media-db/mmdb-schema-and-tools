/**
 * Pure helper functions for GitHub file path generation and serialization.
 * Extracted from github-client.ts for testability.
 */

import { generateSlug } from './id-generator.js';
import { MMDBMovie, MMDBPerson, MMDBSeries } from './normalizer.js';

export function getMovieFilePath(movie: MMDBMovie): string {
  const slug = generateSlug(movie.title);
  return `data/movies/${slug}-${movie.year}.json`;
}

export function getSeriesFilePath(series: MMDBSeries): string {
  const slug = generateSlug(series.title);
  return `data/series/${slug}.json`;
}

export function getPersonFilePath(person: MMDBPerson): string {
  return `data/people/${person.id}.json`;
}

export function serializeEntity(entity: unknown): string {
  return JSON.stringify(entity, null, 2) + '\n';
}
