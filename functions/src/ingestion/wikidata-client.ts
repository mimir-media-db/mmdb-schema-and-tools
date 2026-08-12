/**
 * Wikidata SPARQL query client for MMDB ingestion.
 * Self-contained copy adapted from tools/src/ingestion/wikidata-client.ts
 * with additions for recent-modified queries.
 */

import { logger } from 'firebase-functions/v2';
import { WIKIDATA_RATE_LIMIT_MS } from '../config.js';

export interface WikidataMovie {
  id: string;
  label: string;
  year: number;
  imdbId?: string;
  tmdbId?: number;
  wikidataId: string;
  releaseDate?: string;
  runtime?: number;
  originalLanguage?: string;
  countries?: string[];
  directors?: string[];
  cast?: string[];
}

export interface WikidataPerson {
  id: string;
  label: string;
  birthYear?: number;
  deathYear?: number;
  imdbId?: string;
  wikidataId: string;
}

export interface WikidataSeries {
  id: string;
  label: string;
  startYear: number;
  endYear?: number;
  imdbId?: string;
  tmdbId?: number;
  wikidataId: string;
  totalSeasons?: number;
  totalEpisodes?: number;
}

export function buildMovieQuery(year: number, limit: number = 100, offset: number = 0): string {
  return `
SELECT DISTINCT ?film ?filmLabel ?year ?imdb ?tmdb ?releaseDate ?runtime
WHERE {
  ?film wdt:P31 wd:Q11424.           # instance of film
  ?film wdt:P577 ?releaseDate.       # publication date
  BIND(YEAR(?releaseDate) AS ?year)
  FILTER(?year = ${year})
  
  OPTIONAL { ?film wdt:P345 ?imdb. } # IMDb ID
  OPTIONAL { ?film wdt:P4947 ?tmdb. } # TMDB ID
  OPTIONAL { ?film wdt:P2047 ?runtime. } # duration
  
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?releaseDate
LIMIT ${limit}
OFFSET ${offset}
`.trim();
}

export function buildRecentMovieQuery(modifiedAfter: string, limit: number = 40): string {
  return `
SELECT DISTINCT ?film ?filmLabel ?year ?imdb ?tmdb ?releaseDate ?runtime
WHERE {
  ?film wdt:P31 wd:Q11424.           # instance of film
  ?film wdt:P577 ?releaseDate.       # publication date
  ?film schema:dateModified ?modified.
  BIND(YEAR(?releaseDate) AS ?year)
  FILTER(?modified > "${modifiedAfter}"^^xsd:dateTime)
  
  OPTIONAL { ?film wdt:P345 ?imdb. } # IMDb ID
  OPTIONAL { ?film wdt:P4947 ?tmdb. } # TMDB ID
  OPTIONAL { ?film wdt:P2047 ?runtime. } # duration
  
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?modified)
LIMIT ${limit}
`.trim();
}

export function buildSeriesQuery(year: number, limit: number = 100, offset: number = 0): string {
  return `
SELECT DISTINCT ?series ?seriesLabel ?startDate ?endDate ?imdb ?tmdb ?seasons ?episodes
WHERE {
  ?series wdt:P31 wd:Q5398426.       # instance of television series
  ?series wdt:P580 ?startDate.       # start time
  
  BIND(YEAR(?startDate) as ?startYear)
  FILTER(?startYear = ${year})
  
  OPTIONAL { ?series wdt:P582 ?endDate. }      # end time
  OPTIONAL { ?series wdt:P345 ?imdb. }         # IMDb ID
  OPTIONAL { ?series wdt:P4983 ?tmdb. }        # TMDB ID
  OPTIONAL { ?series wdt:P2437 ?seasons. }     # number of seasons
  OPTIONAL { ?series wdt:P1113 ?episodes. }    # number of episodes
  
  # Ensure entity has an English label
  ?series rdfs:label ?seriesLabel .
  FILTER(LANG(?seriesLabel) = "en")
}
ORDER BY ?seriesLabel
LIMIT ${limit}
OFFSET ${offset}
`.trim();
}

export function buildRecentSeriesQuery(modifiedAfter: string, limit: number = 40): string {
  return `
SELECT DISTINCT ?series ?seriesLabel ?startDate ?endDate ?imdb ?tmdb ?seasons ?episodes
WHERE {
  ?series wdt:P31 wd:Q5398426.       # instance of television series
  ?series wdt:P580 ?startDate.       # start time
  ?series schema:dateModified ?modified.
  FILTER(?modified > "${modifiedAfter}"^^xsd:dateTime)
  
  OPTIONAL { ?series wdt:P582 ?endDate. }      # end time
  OPTIONAL { ?series wdt:P345 ?imdb. }         # IMDb ID
  OPTIONAL { ?series wdt:P4983 ?tmdb. }        # TMDB ID
  OPTIONAL { ?series wdt:P2437 ?seasons. }     # number of seasons
  OPTIONAL { ?series wdt:P1113 ?episodes. }    # number of episodes
  
  ?series rdfs:label ?seriesLabel .
  FILTER(LANG(?seriesLabel) = "en")
}
ORDER BY DESC(?modified)
LIMIT ${limit}
`.trim();
}

export function buildPersonQueryFromMovies(movieWikidataIds: string[], limit: number = 200): string {
  const movieValues = movieWikidataIds.map(id => `wd:${id}`).join(' ');

  return `
SELECT DISTINCT ?person ?personLabel ?birthDate ?deathDate ?imdb
WHERE {
  VALUES ?movie { ${movieValues} }
  
  {
    ?movie wdt:P161 ?person.          # cast member
  } UNION {
    ?movie wdt:P57 ?person.           # director
  } UNION {
    ?movie wdt:P162 ?person.          # producer
  }
  
  ?person wdt:P31 wd:Q5.              # instance of human
  ?person wdt:P345 ?imdb.             # Must have IMDb ID
  
  OPTIONAL { ?person wdt:P569 ?birthDate. }  # birth date
  OPTIONAL { ?person wdt:P570 ?deathDate. }  # death date
  
  # Ensure entity has an English label
  ?person rdfs:label ?personLabel .
  FILTER(LANG(?personLabel) = "en")
}
ORDER BY ?personLabel
LIMIT ${limit}
`.trim();
}

export async function queryWikidata(sparql: string): Promise<any> {
  const url = 'https://query.wikidata.org/sparql';

  // Rate limit: wait before each request
  await new Promise(resolve => setTimeout(resolve, WIKIDATA_RATE_LIMIT_MS));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MMDB-Ingestion/1.0.0 (https://github.com/mimir-media-db)',
    },
    body: `query=${encodeURIComponent(sparql)}`,
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error('Wikidata query failed', { status: response.status, body: text.slice(0, 500) });
    throw new Error(`Wikidata query failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export function parseMovieResults(results: any): WikidataMovie[] {
  const movies: WikidataMovie[] = [];

  for (const binding of results.results.bindings) {
    const wikidataId = binding.film.value.split('/').pop()!;

    movies.push({
      id: '',
      label: binding.filmLabel?.value || 'Unknown',
      year: parseInt(binding.year?.value || '0'),
      imdbId: binding.imdb?.value,
      tmdbId: binding.tmdb?.value ? parseInt(binding.tmdb.value) : undefined,
      wikidataId,
      releaseDate: binding.releaseDate?.value?.split('T')[0],
      runtime: binding.runtime?.value ? parseInt(binding.runtime.value) : undefined,
    });
  }

  return movies;
}

export function parseSeriesResults(results: any): WikidataSeries[] {
  const series: WikidataSeries[] = [];

  for (const binding of results.results.bindings) {
    const wikidataId = binding.series.value.split('/').pop()!;

    series.push({
      id: '',
      label: binding.seriesLabel?.value || 'Unknown',
      startYear: binding.startDate?.value ? new Date(binding.startDate.value).getFullYear() : 0,
      endYear: binding.endDate?.value ? new Date(binding.endDate.value).getFullYear() : undefined,
      imdbId: binding.imdb?.value,
      tmdbId: binding.tmdb?.value ? parseInt(binding.tmdb.value) : undefined,
      wikidataId,
      totalSeasons: binding.seasons?.value ? parseInt(binding.seasons.value) : undefined,
      totalEpisodes: binding.episodes?.value ? parseInt(binding.episodes.value) : undefined,
    });
  }

  return series;
}

export function parsePersonResults(results: any): WikidataPerson[] {
  const people: WikidataPerson[] = [];

  for (const binding of results.results.bindings) {
    const wikidataId = binding.person.value.split('/').pop()!;

    people.push({
      id: '',
      label: binding.personLabel?.value || 'Unknown',
      birthYear: binding.birthDate?.value ? new Date(binding.birthDate.value).getFullYear() : undefined,
      deathYear: binding.deathDate?.value ? new Date(binding.deathDate.value).getFullYear() : undefined,
      imdbId: binding.imdb?.value,
      wikidataId,
    });
  }

  return people;
}
