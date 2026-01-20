---
meta:
  id: package-json-management
  title: Package.json Management & Dependencies
  author: cairel-core
  version: 1.0.0
  category: general
  tags:
    - package-json
    - dependencies
    - npm
    - versioning
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  conditions:
    languages:
      - typescript
      - javascript
  description: >-
    Manage package.json dependencies, scripts, and metadata with validation and
    best practices.
---

# Package.json Management & Dependencies

**Purpose**: Maintain clean, organized package.json with proper dependency management.

**Applies To**: Node.js/JavaScript/TypeScript projects

---

## 🚨 Critical Rules

### 1. Never Modify package.json Manually Without Reason

**Use package manager commands for adding/removing dependencies.**

### 2. Keep Dependencies Organized

**Separate dependencies, devDependencies, and peerDependencies correctly.**

---

## 📋 Standard Rules

### Adding Dependencies

```bash
# Production dependency
npm install package-name
yarn add package-name
pnpm add package-name

# Development dependency
npm install -D package-name
yarn add -D package-name
pnpm add -D package-name

# Peer dependency (manual in package.json)
"peerDependencies": {
  "react": "^18.0.0"
}
```

### Removing Dependencies

```bash
npm uninstall package-name
yarn remove package-name
pnpm remove package-name
```

### Package.json Structure

```json
{
  "name": "project-name",
  "version": "1.0.0",
  "description": "Project description",
  "main": "index.js",
  "scripts": {
    "dev": "...",
    "build": "...",
    "test": "...",
    "lint": "..."
  },
  "dependencies": {
    "production-package": "^1.0.0"
  },
  "devDependencies": {
    "dev-package": "^1.0.0"
  },
  "peerDependencies": {
    "peer-package": "^1.0.0"
  }
}
```

### Dependency Types

**dependencies**: Required for production
**devDependencies**: Only needed for development
**peerDependencies**: Expected to be provided by consumer

---

## ✅ Checklist

When managing dependencies:

- [ ] Used package manager commands
- [ ] Correct dependency type (prod vs dev)
- [ ] Version constraints appropriate
- [ ] Lock file updated
- [ ] Scripts organized and documented

---

## 🔍 Examples

### ✅ Good: Proper Dependency Management

```bash
# Add production dependency
yarn add express

# Add dev dependency
yarn add -D typescript @types/node

# Remove unused dependency
yarn remove old-package

# Update package
yarn upgrade package-name
```

### ❌ Bad: Manual Editing

```json
// Manually editing package.json
"dependencies": {
  "express": "4.18.0"  // No ^ or ~, exact version
}

// Then running npm install
// Lock file might be inconsistent
```

---

## 🚫 Common Mistakes

### Mistake 1: Wrong Dependency Type

**Problem**: Dev tools in dependencies

**Solution**: Use -D flag for dev dependencies

```bash
# WRONG
npm install typescript

# CORRECT
npm install -D typescript
```

### Mistake 2: Exact Versions

**Problem**: Using exact versions without reason

**Solution**: Use ^ for minor updates, ~ for patches

```json
// Flexible (recommended)
"dependencies": {
  "express": "^4.18.0"  // Allows 4.x.x
}

// Exact (only when needed)
"dependencies": {
  "critical-package": "1.2.3"
}
```

### Mistake 3: Unused Dependencies

**Problem**: Keeping unused packages

**Solution**: Regularly audit and remove

```bash
# Check for unused
npm prune
yarn autoclean

# Remove unused
npm uninstall unused-package
```

---

## 🤖 AI Self-Check Protocol

**Before adding dependency:**

1. Is this for production or development?
   - Production → dependencies
   - Development → devDependencies

2. What version constraint?
   - ^ for minor updates (recommended)
   - ~ for patch updates
   - Exact only when necessary

3. Is package manager command used?
   - If NO → Use npm/yarn/pnpm command
   - If YES → Proceed

**After modifying dependencies:**

1. Is lock file updated?
2. Are dependencies in correct section?
3. Are versions appropriate?
4. Is package.json valid JSON?
