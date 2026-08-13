# MMDB — Mimir Media Database

> An open-source, GitHub-centric media metadata database. Plain JSON files, versioned schemas, automated ingestion from Wikidata.

## What is MMDB?

MMDB is a **distributed media database** stored as JSON files in public GitHub repositories:

- **Movies, series, and people** as structured JSON with stable IDs
- **Sharded by year** — one repo per release year (`mmdb-2009`, `mmdb-2010`, ..., `mmdb-2026`)
- **Automated ingestion** from Wikidata — 300+ titles/day, growing continuously
- **No API required** — clone the repos you need, query locally
- **Open source** (MIT) — fork, consume, contribute

**MMDB is not an API** — it's a source of truth you clone and build on top of.

## Quick Start

```bash
# Clone the data you need
git clone --depth 1 https://github.com/mimir-media-db/mmdb-people
git clone --depth 1 https://github.com/mimir-media-db/mmdb-2026

# Query locally — it's just JSON
cat mmdb-2026/data/movies/index.json | jq '.[0:3]'
```

## Project Status

✅ **Phase 3: Automated Ingestion** (Active)

| Component | Status |
|-----------|--------|
| JSON Schemas (v1) | ✅ Complete |
| Validation & indexing tools | ✅ Complete |
| CI/CD workflows (hardened) | ✅ Complete |
| Movie ingestion from Wikidata | ✅ Running |
| Series ingestion from Wikidata | ✅ Running |
| People ingestion (cast, directors, producers) | ✅ Running |
| Serverless pipeline (Firebase Cloud Functions) | ✅ Deployed |
| Bidirectional backlog (forward + backward) | ✅ Running |
| Nightly current-year ingestion | ✅ Running |
| Auto-merge bot PRs (squash) | ✅ Active |
| Automated year repo creation | ✅ Active |
| Safeguards (kill switch, lock, anomaly detection) | ✅ Active |

## Repository Structure

```
mmdb-schema-and-tools/          # This repo
├── schema/                     # JSON Schema definitions
│   ├── movie-v1.json
│   ├── series-v1.json
│   ├── season-v1.json
│   ├── episode-v1.json
│   └── person-v1.json
├── tools/                      # Validation and build tools
│   └── src/
│       ├── validate-repo.ts
│       ├── build-indexes.ts
│       ├── create-year-repo.ts
│       ├── ingest-from-wikidata.ts
│       ├── ingest-people.ts
│       └── ingest-series.ts
├── functions/                  # Firebase Cloud Functions (ingestion pipeline)
│   ├── src/
│   │   ├── index.ts           # Scheduled + HTTP trigger functions
│   │   └── ingestion/         # Orchestrator, Wikidata client, GitHub client
│   ├── test/                  # 143 unit tests
│   └── scripts/               # Manual trigger + setup scripts
└── docs/                       # Documentation
```

## MMDB Ecosystem

| Repository | Purpose |
|-----------|---------|
| [mmdb-schema-and-tools](https://github.com/mimir-media-db/mmdb-schema-and-tools) | Schemas, tools, ingestion pipeline |
| [mmdb-meta](https://github.com/mimir-media-db/mmdb-meta) | Registry, stats, ingestion state |
| [mmdb-people](https://github.com/mimir-media-db/mmdb-people) | Global people database |
| [mmdb-2009](https://github.com/mimir-media-db/mmdb-2009) | Movies & series from 2009 |
| [mmdb-2010](https://github.com/mimir-media-db/mmdb-2010) | Movies & series from 2010 |
| [mmdb-2026](https://github.com/mimir-media-db/mmdb-2026) | Movies & series from 2026 |

New year repos are created automatically as the ingestion pipeline advances.

## Ingestion Pipeline

The pipeline runs as Firebase Cloud Functions:

- **3x daily** — Backlog pass (forward from 2010→now, backward from 2009→1888)
- **Nightly** — Current year (2026) ingestion
- **Source** — [Wikidata](https://www.wikidata.org/) SPARQL queries
- **Output** — Pull requests with auto-merge (squash)

Safeguards: kill switch, concurrency lock, anomaly detection, title count sanity checks, 1 repo creation per run cap.

## Usage

### Validate a Data Repository

```bash
cd mmdb-2010
npx mmdb-schema-and-tools validate
```

### Build Indexes

```bash
cd mmdb-2010
npx mmdb-schema-and-tools build-indexes
```

### Run Ingestion Locally

```bash
cd functions
cp .env.example .env  # Fill in your values
yarn install
yarn ingest:local     # Dry run
yarn ingest:local:live  # Create PRs
```

See [functions/README.md](functions/README.md) for full deployment docs.

## Tech Stack

- **Language**: TypeScript (Node.js 22)
- **Validation**: JSON Schema (Ajv)
- **Ingestion**: Firebase Cloud Functions + Wikidata SPARQL
- **CI/CD**: GitHub Actions
- **Distribution**: Git repositories (GitHub)
- **Cost**: $0 (Firebase free tier)

## Design Principles

1. **Open & Inspectable** — Plain JSON, no proprietary formats
2. **Modular & Sharded** — One repo per year, separate people/schema repos
3. **Stable & Versioned** — Permanent IDs, schema versioning, no history rewrites
4. **GitHub as Source** — Not a runtime database, but canonical distribution
5. **Automation-First** — Scripts generate indexes, CI validates everything

## Stability Contract

- **IDs are permanent** — Never reused for different entities
- **No forced history rewrites** — No `git push --force` on main branches
- **Schema changes are versioned** — Backward compatibility maintained
- **Deprecation over deletion** — Bad data is flagged, not removed
- **Generated indexes** — Never manually edited

## Contributing

We welcome contributions! See [docs/contribution-guide.md](docs/contribution-guide.md).

## License

MIT
