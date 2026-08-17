# MMDB Known Issues & Bugs

> Bug tracking and issue resolution for the Mimir Media Database project.

**Last Updated**: 2026-08-16

---

## Active Issues

### Issue #1: Duplicate file collision during ingestion (SHA not supplied)

**Status**: 🟢 Minor

**Reported**: 2026-08-14

**Component**: Ingestion

**Description**:
When the ingestion pipeline tries to add a movie/person that already exists in the target branch, the GitHub Contents API returns `"sha" wasn't supplied`. The code assumes file creation (no SHA needed), but existing files require the current SHA for updates.

**Impact**:
- Harmless for actual duplicates (item already exists, error is cosmetic)
- Potential silent data loss if two different items normalize to the same slug (e.g., same title, same year but different films)
- Failed items are logged but not retried — offset advances past them

**Workaround**:
None needed for duplicates. For genuine slug collisions, manual ingestion would be required.

**Future fix considerations**:
- Add pre-commit check: query the repo for existing file before attempting create
- Or: catch the 422 error, fetch the file SHA, and retry as an update (upsert pattern)
- Or: add dedup lookup against the existing index before adding to PR

---

## Resolved Issues

### Issue #2: Offset-based pagination gap in current-year ingestion

**Status**: ✅ Resolved

**Reported**: 2026-08-14

**Component**: Ingestion

**Description**:
The current-year ingestion job used offset pagination to incrementally fetch new films. If Wikidata added a film to a position already passed by the offset, that film would never be ingested.

**Impact**:
- Missing films for the current year
- No automatic recovery — gaps were permanent until manually re-scanned

**Resolution**:
Replaced offset pagination with a dual-pass strategy:
- **Pass A**: Full dedup scan — fetches all titles for the current year and deduplicates against existing repos
- **Pass B**: 48-hour recently-modified catch-up — catches films that received labels or date corrections

The `rescan-year.mjs` script was also created for manual backfill of historical years affected by this gap.

**Resolved**: 2026-08-16

---

### Issue #3: Q-ID entries polluting year repos

**Status**: ✅ Resolved

**Reported**: 2026-08-14

**Component**: Ingestion

**Description**:
Wikidata entities without human-readable labels were being ingested with their Q-ID (e.g., `Q140513842`) as the title. This produced files like `q140513842-2026.json` with no useful metadata.

**Impact**:
- Polluted repos with meaningless entries
- Inflated movie counts
- Entries could never be matched to real films without external IDs

**Resolution**:
Three-layer fix:
1. **Q-ID rejection filter** — Titles matching `/^Q\d+$/i` are rejected at ingestion time
2. **Non-Latin title filter** — `isUsableTitle()` rejects titles that produce <2 Latin characters after normalization
3. **Multi-language labels** — SPARQL queries now use 12 languages (`en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru`) reducing Q-ID entries by ~90%
4. **Weekly cleanup cron** — `mmdbCleanupQIds` function removes entries that slipped through before the filters existed
5. **Manual cleanup script** — `cleanup-qids.mjs` for on-demand repo cleaning

**Resolved**: 2026-08-16

---

## Issue Template

When adding issues, use this format:

### Issue #N: [Title]

**Status**: 🔴 Critical / 🟡 Important / 🟢 Minor / ✅ Resolved

**Reported**: YYYY-MM-DD

**Component**: Schema / Tooling / CI/CD / Documentation / Ingestion

**Description**:
Brief description of the issue.

**Steps to Reproduce**:
1. Step one
2. Step two
3. Expected vs actual behavior

**Impact**:
Who/what is affected by this issue.

**Workaround**:
Temporary solution if available.

**Resolution**:
How the issue was fixed (for resolved issues).

**Resolved**: YYYY-MM-DD (for resolved issues)

---

## Known Limitations

### Phase 2 (Current)
- Non-Latin titles are rejected rather than transliterated (future improvement)
- Q-ID entries with external IDs are logged but not auto-resolved (needs label re-fetching)
- Cleanup only covers last 3 year repos per run (configurable via `CLEANUP_YEAR_RANGE`)

### Technical Debt
None at this time.

---

## Future Considerations

### Schema Evolution
- Need strategy for handling schema migrations
- Consider backward compatibility requirements
- Plan for deprecation process

### Performance
- Index generation may be slow for large repos (1000+ titles)
- Consider incremental index updates

### Data Quality
- Need automated duplicate detection
- Consider data quality scoring
- Plan for community moderation tools

---

## Reporting Issues

### For Contributors
1. Check if issue already exists
2. Use issue template above
3. Add to this document via PR
4. Label appropriately

### For Users
1. Open GitHub issue in relevant repo
2. Provide detailed reproduction steps
3. Include schema version and tool versions
4. Tag with appropriate labels

---

## Issue Categories

### Critical (🔴)
- Data loss or corruption
- Security vulnerabilities
- Complete feature breakage
- CI/CD pipeline failures

### Important (🟡)
- Partial feature breakage
- Performance degradation
- Incorrect validation
- Documentation errors

### Minor (🟢)
- Cosmetic issues
- Minor inconsistencies
- Enhancement requests
- Nice-to-have features

---

## Notes

This document tracks issues specific to the MMDB project infrastructure. Data quality issues (incorrect movie info, etc.) should be handled through the normal PR process, not tracked here.
