/**
 * Tests for centralized GitHub authentication factory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createOctokit } from '../../src/ingestion/auth.js';

describe('createOctokit', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    // Clear all auth env vars
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    // Restore original env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should throw when no auth configured', () => {
    assert.throws(
      () => createOctokit(),
      (error: Error) => {
        assert.ok(error.message.includes('No GitHub authentication configured'));
        return true;
      }
    );
  });

  it('should prefer App auth when all vars present', () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----';
    process.env.GITHUB_APP_INSTALLATION_ID = '67890';
    process.env.GITHUB_TOKEN = 'ghp_fallback_token';

    const octokit = createOctokit();
    assert.ok(octokit, 'Should create Octokit instance with App auth');
  });

  it('should fall back to PAT when App vars missing', () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token_123';

    const octokit = createOctokit();
    assert.ok(octokit, 'Should create Octokit instance with PAT');
  });

  it('should fall back to PAT when only some App vars present', () => {
    process.env.GITHUB_APP_ID = '12345';
    // Missing GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID
    process.env.GITHUB_TOKEN = 'ghp_fallback';

    const octokit = createOctokit();
    assert.ok(octokit, 'Should create Octokit with PAT when App auth incomplete');
  });

  it('should handle escaped newlines in private key', () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\\nMIIE...\\n-----END RSA PRIVATE KEY-----';
    process.env.GITHUB_APP_INSTALLATION_ID = '67890';

    // Should not throw — the escaped newlines get replaced
    const octokit = createOctokit();
    assert.ok(octokit, 'Should handle escaped newlines in private key');
  });

  it('should throw when App vars partially set and no PAT', () => {
    process.env.GITHUB_APP_ID = '12345';
    // Missing private key and installation ID, no PAT fallback

    assert.throws(
      () => createOctokit(),
      (error: Error) => {
        assert.ok(error.message.includes('No GitHub authentication configured'));
        return true;
      }
    );
  });
});
