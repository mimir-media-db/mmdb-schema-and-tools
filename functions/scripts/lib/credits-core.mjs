/**
 * MMDB Credits Core — Shared logic for credits building.
 *
 * Extracted from build-credits.mjs so both the bulk script and the Cloud Function
 * credits handler can reuse the same Wikidata querying, person normalization,
 * dedup, and credit entry construction logic.
 *
 * @module credits-core
 */

import {
  isUsablePersonName,
  isValidPersonYear,
  getPeopleRepo,
} from './rescan-core.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

export const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
export const USER_AGENT = 'MMDB-Ingestion/1.0.0 (https://github.com/mimir-media-db)';
export const LABEL_LANGUAGES = 'en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru';

/**
 * Credit role definitions — maps role names to Wikidata property IDs.
 * Each role is queried separately to avoid Wikidata 504 timeouts.
 */
export const ROLES = [
  { role: 'director', property: 'wdt:P57' },
  { role: 'cast', property: 'wdt:P161' },
  { role: 'writer', property: 'wdt:P58' },
  { role: 'producer', property: 'wdt:P162' },
  { role: 'composer', property: 'wdt:P86' },
];

// ─── SPARQL query builder (per-role) ──────────────────────────────────────────

/**
 * Build a SPARQL query for a single role property.
 * Each query is lightweight: one property, no UNION, fast on Wikidata.
 *
 * @param {string[]} movieQIds - Array of Wikidata Q-IDs (e.g., ['Q12345', 'Q67890'])
 * @param {string} property - Wikidata property path (e.g., 'wdt:P57')
 * @returns {string} SPARQL query string
 */
export function buildRoleQuery(movieQIds, property) {
  const values = movieQIds.map(id => `wd:${id}`).join(' ');
  return `
SELECT DISTINCT ?movie ?person ?personLabel ?birthDate ?deathDate ?imdb ?birthName
WHERE {
  VALUES ?movie { ${values} }
  ?movie ${property} ?person.
  ?person wdt:P31 wd:Q5.
  OPTIONAL { ?person wdt:P345 ?imdb. }
  OPTIONAL { ?person wdt:P569 ?birthDate. }
  OPTIONAL { ?person wdt:P570 ?deathDate. }
  OPTIONAL { ?person wdt:P1477 ?birthName. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${LABEL_LANGUAGES}". }
}
`.trim();
}

// ─── Wikidata query with exponential backoff ─────────────────────────────────

/**
 * Query Wikidata SPARQL endpoint with exponential backoff on 429/5xx errors.
 *
 * @param {string} sparql - The SPARQL query string
 * @param {object} [opts] - Options
 * @param {function} [opts.log] - Logger function (default: console.log)
 * @param {number} [opts.maxRetries] - Max retry attempts (default: 5)
 * @param {number} [opts.initialDelay] - Initial retry delay in ms (default: 10000)
 * @returns {Promise<object>} Parsed JSON response
 */
export async function queryWikidataWithBackoff(sparql, opts = {}) {
  const { log = console.log, maxRetries = 5, initialDelay = 10000 } = opts;
  let retryDelay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(WIKIDATA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: `query=${encodeURIComponent(sparql)}`,
    });

    if (response.ok) {
      return response.json();
    }

    const status = response.status;
    if (status === 429 || status >= 500) {
      if (attempt < maxRetries) {
        log(`  ⚠ Wikidata ${status} — retrying in ${retryDelay / 1000}s (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay *= 2;
        continue;
      }
    }

    const text = await response.text().catch(() => '');
    throw new Error(`Wikidata query failed: ${status} ${response.statusText}\n${text.slice(0, 500)}`);
  }
}

// ─── Parse SPARQL credit results ─────────────────────────────────────────────

/**
 * Parse Wikidata SPARQL results into raw credit entries.
 * The role is passed in (not from SPARQL) since we query one role at a time.
 *
 * @param {object} results - Parsed SPARQL JSON response
 * @param {string} role - The role name (director, cast, writer, producer, composer)
 * @returns {Array<{movieQId, personQId, label, role, birthYear, deathYear, imdbId, birthName}>}
 */
export function parseCreditResults(results, role) {
  const credits = [];

  for (const binding of results.results?.bindings || []) {
    const movieQId = binding.movie?.value?.split('/').pop();
    const personQId = binding.person?.value?.split('/').pop();
    const label = binding.personLabel?.value;

    if (!movieQId || !personQId || !label) continue;
    // Skip unlabeled or Q-ID-only labels
    if (/^Q\d+$/i.test(label)) continue;

    const birthDate = binding.birthDate?.value;
    const deathDate = binding.deathDate?.value;
    const imdbId = binding.imdb?.value;
    const birthName = binding.birthName?.value;

    credits.push({
      movieQId,
      personQId,
      label,
      role,
      birthYear: birthDate ? new Date(birthDate).getFullYear() : undefined,
      deathYear: deathDate ? new Date(deathDate).getFullYear() : undefined,
      imdbId,
      birthName,
    });
  }

  return credits;
}

// ─── Person normalization ────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a person's name.
 * @param {string} name
 * @returns {string}
 */
export function generatePersonSlug(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim().replace(/\s+/g, '_');
}

/**
 * Normalize a Wikidata person into an MMDB person object.
 * Returns null if the person cannot be normalized (bad name, ancient, etc.).
 *
 * @param {object} wikiPerson - { wikidataId, label, birthYear, deathYear, imdbId, birthName }
 * @returns {object|null} Normalized MMDB person object or null
 */
export function normalizePerson(wikiPerson) {
  // Skip ancient people (pre-1800)
  if (!isValidPersonYear(wikiPerson.birthYear, wikiPerson.deathYear)) {
    return null;
  }

  let nameForSlug = wikiPerson.label;
  const displayName = wikiPerson.label;
  const alsoKnownAs = [];

  // If label starts with non-alpha, try birth name for slug
  const testSlug = generatePersonSlug(nameForSlug);
  if (/^[^a-z]/.test(testSlug) && wikiPerson.birthName) {
    nameForSlug = wikiPerson.birthName;
    alsoKnownAs.push(wikiPerson.birthName);
  }

  // Final validation via isUsablePersonName
  if (!isUsablePersonName(nameForSlug)) {
    return null;
  }

  // Generate slug
  let slug = generatePersonSlug(nameForSlug);
  if (/^[^a-z]/.test(slug)) {
    slug = slug.replace(/^[^a-z]+/, '');
  }

  if (!slug || slug.length < 2) {
    return null;
  }

  const id = `p_${slug}`;
  const today = new Date().toISOString().split('T')[0];

  const person = {
    schema_version: 1,
    id,
    name: displayName,
    external_ids: { wikidata: wikiPerson.wikidataId },
    last_updated: today,
  };
  if (alsoKnownAs.length > 0) person.also_known_as = alsoKnownAs;
  if (wikiPerson.birthYear) person.birth_year = wikiPerson.birthYear;
  if (wikiPerson.deathYear) person.death_year = wikiPerson.deathYear;
  if (wikiPerson.imdbId && /^nm\d+$/.test(wikiPerson.imdbId)) {
    person.external_ids.imdb = wikiPerson.imdbId;
  }
  return person;
}

/**
 * Get the file path for a person JSON file.
 * @param {object} person - Person object with .id
 * @returns {string}
 */
export function getPersonFilePath(person) {
  return `data/people/${person.id}.json`;
}

// Re-export getPeopleRepo from rescan-core for convenience
export { getPeopleRepo } from './rescan-core.mjs';

// ─── Batch credit querying ───────────────────────────────────────────────────

/**
 * Query Wikidata for credits of a batch of movies across all roles.
 * Respects rate limiting with configurable delays between queries.
 *
 * @param {string[]} movieQIds - Q-IDs to query credits for
 * @param {object} opts - Options
 * @param {number} [opts.batchSize=15] - Movies per batch
 * @param {number} [opts.delayBetweenBatches=2000] - Delay between batches in ms
 * @param {number} [opts.delayBetweenRoles=1000] - Delay between role queries within a batch
 * @param {number} [opts.maxQueries=Infinity] - Maximum total Wikidata queries
 * @param {function} [opts.log] - Logger function
 * @param {function} [opts.onBatchComplete] - Callback after each batch completes
 * @returns {Promise<{credits: Array, queriesMade: number, queryCapped: boolean}>}
 */
export async function queryCreditsForMovies(movieQIds, opts = {}) {
  const {
    batchSize = 15,
    delayBetweenBatches = 2000,
    delayBetweenRoles = 1000,
    maxQueries = Infinity,
    log = console.log,
    onBatchComplete = null,
  } = opts;

  const batches = [];
  for (let j = 0; j < movieQIds.length; j += batchSize) {
    batches.push(movieQIds.slice(j, j + batchSize));
  }

  const allCreditResults = [];
  let totalQueriesMade = 0;
  let queryCapped = false;

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    // Check query cap (each batch uses ROLES.length queries)
    if (totalQueriesMade + ROLES.length > maxQueries) {
      queryCapped = true;
      break;
    }

    const batch = batches[bIdx];

    // Rate limiting between batches (not before the first)
    if (bIdx > 0) {
      await new Promise(r => setTimeout(r, delayBetweenBatches));
    }

    // Query each role separately
    for (let rIdx = 0; rIdx < ROLES.length; rIdx++) {
      const { role, property } = ROLES[rIdx];

      // Delay between role queries within a batch (not before first)
      if (rIdx > 0) {
        await new Promise(r => setTimeout(r, delayBetweenRoles));
      }

      const sparql = buildRoleQuery(batch, property);

      try {
        const result = await queryWikidataWithBackoff(sparql, { log });
        totalQueriesMade++;
        const credits = parseCreditResults(result, role);
        allCreditResults.push(...credits);
      } catch (err) {
        totalQueriesMade++;
        log(`  ⚠ Batch ${bIdx + 1} ${role} failed: ${err.message}`);
      }
    }

    if (onBatchComplete) {
      onBatchComplete(bIdx, batches.length, allCreditResults.length);
    }
  }

  return { credits: allCreditResults, queriesMade: totalQueriesMade, queryCapped };
}

// ─── Credit entry building (with dedup) ──────────────────────────────────────

/**
 * Build deduplicated credit entries from raw Wikidata results.
 *
 * @param {Array} rawCredits - Raw credit results from parseCreditResults
 * @param {Map<string,string>} movieLookup - Map of wikidataQId → movieId
 * @param {object} [opts] - Options
 * @param {Set<string>} [opts.existingCredits] - Set of "movieId|personId|role" keys to skip
 * @param {function} [opts.log] - Logger function
 * @returns {{creditEntries: Array, normalizedByQId: Map, missingPeople: Map, skippedBadName: number}}
 */
export function buildCreditEntries(rawCredits, movieLookup, opts = {}) {
  const { existingCredits = new Set(), log = console.log } = opts;

  // Collect all unique people for normalization
  const uniquePeople = new Map();
  for (const credit of rawCredits) {
    if (!uniquePeople.has(credit.personQId)) {
      uniquePeople.set(credit.personQId, {
        wikidataId: credit.personQId,
        label: credit.label,
        birthYear: credit.birthYear,
        deathYear: credit.deathYear,
        imdbId: credit.imdbId,
        birthName: credit.birthName,
      });
    }
  }

  // Normalize all unique people
  const normalizedByQId = new Map();
  let skippedBadName = 0;

  for (const [personQId, wikiPerson] of uniquePeople) {
    const person = normalizePerson(wikiPerson);
    if (!person) {
      skippedBadName++;
      continue;
    }
    normalizedByQId.set(personQId, person);
  }

  if (skippedBadName > 0) {
    log(`Skipped ${skippedBadName} people with invalid names/years`);
  }

  // Build credit entries with dedup
  const creditEntries = [];
  const seenCredits = new Set();

  for (const credit of rawCredits) {
    const person = normalizedByQId.get(credit.personQId);
    if (!person) continue;

    const movieId = movieLookup.get(credit.movieQId);
    if (!movieId) continue;

    // Dedup: movie+person+role must be unique
    const dedupKey = `${movieId}|${person.id}|${credit.role}`;
    if (seenCredits.has(dedupKey) || existingCredits.has(dedupKey)) continue;
    seenCredits.add(dedupKey);

    const targetRepo = getPeopleRepo(person.id);

    creditEntries.push({
      movie: movieId,
      person: person.id,
      person_repo: targetRepo,
      role: credit.role,
    });
  }

  // Collect missing people (distinct IDs from normalized people used in credits)
  const usedPersonIds = new Set(creditEntries.map(c => c.person));
  const missingPeople = new Map();
  for (const [personQId, person] of normalizedByQId) {
    if (usedPersonIds.has(person.id)) {
      missingPeople.set(person.id, person);
    }
  }

  return { creditEntries, normalizedByQId, missingPeople, skippedBadName };
}

// ─── Credits JSON builder ────────────────────────────────────────────────────

/**
 * Build the credits.json object from credit entries.
 *
 * @param {number} year - The year for the credits index
 * @param {Array} creditEntries - Array of {movie, person, person_repo, role}
 * @returns {object} The complete credits.json object
 */
export function buildCreditsJson(year, creditEntries) {
  const today = new Date().toISOString().split('T')[0];
  return {
    schema_version: 1,
    year,
    last_updated: today,
    credits: creditEntries,
  };
}
