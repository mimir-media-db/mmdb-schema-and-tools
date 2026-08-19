# MMDB Scripts Reference

All scripts live in `functions/scripts/` and are run from the repo root (or `functions/` where noted). They authenticate as `mimir-media-db[bot]` via GitHub App credentials and interact with the MMDB GitHub organization through the API.

---

## Prerequisites

### Environment Variables

Scripts load credentials from `functions/.env`. Required variables:

| Variable | Purpose |
|----------|---------|
| `GITHUB_APP_ID` | GitHub App ID for mimir-media-db |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key (supports escaped `\n`) |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID on the mimir-media-db org |
| `GITHUB_TOKEN` | Fallback PAT (only used if App credentials missing) |
| `FUNCTION_URL` | Firebase Cloud Function URL (for `ingest-*` scripts) |
| `INGEST_API_KEY` | API key for the Cloud Function (for `ingest-*` scripts) |

### Setup

```bash
cd functions
cp .env.example .env   # Fill in credentials
npm install            # Or: yarn install
```

### Runtime

- Node.js 20+ (uses ES modules, top-level await, native fetch)
- All scripts use `.mjs` extension — run with `node scripts/<name>.mjs`

---

## Core Ingestion

### `bulk-fill.mjs`

**Purpose:** Initial population of year repos across a range. Creates repos if they don't exist, then runs a full rescan for each year using paginated Wikidata queries.

**Usage:**
```bash
node scripts/bulk-fill.mjs --from=<YYYY> --to=<YYYY> [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--from=YYYY` | Start year (required) | — |
| `--to=YYYY` | End year (required) | — |
| `--include-series` | Also ingest series for each year | off |
| `--dry-run` | Show plan without executing | off |
| `--resume` | Skip years with existing rescan branches | off |
| `--delay=N` | Seconds to wait between years | 10 |
| `--limit=N` | Page size for paginated Wikidata queries | 2000 |

**Examples:**
```bash
# Full population from 1920 to 2026
node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series

# Just a decade
node scripts/bulk-fill.mjs --from=2000 --to=2010

# Preview without executing
node scripts/bulk-fill.mjs --from=1920 --to=2026 --dry-run

# Resume after interruption
node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series --resume
```

**Internals:** For each year in range: checks if repo exists (creates it if not), checks for recent rescan branches (skips if `--resume`), then calls `rescanYear()` from `lib/rescan-core.mjs` which handles Wikidata querying, deduplication, branch creation, commits, PR, and auto-merge.

**Notes:**
- Creates year repos automatically (with standard structure, branch protection, CI workflow)
- Uses progress bar with ETA
- 10-second default delay between years to respect GitHub rate limits

---

### `bulk-rescan.mjs`

**Purpose:** Fill gaps using OFFSET pagination. Unlike `bulk-fill.mjs`, this assumes repos already exist and uses paginated queries to fetch ALL results (not just the first page).

**Usage:**
```bash
node scripts/bulk-rescan.mjs --from=<YYYY> --to=<YYYY> [options]
node scripts/bulk-rescan.mjs --year=<YYYY> [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--from=YYYY` | Start year (required unless `--year`) | — |
| `--to=YYYY` | End year (required unless `--year`) | — |
| `--year=YYYY` | Single year shorthand (sets from=to) | — |
| `--include-series` | Include series in rescan | off |
| `--dry-run` | Show plan without executing | off |
| `--resume` | Skip years with existing rescan branches | off |
| `--delay=N` | Seconds between years | 10 |

**Examples:**
```bash
node scripts/bulk-rescan.mjs --from=2010 --to=2026 --include-series
node scripts/bulk-rescan.mjs --year=2020
node scripts/bulk-rescan.mjs --from=2010 --to=2026 --dry-run
node scripts/bulk-rescan.mjs --from=2010 --to=2026 --include-series --resume
```

**Internals:** Iterates year range, queries Wikidata with OFFSET pagination (fetches ALL pages until a page returns fewer results than page size), deduplicates against existing entries + pending PRs, commits new entries in batches grouped by first letter, creates PR and squash-merges.

**Notes:**
- Reports gaps found per year
- Does NOT create repos — use `bulk-fill.mjs` for initial creation

---

### `bulk-people.mjs`

**Purpose:** Bulk people enrichment. Iterates year repos, extracts Wikidata Q-IDs from movie entries, queries Wikidata for cast/directors/producers, and commits new people entries to alphabetical people repos.

**Usage:**
```bash
node scripts/bulk-people.mjs --from=<YYYY> --to=<YYYY> [options]
node scripts/bulk-people.mjs --year=<YYYY> [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--from=YYYY` | Start year (required unless `--year`) | — |
| `--to=YYYY` | End year (required unless `--year`) | — |
| `--year=YYYY` | Single year shorthand | — |
| `--dry-run` | Show plan without executing commits | off |
| `--resume` | Skip years with existing people branches | off |
| `--max-queries=N` | Cap total Wikidata queries per run | unlimited |
| `--batch-size=N` | Movies per Wikidata query batch | 30 |
| `--delay=N` | Seconds between Wikidata queries | 2 |

**Examples:**
```bash
node scripts/bulk-people.mjs --from=2000 --to=2026
node scripts/bulk-people.mjs --year=2024
node scripts/bulk-people.mjs --from=2000 --to=2026 --dry-run
node scripts/bulk-people.mjs --from=2000 --to=2026 --resume
node scripts/bulk-people.mjs --from=2000 --to=2010 --max-queries=50
```

**Internals:** Downloads each year repo's tarball (one HTTP call per year for efficiency), parses all movie files to extract Wikidata Q-IDs, batches Q-IDs into Wikidata SPARQL queries for cast/directors/producers, normalizes person data, routes people to alphabetical repos (`mmdb-people-a` through `mmdb-people-z`), commits via Git Trees API with auto-merge.

**Notes:**
- Uses tarball API for efficient bulk download (avoids per-file API calls)
- `--max-queries` is useful for testing or when Wikidata rate limits are tight
- People are routed by first letter of slug: `p_aamir_khan` → `mmdb-people-a`

---

### `rescan-year.mjs`

**Purpose:** Rescan a single historical year for films/series missed during original ingestion. Catches entries added to Wikidata after the offset-based pagination already passed them.

**Usage:**
```bash
node functions/scripts/rescan-year.mjs --year=<YYYY> [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--year=YYYY` | Target year to rescan (required) | — |
| `--dry-run` | Show what would be added without creating PR | off |
| `--limit=N` | Page size for Wikidata queries | 2000 |
| `--include-series` | Also rescan series | off |

**Examples:**
```bash
node functions/scripts/rescan-year.mjs --year=2010 --dry-run
node functions/scripts/rescan-year.mjs --year=2010 --limit=3000
node functions/scripts/rescan-year.mjs --year=2010 --include-series
```

**Internals:** Authenticates via GitHub App, calls `rescanYear()` from `lib/rescan-core.mjs` with paginated Wikidata queries, deduplicates against existing repo contents and pending PRs, creates a branch with new entries grouped by letter, opens and squash-merges PR, dispatches CI workflow for index rebuild.

**Notes:**
- Valid year range: 1888–current year
- Falls back to `GITHUB_TOKEN` if App credentials are missing
- Dry-run mode works without authentication

---

### `ingest-now.mjs`

**Purpose:** Trigger the serverless ingestion pipeline immediately (full run, not dry).

**Usage:**
```bash
cd functions
node scripts/ingest-now.mjs
```

**Flags:** None.

**Internals:** Reads `FUNCTION_URL` and `INGEST_API_KEY` from `functions/.env`, sends a POST request to the Firebase Cloud Function with 10-minute timeout.

**Notes:**
- Must be run from the `functions/` directory (reads `.env` relative to CWD)
- Waits up to 10 minutes for the Cloud Function to respond
- Returns the full ingestion result as JSON

---

### `ingest-dry.mjs`

**Purpose:** Trigger a dry-run of the serverless ingestion pipeline. Shows what would be ingested without creating PRs.

**Usage:**
```bash
cd functions
node scripts/ingest-dry.mjs
```

**Flags:** None.

**Internals:** Same as `ingest-now.mjs` but appends `?dryRun=true` to the function URL.

**Notes:**
- Safe to run anytime — makes no changes to repos
- Useful for checking what Wikidata has available before a live run

---

### `ingest-current-year.mjs`

**Purpose:** Trigger ingestion for only the current year (not the full backlog pass).

**Usage:**
```bash
cd functions
node scripts/ingest-current-year.mjs [--dry]
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--dry` | Dry-run mode (no PRs created) |

**Internals:** Calls the Cloud Function with `?mode=currentYear` parameter. Optionally adds `&dryRun=true`.

**Notes:**
- Current-year ingestion is normally run nightly by a scheduler
- This script allows manual triggering

---

## People Management

### `split-people.mjs`

**Purpose:** Migrate people from the monolithic `mmdb-people` repo into 26 alphabetical repos (`mmdb-people-a` through `mmdb-people-z`). Routing key: first character of the person slug after the `p_` prefix.

**Usage:**
```bash
node scripts/split-people.mjs [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Show distribution counts without executing | off |
| `--letters=a,b,c` | Only process specific letters (comma-separated) | all 26 |

**Examples:**
```bash
node scripts/split-people.mjs --dry-run
node scripts/split-people.mjs
node scripts/split-people.mjs --letters=a,b,c
```

**Internals:** Downloads the full `mmdb-people` repo tarball, parses all person JSON files, groups them by first letter of slug, creates destination repos if they don't exist, commits people in batches via Git Trees API, creates PRs with auto-merge.

**Notes:**
- One-time migration script (run once to split, then use alphabetical repos going forward)
- `--letters` flag useful for partial runs or retrying failed letters

---

### `fix-people-filenames.mjs`

**Purpose:** Fix missing `p_` prefix on person filenames. The internal `id` field is correct but filenames were created without the prefix.

**Usage:**
```bash
node scripts/fix-people-filenames.mjs [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Show counts without executing | off |
| `--letter=x` | Fix specific repo only | all repos |

**Examples:**
```bash
node scripts/fix-people-filenames.mjs              # Fix all repos
node scripts/fix-people-filenames.mjs --letter=s   # Fix specific repo
node scripts/fix-people-filenames.mjs --dry-run    # Just show counts
```

**Internals:** Uses the Git Trees API with `base_tree` + `sha:null` for deletions. For each batch: includes old path with `sha=null` (deletion) and new path (`p_` + old) with the blob SHA (addition). Batches ~250 renames per commit (500 tree entries). Creates a single branch with all batch commits, then opens PR and squash-merges.

**Notes:**
- Index.json is NOT rebuilt here — CI validate workflow rebuilds it automatically after merge
- 10-second delay between repos; 60-second delay after repos with >2000 files
- Handles GitHub rate limits with 60-second retry (up to 3 retries)

---

### `fix-people-indexes.mjs`

**Purpose:** Rebuild and push correct `data/people/index.json` for specified people repos. Uses tarball download for efficiency.

**Usage:**
```bash
node scripts/fix-people-indexes.mjs [letters...]
```

**Arguments:** Space-separated letters to rebuild. Defaults to `s t` if none provided.

**Examples:**
```bash
node scripts/fix-people-indexes.mjs           # Rebuilds s and t
node scripts/fix-people-indexes.mjs a b c     # Rebuilds a, b, c
```

**Internals:** Downloads each repo's tarball, extracts all person files, builds a fresh index.json from the actual file contents, pushes the corrected index directly.

**Notes:**
- Use when indexes are out of sync with actual file contents
- No PR — pushes directly to master

---

### `fix-people-workflow.mjs`

**Purpose:** Fix the `validate.yml` GitHub Actions workflow on people repos. Corrects a bug where the checkout step used `path: data`, causing double-nesting.

**Usage:**
```bash
node scripts/fix-people-workflow.mjs [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--letter=a,b,c` | Comma-separated letters to fix | — |
| `--all` | Fix all 26 repos | — |
| `--dry-run` | Show what would be done without pushing | off |
| `--direct` | Push directly to master (no PR) | off |

**Examples:**
```bash
node scripts/fix-people-workflow.mjs --letter=q         # Fix one
node scripts/fix-people-workflow.mjs --letter=q,z       # Fix multiple
node scripts/fix-people-workflow.mjs --all              # Fix all 26
node scripts/fix-people-workflow.mjs --letter=q --dry-run
```

**Internals:** Replaces the `.github/workflows/validate.yml` file content with the corrected version (checkout to workspace root, no `cd data`).

---

### `cleanup-bad-people.mjs`

**Purpose:** Remove invalid person entries from alphabetical people repos. Scans for files with empty slugs, mismatched IDs, empty names, or invalid ID patterns.

**Usage:**
```bash
node scripts/cleanup-bad-people.mjs [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Just list bad entries | off |
| `--letter=x` | Fix specific repo only | all repos |

**Examples:**
```bash
node scripts/cleanup-bad-people.mjs                # Fix all repos
node scripts/cleanup-bad-people.mjs --letter=z     # Fix specific repo
node scripts/cleanup-bad-people.mjs --dry-run      # Just list bad entries
```

**Validation rules (entry is invalid if):**
- Filename is `p_.json` (empty slug)
- Filename doesn't match internal `id` field
- `name` is empty or whitespace
- `id` doesn't match `^p_[a-z][a-z0-9_]+$`

**Internals:** For each bad file: creates branch, deletes the file, opens PR, squash-merges.

**Notes:**
- 5-second delay between repos for rate limiting

---

### `remove-ancient-people.mjs`

**Purpose:** Remove person entries with `birth_year < 1800` or `death_year < 1800`. These are ancient/medieval people that shouldn't be in a modern media database.

**Usage:**
```bash
node scripts/remove-ancient-people.mjs [options]
```

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Just list entries without deleting | off |
| `--letter=x` | Fix specific repo only | all repos |

**Examples:**
```bash
node scripts/remove-ancient-people.mjs              # Fix all repos
node scripts/remove-ancient-people.mjs --letter=z   # Fix specific repo
node scripts/remove-ancient-people.mjs --dry-run    # Just list entries
```

**Internals:** Downloads repo tarball, reads person JSON content, identifies entries where birth_year or death_year < 1800, builds a new tree without those files (using `sha: null` for deletion), creates commit, branch, PR, and squash-merges. Groups all deletions per repo into a single PR.

**Notes:**
- Cutoff year: 1800
- 5-second delay between repos

---

## Verification & Maintenance

### `verify-integrity.mjs`

**Purpose:** Verify data integrity across all year repos (2000–2026). Compares index.json entry count vs actual .json file count for movies and series.

**Usage:**
```bash
node scripts/verify-integrity.mjs
```

**Flags:** None.

**Examples:**
```bash
node scripts/verify-integrity.mjs
```

**Internals:** For each repo `mmdb-2000` through `mmdb-2026`: fetches `data/movies/index.json` and `data/series/index.json` via Contents API (handles large files via Blob API), counts entries, compares with actual file listing. Reports mismatches.

**Notes:**
- 500ms delay between repos to avoid rate limits
- Reports both index count and actual file count when they differ
- Read-only — makes no changes

---

### `verify-people-split.mjs`

**Purpose:** Verify data integrity across all 26 alphabetical people repos after the split migration.

**Usage:**
```bash
node scripts/verify-people-split.mjs
```

**Flags:** None.

**Checks performed:**
1. Repo exists (was created)
2. Index vs file count — entries in index.json vs actual `p_*.json` files
3. Routing correctness — all person files start with correct letter
4. Total count — sum across all repos vs original mmdb-people total (~4,452)
5. No orphans — every entry in original mmdb-people exists in a split repo

**Internals:** Gets recursive tree for each repo, fetches index content, cross-references counts and routing. Reports discrepancies.

**Notes:**
- 400ms delay between repo checks
- Read-only — makes no changes

---

### `cleanup-qids.mjs`

**Purpose:** Remove entries from year repos where the title is a Wikidata Q-ID (e.g., `Q140513842`) instead of a real movie/series name.

**Usage:**
```bash
node functions/scripts/cleanup-qids.mjs --repo=<repo-name> [--dry-run]
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--repo=mmdb-YYYY` | Target year repo to clean (required) |
| `--dry-run` | Show what would be deleted without making changes |

**Examples:**
```bash
node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026 --dry-run
node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026
```

**Behavior:**
- Scans `data/movies/` and `data/series/` for files matching `q\d+-YYYY.json`
- Reads each file and checks if title matches `/^Q\d+$/i`
- Entries with **no** external IDs (IMDb/TMDB): marked for deletion
- Entries **with** external IDs: logged for future re-resolution (not deleted)
- Creates a PR to delete entries (unless `--dry-run`)

---

### `setup-repos.mjs`

**Purpose:** Configure branch protection and repo settings for all `mmdb-*` data repos. Run after creating new repos or when changing org-wide settings.

**Usage:**
```bash
node scripts/setup-repos.mjs <GITHUB_TOKEN> [options]
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be done without making changes |
| `--repos=a,b,c` | Only configure specific repos (comma-separated) |

**Examples:**
```bash
node scripts/setup-repos.mjs ghp_xxxx
node scripts/setup-repos.mjs ghp_xxxx --dry-run
node scripts/setup-repos.mjs ghp_xxxx --repos=mmdb-2010,mmdb-2026
```

**What it configures:**
1. Enables auto-merge and squash-only merge strategy
2. Sets branch protection (requires `validate` status check)
3. Enables delete-branch-on-merge

**Notes:**
- Requires a GitHub PAT with `Administration: Read and write` permission (not App token)
- Discovers all `mmdb-*` repos in the org automatically (unless `--repos` is specified)

---

## Shared Libraries (`lib/`)

### `lib/rescan-core.mjs`

**Purpose:** Core shared logic for all ingestion and maintenance scripts. Contains Wikidata querying, normalization, GitHub API wrappers, retry logic, and batch commit functionality.

**Key exports:**

| Export | Purpose |
|--------|---------|
| `ORG` | Organization name (`mimir-media-db`) |
| `rescanYear(options)` | Full year rescan (query → dedup → commit → PR → merge) |
| `createGitHubClient(tokenOrManager)` | GitHub API client with token refresh |
| `retryOnServerError(fn, opts)` | Exponential backoff retry (5xx + network errors) |
| `queryWikidata(sparql)` | Single Wikidata SPARQL query |
| `queryWikidataPaginated(builder, pageSize)` | Paginated multi-page Wikidata query |
| `buildMovieQuery(year, limit, offset)` | SPARQL query builder for movies |
| `buildSeriesQuery(year, limit, offset)` | SPARQL query builder for series |
| `parseMovieResults(results)` / `parseSeriesResults(results)` | Parse SPARQL bindings |
| `normalizeMovie(wikiMovie)` / `normalizeSeries(wikiSeries)` | Normalize to MMDB schema |
| `isUsableTitle(title)` | Validate titles (reject Q-IDs, empty slugs) |
| `isUsablePersonName(name)` | Validate person names |
| `isValidPersonYear(birth, death)` | Reject pre-1800 persons |
| `generateSlug(title)` / `generateMovieId()` / `generateSeriesId()` | ID generation |
| `getExistingIds(ghApi, repo, dir)` | Get IDs already in a repo's index |
| `getIdsInPendingPRs(ghApi, repo, dir)` | Get IDs from open PRs (dedup) |
| `commitBatch(ghApi, repo, branch, files, msg)` | Batch commit via Git Trees API |
| `createBranch()` / `createPR()` / `enableAutoMerge()` | Git workflow helpers |
| `repoExists()` / `hasRecentRescanBranch()` | Repo status checks |
| `createYearRepo(ghApi, year)` | Create new year repo with full structure |
| `getPeopleRepo(personId)` | Route person to alphabetical repo |
| `waitForRepo(ghApi, repo)` | Wait for repo propagation after creation |
| `groupByFirstLetter(items)` | Group items for batched commits |

**Constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `WIKIDATA_RATE_LIMIT_MS` | 500ms | Delay between Wikidata queries |
| `GITHUB_RATE_LIMIT_MS` | 200ms | Delay between GitHub API calls |
| `MAX_TREE_BATCH_SIZE` | 400 | Max files per Git Trees API call |
| `MAX_RESULTS_SANITY` | 3000 | Anomaly detection threshold |

---

### `lib/github-app-auth.mjs`

**Purpose:** GitHub App authentication with automatic token refresh. Zero external dependencies — uses Node.js built-in `crypto`.

**Key exports:**

| Export | Purpose |
|--------|---------|
| `loadGitHubAuth(envPath)` | Load auth from .env (App preferred, PAT fallback) |
| `getInstallationToken(appId, key, installId)` | Get a fresh installation token |
| `createTokenManager(appId, key, installId)` | Self-refreshing token manager (50-min TTL) |

**Auth flow:**
1. Creates JWT signed with App private key (RS256)
2. POST `/app/installations/{id}/access_tokens` with JWT
3. Returns installation token (`ghs_xxx...`)
4. Token manager auto-refreshes after 50 minutes (GitHub expires at 60)

**Notes:**
- Handles both PKCS#1 (`RSA PRIVATE KEY`) and PKCS#8 (`PRIVATE KEY`) PEM formats
- Strips surrounding quotes and normalizes escaped newlines in keys
- Falls back to `GITHUB_TOKEN` PAT if App credentials are incomplete

---

### `lib/progress.mjs`

**Purpose:** Progress bars and download tracking for long-running operations.

**Key exports:**

| Export | Purpose |
|--------|---------|
| `createProgress(total, label)` | Terminal progress bar with ETA |
| `trackDownload(response, label)` | Track fetch response download progress |

**`createProgress` methods:**
- `.tick(stepLabel)` — Advance by one, update progress bar
- `.done()` — Print newline, return duration string
- `.log(msg)` — Print message without breaking progress bar

**`trackDownload`:** Reads a fetch Response body as a stream, displaying MB downloaded and percentage (if Content-Length header is available).

---

## Typical Workflows

### How to Add a New Year

```bash
# Option 1: Let bulk-fill create it automatically
node scripts/bulk-fill.mjs --from=2027 --to=2027 --include-series

# Option 2: Manual (if you want to verify first)
node scripts/bulk-fill.mjs --from=2027 --to=2027 --dry-run
node scripts/bulk-fill.mjs --from=2027 --to=2027 --include-series

# Then set up branch protection
node scripts/setup-repos.mjs ghp_xxxx --repos=mmdb-2027
```

### How to Run Bulk People Enrichment

```bash
# First, dry-run to see what's available
node scripts/bulk-people.mjs --from=2020 --to=2026 --dry-run

# Run with a query cap (safe first run)
node scripts/bulk-people.mjs --from=2020 --to=2026 --max-queries=50

# Full run (may take hours)
node scripts/bulk-people.mjs --from=2000 --to=2026

# If interrupted, resume from where you left off
node scripts/bulk-people.mjs --from=2000 --to=2026 --resume
```

### How to Clean Up a Year Repo

```bash
# Check for Q-ID entries
node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026 --dry-run

# If found, remove them
node functions/scripts/cleanup-qids.mjs --repo=mmdb-2026

# Verify index integrity after cleanup
node scripts/verify-integrity.mjs
```

### How to Fix People Data Issues

```bash
# Check for invalid entries
node scripts/cleanup-bad-people.mjs --dry-run

# Remove ancient people
node scripts/remove-ancient-people.mjs --dry-run
node scripts/remove-ancient-people.mjs

# Fix filenames missing p_ prefix
node scripts/fix-people-filenames.mjs --dry-run
node scripts/fix-people-filenames.mjs

# Rebuild indexes if out of sync
node scripts/fix-people-indexes.mjs a b c d
```

### Post-Migration Verification

```bash
# Verify year repos
node scripts/verify-integrity.mjs

# Verify people split
node scripts/verify-people-split.mjs
```

---

## Rate Limiting

### Wikidata

- **Minimum delay:** 500ms between queries (enforced in `rescan-core.mjs`)
- **Pagination:** Large result sets are split into 2000-result pages
- **Mitigation:** Scripts use `--delay` flags to add extra time between operations
- **If rate-limited:** Wikidata returns 429 or 503 — the retry logic handles this with exponential backoff

### GitHub API

- **Minimum delay:** 200ms between API calls (enforced in `rescan-core.mjs`)
- **Rate limit:** 5,000 requests/hour for GitHub App tokens
- **Secondary rate limits:** Triggered by creating too much content too fast
- **Mitigation:**
  - `--delay` between years (default 10s)
  - Inter-repo delays (5–10s depending on script)
  - Large-repo delays (60s after repos with >2000 files)
  - 60-second wait + 3 retries on rate limit errors
- **Token refresh:** App tokens expire after 60 minutes; the token manager auto-refreshes at 50 minutes

### Best Practices

- Always start with `--dry-run` to preview scope
- Use `--max-queries` to cap Wikidata requests per session
- Run bulk operations during off-peak hours
- Monitor GitHub rate limit headers in script output

---

## Resume & Recovery

### `--resume` Flag

Most bulk scripts support `--resume`. This checks for existing rescan branches on each year/letter and skips repos that already have one, allowing you to restart after interruptions without repeating work.

```bash
# Safe to re-run — skips completed years
node scripts/bulk-fill.mjs --from=1920 --to=2026 --include-series --resume
node scripts/bulk-people.mjs --from=2000 --to=2026 --resume
```

### After Failures

1. **Network errors / timeouts:** Safe to re-run with `--resume`. Partially completed PRs may need manual cleanup (check for open PRs on the target repo).

2. **Auth expiry mid-run:** Token manager auto-refreshes. If a persistent 401 occurs, check that the GitHub App installation hasn't been revoked.

3. **Wikidata downtime:** Scripts will fail with query errors. Wait and retry — data is idempotent.

4. **Partial year completion:** If a year got a branch but the PR wasn't merged, either:
   - Merge the PR manually, or
   - Delete the branch and re-run without `--resume`

5. **Index desync:** After manual interventions, run `verify-integrity.mjs` and `fix-people-indexes.mjs` as needed.

### Idempotency

All scripts are designed to be **idempotent** — running them twice produces the same result. Deduplication happens against existing repo contents AND open PRs, so re-runs won't create duplicates.

---

## Script Index (Quick Reference)

| Script | Category | Key Flags |
|--------|----------|-----------|
| `bulk-fill.mjs` | Ingestion | `--from`, `--to`, `--resume`, `--include-series` |
| `bulk-rescan.mjs` | Ingestion | `--from`, `--to`, `--year`, `--resume` |
| `bulk-people.mjs` | Ingestion | `--from`, `--to`, `--year`, `--max-queries`, `--resume` |
| `rescan-year.mjs` | Ingestion | `--year`, `--limit`, `--include-series` |
| `ingest-now.mjs` | Ingestion | (none) |
| `ingest-dry.mjs` | Ingestion | (none) |
| `ingest-current-year.mjs` | Ingestion | `--dry` |
| `split-people.mjs` | People | `--letters`, `--dry-run` |
| `fix-people-filenames.mjs` | People | `--letter`, `--dry-run` |
| `fix-people-indexes.mjs` | People | `[letters...]` |
| `fix-people-workflow.mjs` | People | `--letter`, `--all`, `--direct` |
| `cleanup-bad-people.mjs` | People | `--letter`, `--dry-run` |
| `remove-ancient-people.mjs` | People | `--letter`, `--dry-run` |
| `verify-integrity.mjs` | Verification | (none) |
| `verify-people-split.mjs` | Verification | (none) |
| `cleanup-qids.mjs` | Maintenance | `--repo`, `--dry-run` |
| `setup-repos.mjs` | Maintenance | `<TOKEN>`, `--repos`, `--dry-run` |
