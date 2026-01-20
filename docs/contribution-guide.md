# MMDB Contribution Guide

> How to contribute to the Mimir Media Database project.

**Status**: Draft (will be finalized after Phase 1 tooling is complete)

---

## Welcome!

Thank you for your interest in contributing to MMDB! This guide will help you understand how to add or improve data in the database.

## Before You Start

### Prerequisites

- GitHub account
- Basic knowledge of JSON
- Familiarity with Git and pull requests
- Node.js 18+ installed (for running validation tools)

### Understanding MMDB

MMDB is not a traditional database with an API. It's a collection of JSON files in GitHub repositories. Changes are made through pull requests, and all data is validated automatically.

Read the [Architecture documentation](architecture.md) to understand the data model.

---

## Types of Contributions

### 1. Adding New Titles

Add movies, series, or documentaries that don't exist in MMDB yet.

### 2. Improving Existing Data

Fix errors, add missing information, or update outdated data.

### 3. Adding People

Add actors, directors, writers, and other crew members.

### 4. Tooling & Infrastructure

Improve validation tools, CI/CD workflows, or documentation.

---

## Contribution Workflow

### Step 1: Fork the Repository

Fork the appropriate repository:
- **Movies/Series**: Fork the year repo (e.g., `mmdb-2010`)
- **People**: Fork `mmdb-people`
- **Tools**: Fork `mmdb-schema-and-tools`

### Step 2: Clone Your Fork

```bash
git clone https://github.com/YOUR_USERNAME/mmdb-2010.git
cd mmdb-2010
```

### Step 3: Create a Branch

```bash
git checkout -b add-inception
```

Use descriptive branch names:
- `add-inception` (for new titles)
- `fix-inception-runtime` (for corrections)
- `add-christopher-nolan` (for new people)

### Step 4: Make Your Changes

#### Adding a Movie

1. Create a new JSON file in `data/movies/`:

```bash
touch data/movies/inception-2010.json
```

2. Fill in the data following the schema:

```json
{
  "schema_version": 1,
  "id": "m_inception_2010",
  "title": "Inception",
  "original_title": "Inception",
  "year": 2010,
  "release_date": "2010-07-16",
  "type": "movie",
  "runtime_minutes": 148,
  "original_language": "en",
  "countries": ["US", "GB"],
  "summary": "A thief who steals corporate secrets through dream-sharing technology is given the inverse task of planting an idea into the mind of a C.E.O.",
  "genres": ["science fiction", "action", "thriller"],
  "directors": ["p_christopher_nolan"],
  "writers": ["p_christopher_nolan"],
  "cast": [
    "p_leonardo_dicaprio",
    "p_joseph_gordon_levitt",
    "p_ellen_page",
    "p_tom_hardy",
    "p_marion_cotillard"
  ],
  "external_ids": {
    "wikidata": "Q43320",
    "imdb": "tt1375666",
    "tmdb": 27205
  },
  "last_updated": "2026-01-19"
}
```

#### Adding a Person

1. Create a new JSON file in `data/people/`:

```bash
touch data/people/p_christopher_nolan.json
```

2. Fill in the data:

```json
{
  "schema_version": 1,
  "id": "p_christopher_nolan",
  "name": "Christopher Nolan",
  "birth_year": 1970,
  "death_year": null,
  "also_known_as": ["Chris Nolan"],
  "external_ids": {
    "wikidata": "Q25191",
    "imdb": "nm0634240"
  },
  "last_updated": "2026-01-19"
}
```

### Step 5: Validate Your Changes

```bash
# Install dependencies (first time only)
cd ../mmdb-schema-and-tools
npm install

# Run validation
npm run validate -- --repo-path=../mmdb-2010

# Build indexes
npm run build-indexes -- --repo-path=../mmdb-2010
```

Fix any validation errors before proceeding.

### Step 6: Commit Your Changes

```bash
cd ../mmdb-2010
git add data/movies/inception-2010.json
git add data/movies/index.json  # Updated by build-indexes
git commit -m "Add Inception (2010)"
```

**Commit message guidelines**:
- Use present tense: "Add", "Fix", "Update"
- Be specific: "Add Inception (2010)" not "Add movie"
- Reference issues if applicable: "Fix #123: Correct runtime"

### Step 7: Push to Your Fork

```bash
git push origin add-inception
```

### Step 8: Open a Pull Request

1. Go to your fork on GitHub
2. Click "Compare & pull request"
3. Fill in the PR template:
   - **Title**: Clear, descriptive (e.g., "Add Inception (2010)")
   - **Description**: What you added/changed and why
   - **Checklist**: Confirm validation passed
4. Submit the PR

### Step 9: Respond to Feedback

Maintainers may request changes:
- Fix validation errors
- Add missing information
- Correct formatting
- Provide sources for data

Make changes in your branch and push again. The PR will update automatically.

---

## Data Quality Guidelines

### Required Information

**For Movies**:
- Title and year (minimum)
- Original title if different
- Runtime if available
- At least one external ID (Wikidata, IMDb, or TMDB)

**For People**:
- Name (minimum)
- Birth year if available
- At least one external ID

### Data Sources

Acceptable sources (in order of preference):
1. **Wikidata** – Structured, community-verified
2. **IMDb** – Comprehensive, but check accuracy
3. **TMDB** – Good for recent titles
4. **Official sources** – Studio websites, press releases
5. **Wikipedia** – Use with caution, verify facts

**Never use**:
- Unverified fan sites
- Social media posts
- Personal knowledge without verification

### Data Accuracy

- **Verify facts** from multiple sources
- **Cite sources** in PR description
- **Be conservative** – if unsure, leave field empty
- **Use original titles** for non-English films
- **ISO codes** for languages and countries

### What NOT to Include

- **Opinions** – No reviews or ratings
- **Spoilers** – Keep summaries spoiler-free
- **Speculation** – Only confirmed information
- **Personal data** – Respect privacy
- **Copyrighted content** – No plot details beyond fair use

---

## ID and Naming Conventions

### Creating IDs

**Movie IDs**:
```
m_<slug>_<year>
```
Example: `m_the_dark_knight_2008`

**Series IDs**:
```
s_<slug>
```
Example: `s_breaking_bad`

**Person IDs**:
```
p_<slug>
```
Example: `p_christopher_nolan`

### Slug Rules

1. Convert to lowercase
2. Replace spaces with underscores
3. Remove special characters
4. Transliterate non-ASCII (é → e, ñ → n)
5. Remove articles at the start (The, A, An)

**Examples**:
- "The Dark Knight" → `the_dark_knight`
- "Amélie" → `amelie`
- "¡Three Amigos!" → `three_amigos`

### File Naming

**Movies**: `<slug>-<year>.json`
- Example: `inception-2010.json`

**People**: `<id>.json`
- Example: `p_christopher_nolan.json`

**Series**: `<slug>/meta.json`
- Example: `breaking-bad/meta.json`

---

## Common Mistakes

### ❌ Don't Do This

```json
{
  "id": "inception",  // Missing year and prefix
  "title": "Inception (2010)",  // Don't include year in title
  "year": "2010",  // Should be number, not string
  "runtime": "2h 28m",  // Should be minutes as number
  "genres": "sci-fi, action"  // Should be array
}
```

### ✅ Do This

```json
{
  "schema_version": 1,
  "id": "m_inception_2010",
  "title": "Inception",
  "year": 2010,
  "runtime_minutes": 148,
  "genres": ["science fiction", "action"]
}
```

---

## Advanced Topics

### Adding Series with Episodes

Series are more complex. See [Architecture documentation](architecture.md) for the full structure.

Basic steps:
1. Create series `meta.json`
2. Create season directories and `meta.json` files
3. Create episode JSON files
4. Ensure all IDs are consistent

### Handling Duplicates

If a title already exists:
1. Check if it's truly a duplicate (same year, same title)
2. If duplicate, improve existing entry instead
3. If different (remake, different year), create new entry

### Deprecating Incorrect Entries

Don't delete incorrect entries. Instead:
1. Add `"deprecated": true`
2. Add `"deprecation_reason": "Explanation"`
3. Create correct entry if needed

---

## Getting Help

### Questions?

- **Documentation**: Check [Architecture](architecture.md) and [Dev Plan](dev-plan.md)
- **GitHub Discussions**: [Coming soon]
- **Discord**: [Coming soon]

### Found a Bug?

Report in [bugs.md](bugs.md) or open a GitHub issue.

---

## Code of Conduct

### Be Respectful

- Treat all contributors with respect
- Assume good intentions
- Provide constructive feedback
- Welcome newcomers

### Be Collaborative

- Respond to feedback promptly
- Help others when you can
- Share knowledge and sources
- Credit others' work

### Be Honest

- Verify your data
- Cite your sources
- Admit mistakes
- Don't plagiarize

---

## Recognition

All contributors are recognized in:
- Git commit history
- GitHub contributor graphs
- Annual contributor acknowledgments (coming soon)

---

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (TBD – likely MIT for code, CC0 for data).

---

## Thank You!

Every contribution, no matter how small, helps make MMDB better. Thank you for being part of this project!
