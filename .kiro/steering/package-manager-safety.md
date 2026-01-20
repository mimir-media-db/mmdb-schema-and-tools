---
meta:
  id: package-manager-safety
  title: Package Manager Safety & Standards
  author: cairel-core
  version: 1.0.0
  category: general
  tags:
    - package-manager
    - safety
    - npm
    - yarn
    - pnpm
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  conditions:
    languages:
      - typescript
      - javascript
  description: >-
    Prevent destructive package operations by blocking --force flags and
    requiring human approval.
---

# Package Manager Safety & Standards

**Purpose**: Prevent destructive operations and maintain consistent package management practices.

**Applies To**: All Node.js/JavaScript/TypeScript projects

---

## 🚨 Critical Rules

### 1. NEVER Use --force Flag Without Permission

**FORBIDDEN without explicit user consent:**

```bash
# ❌ NEVER do this without permission
npm install --force
yarn add package --force
firebase deploy --force
any-command --force
```

**REQUIRED before using --force:**

1. Explain what --force does
2. Explain the risks and consequences
3. Request explicit permission
4. Wait for confirmation
5. Only then execute with --force

**Why**: `--force` flags bypass safety checks and can cause IRREVERSIBLE DAMAGE to production systems.

### 2. Respect Project's Package Manager

**Detect and use the project's chosen package manager:**

**Detection Strategy:**
```bash
# Check for lock files
if [ -f "yarn.lock" ]; then
  # Use yarn
elif [ -f "pnpm-lock.yaml" ]; then
  # Use pnpm
elif [ -f "package-lock.json" ]; then
  # Use npm
fi
```

**Never mix package managers in the same project.**

### 3. Non-Interactive Test Execution

**All test commands MUST be non-interactive:**

**✅ Correct:**
```bash
npm test -- --watchAll=false
yarn test --watchAll=false
jest --passWithNoTests --silent
```

**❌ Wrong:**
```bash
npm test  # Might start watch mode
yarn test # Might be interactive
```

**Why**: Interactive mode blocks AI tools and prevents automation.

---

## 📋 Standard Rules

### Package Manager Commands

**npm:**
```bash
npm install              # Install dependencies
npm install package      # Add package
npm uninstall package    # Remove package
npm run script           # Run script
npm test -- --watchAll=false  # Run tests (non-interactive)
```

**yarn:**
```bash
yarn                     # Install dependencies
yarn add package         # Add package
yarn remove package      # Remove package
yarn script              # Run script
yarn test --watchAll=false    # Run tests (non-interactive)
```

**pnpm:**
```bash
pnpm install             # Install dependencies
pnpm add package         # Add package
pnpm remove package      # Remove package
pnpm script              # Run script
pnpm test -- --watchAll=false # Run tests (non-interactive)
```

### Force Flag Request Template

**When --force is needed:**

```
This operation requires the --force flag, which bypasses safety checks.

What --force does:
[Explain the specific behavior]

Risks:
- [List potential consequences]
- [Include irreversible changes]
- [Mention production impact if applicable]

Do you want me to proceed with --force? (y/n)

If yes, I will execute:
[Show exact command]
```

### Lock File Management

**NEVER:**
- Delete lock files without permission
- Commit changes to lock files without review
- Mix lock files from different package managers

**ALWAYS:**
- Commit lock files to version control
- Update lock files when adding/removing packages
- Use the same package manager as the project

---

## ✅ Checklist

Before using ANY package manager command:

- [ ] Detected project's package manager (check lock files)
- [ ] Using correct package manager for project
- [ ] Not mixing package managers
- [ ] Tests are non-interactive (if running tests)

Before using --force flag:

- [ ] Explained what --force does
- [ ] Explained risks and consequences
- [ ] Requested explicit permission
- [ ] Received confirmation
- [ ] Showed exact command to be executed

---

## 🔍 Examples

### ✅ Good: Detecting Package Manager

```bash
# Check for lock files
if [ -f "yarn.lock" ]; then
  echo "Project uses yarn"
  yarn add lodash
elif [ -f "pnpm-lock.yaml" ]; then
  echo "Project uses pnpm"
  pnpm add lodash
else
  echo "Project uses npm"
  npm install lodash
fi
```

### ✅ Good: Requesting --force Permission

```
This operation requires the --force flag.

What --force does:
Forces Firebase to deploy even if there are validation errors or warnings.

Risks:
- May deploy broken configuration
- Could overwrite production settings
- Bypasses safety checks
- Changes are immediate and affect live users

Do you want me to proceed with --force? (y/n)

If yes, I will execute:
firebase deploy --force
```

### ❌ Bad: Using --force Without Permission

```bash
# WRONG - using --force without asking
firebase deploy --force
```

### ❌ Bad: Mixing Package Managers

```bash
# Project has yarn.lock
yarn add package-a

# Later, using npm (WRONG)
npm install package-b

# Now have both yarn.lock and package-lock.json (BAD)
```

---

## 🚫 Common Mistakes

### Mistake 1: Using --force Without Permission

**Problem**: Executing destructive commands without user consent

**Solution**: Always explain risks and request permission

**Why**: Can cause irreversible damage to production systems

### Mistake 2: Mixing Package Managers

**Problem**: Using npm in a yarn project or vice versa

**Solution**: Detect and use project's package manager

**Why**: Creates conflicting lock files, dependency issues

### Mistake 3: Interactive Test Execution

**Problem**: Running tests in watch mode

**Solution**: Always use non-interactive flags

**Why**: Blocks AI tools, prevents automation

### Mistake 4: Deleting Lock Files

**Problem**: Removing lock files to "fix" issues

**Solution**: Never delete lock files without permission

**Why**: Lock files ensure consistent dependencies

---

## 🤖 AI Self-Check Protocol

**Before ANY package manager operation:**

1. What package manager does this project use?
   - Check for lock files
   - Use detected package manager

2. Am I using --force or similar destructive flags?
   - If YES → Request permission first
   - If NO → Continue

3. Am I running tests?
   - If YES → Ensure non-interactive mode
   - If NO → Continue

4. Am I modifying lock files?
   - If YES → Will commit with review
   - If NO → Continue

**Package Manager Detection:**

```
Package Manager Operation Needed
        ↓
Check for lock files
        ↓
yarn.lock? ──YES──→ Use yarn
        ↓ NO
        ↓
pnpm-lock.yaml? ──YES──→ Use pnpm
        ↓ NO
        ↓
package-lock.json? ──YES──→ Use npm
        ↓ NO
        ↓
Ask user which to use
```

**Force Flag Protocol:**

```
Need --force flag?
        ↓ YES
        ↓
Explain what --force does
        ↓
Explain risks
        ↓
Request permission
        ↓
Approved? ──NO──→ Stop, find alternative
        ↓ YES
        ↓
Execute with --force
```
