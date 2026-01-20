---
meta:
  id: typescript-validation
  title: TypeScript Compilation Validation
  author: cairel-core
  version: 1.0.0
  category: typescript
  tags:
    - typescript
    - validation
    - compilation
    - type-safety
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  conditions:
    languages:
      - typescript
  description: >-
    Mandate TypeScript compilation validation after every file change to catch
    errors early.
---

# TypeScript Compilation Validation

**Purpose**: Prevent TypeScript error accumulation by validating compilation after every code change.

**Applies To**: TypeScript projects

---

## 🚨 Critical Rules

### 1. Validate After EVERY TypeScript File Change

**AI MUST run TypeScript validation after creating or modifying ANY .ts/.tsx file.**

```bash
# MANDATORY after every .ts/.tsx change
npx tsc --noEmit
```

**Never accumulate TypeScript errors. Fix them immediately as they occur.**

### 2. Stop and Fix Errors Immediately

**If TypeScript errors exist:**

1. STOP adding new code
2. Fix ALL TypeScript errors before proceeding
3. Re-run `npx tsc --noEmit` to verify fixes
4. Only after clean compilation, continue with next file

### 3. Component Creation Validation

**When creating components with multiple files:**

```bash
# Create component files
touch Avatar.tsx index.ts

# Write code in Avatar.tsx
# IMMEDIATELY validate
npx tsc --noEmit

# Fix any errors
# Then create subcomponents
```

**CRITICAL**: Validate after main component before creating subcomponents to prevent cascading errors.

---

## 📋 Standard Rules

### Validation Command

**Always use:**
```bash
npx tsc --noEmit
```

**Alternative (if tsc is in package.json scripts):**
```bash
yarn tsc --noEmit
# or
npm run tsc -- --noEmit
```

### Common TypeScript Issues to Check

**Import Paths:**
- ✅ `import { Type } from './file'` (correct for TypeScript)
- ❌ `import { Type } from './file.js'` (wrong in .ts projects)

**Interface Compliance:**
- ✅ All required properties present and correctly typed
- ❌ Missing properties or wrong types

**Method Existence:**
- ✅ Check interface/class definitions before calling methods
- ❌ Calling methods that don't exist on objects

**Type Compatibility:**
- ✅ Use proper type assertions or fix type definitions
- ❌ Assigning incompatible types

---

## ✅ Checklist

Before committing ANY TypeScript code:

- [ ] `npx tsc --noEmit` returns exit code 0
- [ ] No TypeScript errors in output
- [ ] All imports use correct paths
- [ ] All interfaces are properly implemented
- [ ] All method calls are valid

After creating/modifying .ts/.tsx files:

- [ ] Ran `npx tsc --noEmit` immediately
- [ ] Fixed all errors before proceeding
- [ ] Verified clean compilation
- [ ] No accumulated technical debt

---

## 🔍 Examples

### ✅ Good: Validate as You Go

```bash
# Create file
touch src/services/auth.ts

# Write code in auth.ts
# IMMEDIATELY validate
npx tsc --noEmit

# Output: No errors
# Continue to next file

touch src/services/user.ts
# Write code
npx tsc --noEmit
# Fix any errors
# Continue
```

### ❌ Bad: Code First, Fix Later

```bash
# Create multiple files
touch file1.ts file2.ts file3.ts

# Write code in all files
# Then run tsc and get 20+ errors
npx tsc --noEmit

# Now have to fix errors across multiple files
# Context is lost, harder to debug
```

---

## 🚫 Common Mistakes

### Mistake 1: Accumulating Errors

**Problem**: Creating multiple files before validating

**Solution**: Validate after each file creation/modification

**Why**: Errors are easier to fix when context is fresh

### Mistake 2: Ignoring Validation

**Problem**: Skipping `tsc --noEmit` to "save time"

**Solution**: Always validate, it saves time in the long run

**Why**: Prevents cascading errors and debugging sessions

### Mistake 3: Partial Fixes

**Problem**: Fixing some errors but not all

**Solution**: Fix ALL errors before proceeding

**Why**: Partial fixes lead to confusion and more errors

---

## 🤖 AI Self-Check Protocol

**Before creating any .ts/.tsx file:**

1. Plan the interfaces - What types will this file use?
2. Check existing interfaces - Do they match what I need?
3. Write the code - Implement with proper types
4. Validate immediately - Run `npx tsc --noEmit`
5. Fix errors - Don't proceed until clean

**After modifying any .ts/.tsx file:**

1. Run validation - `npx tsc --noEmit`
2. Fix errors immediately - Don't accumulate technical debt
3. Verify clean compilation - Exit code 0 required

**Development Workflow:**

```
Create/Modify .ts file
        ↓
Run: npx tsc --noEmit
        ↓
Errors? ──YES──→ Fix errors ──→ Re-validate
   ↓                                  ↓
   NO                                 ↓
   ↓ ←────────────────────────────────
   ↓
Proceed to next file/feature
```

---

## 📊 Success Criteria

**Clean Development:**
- Zero TypeScript errors at any point
- Immediate error resolution
- No error accumulation
- Faster overall development time

**Quality Assurance:**
- Type safety maintained throughout
- Interface compliance verified continuously
- Method existence validated immediately
- Import paths correct from the start
