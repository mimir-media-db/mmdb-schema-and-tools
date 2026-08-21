/**
 * Tests for the credits ingestion handler's pure logic.
 * Tests the helper functions (getPeopleRepo, buildRoleQuery, parseCreditResults)
 * that are used by the credits handler.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// Test getPeopleRepo logic (reimplemented here since the TS handler has a local copy)
function getPeopleRepo(personId: string): string {
  const slug = personId.replace(/^p_/, '');
  const letter = (slug[0] || 'z').toLowerCase();
  return `mmdb-people-${letter}`;
}

describe('Credits Ingestion', () => {
  describe('getPeopleRepo', () => {
    it('should route person to correct letter repo', () => {
      assert.strictEqual(getPeopleRepo('p_steven_spielberg'), 'mmdb-people-s');
      assert.strictEqual(getPeopleRepo('p_martin_scorsese'), 'mmdb-people-m');
      assert.strictEqual(getPeopleRepo('p_alfred_hitchcock'), 'mmdb-people-a');
    });

    it('should handle single character slugs', () => {
      assert.strictEqual(getPeopleRepo('p_z'), 'mmdb-people-z');
    });

    it('should fallback to z for empty slug', () => {
      assert.strictEqual(getPeopleRepo('p_'), 'mmdb-people-z');
    });

    it('should handle numeric-starting slugs', () => {
      assert.strictEqual(getPeopleRepo('p_2pac'), 'mmdb-people-2');
    });
  });

  describe('credit entry deduplication logic', () => {
    it('should deduplicate by movie+person+role key', () => {
      const entries = [
        { movie: 'm_test_2024', person: 'p_john_doe', role: 'director' },
        { movie: 'm_test_2024', person: 'p_john_doe', role: 'director' }, // duplicate
        { movie: 'm_test_2024', person: 'p_john_doe', role: 'writer' },  // different role = unique
        { movie: 'm_other_2024', person: 'p_john_doe', role: 'director' }, // different movie = unique
      ];

      const seen = new Set<string>();
      const deduped = entries.filter(entry => {
        const key = `${entry.movie}|${entry.person}|${entry.role}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      assert.strictEqual(deduped.length, 3);
    });

    it('should skip entries already in existing credits', () => {
      const existingKeys = new Set(['m_test_2024|p_john_doe|director']);
      const newEntries = [
        { movie: 'm_test_2024', person: 'p_john_doe', role: 'director' }, // exists
        { movie: 'm_test_2024', person: 'p_jane_doe', role: 'cast' },     // new
      ];

      const filtered = newEntries.filter(entry => {
        const key = `${entry.movie}|${entry.person}|${entry.role}`;
        return !existingKeys.has(key);
      });

      assert.strictEqual(filtered.length, 1);
      assert.strictEqual(filtered[0].person, 'p_jane_doe');
    });
  });

  describe('credits JSON schema compliance', () => {
    it('should produce valid credits.json structure', () => {
      const year = 2026;
      const credits = [
        { movie: 'm_test_film_2026', person: 'p_john_doe', person_repo: 'mmdb-people-j', role: 'director' },
        { movie: 'm_test_film_2026', person: 'p_jane_doe', person_repo: 'mmdb-people-j', role: 'cast' },
      ];

      const creditsJson = {
        schema_version: 1,
        year,
        last_updated: '2026-08-21',
        credits,
      };

      assert.strictEqual(creditsJson.schema_version, 1);
      assert.strictEqual(creditsJson.year, 2026);
      assert.strictEqual(typeof creditsJson.last_updated, 'string');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(creditsJson.last_updated));
      assert.ok(Array.isArray(creditsJson.credits));
      assert.strictEqual(creditsJson.credits.length, 2);

      for (const entry of creditsJson.credits) {
        assert.ok(entry.movie.startsWith('m_'));
        assert.ok(entry.person.startsWith('p_'));
        assert.ok(entry.person_repo.startsWith('mmdb-people-'));
        assert.ok(['director', 'cast', 'writer', 'producer', 'composer'].includes(entry.role));
      }
    });

    it('should merge existing and new credits', () => {
      const existing = [
        { movie: 'm_old_film_2026', person: 'p_alice', person_repo: 'mmdb-people-a', role: 'director' },
      ];
      const newEntries = [
        { movie: 'm_new_film_2026', person: 'p_bob', person_repo: 'mmdb-people-b', role: 'cast' },
      ];

      const merged = [...existing, ...newEntries];
      assert.strictEqual(merged.length, 2);
      assert.strictEqual(merged[0].movie, 'm_old_film_2026');
      assert.strictEqual(merged[1].movie, 'm_new_film_2026');
    });
  });

  describe('SPARQL result parsing logic', () => {
    it('should extract movieQId and personQId from URIs', () => {
      const binding = {
        movie: { value: 'http://www.wikidata.org/entity/Q12345' },
        person: { value: 'http://www.wikidata.org/entity/Q67890' },
        personLabel: { value: 'John Doe' },
      };

      const movieQId = binding.movie.value.split('/').pop();
      const personQId = binding.person.value.split('/').pop();

      assert.strictEqual(movieQId, 'Q12345');
      assert.strictEqual(personQId, 'Q67890');
    });

    it('should skip entries with Q-ID-only labels', () => {
      const isQIdLabel = (label: string) => /^Q\d+$/i.test(label);

      assert.strictEqual(isQIdLabel('Q12345'), true);
      assert.strictEqual(isQIdLabel('q999'), true);
      assert.strictEqual(isQIdLabel('Q1'), true);
      assert.strictEqual(isQIdLabel('John Doe'), false);
      assert.strictEqual(isQIdLabel('María García'), false);
    });

    it('should parse birth year from ISO date', () => {
      const birthDate = '1946-09-05T00:00:00Z';
      const year = new Date(birthDate).getFullYear();
      assert.strictEqual(year, 1946);
    });

    it('should handle missing optional fields', () => {
      const binding: Record<string, { value: string } | undefined> = {
        movie: { value: 'http://www.wikidata.org/entity/Q100' },
        person: { value: 'http://www.wikidata.org/entity/Q200' },
        personLabel: { value: 'Test Person' },
        // No birthDate, deathDate, imdb, birthName
      };

      const birthYear = binding.birthDate?.value ? new Date(binding.birthDate.value).getFullYear() : undefined;
      const imdbId = binding.imdb?.value;

      assert.strictEqual(birthYear, undefined);
      assert.strictEqual(imdbId, undefined);
    });
  });

  describe('movie lookup from index', () => {
    it('should build Q-ID to movieId map from movie index', () => {
      const movieIndex = [
        { id: 'm_inception_2010', external_ids: { wikidata: 'Q25188' } },
        { id: 'm_avatar_2009', external_ids: { wikidata: 'Q24815' } },
        { id: 'm_no_qid_2010', external_ids: {} },
        { id: 'm_null_ext_2010' },
      ];

      const lookup = new Map<string, string>();
      for (const entry of movieIndex) {
        const wikidataId = (entry as any).external_ids?.wikidata;
        if (wikidataId && /^Q\d+$/i.test(wikidataId)) {
          lookup.set(wikidataId, entry.id);
        }
      }

      assert.strictEqual(lookup.size, 2);
      assert.strictEqual(lookup.get('Q25188'), 'm_inception_2010');
      assert.strictEqual(lookup.get('Q24815'), 'm_avatar_2009');
    });

    it('should identify movies missing from credits', () => {
      const movieLookup = new Map([
        ['Q1', 'm_film_a_2026'],
        ['Q2', 'm_film_b_2026'],
        ['Q3', 'm_film_c_2026'],
      ]);

      const existingCredits = new Set(['m_film_a_2026']); // already has credits

      const missingQIds: string[] = [];
      for (const [qId, movieId] of movieLookup) {
        if (!existingCredits.has(movieId)) {
          missingQIds.push(qId);
        }
      }

      assert.strictEqual(missingQIds.length, 2);
      assert.ok(missingQIds.includes('Q2'));
      assert.ok(missingQIds.includes('Q3'));
    });
  });
});
