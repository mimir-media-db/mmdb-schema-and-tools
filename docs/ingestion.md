# MMDB Ingestion Pipeline

Automated data ingestion from Wikidata into MMDB year repositories via Firebase Cloud Functions.

## Overview

The ingestion pipeline runs as serverless Cloud Functions with three scheduled jobs:

| Job | Schedule | Purpose |
|-----|----------|---------|
| `mmdbIngest` | Every 4 hours | Backlog fill (year-by-year, forward + backward) |
| `mmdbIngestCurrentYear` | Nightly (2 AM) | Current year: full scan + catch-up pass |
| `mmdbCleanupQIds` | Weekly (Sunday 4 AM) | Remove Q-ID / non-Latin entries from year repos |

All jobs authenticate as `mimir-media-db[bot]` (GitHub App) and create PRs that are immediately squash-merged by the bot.

## Backlog Ingestion (`mmdbIngest`)

Processes historical years sequentially:
- **Forward pass**: 2010 → current year (100 titles/run)
- **Backward pass**: 2009 → 1888 (100 titles/run)
- **Recent pass**: 100 titles modified since last run
- **People pass**: Cast/directors/producers from newly ingested movies

State is stored in `mmdb-meta/ingestion/state.json`.

## Current-Year Ingestion (`mmdbIngestCurrentYear`)

Runs nightly with a dual-pass strategy:

### Pass A: Full Dedup Scan

Fetches all titles for the current year (up to 2000) and deduplicates against existing repos. This replaces the old offset-based pagination which could miss films added out-of-order.

### Pass B: Recently Modified Catch-up

Fetches titles modified in the last 48 hours (`RECENT_MODIFIED_HOURS`). Catches:
- Films that received labels after initial ingestion attempt
- Films with corrected publication dates
- New films added to Wikidata since the last full scan

Publication date (P577) is **not required** for the recent pass — films without dates are still caught if they were recently modified.

### Why the dual-pass approach?

The old offset-based pagination had a fundamental gap: if Wikidata added a film *between* offset positions already processed, it would never be picked up. The full scan + catch-up approach ensures completeness without relying on stable ordering.

## Title Validation

All ingestion paths reject entries that fail title validation before creating PRs:

### Q-ID Rejection

Titles matching `/^Q\d+$/i` (e.g., `Q140513842`) are Wikidata entities that have no human-readable label in any supported language. These are rejected immediately.

### Non-Latin Title Filter (`isUsableTitle()`)

Titles that produce unusable slugs are rejected. A title is unusable if:
- It's empty or null
- It's a Q-ID (see above)
- After normalization (lowercase → NFD → strip diacritics → strip non-ASCII), the result is fewer than 2 characters

This filters out Arabic-only, CJK-only, Cyrillic-only, and other titles that can't produce a meaningful Latin filename slug. These entries are still valid films — they just need a label in a supported language first.

### Multi-Language Label Fallback

SPARQL queries request labels in 12 languages (priority order):

```
en, es, fr, de, pt, it, ja, ko, zh, ar, hi, ru
```

Wikidata's label service returns the first available label in priority order. This dramatically reduces Q-ID entries compared to English-only queries.

## Cleanup Cycle (`mmdbCleanupQIds`)

Runs weekly (Sunday 4 AM) to catch entries that slipped through before the title filters were added:

1. Scans the last `CLEANUP_YEAR_RANGE` (3) year repos
2. Reads every movie/series JSON file
3. Checks if title passes `isUsableTitle()`
4. **Entries without external IDs** (no IMDb/TMDB): deleted via PR
5. **Entries with external IDs**: logged for future re-resolution (not deleted)
6. Creates one cleanup PR per repo, squash-merges immediately

The cleanup function can also be triggered manually with the `cleanup-qids.mjs` script (see [functions/README.md](../functions/README.md#scripts)).

## Data Flow

```
Wikidata SPARQL → Title validation → Dedup check → Normalize → GitHub PR → Direct merge → CI builds indexes
                  (Q-ID + non-Latin)   (index + PRs)   (MMDB schema)
```

## Duplicate Prevention

Before adding any title, the pipeline checks:

1. **Existing IDs** in the target repo's `index.json` (master branch)
2. **IDs in open PRs** against the target repo
3. **Intra-batch dedup** — prevents duplicate IDs within a single run

## Configuration

Key constants in `functions/src/config.ts`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECENT_LIMIT` | 100 | Titles per recent pass |
| `BACKLOG_LIMIT` | 200 | Total backlog titles per run |
| `CURRENT_YEAR_FULL_SCAN_LIMIT` | 2000 | Max titles in full dedup scan |
| `RECENT_MODIFIED_HOURS` | 48 | Look-back window for catch-up pass |
| `RECENT_MODIFIED_LIMIT` | 200 | Max recently modified titles |
| `LABEL_LANGUAGES` | `en,es,fr,...,ru` | 12-language fallback for labels |
| `CLEANUP_SCHEDULE` | `every sunday 04:00` | Weekly cleanup cron |
| `CLEANUP_YEAR_RANGE` | 3 | Number of recent year repos to clean |

## Manual Scripts

For ad-hoc operations outside the scheduled pipeline:

- **`cleanup-qids.mjs`** — Clean a specific repo on demand
- **`rescan-year.mjs`** — Re-scan a historical year for missed films

See [functions/README.md](../functions/README.md#scripts) for usage.

## Safeguards

- **Kill switch**: Set `INGESTION_PAUSED=true` to stop all scheduled runs
- **Concurrency lock**: Only one function runs at a time (10-min timeout)
- **Anomaly detection**: Aborts if Wikidata returns > 2000 results (likely bad query)
- **Run timeout**: Graceful shutdown at 8 minutes (hard limit 9 min)
- **Max empty runs**: Auto-pauses after 3 consecutive runs with zero results
