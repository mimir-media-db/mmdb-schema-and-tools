---
meta:
  id: "development-workflow-meta"
  title: "Development Workflow and Rule Application"
  author: "cairel-core"
  version: "1.0.0"
  category: "general"
  tags: ["workflow", "meta", "rules", "development"]
  ai-tools: ["kiro-cli", "amazon-q-developer"]
  last-updated: "2026-01-16"
  description: "Systematic rule application based on development context for consistent code quality."
  always-include: false
  conditions:
    project-types:
      - ui
      - backend
      - cli
      - library
      - fullstack
---

# Development Workflow and Rule Application

**Purpose**: Guide systematic rule application based on development context to ensure consistent code quality.

**Applies To**: All projects with multiple steering rules

---

## 🚨 Critical Rules

### Rule 1: Apply Relevant Rules Based on Context

**Before starting any development task, identify which rules apply to your current work.**

Different development contexts require different rules. Always review and apply applicable rules.

### Rule 2: Never Skip Critical Rules

**Some rules are critical and must NEVER be skipped:**
- Visual verification for UI changes
- TypeScript compilation checks
- Implementation approval for breaking changes
- Package manager safety

---

## 📋 Standard Rules

### Rule Application by Development Context

#### 🎨 UI Components & Pages

**When developing: components, pages, layouts, UI elements**

Apply these rules:
- ✅ Visual verification (MANDATORY for all UI changes)
- ✅ Component structure patterns
- ✅ Props destructuring patterns
- ✅ Absolute imports
- ✅ Icon usage patterns (if using icons)
- ✅ UI library integration (Chakra UI, GlueStack UI, etc.)
- ✅ Mock data strategy (for data-driven components)

#### 🔧 Services & API Integration

**When developing: services, API calls, data fetching, backend integration**

Apply these rules:
- ✅ TypeScript validation
- ✅ Absolute imports
- ✅ Error handling patterns
- ✅ Multi-environment management (if using env vars)

#### 📦 Package Management & Dependencies

**When: installing packages, managing dependencies, running scripts**

Apply these rules:
- ✅ Package manager safety (MANDATORY)
- ✅ Package.json management
- ✅ Semantic versioning (for libraries)

#### 🧪 Testing & Verification

**When: writing tests, validating functionality, checking quality**

Apply these rules:
- ✅ Visual verification (for UI)
- ✅ Test cleanup protocol (for temporary tests)
- ✅ TypeScript validation

#### 🏗️ Architecture & Code Quality

**When: structuring code, organizing files, refactoring**

Apply these rules:
- ✅ TypeScript validation (MANDATORY before changes)
- ✅ Component structure patterns
- ✅ Absolute imports
- ✅ Git management

#### 📝 Documentation

**When: creating or modifying documentation**

Apply these rules:
- ✅ Markdown maintenance (for .md files)
- ✅ Context retrieval optimization

---

## ✅ Checklist

### Before Starting Development

- [ ] Identify development context (UI/services/testing/etc.)
- [ ] Review applicable rules for this context
- [ ] Note any critical rules that must be followed
- [ ] Plan implementation following relevant rules

### During Development

- [ ] Apply component/code structure patterns
- [ ] Use proper import strategies
- [ ] Follow framework-specific patterns
- [ ] Implement proper error handling
- [ ] Add test IDs for UI components (if applicable)

### After Implementation

- [ ] Run TypeScript validation (if applicable)
- [ ] Perform visual verification (for UI changes)
- [ ] Confirm all applicable rules followed
- [ ] Clean up temporary files (if created)
- [ ] Update documentation (if needed)

---

## 🔍 Examples

### Example 1: Creating a New UI Component

**Context**: UI development

**Applicable Rules**:
1. Component structure patterns
2. Props destructuring
3. Absolute imports
4. TypeScript validation
5. Visual verification
6. UI library integration (Chakra UI/GlueStack UI)

**Workflow**:
```typescript
// 1. Apply component structure pattern
// Create: src/components/elements/NewComponent/

// 2. Apply props destructuring
export const NewComponent: React.FC<INewComponentProps> = ({
  title,
  dataTestId = 'new-component',
  ...rest
}) => {
  // 3. Apply absolute imports
  import { formatDate } from '@/utils/date';
  
  // 4. Apply UI library patterns
  return (
    <Card.Root data-testid={dataTestId} {...rest}>
      <Card.Body>{title}</Card.Body>
    </Card.Root>
  );
};

// 5. Run TypeScript validation
// yarn tsc --noEmit

// 6. Perform visual verification
// take_screenshot + analyze
```

### Example 2: Adding a Service

**Context**: Service/API development

**Applicable Rules**:
1. TypeScript validation
2. Absolute imports
3. Error handling
4. Multi-environment management (if using env vars)

**Workflow**:
```typescript
// 1. Apply absolute imports
import { apiClient } from '@/lib/api';
import { IUser } from '@/types/user';

// 2. Apply error handling
export const getUserData = async (id: string): Promise<IUser> => {
  try {
    const response = await apiClient.get(`/users/${id}`);
    return response.data;
  } catch (error) {
    console.error('Failed to fetch user:', error);
    throw error;
  }
};

// 3. Apply multi-environment management
const API_URL = process.env.API_URL || 'http://localhost:3000';

// 4. Run TypeScript validation
// yarn tsc --noEmit
```

### Example 3: Writing Temporary Tests

**Context**: Testing/validation

**Applicable Rules**:
1. Test cleanup protocol
2. TypeScript validation (if TypeScript)

**Workflow**:
```bash
# 1. Create temporary test
cat > test_parser.lua << EOF
local parser = require("parser")
assert(parser.parse("test") == "expected")
print("Test passed!")
EOF

# 2. Run test
lua test_parser.lua

# 3. Apply test cleanup protocol
rm test_parser.lua

# 4. Verify cleanup
git status  # Should be clean
```

---

## 🚫 Common Mistakes

### Mistake 1: Applying All Rules to Everything

**Problem**: Trying to apply every rule to every task

**Fix**: Identify context first, then apply relevant rules only

**Why**: Not all rules apply to all contexts

### Mistake 2: Skipping Critical Rules

**Problem**: Skipping visual verification or TypeScript checks

**Fix**: Always apply critical rules, no exceptions

**Why**: Critical rules prevent major issues

### Mistake 3: Not Reviewing Rules Before Starting

**Problem**: Starting work without checking applicable rules

**Fix**: Review rules first, then implement

**Why**: Easier to follow rules from the start than to refactor

### Mistake 4: Inconsistent Rule Application

**Problem**: Following rules sometimes but not always

**Fix**: Make rule application systematic and consistent

**Why**: Consistency ensures code quality

---

## 🤖 AI Self-Check Protocol

### Before Starting Task

Ask yourself:

1. **What am I building?**
   - UI component?
   - Service/API?
   - Test?
   - Documentation?

2. **Which rules apply to this context?**
   - Review rule application matrix
   - Identify relevant rules
   - Note critical rules

3. **What are the critical rules I must follow?**
   - Visual verification (for UI)?
   - TypeScript validation?
   - Package manager safety?
   - Implementation approval?

### During Development

Monitor:

1. **Am I following the applicable rules?**
   - Component structure?
   - Import patterns?
   - Props patterns?
   - Error handling?

2. **Have I skipped any critical rules?**
   - If yes → Apply them now
   - If no → Continue

### After Completion

Verify:

1. **Did I apply all applicable rules?**
   - Review checklist
   - Confirm compliance

2. **Did I complete all critical rule requirements?**
   - TypeScript validation run?
   - Visual verification done?
   - Tests cleaned up?

3. **Is the code ready for commit?**
   - All rules followed
   - All checks passed
   - No temporary files

---

## 📊 Rule Application Matrix

| Context | Critical Rules | Standard Rules |
|---------|---------------|----------------|
| UI Components | Visual verification, TypeScript | Component structure, Props patterns, Imports |
| Services/API | TypeScript validation | Imports, Error handling, Env management |
| Package Management | Package manager safety | Package.json management, Versioning |
| Testing | Test cleanup protocol | TypeScript validation |
| Documentation | Markdown maintenance | Context retrieval |
| Git Operations | Git management | Implementation approval |

---

## 🎯 Quick Reference

**Step 1: Identify Context**
- What am I building?
- What type of work is this?

**Step 2: Review Applicable Rules**
- Check rule application matrix
- Identify relevant rules
- Note critical rules

**Step 3: Apply Rules Systematically**
- Follow structure patterns
- Use proper imports
- Implement error handling
- Add test IDs (if UI)

**Step 4: Verify Compliance**
- Run TypeScript validation
- Perform visual verification (if UI)
- Clean up temporary files
- Confirm all rules followed

**Golden Rule**: Context determines which rules apply. Always identify context first, then apply relevant rules systematically.

**Why it matters**: Systematic rule application ensures consistent code quality, prevents common mistakes, and maintains project standards.
