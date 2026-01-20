---
meta:
  id: absolute-imports
  title: Absolute Imports Configuration
  author: cairel-core
  version: 1.0.0
  category: typescript
  tags:
    - imports
    - paths
    - aliases
    - typescript
  ai-tools:
    - kiro-cli
    - amazon-q-developer
  last-updated: '2026-01-14'
  conditions:
    languages:
      - typescript
      - javascript
  description: >-
    Configure and use absolute imports with @ alias for cleaner, more
    maintainable import statements.
---

# Absolute Imports Configuration

**Purpose**: Use absolute imports with @ alias for cleaner, more maintainable imports.

**Applies To**: TypeScript/JavaScript projects

---

## 🚨 Critical Rules

### 1. Use Absolute Imports for External Dependencies

**ALWAYS use absolute imports with @/ alias for imports from src/ directory.**

### 2. Relative Imports Only for Children

**Relative imports ONLY allowed for child components within same folder (max 2 levels deep).**

---

## 📋 Standard Rules

### Import Strategy

**✅ Absolute imports:**
```typescript
import { Button } from '@/components/elements/Button';
import { useAuth } from '@/hooks/useAuth';
import { API_ENDPOINTS } from '@/utils/constants';
```

**✅ Relative imports (children only):**
```typescript
// Inside components/Avatar/Avatar.tsx
import { AvatarHeader } from './components/AvatarHeader';
import { AvatarImage } from './AvatarImage';
```

**❌ Never relative for siblings:**
```typescript
// WRONG
import { Button } from '../Button';
import { utils } from '../../utils/helpers';
```

### Configuration

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"],
      "@/components/*": ["./src/components/*"],
      "@/utils/*": ["./src/utils/*"],
      "@/hooks/*": ["./src/hooks/*"],
      "@/types/*": ["./src/types/*"]
    }
  }
}
```

---

## ✅ Checklist

- [ ] tsconfig.json configured with @ alias
- [ ] All external imports use @/ prefix
- [ ] Relative imports only for child components
- [ ] No sibling relative imports

---

## 🔍 Examples

### ✅ Good

```typescript
// External dependencies
import { Button } from '@/components/elements/Button';
import { formatDate } from '@/utils/date';

// Child components
import { CardHeader } from './components/CardHeader';
```

### ❌ Bad

```typescript
// Sibling relative imports
import { Button } from '../Button';
import { formatDate } from '../../utils/date';
```
