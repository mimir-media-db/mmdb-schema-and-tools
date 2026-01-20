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
- [ ] SPARQL query builder
  - Backlog query (historical data)
  - Recent query (updates)
  - Rate limiting and throttling
- [ ] Wikidata entity parser
  - Extract movie data
  - Extract series/season/episode data
  - Extract person data
- [ ] External ID mapping (Wikidata, IMDb, TMDB)

### Stage 2.2: Data Normalization
- [ ] MMDB ID generator
  - Slug generation
  - ID uniqueness validation
- [ ] Entity normalizer
  - Map Wikidata to MMDB schema
  - Handle missing fields
  - Validate output
- [ ] Duplicate detection

### Stage 2.3: GitHub Integration
- [ ] Octokit setup and authentication
- [ ] Branch creation via API
- [ ] File creation/update via API
- [ ] PR creation with labels
- [ ] Batch operations (multiple files per PR)

### Stage 2.4: Ingestion Script
- [ ] State management (local JSON file)
  - Track backlog offset
  - Track last recent timestamp
- [ ] Main ingestion loop
  - Fetch from Wikidata
  - Normalize entities
  - Validate output
  - Create GitHub PRs
  - Update state
- [ ] Error handling and logging
- [ ] CLI interface with options

### Stage 2.5: Testing & Refinement
- [ ] Test with 100 titles
- [ ] Verify PR quality
- [ ] Tune rate limits
- [ ] Handle edge cases
- [ ] Documentation updates

**Phase 2 Success Criteria**:
- ✅ Ingestion script runs successfully
- ✅ Can import 100 titles/day
- ✅ PRs are well-formed and valid
- ✅ State persists between runs
- ✅ Error handling is robust
- ✅ Documentation for running locally

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
