# Testing Guide

## Running Tests

```bash
npm test
```

This will:
1. Compile TypeScript (`npm run build`)
2. Run all tests in `dist/test/*.test.js`

## Test Structure

Tests are located in `tools/test/` directory:

```
tools/
  test/
    id-generator.test.ts      # ID and slug generation tests
    normalizer.test.ts         # Data normalization tests
    wikidata-client.test.ts    # Wikidata query and parsing tests
```

## Test Coverage

### ID Generator Tests (10 tests)
- `generateSlug()` - Converts titles to URL-safe slugs
  - Basic titles
  - Titles with spaces
  - Special characters (hyphens, colons)
  - Accented characters (é, ñ, etc.)
  - Article removal (the, a, an)
  - Multiple spaces normalization

- `generateMovieId()` - Creates movie IDs
- `generatePersonId()` - Creates person IDs

### Normalizer Tests (3 tests)
- `normalizeMovie()` - Converts Wikidata format to MMDB format
  - Minimal movie (required fields only)
  - Full movie (all optional fields)
  - Special characters in titles

### Wikidata Client Tests (4 tests)
- `buildMovieQuery()` - Generates SPARQL queries
  - Default parameters
  - Custom limit and offset
  
- `parseMovieResults()` - Parses Wikidata API responses
  - Complete movie data
  - Missing optional fields

## Writing New Tests

Use Node.js built-in test runner:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { yourFunction } from '../src/your-module.js';

test('description of what is being tested', () => {
  const result = yourFunction(input);
  assert.strictEqual(result, expected);
});
```

### Test File Naming

- Place in `tools/test/`
- Name: `<module-name>.test.ts`
- Import from compiled JS: `../src/module.js` (not `.ts`)

### Running Specific Tests

```bash
# Run all tests
npm test

# Run specific test file
node --test dist/test/id-generator.test.js
```

## Test Results

Current coverage: **17 tests, 17 passing**

```
# tests 17
# pass 17
# fail 0
```

## CI/CD Integration

Tests run automatically on:
- Pull requests
- Push to master branch

See `.github/workflows/validate.yml` for CI configuration.

## Best Practices

1. **Test before implementing** - Write tests first when possible
2. **One assertion per test** - Keep tests focused
3. **Descriptive names** - Test names should explain what they verify
4. **Test edge cases** - Empty strings, special characters, missing data
5. **Mock external APIs** - Don't call real Wikidata/GitHub in tests
