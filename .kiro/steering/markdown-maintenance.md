---
meta:
  id: "markdown-maintenance"
  title: "Markdown Maintenance for AI Context"
  author: "cairel-core"
  version: "1.0.0"
  category: "general"
  tags: ["documentation", "markdown", "ai-context", "maintenance"]
  ai-tools: ["kiro-cli", "amazon-q-developer"]
  last-updated: "2026-01-16"
  description: "Maintain accurate line numbers and navigation in markdown files for efficient AI context retrieval."
  always-include: false
  conditions:
    project-types:
      - ui
      - backend
      - cli
      - library
      - fullstack
---

# Markdown Maintenance for AI Context

**Purpose**: Ensure all .md files remain AI-friendly with accurate indices, line numbers, and navigation for efficient context retrieval.

**Applies To**: All projects with documentation

---

## 🚨 Critical Rules

### Rule 1: Update Indices After Every Modification

**Every time you create or modify a .md file, you MUST update its corresponding navigation and line numbers.**

Line numbers in indices become outdated when files are modified. Always verify and update.

### Rule 2: Never Make False Line Number Claims

**ALWAYS verify line numbers are accurate before referencing them in navigation tables or section markers.**

Outdated line numbers break AI context retrieval and waste tokens.

---

## 📋 Standard Rules

### When Creating New .md File

1. **Determine if indexing is needed**:
   - Files < 100 lines: No index needed
   - Files 100-300 lines: Add internal navigation table
   - Files > 300 lines: Add internal navigation + consider separate index file

2. **Add navigation table** at the top (lines 5-20):
   ```markdown
   ## 📍 Navigation
   | Section | Jump Link | Lines | Priority |
   |---------|-----------|-------|----------|
   | Section Name | [→ Jump](#section) | X-Y | HIGH |
   ```

3. **Add section markers** throughout document:
   ```markdown
   <!-- SECTION: name | LINES: X-Y | PRIORITY: HIGH -->
   ## Section Title
   ...content...
   <!-- END SECTION: name -->
   ```

4. **Create separate index file** if document > 500 lines:
   - Name: `{MAIN-NAME}-INDEX.md`
   - Contains: Quick navigation, line ranges, summaries

### When Modifying Existing .md File

1. **Count lines** after modification:
   ```bash
   wc -l filename.md
   ```

2. **Identify what changed**:
   - Added content? → Update all line numbers below insertion
   - Deleted content? → Update all line numbers below deletion
   - Modified content? → Check if section boundaries changed

3. **Update navigation table** with new line numbers

4. **Update section markers** with new line ranges

5. **Update corresponding index file** (if exists)

6. **Verify all links** still point to correct sections

### When Deleting Content from .md File

1. **Calculate line shift**: How many lines were deleted?

2. **Update all line numbers** below deletion point:
   - Navigation table
   - Section markers
   - Index file (if exists)

3. **Verify section boundaries** are still accurate

---

## ✅ Checklist

### Creating New Documentation

- [ ] Determine if file needs navigation (>100 lines)
- [ ] Add navigation table at top
- [ ] Add section markers throughout
- [ ] Create separate index if >500 lines
- [ ] Verify all line numbers are accurate

### Modifying Existing Documentation

- [ ] Count lines after modification
- [ ] Calculate line shift (added/removed lines)
- [ ] Update navigation table
- [ ] Update section markers
- [ ] Update index file (if exists)
- [ ] Verify all links work
- [ ] Test line number accuracy

### Before Committing Changes

- [ ] All navigation tables updated
- [ ] All section markers updated
- [ ] All index files updated
- [ ] Line numbers verified accurate
- [ ] Links tested and working

---

## 🔍 Examples

### Good: Accurate Navigation Table

```markdown
## 📍 Navigation
| Section | Jump Link | Lines | Priority |
|---------|-----------|-------|----------|
| Setup | [→ Jump](#setup) | 20-45 | HIGH |
| Usage | [→ Jump](#usage) | 47-89 | MEDIUM |
| API | [→ Jump](#api) | 91-150 | HIGH |

<!-- SECTION: setup | LINES: 20-45 | PRIORITY: HIGH -->
## Setup
...content from lines 20-45...
<!-- END SECTION: setup -->
```

### Bad: Outdated Line Numbers

```markdown
## 📍 Navigation
| Section | Jump Link | Lines | Priority |
|---------|-----------|-------|----------|
| Setup | [→ Jump](#setup) | 20-45 | HIGH |  ← Wrong! Actually 20-55 now

<!-- SECTION: setup | LINES: 20-45 | PRIORITY: HIGH -->  ← Wrong!
## Setup
...content actually spans 20-55 after adding 10 lines...
<!-- END SECTION: setup -->
```

### Line Number Shift Calculation

**Example: Adding 10 lines at line 50**

```markdown
Before:
- Section A: Lines 20-45
- Section B: Lines 50-80  ← Adding 10 lines here
- Section C: Lines 85-120

After:
- Section A: Lines 20-45 (unchanged)
- Section B: Lines 50-90 (was 50-80, now +10)
- Section C: Lines 95-130 (was 85-120, now +10)
```

---

## 🚫 Common Mistakes

### Mistake 1: Forgetting to Update Sections Below

**Problem**: Added lines to one section, didn't update sections below

**Fix**: Update ALL line numbers below the insertion/deletion point

### Mistake 2: Only Updating Navigation Table

**Problem**: Updated navigation but forgot section markers

**Fix**: Update both navigation table AND section markers

### Mistake 3: Not Verifying Accuracy

**Problem**: Updated line numbers but didn't verify they're correct

**Fix**: Use `wc -l` or editor line counter to verify

### Mistake 4: Breaking Anchor Links

**Problem**: Changed section heading, broke navigation links

**Fix**: Update both heading and anchor in navigation table

---

## 🤖 AI Self-Check Protocol

### Before Completing Task

Ask yourself:

1. **Did I modify any .md files?**
   - If yes → Continue to next question
   - If no → No action needed

2. **How many lines did I add/remove?**
   - Calculate line shift
   - Identify affected sections

3. **Did I update the navigation table?**
   - If no → Update it now
   - If yes → Verify accuracy

4. **Did I update section markers?**
   - If no → Update them now
   - If yes → Verify line ranges

5. **Does this file have a separate index?**
   - If yes → Update index file
   - If no → No action needed

6. **Are all line numbers accurate?**
   - Verify with line counter
   - Test a few line reads

### Verification Process

```bash
# 1. Count total lines
wc -l filename.md

# 2. Verify section boundaries match navigation
# Read lines from navigation table and check content

# 3. Test anchor links (manual)
# Click each link and verify it jumps correctly
```

---

## 📊 Maintenance Triggers

### Always Update When:
- Adding new sections
- Deleting sections
- Adding/removing significant content (>5 lines)
- Restructuring document
- Completing project phases

### Consider Updating When:
- Minor content edits (<5 lines)
- Fixing typos that span multiple lines
- Adding examples or code blocks

### No Update Needed When:
- Fixing single-line typos
- Updating timestamps
- Minor wording changes (same line count)

---

## 🎯 Quick Reference

| Action | Required Updates |
|--------|------------------|
| Create new .md | Navigation table + section markers |
| Add content | All line numbers below insertion |
| Delete content | All line numbers below deletion |
| Modify content | Check if line count changed |
| Restructure | All navigation + section markers |

**Golden Rule**: If you touch a .md file, update its navigation and verify line numbers.

**Why it matters**: Outdated line numbers break AI context retrieval and waste tokens.
