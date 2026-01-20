---
meta:
  id: context-retrieval
  title: Context Retrieval & Token Optimization
  description: >-
    Minimize token usage through efficient context loading strategies using
    index files and targeted reads.
  author: cairel-core
  version: 1.0.0
  category: general
  tags:
    - context
    - optimization
    - efficiency
    - token-management
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  always-include: true
---

# Context Retrieval & Token Optimization

**Purpose**: Minimize token usage while maintaining full project understanding through efficient context loading strategies.

**Applies To**: All project types

---

## 🚨 Critical Rules

### 1. Always Read Index Files First

**NEVER read full documentation files without checking for index files first.**

- Look for `*-INDEX.md`, `INDEX.md`, or navigation tables at file start
- Read index files to understand structure before reading content
- Use line numbers from indices for targeted reads
- **Token Savings**: 80-90% compared to reading full files

### 2. Use Line Numbers for Targeted Reads

**NEVER read entire files when you need specific sections.**

```typescript
// ✅ CORRECT - Targeted read
fs_read({
  mode: "Line",
  path: "docs/api.md",
  start_line: 100,
  end_line: 150
})

// ❌ WRONG - Reading full file
fs_read({
  mode: "Line",
  path: "docs/api.md"
})
```

### 3. Respect Priority Levels

**Read sections based on priority markers:**

- **CRITICAL**: Always read (security, privacy, compliance)
- **HIGH**: Read when relevant to current work
- **MEDIUM**: Read when making related decisions
- **LOW**: Read only if specifically needed

---

## 📋 Standard Rules

### Session Start Protocol

**Minimal context loading at session start:**

1. Read index files or navigation tables (~150-200 tokens)
2. Read "Current Status" section (~50-100 tokens)
3. Read "Session Context" or "Overview" (~100-150 tokens)

**Total Budget**: 300-400 tokens (vs 2000-3000+ for all files)

### Navigation Markers

**Recognize and use standard section markers:**

```markdown
<!-- SECTION: section-name | LINES: X-Y | PRIORITY: HIGH -->
## Section Title
...content...
<!-- END SECTION: section-name -->
```

**Use navigation tables to find sections:**

```markdown
| Section | Lines | Priority | Summary |
|---------|-------|----------|---------|
| API Docs | 20-45 | HIGH | REST endpoints |
```

### Search Strategy

**Use search mode for specific features:**

```typescript
fs_read({
  mode: "Search",
  path: "docs/features.md",
  pattern: "authentication",
  context_lines: 5
})
```

---

## ✅ Checklist

Before reading any documentation:

- [ ] Checked for index files or navigation tables
- [ ] Identified priority level of needed information
- [ ] Determined minimum sections needed
- [ ] Using line numbers for targeted reads
- [ ] Avoiding reading low-priority sections

During active development:

- [ ] Reading only current phase/stage details
- [ ] Using search for specific features
- [ ] Not re-reading same sections
- [ ] Staying within token budget

---

## 🔍 Examples

### ✅ Good: Efficient Session Start

```typescript
// 1. Read index file
fs_read({ mode: "Line", path: "docs/INDEX.md" })

// 2. Read current status section (lines from index)
fs_read({ 
  mode: "Line", 
  path: "docs/progress.md",
  start_line: 50,
  end_line: 100
})

// Total: ~300 tokens
```

### ❌ Bad: Reading Everything

```typescript
// Reading all documentation at start
fs_read({ mode: "Line", path: "docs/api.md" })
fs_read({ mode: "Line", path: "docs/architecture.md" })
fs_read({ mode: "Line", path: "docs/features.md" })

// Total: 2000+ tokens
```

---

## 🚫 Common Mistakes

### Mistake 1: Reading Full Files Without Index

**Problem**: Reading 800-line document when only need 50 lines

**Solution**: Read index file, use line numbers for specific section

**Savings**: 75-85%

### Mistake 2: Reading All Documentation at Start

**Problem**: Loading all .md files at session start

**Solution**: Read only index files and current status

**Savings**: 85-90%

### Mistake 3: Re-reading Same Sections

**Problem**: Reading same section multiple times in one session

**Solution**: Read once, reference from memory

**Savings**: 100% on subsequent reads

---

## 📊 Token Budget Guidelines

| Activity | Budget | What to Read |
|----------|--------|--------------|
| Session Start | 300-400 | Index files, current status, overview |
| Active Development | 500-700 | Session start + current phase details |
| New Phase | 700-900 | Session start + previous phase + next phase |
| Maximum | 1500 | Only when absolutely necessary |

---

## 🤖 AI Self-Check Protocol

**Before starting any task:**

1. Have I read the index files?
2. Do I know the current project state?
3. Do I understand the immediate goal?
4. Am I reading the minimum necessary?

**After completing any task:**

1. Did I read efficiently?
2. Can I summarize without re-reading?
3. Did I stay within token budget?
