import { WikidataMovie, WikidataPerson } from './wikidata-client.js';
import { generateMovieId, generatePersonId } from './id-generator.js';

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

export function normalizeMovie(wikiMovie: WikidataMovie): MMDBMovie {
  const id = generateMovieId(wikiMovie.label, wikiMovie.year);
  const today = new Date().toISOString().split('T')[0];
  
  const movie: MMDBMovie = {
    schema_version: 1,
    id,
    title: wikiMovie.label,
    year: wikiMovie.year,
    type: 'movie',
    external_ids: {
      wikidata: wikiMovie.wikidataId
    },
    last_updated: today
  };
  
  if (wikiMovie.releaseDate) {
    movie.release_date = wikiMovie.releaseDate;
  }
  
  if (wikiMovie.runtime) {
    movie.runtime_minutes = wikiMovie.runtime;
  }
  
  if (wikiMovie.imdbId) {
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
      wikidata: wikiPerson.wikidataId
    },
    last_updated: today
  };
  
  if (wikiPerson.birthYear) {
    person.birth_year = wikiPerson.birthYear;
  }
  
  if (wikiPerson.deathYear) {
    person.death_year = wikiPerson.deathYear;
  } else {
    person.death_year = null;
  }
  
  if (wikiPerson.imdbId) {
    person.external_ids.imdb = wikiPerson.imdbId;
  }
  
  return person;
}
