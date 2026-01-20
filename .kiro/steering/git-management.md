---
meta:
  id: git-management
  title: Git Repository Management
  author: cairel-core
  version: 1.0.0
  category: git
  tags:
    - git
    - version-control
    - commits
    - workflow
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  conditions:
    requires-git: true
  description: >-
    Manage git operations safely with human review for commits and protection
    against destructive commands.
---

# Git Repository Management

**Purpose**: Ensure safe and consistent git operations with human oversight.

**Applies To**: All projects using git

---

## 🚨 Critical Rules

### 1. Human Review Before Committing

**AI MUST show human before committing ANY changes:**

**Required Review Format:**
```
Repository: /path/to/repo
Files to commit:
  - src/auth.ts (modified)
  - tests/auth.test.ts (new)

Changes:
  +45 lines, -12 lines

Proposed commit message (28 chars):
  "Add JWT authentication logic"

Ready to commit? (y/n)
```

**Only after explicit approval:**
- Execute `git add` commands
- Execute `git commit` with approved message
- If push requested, execute `git push`

### 2. Commit Message Length Limit

**All commit messages MUST be ≤ 50 characters**

**Format**: Imperative mood, concise, descriptive

**✅ Good Examples:**
- `Add user authentication` (23 chars)
- `Fix memory leak in parser` (26 chars)
- `Update API documentation` (24 chars)
- `Remove deprecated endpoints` (28 chars)

**❌ Bad Examples:**
- `Added new feature for user authentication with JWT tokens` (59 chars - too long)
- `fixed bug` (9 chars - not descriptive)
- `Updated files` (13 chars - too vague)

### 3. Never Push Without Request

**NEVER push to remote unless explicitly requested by human**

**Before pushing:**
1. Confirm remote exists: `git remote -v`
2. Confirm branch: `git branch --show-current`
3. Show commits to be pushed: `git log origin/branch..HEAD --oneline`
4. Get explicit human approval

**If no remote configured:**
- Inform human that repo has no remote
- Do NOT attempt to push

---

## 📋 Standard Rules

### Pre-Commit Checks

**Before ANY git operation:**

1. Verify correct repository location
2. Check `git status` to see what will be committed
3. Verify commit message is ≤ 50 characters
4. Show human the review format
5. Wait for explicit approval

### Commit Workflow

```bash
# 1. Check status
git status

# 2. Show human what will be committed
git diff --stat

# 3. Get approval with proposed message

# 4. After approval
git add <files>
git commit -m "Approved message"

# 5. Only if push requested
git push
```

### Multi-Repository Projects

**For workspace projects with multiple repos:**

- Each repository is independent
- Always `cd` to specific repo before git operations
- Verify location with `git rev-parse --show-toplevel`
- Never commit changes from one repo to another

---

## ✅ Checklist

Before ANY git operation:

- [ ] Identified correct repository
- [ ] Changed to correct directory
- [ ] Verified location with `git rev-parse --show-toplevel`

Before committing:

- [ ] Checked `git status`
- [ ] Verified commit message is ≤ 50 characters
- [ ] Showed human the review format
- [ ] Received explicit approval

Before pushing:

- [ ] Human explicitly requested push
- [ ] Verified remote exists
- [ ] Showed commits to be pushed
- [ ] Received explicit approval

---

## 🔍 Examples

### ✅ Good: Proper Commit Workflow

```bash
# 1. Navigate to repo
cd /path/to/project

# 2. Check status
git status

# 3. Show human
# Repository: /path/to/project
# Files: src/auth.ts (modified)
# Changes: +30, -5
# Message (23 chars): "Add token validation"
# Approve? (y/n)

# 4. After approval
git add src/auth.ts
git commit -m "Add token validation"
```

### ✅ Good: Push Workflow

```bash
# Human says: "push the changes"

# 1. Check remote
git remote -v

# 2. Show commits to push
git log origin/main..HEAD --oneline

# 3. Show human:
# Remote: origin (git@github.com:user/repo.git)
# Branch: main
# Commits to push:
#   abc1234 Add token validation
# Approve push? (y/n)

# 4. After approval
git push origin main
```

### ❌ Bad: Committing Without Review

```bash
# WRONG - immediate commit
git add . && git commit -m "Fix bug"

# CORRECT - show human first
# 1. Show: git status, git diff --stat
# 2. Propose: commit message
# 3. Wait: for approval
# 4. Then: git add && git commit
```

### ❌ Bad: Long Commit Message

```bash
# WRONG - 67 characters
git commit -m "Added new authentication feature with JWT tokens and refresh logic"

# CORRECT - 28 characters
git commit -m "Add JWT authentication logic"
```

---

## 🚫 Common Mistakes

### Mistake 1: Committing Without Review

**Problem**: Executing git commands without showing human

**Solution**: Always show review format and wait for approval

### Mistake 2: Long Commit Messages

**Problem**: Commit messages exceeding 50 characters

**Solution**: Use imperative mood, be concise, focus on what changed

### Mistake 3: Pushing Without Request

**Problem**: Automatically pushing after commit

**Solution**: Only push when human explicitly requests it

### Mistake 4: Cross-Repo Commits

**Problem**: Trying to commit from parent directory in multi-repo projects

**Solution**: Always `cd` to specific repo before git operations

---

## 🤖 AI Self-Check Protocol

**Before executing ANY git command:**

1. Am I in the correct repository?
   - Run: `git rev-parse --show-toplevel`
   - Verify: matches intended repo path

2. Is my commit message ≤ 50 characters?
   - Count: characters in message
   - Verify: ≤ 50

3. Have I shown the human what I'm about to commit?
   - Show: repository, files, changes, message
   - Wait: for approval

4. Is the human asking me to push?
   - If no: DO NOT push
   - If yes: verify remote and get final approval

**Workflow Verification:**

```
Git Operation Request
        ↓
Am I in correct repo? ──NO──→ cd to correct repo
        ↓ YES
        ↓
Show human review format
        ↓
Wait for approval
        ↓
Approved? ──NO──→ Stop, ask for changes
        ↓ YES
        ↓
Execute git commands
        ↓
Push requested? ──NO──→ Done
        ↓ YES
        ↓
Show push details
        ↓
Wait for approval
        ↓
Execute push
```
