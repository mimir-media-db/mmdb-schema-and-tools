/**
 * Wikidata → MMDB format normalizer.
 * Self-contained copy adapted from tools/src/ingestion/normalizer.ts
 */

import { WikidataMovie, WikidataPerson, WikidataSeries } from './wikidata-client.js';
import { generateMovieId, generatePersonId, generateSeriesId } from './id-generator.js';

/**
 * Determines whether a title is usable for ingestion.
 * Rejects Wikidata Q-IDs and titles that would produce an empty/unusable slug
 * (e.g., purely non-Latin titles like Arabic-only or CJK-only).
 */
export function isUsableTitle(title: string): boolean {
  if (!title) return false;
  if (/^Q\d+$/i.test(title)) return false;
  const slug = title.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim();
  return slug.length >= 2;
}

export interface MMDBMovie {
  schema_version: number;
  id: string;
  title: string;
  year: number;
  type: string;
  release_date?: string;
  runtime_minutes?: number;
  external_ids: {
    wikidata: string;
    imdb?: string;
    tmdb?: number;
  };
  last_updated: string;
}

export interface MMDBPerson {
  schema_version: number;
  id: string;
  name: string;
  birth_year?: number;
  death_year?: number | null;
  external_ids: {
    wikidata: string;
    imdb?: string;
  };
  last_updated: string;
}

export interface MMDBSeries {
  schema_version: number;
  id: string;
  title: string;
  start_year: number;
  end_year?: number | null;
  total_seasons?: number;
  total_episodes?: number;
  external_ids: {
    wikidata: string;
    imdb?: string;
    tmdb?: number;
  };
  last_updated: string;
}

export function normalizeMovie(wikiMovie: WikidataMovie): MMDBMovie {
  if (!isUsableTitle(wikiMovie.label)) {
    throw new Error(`Cannot normalize: title is unusable (${wikiMovie.label})`);
  }

  const id = generateMovieId(wikiMovie.label, wikiMovie.year);
  const today = new Date().toISOString().split('T')[0];

  const movie: MMDBMovie = {
    schema_version: 1,
    id,
    title: wikiMovie.label,
    year: wikiMovie.year,
    type: 'movie',
    external_ids: {
      wikidata: wikiMovie.wikidataId,
    },
    last_updated: today,
  };

  if (wikiMovie.releaseDate) {
    movie.release_date = wikiMovie.releaseDate;
  }

  if (wikiMovie.runtime) {
    movie.runtime_minutes = wikiMovie.runtime;
  }

  if (wikiMovie.imdbId && /^tt\d+$/.test(wikiMovie.imdbId)) {
    movie.external_ids.imdb = wikiMovie.imdbId;
  }

  if (wikiMovie.tmdbId) {
    movie.external_ids.tmdb = wikiMovie.tmdbId;
  }

  return movie;
}

export function normalizePerson(wikiPerson: WikidataPerson): MMDBPerson {
  const id = generatePersonId(wikiPerson.label);
  const today = new Date().toISOString().split('T')[0];

  const person: MMDBPerson = {
    schema_version: 1,
    id,
    name: wikiPerson.label,
    external_ids: {
      wikidata: wikiPerson.wikidataId,
    },
    last_updated: today,
  };

  if (wikiPerson.birthYear) {
    person.birth_year = wikiPerson.birthYear;
  }

  if (wikiPerson.deathYear) {
    person.death_year = wikiPerson.deathYear;
  } else {
    person.death_year = null;
  }

  if (wikiPerson.imdbId && /^nm\d+$/.test(wikiPerson.imdbId)) {
    person.external_ids.imdb = wikiPerson.imdbId;
  }

  return person;
}

export function normalizeSeries(wikiSeries: WikidataSeries): MMDBSeries {
  if (!isUsableTitle(wikiSeries.label)) {
    throw new Error(`Cannot normalize: title is unusable (${wikiSeries.label})`);
  }

  const today = new Date().toISOString().split('T')[0];
  const id = generateSeriesId(wikiSeries.label);

  const series: MMDBSeries = {
    schema_version: 1,
    id,
    title: wikiSeries.label,
    start_year: wikiSeries.startYear,
    external_ids: {
      wikidata: wikiSeries.wikidataId,
    },
    last_updated: today,
  };

  if (wikiSeries.endYear) {
    series.end_year = wikiSeries.endYear;
  } else {
    series.end_year = null;
  }

  if (wikiSeries.totalSeasons) {
    series.total_seasons = wikiSeries.totalSeasons;
  }

  if (wikiSeries.totalEpisodes) {
    series.total_episodes = wikiSeries.totalEpisodes;
  }

  if (wikiSeries.imdbId && /^tt\d+$/.test(wikiSeries.imdbId)) {
    series.external_ids.imdb = wikiSeries.imdbId;
  }

  if (wikiSeries.tmdbId) {
    series.external_ids.tmdb = wikiSeries.tmdbId;
  }

  return series;
}
