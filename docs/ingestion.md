# MMDB Ingestion Tool

Automated data ingestion from Wikidata to MMDB repositories.

**⚠️ Note**: PR creation is currently disabled in all ingestion scripts for testing purposes. See "Enabling PR Creation" section below.

## Setup

1. Install dependencies:
```bash
npm install
npm run build
```

2. Set GitHub token:
```bash
export GITHUB_TOKEN=your_github_token
```

## Usage

### Ingest movies from a specific year

```bash
npm run ingest -- --year=2010 --limit=10
```

### Parameters

- `--year=YYYY` - Year to ingest (required)
- `--limit=N` - Number of movies to add per PR (default: 10)

## How it works

1. Queries Wikidata for movies from specified year (fetches 3x limit to account for duplicates)
2. **Checks GitHub for existing movies** (in master branch)
3. **Checks GitHub for movies in pending PRs**
4. Normalizes and validates data
5. Collects exactly `limit` unique movies
6. Creates branch and pull request

## Duplicate Prevention

The tool **derives state from GitHub** instead of local files:

- **Master branch**: Checks `data/movies/index.json` for existing movies
- **Pending PRs**: Scans all open PRs for movie files

This means:
- ✅ No local state files to maintain
- ✅ Works from any machine
- ✅ Automatically syncs when PRs are merged
- ✅ No manual cleanup needed

## Example Workflow

```bash
# First run: add 10 movies from 2010
npm run ingest -- --year=2010 --limit=10
# Creates PR #1 with 10 movies

# Second run: add 10 MORE movies (while PR #1 is pending)
npm run ingest -- --year=2010 --limit=10
# Creates PR #2 with 10 NEW movies (automatically skips the 10 from PR #1)

# After PR #1 is merged, third run:
npm run ingest -- --year=2010 --limit=10
# Creates PR #3 with 10 NEW movies (automatically knows PR #1 was merged)
```

Each run creates a separate PR with unique movies. No manual state management required!

## People Ingestion

### Overview

People ingestion fetches cast members, directors, and producers from movies already in MMDB repositories.

### Usage

```bash
npm run ingest-people -- --limit=10
```

### Parameters

- `--limit=N` - Number of people to add per PR (default: 10)

### How it works

1. **Fetches movie Wikidata IDs** from all year-based repos (mmdb-2010, mmdb-2011, etc.)
2. **Queries Wikidata** for people associated with those movies:
   - Cast members (P161)
   - Directors (P57)
   - Producers (P162)
3. **Processes in batches** of 50 movies to avoid query size limits
4. **Checks for duplicates** against existing people in master branch
5. **Validates** each person against schema
6. **Creates PR** with exactly `limit` unique people

### Key Features

- **Movie-based approach**: Only fetches people related to existing movies
- **No timeouts**: Focused queries complete in <2 seconds
- **Comprehensive**: Includes actors, directors, and producers
- **English labels**: Filters for entities with English names
- **Rate limiting**: 500ms delay between batch queries

### Example

```bash
# Add 20 people from existing movies
npm run ingest-people -- --limit=20

# Output:
# Found 8 movies with Wikidata IDs
# Querying Wikidata for cast members (batch 1/1)...
# Found 138 people in this batch
# ✓ Will add M. Night Shyamalan (p_m_night_shyamalan)
# ✓ Will add David Fincher (p_david_fincher)
# ✓ Will add Andrew Garfield (p_andrew_garfield)
# ...
# Ready to add 20 people (0 skipped)
```

### Duplicate Prevention

- Only checks against **merged people in master branch**
- Does NOT check pending PRs (allows multiple PRs with same people)
- Duplicates resolved during PR merge process

## Series Ingestion

### Overview

Series ingestion fetches TV series from Wikidata by start year.

### Usage

```bash
npm run ingest-series -- --year=2010 --limit=10
```

### Parameters

- `--year=YYYY` - Year series started (required)
- `--limit=N` - Number of series to add per PR (default: 10)

### How it works

1. **Queries Wikidata** for TV series that started in specified year
2. **Filters for English labels** using rdfs:label
3. **Checks for duplicates** against existing series in master branch
4. **Validates** each series against schema
5. **Creates PR** with exactly `limit` unique series

### Key Features

- **Year-based queries**: Fetches series by start year
- **Fast queries**: Complete in <2 seconds
- **Comprehensive data**: Includes seasons, episodes, IMDb/TMDB IDs
- **English labels**: Filters for entities with English names
- **Handles ongoing series**: Properly manages series without end dates

### Example

```bash
# Add 10 series from 2020
npm run ingest-series -- --year=2020 --limit=10

# Output:
# Found 30 series from Wikidata
# ✓ Will add Breaking Bad (s_breaking_bad)
# ✓ Will add Game of Thrones (s_game_of_thrones)
# ✓ Will add The Simpsons (s_simpsons)
# ...
# Ready to add 10 series (0 skipped)
```

### Duplicate Prevention

- Only checks against **merged series in master branch**
- Does NOT check pending PRs
- Duplicates resolved during PR merge process

---

## Enabling PR Creation

**Current Status**: PR creation is disabled in all scripts for testing.

**To enable for production use:**

1. **Movies** (`tools/src/ingest-from-wikidata.ts`):
   - Find the TODO comment: `// TODO: Uncomment when ready for production`
   - Uncomment the PR creation block

2. **People** (`tools/src/ingest-people.ts`):
   - Find the TODO comment: `// TODO: Uncomment when ready for production`
   - Uncomment the PR creation block

3. **Series** (`tools/src/ingest-series.ts`):
   - Find the TODO comment: `// TODO: Uncomment when ready for production`
   - Uncomment the PR creation block

**Testing recommendation**: Test each script with `--limit=1` first to verify PR creation works correctly.
