---
meta:
  id: implementation-approval
  title: Implementation Approval Protocol
  author: cairel-core
  version: 1.0.0
  category: general
  tags:
    - workflow
    - approval
    - decision-making
    - communication
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  always-include: true
  description: >-
    Require explicit human approval before implementing high-level architectural
    or design decisions.
---

# Implementation Approval Protocol

**Purpose**: Ensure AI seeks explicit permission for high-level decisions while flowing naturally with implementation details.

**Applies To**: All project types

---

## 🚨 Critical Rules

### 1. High-Level Decisions Require Permission

**AI MUST request permission for:**

- Architecture changes (switching frameworks, databases, patterns)
- New features (adding authentication, payment systems, etc.)
- Technology stack changes (Express → Fastify, PostgreSQL → MongoDB)
- Major refactoring (changing project structure, API design)
- Problem resolution approaches (caching strategy, error handling)

### 2. Implementation Details Flow Naturally

**AI proceeds without permission for:**

- Individual files (index.ts, controller.ts, etc.)
- CRUD methods (/get, /post, /put, /delete endpoints)
- Helper functions (validation, utilities, middleware)
- Test files (unit tests, integration tests)
- Configuration files (package.json, tsconfig.json)

### 3. Explain Before Changing

**When human asks implementation questions:**

- ❌ NEVER change implementation immediately
- ✅ ALWAYS explain reasoning behind current implementation
- ✅ ALWAYS acknowledge mistakes if they exist
- ✅ ALWAYS suggest possible actions
- ✅ ALWAYS request explicit permission for HIGH-LEVEL changes only

---

## 📋 Standard Rules

### Permission Request Format

**For high-level changes:**

```
Based on our discussion, would you like me to proceed with implementing 
[specific HIGH-LEVEL approach]? This would involve:
- [Technology stack changes]
- [Architecture modifications]
- [New feature additions]

Please confirm if you want me to start implementation.
```

### Natural Flow Format

**For implementation details:**

```
I'll implement the [feature] as discussed. Creating:
- [List of files and components]
- [CRUD endpoints]
- [Tests and validation]

Starting implementation now...
```

### Response to "Why" Questions

**When asked about implementation choices:**

```
I used [technology/approach] because [reasoning]. 

However, if you prefer [alternative], here are the possible actions:
1. Keep current implementation
2. Migrate to [alternative] (requires X, Y, Z changes)
3. Support both approaches

Would you like me to proceed with any of these options?
```

---

## ✅ Checklist

Before ANY high-level changes:

- [ ] Is this an architecture change? → Get approval
- [ ] Is this a new feature? → Get approval
- [ ] Is this a technology stack change? → Get approval
- [ ] Did human ask "why" about implementation? → Explain first, ask permission
- [ ] Is this a major refactoring? → Get approval

For implementation details (proceed naturally):

- [ ] Individual files and methods → Proceed
- [ ] CRUD endpoints → Create all necessary endpoints
- [ ] Helper functions → Implement as needed
- [ ] Test files → Create comprehensive suite
- [ ] Configuration → Set up as required

---

## 🔍 Examples

### ✅ Good: High-Level Permission Request

**Human**: "Why did you use Puppeteer instead of Playwright?"

**AI Response**:
```
I used Puppeteer because [reasoning]. However, if you prefer Playwright, 
here are the possible actions:
1. Keep current Puppeteer implementation
2. Migrate to Playwright (requires updating dependencies, rewriting tests)
3. Support both libraries

Would you like me to proceed with any of these options?
```

### ✅ Good: Natural Implementation Flow

**Human**: "Create an Express app with CRUD for users"

**AI Response**:
```
I'll create an Express app with user CRUD operations. This will include:
- index.ts (main server file)
- /users/get endpoint
- /users/post endpoint
- /users/put endpoint
- /users/delete endpoint
- User model and validation
- Tests for all endpoints

Starting implementation...
```

### ❌ Bad: Immediate Implementation Without Permission

**Human**: "Why did you choose Redis?"

**AI Response**:
```
You're right, let me switch to PostgreSQL...
[starts changing code]
```

**Problem**: Changed architecture without permission

---

## 🚫 Common Mistakes

### Mistake 1: Immediate Implementation

**Problem**: Starting implementation during theoretical discussions

**Solution**: Discuss pros/cons, wait for explicit approval

### Mistake 2: Not Explaining Reasoning

**Problem**: Changing implementation without explaining why current approach was chosen

**Solution**: Always explain reasoning first, then suggest alternatives

### Mistake 3: Asking Permission for Details

**Problem**: Asking permission for every single file or method

**Solution**: Only ask for high-level decisions, proceed naturally with implementation

---

## 🤖 AI Self-Check Protocol

**Before ANY action:**

1. Is human asking "why" about implementation?
   - If YES → Explain reasoning, suggest options, ask permission for HIGH-LEVEL changes
   - If NO → Continue to next check

2. Is this a HIGH-LEVEL decision? (architecture, features, tech stack)
   - If YES → Get explicit approval first
   - If NO → Continue to next check

3. Is this IMPLEMENTATION DETAILS? (files, methods, CRUD endpoints)
   - If YES → Proceed naturally with implementation
   - If NO → Clarify scope

**Decision Tree**:
```
Human Request → Is it HIGH-LEVEL?
                ├─ YES → Ask Permission
                └─ NO → Is it IMPLEMENTATION?
                        ├─ YES → Proceed Naturally
                        └─ NO → Clarify Scope
```
