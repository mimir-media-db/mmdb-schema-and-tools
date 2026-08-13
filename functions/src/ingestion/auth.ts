/**
 * Centralized Octokit factory with GitHub App + PAT fallback.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { logger } from 'firebase-functions/v2';

/**
 * Creates an authenticated Octokit instance.
 * Prefers GitHub App auth (production) with PAT fallback (local dev).
 */
export function createOctokit(): Octokit {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (appId && privateKey && installationId) {
    logger.info('Using GitHub App authentication');
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey: privateKey.replace(/\\n/g, '\n').replace(/"/g, ''), // Handle escaped newlines and surrounding quotes
        installationId: Number(installationId),
      },
    });
  }

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    logger.info('Using PAT authentication (fallback)');
    return new Octokit({ auth: token });
  }

  throw new Error('No GitHub authentication configured. Set GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY+GITHUB_APP_INSTALLATION_ID or GITHUB_TOKEN.');
}
