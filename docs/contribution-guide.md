# MMDB Contribution Guide

> How to contribute to the Mimir Media Database project.

---

## Welcome!

Thank you for your interest in contributing to MMDB! This guide covers how to add or improve data in the database.

**Note**: Automated ingestion from Wikidata runs via Firebase Cloud Functions (6x daily). You don't need to run ingestion manually — contributions focus on data corrections, additions the pipeline missed, and tooling improvements.

## Before You Start

### Prerequisites

- GitHub account
- Basic knowledge of JSON
- Familiarity with Git and pull requests
- Node.js 22+ installed (for running validation tools)

### Understanding MMDB

MMDB is not a traditional database with an API. It's a collection of JSON files in GitHub repositories. Changes are made through pull requests, and all data is validated automatically by CI.

Read the [Architecture documentation](architecture.md) to understand the data model.

### Schema Versions & Entity Types

All schemas are currently at **v1**:

| Entity | Schema | Location |
|--------|--------|----------|
| Movie | `movie-v1.json` | `schema/movie-v1.json` |
| Series | `series-v1.json` | `schema/series-v1.json` |
| Season | `season-v1.json` | `schema/season-v1.json` |
| Episode | `episode-v1.json` | `schema/episode-v1.json` |
| Person | `person-v1.json` | `schema/person-v1.json` |

---

## Types of Contributions

### 1. Data Corrections

Fix errors in existing entries (wrong runtime, misspelled names, incorrect dates).

### 2. Adding Missing Titles

Add movies, series, or people that the automated pipeline missed.

### 3. Improving Existing Data

Add missing fields (summaries, genres, cast) to entries the pipeline created with minimal data.

### 4. Tooling & Infrastructure

Improve validation tools, CI/CD workflows, or documentation.

---

## Contribution Workflow

### Step 1: Fork the Repository

Fork the appropriate repository:
- **Movies/Series**: Fork the year repo (e.g., `mmdb-2010`)
- **People**: Fork `mmdb-people`
- **Tools/Schemas**: Fork `mmdb-schema-and-tools`

### Step 2: Clone Your Fork

```bash
git clone https://github.com/YOUR_USERNAME/mmdb-2010.git
cd mmdb-2010
```

### Step 3: Create a Branch

```bash
git checkout -b fix-inception-runtime
```

Use descriptive branch names:
- `add-inception` (for new titles)
- `fix-inception-runtime` (for corrections)
- `add-christopher-nolan` (for new people)

### Step 4: Make Your Changes

#### Adding a Movie

Create a JSON file in `data/movies/`:

```json
{
  "schema_version": 1,
  "id": "mmdb-movie-Q43320",
  "title": "Inception",
  "original_title": "Inception",
  "year": 2010,
  "release_date": "2010-07-16",
  "type": "movie",
  "runtime_minutes": 148,
  "original_language": "en",
  "countries": ["US", "GB"],
  "summary": "A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea into the mind of a C.E.O.",
  "genres": ["science fiction", "action", "thriller"],
  "directors": ["mmdb-person-Q25191"],
  "cast": ["mmdb-person-Q38111", "mmdb-person-Q180338"],
  "external_ids": {
    "wikidata": "Q43320",
    "imdb": "tt1375666"
  },
  "last_updated": "2026-08-13"
}
```

#### Adding a Person

Create a JSON file in `data/people/`:

```json
{
  "schema_version": 1,
  "id": "mmdb-person-Q25191",
  "name": "Christopher Nolan",
  "birth_year": 1970,
  "death_year": null,
  "external_ids": {
    "wikidata": "Q25191",
    "imdb": "nm0634240"
  },
  "last_updated": "2026-08-13"
}
```

### Step 5: Validate Your Changes Locally

Clone the schema-and-tools repo and run validation against your data repo:

```bash
# Clone tools (first time only)
git clone https://github.com/mimir-media-db/mmdb-schema-and-tools.git
cd mmdb-schema-and-tools

# Install dependencies and build
npm install
npm run build

# Validate a data repo
npm run validate -- --repo-path=../mmdb-2010

# Build indexes (updates index.json files)
npm run build-indexes -- --repo-path=../mmdb-2010
```

Alternatively, using npx from inside the data repo:

```bash
cd mmdb-2010
npx mmdb-schema-and-tools validate
npx mmdb-schema-and-tools build-indexes
```

Fix any validation errors before proceeding.

### Step 6: Commit Your Changes

```bash
git add data/movies/inception-2010.json
git add data/movies/index.json  # Updated by build-indexes
git commit -m "Add Inception (2010)"
```

**Commit message guidelines**:
- Use present tense: "Add", "Fix", "Update"
- Be specific: "Add Inception (2010)" not "Add movie"
- Reference issues if applicable: "Fix #123: Correct runtime"

### Step 7: Push and Open a Pull Request

```bash
git push origin fix-inception-runtime
```

Then open a PR on GitHub with:
- **Title**: Clear and descriptive (e.g., "Add Inception (2010)")
- **Description**: What you added/changed and why
- **Checklist**: Confirm validation passed locally

---

## About Automated Ingestion

The MMDB ingestion pipeline runs automatically via Firebase Cloud Functions:

- **6x daily**: Processes the backlog of Wikidata entries (movies, series, people)
- **Nightly**: Ingests new releases for the current year
- **Auto-merge**: Bot PRs are squash-merged automatically after CI passes

**You don't need to run ingestion yourself.** Focus contributions on:
- Data the pipeline missed or got wrong
- Richer metadata (summaries, genres, cast lists)
- Tooling improvements
- Documentation

---

## Data Quality Guidelines

### Required Fields

**For Movies**:
- `schema_version`, `id`, `title`, `year`, `type` (minimum)
- At least one external ID (`wikidata` preferred)

**For People**:
- `schema_version`, `id`, `name` (minimum)
- At least one external ID

### ID Format

IDs follow the pattern `mmdb-{type}-{wikidata-id}`:
- Movies: `mmdb-movie-Q43320`
- Series: `mmdb-series-Q83807`
- People: `mmdb-person-Q25191`

### Data Sources

Acceptable sources (in order of preference):
1. **Wikidata** — Structured, community-verified (primary source)
2. **IMDb** — Comprehensive reference
3. **TMDB** — Good for recent titles
4. **Official sources** — Studio websites, press releases

### What NOT to Include

- Opinions or reviews
- Spoilers in summaries
- Unverified speculation
- Copyrighted plot details beyond fair use

---

## Common Mistakes

### ❌ Don't Do This

```json
{
  "id": "inception",
  "title": "Inception (2010)",
  "year": "2010",
  "runtime": "2h 28m",
  "genres": "sci-fi, action"
}
```

### ✅ Do This

```json
{
  "schema_version": 1,
  "id": "mmdb-movie-Q43320",
  "title": "Inception",
  "year": 2010,
  "runtime_minutes": 148,
  "genres": ["science fiction", "action"]
}
```

---

## PR Process

1. Fork → Branch → Change → Validate → Push → PR
2. CI runs validation automatically on your PR
3. Maintainers review within a few days
4. Fix any requested changes and push to same branch
5. Once approved, PR is squash-merged

---

## Getting Help

- **Documentation**: Check [Architecture](architecture.md) for schema details
- **Issues**: Open a GitHub issue for questions or bug reports
- **Schema reference**: See `schema/` directory for full JSON Schema definitions

---

## License

By contributing, you agree that your contributions will be licensed under MIT (code) and CC0 (data).
