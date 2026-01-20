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
- `--limit=N` - Number of movies to fetch per run (default: 10)

### How it works

1. Queries Wikidata for movies from specified year
2. Normalizes data to MMDB format
3. Validates against JSON schema
4. Creates a new branch in the year repo
5. Adds movie JSON files
6. Creates a pull request

### State Management

The tool maintains state in `.ingestion-state.json`:
- Tracks offset for pagination
- Remembers last run timestamp
- Counts total processed movies

Run multiple times to process more movies from the same year.

## Example

```bash
# First run: process 10 movies from 2010
npm run ingest -- --year=2010 --limit=10

# Second run: process next 10 movies
npm run ingest -- --year=2010 --limit=10
```

Each run creates a separate PR.
