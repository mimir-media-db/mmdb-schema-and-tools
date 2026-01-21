# MMDB Development Plan

> Stage-based implementation roadmap for the Mimir Media Database project.

## Overview

MMDB development is organized into three main phases, each building on the previous one. This plan focuses on **deliverables and milestones**, not specific dates.

## Phase 1: Foundation

**Goal**: Establish core infrastructure, schemas, and tooling.

### Stage 1.1: Project Setup
- [x] Architecture documentation
- [ ] Repository initialization
- [ ] Package.json and TypeScript configuration
- [ ] Development environment setup
- [ ] Git workflow and branching strategy

### Stage 1.2: Schema Definitions
- [ ] Define JSON Schema for Movie entity (v1)
- [ ] Define JSON Schema for Series entity (v1)
- [ ] Define JSON Schema for Season entity (v1)
- [ ] Define JSON Schema for Episode entity (v1)
- [ ] Define JSON Schema for Person entity (v1)
- [ ] Schema documentation and examples
- [ ] Schema versioning strategy

### Stage 1.3: Core Tooling
- [ ] `validate-repo.ts` – Schema validation tool
  - Validate individual JSON files
  - Validate entire repo structure
  - Report errors with file/line numbers
- [ ] `build-indexes.ts` – Index generation tool
  - Scan data directories
  - Extract summary fields
  - Generate sorted index.json files
- [ ] `create-year-repo.ts` – Repo scaffolding tool
  - Create standard directory structure
  - Initialize README and LICENSE
  - Set up GitHub Actions workflows
- [ ] Shared utilities and configuration
- [ ] CLI interface for all tools

### Stage 1.4: Initial Repositories
- [ ] Create `mmdb-schema-and-tools` repo
  - Populate with schemas
  - Add tooling scripts
  - Include architecture docs
  - Set up npm package
- [ ] Create `mmdb-people` repo
  - Standard directory structure
  - Empty index.json
  - GitHub Actions workflow
- [ ] Create `mmdb-meta` repo
  - repos.json registry
  - Main README
- [ ] Create `mmdb-2010` test repo
  - Standard structure
  - Ready for data

### Stage 1.5: CI/CD Workflows
- [ ] Validation workflow (runs on PR)
  - Checkout code
  - Install dependencies
  - Run validation
  - Check index consistency
- [ ] Index building workflow
  - Auto-generate indexes
  - Commit if needed
- [ ] Workflow templates for all repos
- [ ] Branch protection rules

### Stage 1.6: Documentation
- [ ] README for each repo
- [ ] Contribution guide
- [ ] Schema documentation
- [ ] Data sourcing guidelines
- [ ] Code of conduct

### Stage 1.7: Initial Data Seeding
- [ ] Manually add 5-10 movies to `mmdb-2010`
- [ ] Add corresponding people records
- [ ] Validate end-to-end workflow
- [ ] Test PR process
- [ ] Verify CI/CD pipelines

**Phase 1 Success Criteria**:
- ✅ All schemas defined and documented
- ✅ Validation and indexing tools working
- ✅ 4 repos created with proper structure
- ✅ CI/CD workflows passing
- ✅ At least 5 titles successfully added
- ✅ Documentation complete

---

## Phase 2: Local Ingestion

**Goal**: Automate data import from Wikidata using local scripts.

### Stage 2.1: Wikidata Integration
- [x] SPARQL query builder
  - Backlog query (historical data)
  - Recent query (updates)
  - Rate limiting and throttling
- [x] Wikidata entity parser
  - Extract movie data
  - [x] Extract person data (cast, directors, producers)
  - [x] Extract series data
- [x] External ID mapping (Wikidata, IMDb, TMDB)

### Stage 2.2: Data Normalization
- [x] MMDB ID generator
  - Slug generation
  - ID uniqueness validation
- [x] Entity normalizer (movies)
  - Map Wikidata to MMDB schema
  - Handle missing fields
  - Validate output
- [x] Duplicate detection (GitHub-based)
  - Check master branch for existing entities
  - Check pending PRs for in-flight entities
  - Collect exactly N unique entities per run

### Stage 2.3: GitHub Integration
- [x] Octokit setup and authentication
- [x] Branch creation via API
- [x] File creation/update via API
- [x] PR creation with labels
- [x] Batch operations (multiple files per PR)
- [x] Scan pending PRs for duplicate prevention

### Stage 2.4: Ingestion Script (Movies)
- [x] GitHub-based state management
  - Derive state from master branch
  - Scan open PRs for pending entities
  - No local state files required
- [x] Main ingestion loop
  - Fetch from Wikidata
  - Normalize entities
  - Validate output
  - Create GitHub PRs
- [x] Error handling and logging
- [x] CLI interface with options

### Stage 2.5: Testing & Refinement
- [x] Unit tests (43 tests, all passing)
  - ID generator tests (10)
  - Normalizer tests - movies (3)
  - Normalizer tests - series (3)
  - Wikidata client tests - movies (4)
  - Wikidata client tests - people (7)
  - Wikidata client tests - series (6)
  - Duplicate prevention tests (10)
- [x] Documentation updates
  - Ingestion guide
  - Testing guide

### Stage 2.6: Extend to Other Entity Types
- [x] People ingestion
  - [x] SPARQL query for people (movie-based approach)
  - [x] Person normalizer
  - [x] Duplicate prevention (GitHub-based, master only)
  - [x] Route to mmdb-people repo
  - [x] Unit tests (7 tests)
  - [x] Fixed Wikidata label issue (rdfs:label filtering)
  - [x] Query cast (P161), directors (P57), producers (P162)
- [x] Series ingestion
  - [x] SPARQL query for series (year-based)
  - [x] Series normalizer
  - [x] Duplicate prevention (GitHub-based, master only)
  - [x] Route to year repos
  - [x] Unit tests (9 tests: 6 wikidata-client, 3 normalizer)

**Phase 2 Success Criteria**:
- ✅ Ingestion script runs successfully (movies)
- ✅ Can import 100 titles/day
- ✅ PRs are well-formed and valid
- ✅ State derived from GitHub (no local files)
- ✅ Duplicate prevention working (master + pending PRs)
- ✅ Error handling is robust
- ✅ Documentation for running locally
- ✅ People ingestion implemented
- [ ] Series ingestion implemented

---

## Phase 3: Serverless Ingestion

**Goal**: Deploy ingestion to Firebase Cloud Functions for automated daily runs.

### Stage 3.1: Firebase Setup
- [ ] Create Firebase project
- [ ] Configure Firestore database
- [ ] Set up Cloud Scheduler
- [ ] Configure authentication and secrets

### Stage 3.2: Cloud Function Development
- [ ] Adapt ingestion script for Cloud Functions
- [ ] Migrate state from JSON to Firestore
- [ ] Add Cloud Scheduler trigger
- [ ] Environment configuration
- [ ] Logging and monitoring

### Stage 3.3: Deployment
- [ ] Deploy to Firebase
- [ ] Configure Cloud Scheduler job
- [ ] Test end-to-end
- [ ] Monitor first week of runs
- [ ] Cost tracking

### Stage 3.4: Monitoring & Optimization
- [ ] Set up alerts for failures
- [ ] Dashboard for ingestion metrics
- [ ] Optimize for cost
- [ ] Tune batch sizes
- [ ] Documentation updates

**Phase 3 Success Criteria**:
- ✅ Cloud Function deployed and running
- ✅ Daily ingestion working automatically
- ✅ Cost stays within free tier
- ✅ Monitoring and alerts configured
- ✅ Documentation for deployment

---

## Key Design Decisions

### GitHub-Based State Management (Phase 2)

**Problem**: How to prevent duplicate PRs when running ingestion multiple times?

**Solution**: Derive state from GitHub instead of local files.

**Implementation**:
1. **Check master branch**: Read `data/movies/index.json` for existing entities
2. **Scan open PRs**: Fetch all open PRs and extract entity IDs from files
3. **Skip duplicates**: Don't create PRs for entities already in master or pending PRs
4. **Collect exactly N**: Fetch 3x limit from Wikidata, filter duplicates, collect exactly N unique entities

**Benefits**:
- ✅ No local state files to maintain
- ✅ Works from any machine
- ✅ Automatically syncs when PRs are merged
- ✅ No manual cleanup needed

**Replication**: This approach must be replicated for people and series ingestion (Stage 2.6).

---

## Future Phases (Post-Launch)

### Phase 4: Community & Scale
- [ ] Public announcement
- [ ] Contribution guidelines refinement
- [ ] Community moderation tools
- [ ] Additional year repos (1950-2025)
- [ ] Data quality improvements

### Phase 5: Advanced Features
- [ ] Taxonomy repo (genres, languages, countries)
- [ ] Ratings and certifications
- [ ] Streaming availability (separate project)
- [ ] API examples and templates
- [ ] Consumer documentation

### Phase 6: Ecosystem
- [ ] Official website/docs site
- [ ] Example API implementations
- [ ] Client libraries
- [ ] Data quality dashboard
- [ ] Community tools and integrations

---

## Dependencies & Blockers

### Phase 1 → Phase 2
- Must have: Working validation and indexing tools
- Must have: At least one year repo with test data
- Must have: GitHub Actions workflows validated

### Phase 2 → Phase 3
- Must have: Ingestion script working locally
- Must have: 100+ titles successfully imported
- Must have: PR quality validated by maintainers

### Phase 3 → Phase 4
- Must have: Automated ingestion running for 1+ week
- Must have: Cost confirmed within budget
- Must have: No critical bugs

---

## Risk Management

### Technical Risks
- **GitHub rate limits**: Mitigated by batching and rate limiting
- **Wikidata availability**: Mitigated by retry logic and backoff
- **Schema evolution**: Mitigated by versioning strategy
- **Data quality**: Mitigated by validation and manual review

### Operational Risks
- **Cost overruns**: Mitigated by free tier usage and monitoring
- **Maintenance burden**: Mitigated by automation and CI/CD
- **Community management**: Mitigated by clear guidelines and moderation

### Project Risks
- **Scope creep**: Mitigated by phased approach and clear success criteria
- **Burnout**: Mitigated by sustainable pace and automation
- **Adoption**: Mitigated by clear documentation and examples

---

## Success Metrics

### Phase 1
- 4 repos created
- 5+ titles added manually
- 100% CI/CD pass rate

### Phase 2
- 1000+ titles imported
- <1% PR rejection rate
- Ingestion runs successfully 90%+ of the time

### Phase 3
- 30+ consecutive days of automated ingestion
- Cost ≤10 MXN/month
- Zero manual intervention needed

### Long-term
- 10,000+ titles in database
- 10+ external consumers
- Active community contributions
