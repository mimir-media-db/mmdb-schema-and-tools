# MMDB Schema and Tools

> JSON schemas, validation tools, and documentation for the Mimir Media Database.

## What is This?

This repository contains:
- **JSON Schemas** for all MMDB entities (movies, series, people, etc.)
- **Validation tools** to ensure data quality
- **Index building tools** to generate searchable indexes
- **Repository scaffolding tools** to create new year repos
- **Documentation** for the MMDB project

## MMDB Overview

MMDB is a **GitHub-centric media database** where:
- Data is stored as **plain JSON files** in public repositories
- Content is **sharded by release year** for scalability
- All changes flow through **pull requests** for transparency
- Stable IDs and versioned schemas ensure **long-term reliability**
- Consumers build their own APIs and databases on top of MMDB

**MMDB is not an API** – it's a source of truth that you clone, import, and query locally.

## Project Status

🚧 **Phase 1: Foundation** (In Progress)

We're currently building:
- JSON Schema definitions
- Core validation and indexing tools
- Initial repository structure
- CI/CD workflows

## Installation

```bash
npm install -g mmdb-schema-and-tools
```

Or use locally in a data repository:

```bash
npm install mmdb-schema-and-tools
```

## Usage

### Validate a Repository

```bash
# In a data repo (mmdb-2010, mmdb-people, etc.)
mmdb-validate

# Or specify path
mmdb-validate --repo-path=/path/to/mmdb-2010
```

### Build Indexes

```bash
mmdb-build-indexes

# Or specify path
mmdb-build-indexes --repo-path=/path/to/mmdb-2010
```

### Create a New Year Repository

```bash
mmdb-create-year-repo --year=2010 --output=./repos
```

## Repository Structure

## Repository Structure

This repo (`mmdb-schema-and-tools`):

```
mmdb-schema-and-tools/
  schema/               # JSON Schema definitions
    movie-v1.json
    series-v1.json
    season-v1.json
    episode-v1.json
    person-v1.json
  tools/                # Validation and build tools
    src/
      validate-repo.ts
      build-indexes.ts
      create-year-repo.ts
  docs/                 # Documentation
  data/                 # Test data (for development)
```

Data repositories (separate repos):

```
mmdb-2010/            # Movies/series from 2010
mmdb-people/          # Global people database
mmdb-meta/            # Cross-repo metadata
```

## Quick Start (For Consumers)

```bash
# Clone the data repos you need
git clone --depth 1 https://github.com/mimir-media-db/mmdb-people
git clone --depth 1 https://github.com/mimir-media-db/mmdb-2010

# Install tools
npm install -g mmdb-schema-and-tools

# Validate data
cd mmdb-2010
mmdb-validate

# Build indexes
mmdb-build-indexes
```

## Quick Start (For Contributors)

See [docs/contribution-guide.md](docs/contribution-guide.md) for detailed instructions.

```bash
# Fork a data repo (e.g., mmdb-2010)
# Add or edit JSON files

# Install tools
npm install mmdb-schema-and-tools

# Validate
npx mmdb-validate

# Build indexes
npx mmdb-build-indexes

# Submit PR
```

## Documentation

- [Architecture Overview](mmdb_architecture_updated.md) – Complete technical blueprint
- [Development Plan](docs/dev-plan.md) – Stage-based implementation roadmap
- [Schema Documentation](docs/architecture.md) – Entity schemas and data model
- [Contribution Guide](docs/contribution-guide.md) – How to add/edit data
- [Progress Tracking](docs/progress.md) – Current status and milestones
- [Known Issues](docs/bugs.md) – Bug tracking and resolutions

## Tech Stack

- **Language**: TypeScript (Node.js 20+)
- **Validation**: JSON Schema (Ajv)
- **Build**: TypeScript Compiler
- **CI/CD**: GitHub Actions

## Design Principles

1. **Open & Inspectable** – Plain JSON, no proprietary formats
2. **Modular & Sharded** – One repo per year, separate people/schema repos
3. **Stable & Versioned** – Permanent IDs, schema versioning, no history rewrites
4. **GitHub as Source** – Not a runtime database, but canonical distribution
5. **Automation-First** – Scripts generate indexes, CI validates everything

## Stability Contract

- **IDs are permanent** – Never reused for different entities
- **No forced history rewrites** – No `git push --force` on main branches
- **Schema changes are versioned** – Backward compatibility maintained
- **Deprecation over deletion** – Bad data is flagged, not removed
- **Generated indexes** – Never manually edited

## Cost & Sustainability

- **Phase 1-2**: $0 (GitHub Actions free tier, local tooling)
- **Phase 3**: $0 (Firebase free tier for ~100 titles/day ingestion)
- **Target**: ≤10 MXN/month operational cost

## Roadmap

- ✅ Schema definitions (v1)
- ✅ Core tooling (validation, indexing, scaffolding)
- ✅ CI/CD workflows
- 🚧 Initial data repositories
- ⏳ Manual data seeding
- ⏳ Local ingestion script
- ⏳ Serverless ingestion pipeline
- ⏳ Community contributions

## License

MIT

## Contributing

We welcome contributions! Please read [docs/contribution-guide.md](docs/contribution-guide.md) before submitting PRs.

## Contact

[To be determined – GitHub Discussions, Discord, or mailing list]
