/**
 * Tests for Q-ID detection, prevention, and cleanup logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeMovie, normalizeSeries } from '../../src/ingestion/normalizer.js';
import { isQIdTitle, getCleanupYearRepos } from '../../src/ingestion/cleanup.js';
import { buildMovieQuery, buildSeriesQuery, buildPersonQueryFromMovies, buildRecentMovieQuery, buildRecentlyModifiedMovieQuery, buildRecentlyModifiedSeriesQuery, buildRecentSeriesQuery } from '../../src/ingestion/wikidata-client.js';
import { LABEL_LANGUAGES } from '../../src/config.js';
import type { WikidataMovie, WikidataSeries } from '../../src/ingestion/wikidata-client.js';

describe('Q-ID Detection', () => {
  describe('isQIdTitle', () => {
    it('should detect uppercase Q-IDs', () => {
      assert.strictEqual(isQIdTitle('Q123'), true);
      assert.strictEqual(isQIdTitle('Q140513842'), true);
      assert.strictEqual(isQIdTitle('Q1'), true);
    });

    it('should detect lowercase Q-IDs', () => {
      assert.strictEqual(isQIdTitle('q456'), true);
      assert.strictEqual(isQIdTitle('q140513842'), true);
      assert.strictEqual(isQIdTitle('q1'), true);
    });

    it('should reject normal movie titles', () => {
      assert.strictEqual(isQIdTitle('Inception'), false);
      assert.strictEqual(isQIdTitle('The Matrix'), false);
      assert.strictEqual(isQIdTitle('Q: The Winged Serpent'), false);
      assert.strictEqual(isQIdTitle('Station Q'), false);
    });

    it('should reject titles containing Q followed by non-digits', () => {
      assert.strictEqual(isQIdTitle('Quantum'), false);
      assert.strictEqual(isQIdTitle('Q&A'), false);
      assert.strictEqual(isQIdTitle('Q Force'), false);
    });

    it('should reject empty and whitespace strings', () => {
      assert.strictEqual(isQIdTitle(''), false);
      assert.strictEqual(isQIdTitle(' '), false);
      assert.strictEqual(isQIdTitle('  Q123  '), false); // has surrounding spaces
    });

    it('should reject titles with Q-ID as substring', () => {
      assert.strictEqual(isQIdTitle('Movie Q123'), false);
      assert.strictEqual(isQIdTitle('Q123 Movie'), false);
      assert.strictEqual(isQIdTitle('The Q123 Story'), false);
    });
  });
});

describe('Q-ID Normalizer Rejection', () => {
  describe('normalizeMovie with Q-ID title', () => {
    it('should throw for uppercase Q-ID title', () => {
      const movie: WikidataMovie = {
        id: '',
        label: 'Q140513842',
        year: 2026,
        wikidataId: 'Q140513842',
      };

      assert.throws(
        () => normalizeMovie(movie),
        /Cannot normalize: title is unusable/
      );
    });

    it('should throw for lowercase Q-ID title', () => {
      const movie: WikidataMovie = {
        id: '',
        label: 'q456',
        year: 2026,
        wikidataId: 'Q456',
      };

      assert.throws(
        () => normalizeMovie(movie),
        /Cannot normalize: title is unusable/
      );
    });

    it('should NOT throw for normal titles', () => {
      const movie: WikidataMovie = {
        id: '',
        label: 'Inception',
        year: 2010,
        wikidataId: 'Q43320',
      };

      assert.doesNotThrow(() => normalizeMovie(movie));
    });

    it('should NOT throw for titles containing Q', () => {
      const movie: WikidataMovie = {
        id: '',
        label: 'Q: The Winged Serpent',
        year: 1982,
        wikidataId: 'Q999',
      };

      assert.doesNotThrow(() => normalizeMovie(movie));
    });
  });

  describe('normalizeSeries with Q-ID title', () => {
    it('should throw for Q-ID title', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Q789123',
        startYear: 2025,
        wikidataId: 'Q789123',
      };

      assert.throws(
        () => normalizeSeries(series),
        /Cannot normalize: title is unusable/
      );
    });

    it('should NOT throw for normal series titles', () => {
      const series: WikidataSeries = {
        id: '',
        label: 'Breaking Bad',
        startYear: 2008,
        wikidataId: 'Q1079',
      };

      assert.doesNotThrow(() => normalizeSeries(series));
    });
  });
});

describe('Multi-Language Label Service', () => {
  const expectedLangs = 'en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru';

  it('should have correct LABEL_LANGUAGES config constant', () => {
    assert.strictEqual(LABEL_LANGUAGES, expectedLangs);
  });

  it('buildMovieQuery should include multi-language label service', () => {
    const query = buildMovieQuery(2026, 100, 0);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Movie query should use multi-language label service'
    );
    assert.ok(
      !query.includes('wikibase:language "en"'),
      'Movie query should not use English-only label service'
    );
  });

  it('buildSeriesQuery should include multi-language label service', () => {
    const query = buildSeriesQuery(2026, 100, 0);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Series query should use multi-language label service'
    );
  });

  it('buildPersonQueryFromMovies should include multi-language label service', () => {
    const query = buildPersonQueryFromMovies(['Q43320', 'Q127367'], 100);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Person query should use multi-language label service'
    );
  });

  it('buildRecentMovieQuery should include multi-language label service', () => {
    const query = buildRecentMovieQuery('2026-01-01T00:00:00Z', 40);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Recent movie query should use multi-language label service'
    );
  });

  it('buildRecentlyModifiedMovieQuery should include multi-language label service', () => {
    const query = buildRecentlyModifiedMovieQuery('2026-01-01T00:00:00Z', 2026, 200);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Recently modified movie query should use multi-language label service'
    );
  });

  it('buildRecentlyModifiedSeriesQuery should include multi-language label service', () => {
    const query = buildRecentlyModifiedSeriesQuery('2026-01-01T00:00:00Z', 2026, 100);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Recently modified series query should use multi-language label service'
    );
  });

  it('buildRecentSeriesQuery should include multi-language label service', () => {
    const query = buildRecentSeriesQuery('2026-01-01T00:00:00Z', 40);
    assert.ok(
      query.includes(`wikibase:language "${expectedLangs}"`),
      'Recent series query should use multi-language label service'
    );
  });

  it('queries should not use English-only rdfs:label FILTER', () => {
    const movieQuery = buildMovieQuery(2026, 100, 0);
    const seriesQuery = buildSeriesQuery(2026, 100, 0);
    const personQuery = buildPersonQueryFromMovies(['Q43320'], 100);

    assert.ok(
      !movieQuery.includes('FILTER(LANG(?filmLabel) = "en")'),
      'Movie query should not filter to English-only'
    );
    assert.ok(
      !seriesQuery.includes('FILTER(LANG(?seriesLabel) = "en")'),
      'Series query should not filter to English-only'
    );
    assert.ok(
      !personQuery.includes('FILTER(LANG(?personLabel) = "en")'),
      'Person query should not filter to English-only'
    );
  });
});

describe('Cleanup Utilities', () => {
  describe('getCleanupYearRepos', () => {
    it('should return correct number of repos', () => {
      const repos = getCleanupYearRepos(3);
      assert.strictEqual(repos.length, 3);
    });

    it('should include current year', () => {
      const currentYear = new Date().getFullYear();
      const repos = getCleanupYearRepos(3);
      assert.ok(repos.includes(`mmdb-${currentYear}`));
    });

    it('should include previous years', () => {
      const currentYear = new Date().getFullYear();
      const repos = getCleanupYearRepos(3);
      assert.ok(repos.includes(`mmdb-${currentYear - 1}`));
      assert.ok(repos.includes(`mmdb-${currentYear - 2}`));
    });

    it('should return repos in reverse chronological order', () => {
      const currentYear = new Date().getFullYear();
      const repos = getCleanupYearRepos(3);
      assert.strictEqual(repos[0], `mmdb-${currentYear}`);
      assert.strictEqual(repos[1], `mmdb-${currentYear - 1}`);
      assert.strictEqual(repos[2], `mmdb-${currentYear - 2}`);
    });

    it('should handle yearRange of 1', () => {
      const currentYear = new Date().getFullYear();
      const repos = getCleanupYearRepos(1);
      assert.strictEqual(repos.length, 1);
      assert.strictEqual(repos[0], `mmdb-${currentYear}`);
    });
  });
});
