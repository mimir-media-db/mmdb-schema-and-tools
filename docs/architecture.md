# MMDB Architecture

> Technical architecture and data model for the Mimir Media Database.

## Overview

MMDB is a distributed, GitHub-hosted media metadata database. This document describes the data model, schemas, and technical design decisions.

For the complete implementation blueprint, see [mmdb_architecture_updated.md](../mmdb_architecture_updated.md).

## Core Entities

### Movie

A standalone film, documentary, or short.

**Schema Version**: 1

**Required Fields**:
- `schema_version` (number): Schema version (currently 1)
- `id` (string): MMDB ID (format: `m_<slug>_<year>`)
- `title` (string): Display title
- `year` (number): Primary release year
- `type` (string): "movie", "documentary", "short", etc.

**Optional Fields**:
- `original_title` (string): Original language title
- `release_date` (string): ISO 8601 date
- `runtime_minutes` (number): Duration
- `original_language` (string): ISO 639-1 code
- `countries` (array): ISO 3166-1 alpha-2 codes
- `summary` (string): Plot summary
- `genres` (array): Genre tags
- `directors` (array): Person IDs
- `writers` (array): Person IDs
- `cast` (array): Person IDs
- `external_ids` (object): Wikidata, IMDb, TMDB IDs
- `last_updated` (string): ISO 8601 date

**Example**:
```json
{
  "schema_version": 1,
  "id": "m_inception_2010",
  "title": "Inception",
  "year": 2010,
  "type": "movie",
  "runtime_minutes": 148,
  "directors": ["p_christopher_nolan"],
  "external_ids": {
    "wikidata": "Q43320",
    "imdb": "tt1375666",
    "tmdb": 27205
  },
  "last_updated": "2025-01-01"
}
```

---

### Series

A TV show, streaming series, or limited series.

**Schema Version**: 1

**Required Fields**:
- `schema_version` (number)
- `id` (string): Format: `s_<slug>`
- `title` (string)
- `start_year` (number)

**Optional Fields**:
- `end_year` (number): null if ongoing
- `original_title` (string)
- `summary` (string)
- `original_language` (string)
- `countries` (array)
- `genres` (array)
- `creators` (array): Person IDs
- `main_cast` (array): Person IDs
- `total_seasons` (number)
- `total_episodes` (number)
- `external_ids` (object)
- `last_updated` (string)

**Example**:
```json
{
  "schema_version": 1,
  "id": "s_breaking_bad",
  "title": "Breaking Bad",
  "start_year": 2008,
  "end_year": 2013,
  "total_seasons": 5,
  "total_episodes": 62,
  "creators": ["p_vince_gilligan"],
  "external_ids": {
    "wikidata": "Q9130",
    "imdb": "tt0903747"
  },
  "last_updated": "2025-01-01"
}
```

---

### Season

A subdivision of a series.

**Schema Version**: 1

**Required Fields**:
- `schema_version` (number)
- `id` (string): Format: `s_<series_slug>_season_<nn>`
- `series_id` (string): Parent series ID
- `season_number` (number)

**Optional Fields**:
- `title` (string)
- `summary` (string)
- `year` (number)
- `first_air_date` (string)
- `last_air_date` (string)
- `episode_count` (number)
- `last_updated` (string)

---

### Episode

A single episode of a series.

**Schema Version**: 1

**Required Fields**:
- `schema_version` (number)
- `id` (string): Format: `e_<series_slug>_s<nn>e<nn>`
- `series_id` (string)
- `season_id` (string)
- `season_number` (number)
- `episode_number` (number)

**Optional Fields**:
- `absolute_number` (number): Overall episode number
- `title` (string)
- `air_date` (string)
- `runtime_minutes` (number)
- `summary` (string)
- `directors` (array): Person IDs
- `writers` (array): Person IDs
- `cast` (array): Person IDs
- `external_ids` (object)
- `last_updated` (string)

---

### Person

An individual (actor, director, writer, etc.).

**Schema Version**: 1

**Required Fields**:
- `schema_version` (number)
- `id` (string): Format: `p_<slug>`
- `name` (string): Display name

**Optional Fields**:
- `birth_year` (number)
- `death_year` (number): null if alive
- `also_known_as` (array): Alternative names
- `external_ids` (object)
- `last_updated` (string)

**Example**:
```json
{
  "schema_version": 1,
  "id": "p_christopher_nolan",
  "name": "Christopher Nolan",
  "birth_year": 1970,
  "external_ids": {
    "wikidata": "Q25191",
    "imdb": "nm0634240"
  },
  "last_updated": "2025-01-01"
}
```

---

## ID Conventions

### Format Rules

- **Movie**: `m_<slug>_<year>`
  - Example: `m_inception_2010`
- **Series**: `s_<slug>`
  - Example: `s_breaking_bad`
- **Season**: `s_<series_slug>_season_<nn>`
  - Example: `s_breaking_bad_season_01`
- **Episode**: `e_<series_slug>_s<nn>e<nn>`
  - Example: `e_breaking_bad_s01e01`
- **Person**: `p_<slug>`
  - Example: `p_christopher_nolan`

### Slug Rules

- Lowercase ASCII only
- Words separated by underscores (`_`)
- Non-ASCII characters transliterated
- Special characters removed
- No leading/trailing underscores

### ID Stability

- IDs are **permanent** and never reused
- Once assigned, an ID always refers to the same entity
- Deprecated entities keep their IDs but are flagged

---

## File Structure

### Per-Year Repo (`mmdb-YYYY`)

```
mmdb-2010/
  data/
    movies/
      index.json                    # Generated
      inception-2010.json
      the-social-network-2010.json
    series/
      index.json                    # Generated
      breaking-bad/
        meta.json
        seasons/
          01/
            meta.json
            episodes/
              01.json
              02.json
  .github/
    workflows/
      validate-and-build.yml
  README.md
  LICENSE
```

### People Repo (`mmdb-people`)

```
mmdb-people/
  data/
    people/
      index.json                    # Generated
      p_christopher_nolan.json
      p_leonardo_dicaprio.json
  .github/
    workflows/
      validate-and-build.yml
  README.md
  LICENSE
```

### Schema & Tools Repo (`mmdb-schema-and-tools`)

```
mmdb-schema-and-tools/
  schema/
    movie-v1.json
    series-v1.json
    season-v1.json
    episode-v1.json
    person-v1.json
  tools/
    src/
      validate-repo.ts
      build-indexes.ts
      create-year-repo.ts
      shared-config.ts
    package.json
    tsconfig.json
  docs/
    architecture.md
    contribution-guide.md
  README.md
  LICENSE
```

---

## Index Files

Index files are **generated** by `build-indexes.ts` and should never be manually edited.

### Movie Index

```json
[
  {
    "id": "m_inception_2010",
    "title": "Inception",
    "year": 2010,
    "type": "movie",
    "runtime_minutes": 148,
    "path": "data/movies/inception-2010.json"
  }
]
```

### Series Index

```json
[
  {
    "id": "s_breaking_bad",
    "title": "Breaking Bad",
    "start_year": 2008,
    "end_year": 2013,
    "path": "data/series/breaking-bad/meta.json"
  }
]
```

### People Index

```json
[
  {
    "id": "p_christopher_nolan",
    "name": "Christopher Nolan",
    "birth_year": 1970,
    "path": "data/people/p_christopher_nolan.json"
  }
]
```

---

## Schema Versioning

### Current Version

All entities are currently at **schema version 1**.

### Evolution Strategy

1. New schema versions are introduced in `mmdb-schema-and-tools`
2. Tools support multiple versions simultaneously
3. Old versions are deprecated but not broken
4. Migration tools provided for major changes
5. Each JSON file declares its `schema_version`

### Deprecation Process

1. Announce deprecation in schema repo
2. Update tools to support new version
3. Provide migration guide
4. Set deprecation timeline (minimum 6 months)
5. Eventually remove support for old version

---

## External IDs

MMDB links to external databases via the `external_ids` field:

- **Wikidata**: `Q` followed by digits (e.g., `Q43320`)
- **IMDb**: `tt` followed by digits for titles, `nm` for people (e.g., `tt1375666`)
- **TMDB**: Numeric ID (e.g., `27205`)

These IDs enable consumers to cross-reference with other databases.

---

## Validation Rules

### Schema Validation

- All JSON files must validate against their schema
- Required fields must be present
- Field types must match schema
- Enum values must be from allowed list

### Structural Validation

- File names must match ID conventions
- File paths must follow repo structure
- Index files must be consistent with data files
- No duplicate IDs within a repo

### Referential Integrity

- Person IDs in cast/directors/writers must exist in `mmdb-people`
- Series IDs in seasons/episodes must exist
- Season IDs in episodes must exist

### Business Rules

- Years must be reasonable (1800-2100)
- Runtime must be positive
- Episode/season numbers must be positive
- Birth year must be before death year

---

## Stability Contract

### Guarantees

1. **Permanent IDs**: Once assigned, never reused
2. **No history rewrites**: No force pushes on main branches
3. **Schema versioning**: Backward compatibility maintained
4. **Deprecation over deletion**: Bad data flagged, not removed
5. **Generated indexes**: Always consistent with data

### Non-Guarantees

- Field values may be corrected (typos, errors)
- New fields may be added to schemas
- Deprecated entities may be hidden from indexes
- External IDs may be updated if incorrect

---

## Performance Considerations

### For Consumers

- **Don't query GitHub directly** for production APIs
- Clone repos and import into your own database
- Use shallow clones (`--depth 1`) for faster downloads
- Index on fields you'll query frequently
- Cache data locally

### For Contributors

- Keep JSON files under 100KB each
- Batch related changes in single PRs
- Run validation locally before pushing
- Let CI generate indexes

---

## Future Extensions

### Planned

- Canonical taxonomy repo (genres, languages, countries)
- Ratings and certifications
- Production companies and studios
- Awards and nominations

### Under Consideration

- Streaming availability (separate project)
- User reviews and ratings (separate project)
- Images and posters (separate project)
- Subtitles and transcripts (separate project)

---

## See Also

- [Complete Architecture Blueprint](../mmdb_architecture_updated.md)
- [Development Plan](dev-plan.md)
- [Contribution Guide](contribution-guide.md)
