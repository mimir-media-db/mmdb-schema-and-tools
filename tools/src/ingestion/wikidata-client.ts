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

export async function queryWikidata(sparql: string): Promise<any> {
  const url = 'https://query.wikidata.org/sparql';
  
  // Add delay to respect rate limits
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'MMDB-Ingestion/0.1.0 (https://github.com/mimir-media-db)'
    },
    body: `query=${encodeURIComponent(sparql)}`
  });
  
  if (!response.ok) {
    throw new Error(`Wikidata query failed: ${response.statusText}`);
  }
  
  return response.json();
}

export function parseMovieResults(results: any): WikidataMovie[] {
  const movies: WikidataMovie[] = [];
  
  for (const binding of results.results.bindings) {
    const wikidataId = binding.film.value.split('/').pop();
    
    movies.push({
      id: '',
      label: binding.filmLabel?.value || 'Unknown',
      year: parseInt(binding.year?.value || '0'),
      imdbId: binding.imdb?.value,
      tmdbId: binding.tmdb?.value ? parseInt(binding.tmdb.value) : undefined,
      wikidataId,
      releaseDate: binding.releaseDate?.value?.split('T')[0],
      runtime: binding.runtime?.value ? parseInt(binding.runtime.value) : undefined
    });
  }
  
  return movies;
}

export function buildPersonQuery(limit: number = 100, offset: number = 0, birthYear?: number): string {
  const birthYearFilter = birthYear 
    ? `FILTER(YEAR(?birthDate) = ${birthYear})`
    : '';
    
  return `
SELECT DISTINCT ?person ?personLabel ?birthDate ?deathDate ?imdb
WHERE {
  ?person wdt:P31 wd:Q5.              # instance of human
  ?person wdt:P106 wd:Q33999.         # occupation: actor
  ?person wdt:P345 ?imdb.             # Must have IMDb ID
  ?person wdt:P569 ?birthDate.        # Must have birth date
  
  ${birthYearFilter}
  
  OPTIONAL { ?person wdt:P570 ?deathDate. }  # date of death
  
  # Ensure entity has an English label
  ?person rdfs:label ?personLabel .
  FILTER(LANG(?personLabel) = "en")
}
ORDER BY ?personLabel
LIMIT ${limit}
OFFSET ${offset}
`.trim();
}

export function buildPersonQueryFromMovies(movieWikidataIds: string[], limit: number = 100): string {
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

export function parsePersonResults(results: any): WikidataPerson[] {
  const people: WikidataPerson[] = [];
  
  for (const binding of results.results.bindings) {
    const wikidataId = binding.person.value.split('/').pop();
    
    people.push({
      id: '',
      label: binding.personLabel?.value || 'Unknown',
      birthYear: binding.birthDate?.value ? new Date(binding.birthDate.value).getFullYear() : undefined,
      deathYear: binding.deathDate?.value ? new Date(binding.deathDate.value).getFullYear() : undefined,
      imdbId: binding.imdb?.value,
      wikidataId
    });
  }
  
  return people;
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

export function parseSeriesResults(results: any): WikidataSeries[] {
  const series: WikidataSeries[] = [];
  
  for (const binding of results.results.bindings) {
    const wikidataId = binding.series.value.split('/').pop();
    
    series.push({
      id: '',
      label: binding.seriesLabel?.value || 'Unknown',
      startYear: binding.startDate?.value ? new Date(binding.startDate.value).getFullYear() : 0,
      endYear: binding.endDate?.value ? new Date(binding.endDate.value).getFullYear() : undefined,
      imdbId: binding.imdb?.value,
      tmdbId: binding.tmdb?.value ? parseInt(binding.tmdb.value) : undefined,
      wikidataId,
      totalSeasons: binding.seasons?.value ? parseInt(binding.seasons.value) : undefined,
      totalEpisodes: binding.episodes?.value ? parseInt(binding.episodes.value) : undefined
    });
  }
  
  return series;
}
