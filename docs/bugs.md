# MMDB Known Issues & Bugs

> Bug tracking and issue resolution for the Mimir Media Database project.

**Last Updated**: 2026-01-19

---

## Active Issues

No active issues at this time.

---

## Resolved Issues

No resolved issues yet.

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

### Phase 1 (Current)
- No automated ingestion yet (by design)
- Manual data entry only
- Limited to one test year repo (mmdb-2010)

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
