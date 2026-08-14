# MMDB Ingestion Cloud Function

Automated serverless pipeline that ingests movie, series, and people metadata from Wikidata into MMDB GitHub repositories via scheduled Cloud Functions.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloud Scheduler (every 4h)                     │
└──────────────────────────────┬──────────────────────────────────┘
                               │ triggers
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Cloud Function: mmdbIngest (2nd gen)                 │
│                                                                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │  Backlog Pass     │  │  Recent Pass      │  │ People Pass   │  │
│  │  (200 titles/run) │  │  (40 titles/run)  │  │ (uncapped)    │  │
│  │  Year-by-year     │  │  Modified since   │  │ From new      │  │
│  │  sequential       │  │  last run         │  │ movies        │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
│           │                      │                    │           │
│           └──────────┬───────────┘                    │           │
│                      ▼                                ▼           │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐  │
│  │  Normalize & Deduplicate      │  │  Normalize & Deduplicate  │  │
│  └──────────────┬───────────────┘  └────────────┬─────────────┘  │
│                 ▼                                 ▼                │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │                    GitHub PR Creation                          ││
│  │  • One PR per mmdb-YYYY repo (movies + series for that year)  ││
│  │  • One PR for mmdb-people                                     ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│   mmdb-2010      │ │   mmdb-YYYY      │ │   mmdb-people    │
│   (GitHub repo)  │ │   (GitHub repo)  │ │   (GitHub repo)  │
└──────────────────┘ └──────────────────┘ └──────────────────┘

State: Firestore document at mmdb-ingestion/state
Secrets: GITHUB_TOKEN via Secret Manager
```

## Prerequisites

1. **Firebase project** with Blaze (pay-as-you-go) billing plan enabled
   - Required for Cloud Functions 2nd gen and Cloud Scheduler
2. **Firebase CLI** installed globally: `npm install -g firebase-tools`
3. **Node.js 22** runtime
4. **GitHub Fine-Grained Personal Access Token** for the `mimir-media-db` org

### GitHub Token Setup

Create a fine-grained PAT at https://github.com/settings/tokens with:

- **Resource owner**: `mimir-media-db`
- **Repository access**: All repositories (or select all mmdb-* repos + mmdb-meta)
- **Permissions**:
  - Contents: Read and write
  - Pull requests: Read and write
  - Metadata: Read (auto-granted)

### Repository Settings (per data repo)

Each data repo (`mmdb-YYYY`, `mmdb-people`) needs:

1. **Settings → Actions → General → Workflow permissions**: Set to **Read and write permissions**
2. **Optionally**: Enable "Allow GitHub Actions to create and approve pull requests"

This allows the CI workflow to auto-commit index updates after PRs are merged.

### Organization Settings

At **mimir-media-db org → Settings → Actions → General**:

- Workflow permissions: Allow **Read and write** (org-level enables per-repo setting)

## Setup

### 1. Firebase Login

```bash
firebase login
firebase use <your-project-id>
```

### 2. Configure Environment Variables

```bash
cd functions
cp .env.example .env
# Edit .env with your values:
#   GITHUB_TOKEN — your fine-grained PAT
#   INGEST_API_KEY — any random secret string (openssl rand -hex 32)
#   FUNCTION_URL — filled in after first deploy
#   MMDB_DRY_RUN — set to "false" for production
```

### 3. Install Dependencies

```bash
yarn install
```

### 4. Build

```bash
yarn build
```

## Deployment

```bash
# Deploy all functions (reads .env automatically)
yarn deploy
```

After first deploy, update `FUNCTION_URL` in your `.env` with the URL printed in the output.

## Manual Trigger

```bash
# Dry run (logs what it would do, no PRs)
yarn ingest:dry

# Real run (creates PRs)
yarn ingest:now

# Local run (no deployment needed, uses .env directly)
yarn ingest:local           # dry run
yarn ingest:local:live      # creates PRs
```

## Configuration

### Schedule

The default schedule is `every 4 hours` (6 times daily) for faster backlog processing. Once the backlog is complete, change to `every 24 hours` in `src/config.ts`:

```typescript
export const SCHEDULE_CRON = 'every 24 hours';
```

### Dry Run Mode

Set the `MMDB_DRY_RUN` environment variable to `true` to enable dry run mode. The function will log what it would do without creating any GitHub PRs.

```bash
firebase functions:config:set mmdb.dry_run=true
# Or set via environment variables in the Cloud Console
```

### Daily Caps

- **Backlog pass**: 200 titles (140 movies, 60 series)
- **Recent pass**: 40 titles (28 movies, 12 series)
- **Total cap**: 200 titles per run
- **People**: Uncapped (limited by associated movies)

### State Management

State is stored as a JSON file in the `mmdb-meta` repo at `ingestion/state.json`:

```json
{
  "backlog_offset": 0,
  "backlog_current_year": 2010,
  "last_recent_timestamp": "2026-01-01T00:00:00Z",
  "last_run": "2026-08-12T00:00:00Z",
  "total_ingested": { "movies": 0, "series": 0, "people": 0 }
}
```

To reset ingestion state (e.g., to re-process a year), edit the file directly in the `mmdb-meta` repo.

## Cost Expectations

This function operates well within Firebase's free tier:

| Resource | Free Tier | Expected Usage |
|----------|-----------|----------------|
| Cloud Functions invocations | 2M/month | ~180/month (6/day) |
| Cloud Functions compute | 400K GB-sec | ~45 GB-sec/month |
| Cloud Scheduler jobs | 3 free | 1 job |
| Outbound networking | 5GB/month | ~10MB/month |

**Estimated monthly cost: $0** (within free tier limits)

Note: No Firestore usage — state is stored in GitHub (mmdb-meta repo).

## Idempotency

The function is idempotent by design:

1. **Duplicate detection**: Before adding any title, it checks:
   - Existing IDs in the target repo's index.json
   - IDs in open PRs against the target repo
2. **State persistence**: Even on partial failure, the state is updated with progress
3. **Branch reuse**: If a branch already exists (from a failed prior run), it reuses it

## Error Handling

- Individual title failures don't abort the run
- Errors are logged and collected in the result
- State is updated even on partial success
- Missing year repos (`mmdb-YYYY`) are skipped with a warning
- The function re-throws fatal errors to mark the execution as failed in Cloud Monitoring

## Project Structure

```
functions/
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript config (strict mode, Node.js 20)
├── .gitignore             # Ignore dist/, node_modules/, env files
├── src/
│   ├── index.ts           # Cloud Function entrypoint (onSchedule)
│   ├── config.ts          # Constants: limits, cron, org name
│   └── ingestion/
│       ├── orchestrator.ts    # Dual-pass logic: backlog → recent → people
│       ├── wikidata-client.ts # SPARQL queries + HTTP client
│       ├── github-client.ts   # Octokit: branches, PRs, file uploads
│       ├── normalizer.ts      # Wikidata → MMDB format conversion
│       ├── id-generator.ts    # Slug/ID generation (m_, s_, p_ prefixes)
│       └── state.ts          # Firestore state read/write
└── README.md              # This file
```
