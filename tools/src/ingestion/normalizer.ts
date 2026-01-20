import { WikidataMovie } from './wikidata-client.js';
import { generateMovieId } from './id-generator.js';

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
