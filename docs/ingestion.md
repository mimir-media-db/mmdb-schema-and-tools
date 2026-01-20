# MMDB Ingestion Tool

Automated data ingestion from Wikidata to MMDB repositories.

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
