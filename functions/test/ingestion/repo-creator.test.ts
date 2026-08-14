/**
 * Tests for automated year repo creation validation logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateYearForRepoCreation, VALIDATE_WORKFLOW } from '../../src/ingestion/repo-creator.js';

describe('Repo Creator', () => {
  describe('VALIDATE_WORKFLOW template', () => {
    it('should include permissions: contents: write', () => {
      assert.ok(
        VALIDATE_WORKFLOW.includes('permissions:'),
        'Workflow must include a permissions block'
      );
      assert.ok(
        VALIDATE_WORKFLOW.includes('contents: write'),
        'Workflow must grant contents: write permission'
      );
    });

    it('should have permissions before jobs block', () => {
      const permIndex = VALIDATE_WORKFLOW.indexOf('permissions:');
      const jobsIndex = VALIDATE_WORKFLOW.indexOf('jobs:');
      assert.ok(
        permIndex < jobsIndex,
        'permissions block must appear before jobs block'
      );
    });

    it('should skip runs for github-actions[bot]', () => {
      assert.ok(
        VALIDATE_WORKFLOW.includes("github.actor != 'github-actions[bot]'"),
        'Workflow must skip bot-triggered runs'
      );
    });

    it('should include git push step', () => {
      assert.ok(
        VALIDATE_WORKFLOW.includes('git push'),
        'Workflow must push index updates'
      );
    });
  });

  describe('validateYearForRepoCreation', () => {
    describe('year bounds', () => {
      it('should reject year below minimum (1887)', () => {
        const result = validateYearForRepoCreation(1887);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('outside bounds'));
      });

      it('should accept minimum year (1888)', () => {
        const result = validateYearForRepoCreation(1888);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.reason, undefined);
      });

      it('should accept current year', () => {
        const currentYear = new Date().getFullYear();
        const result = validateYearForRepoCreation(currentYear);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.reason, undefined);
      });

      it('should reject year beyond current year', () => {
        const futureYear = new Date().getFullYear() + 1;
        const result = validateYearForRepoCreation(futureYear);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('outside bounds'));
      });

      it('should reject very old year (1800)', () => {
        const result = validateYearForRepoCreation(1800);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('outside bounds'));
      });

      it('should reject negative year', () => {
        const result = validateYearForRepoCreation(-1);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('outside bounds'));
      });
    });

    describe('name validation', () => {
      it('should accept valid 4-digit years', () => {
        assert.strictEqual(validateYearForRepoCreation(2010).valid, true);
        assert.strictEqual(validateYearForRepoCreation(1999).valid, true);
        assert.strictEqual(validateYearForRepoCreation(1900).valid, true);
      });

      it('should reject 5-digit year (99999)', () => {
        const result = validateYearForRepoCreation(99999);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('outside bounds') || result.reason?.includes('Invalid repo name'));
      });

      it('should reject non-integer year', () => {
        const result = validateYearForRepoCreation(2010.5);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('not an integer'));
      });

      it('should reject NaN', () => {
        const result = validateYearForRepoCreation(NaN);
        assert.strictEqual(result.valid, false);
      });
    });

    describe('boundary cases', () => {
      it('should accept year 2000', () => {
        const result = validateYearForRepoCreation(2000);
        assert.strictEqual(result.valid, true);
      });

      it('should accept year 1888 exactly', () => {
        const result = validateYearForRepoCreation(1888);
        assert.strictEqual(result.valid, true);
      });

      it('should accept year 2025', () => {
        // 2025 should be valid as it's <= current year (2026)
        const result = validateYearForRepoCreation(2025);
        assert.strictEqual(result.valid, true);
      });
    });
  });
});
