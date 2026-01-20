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
