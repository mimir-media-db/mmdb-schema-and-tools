/**
 * MMDB Ingestion Cloud Function (2nd gen)
 *
 * Automated Wikidata → MMDB ingestion pipeline triggered by Cloud Scheduler.
 * Runs a dual-pass strategy: backlog (historical) + recent (newly modified).
 * Creates GitHub PRs with new movie, series, and people data.
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { runIngestion } from './ingestion/orchestrator.js';
import { runCurrentYearIngestion } from './ingestion/current-year.js';
import { runCleanup } from './ingestion/cleanup.js';
import { isIngestionPaused } from './ingestion/safeguards.js';
import { SCHEDULE_CRON, SCHEDULE_TIMEZONE, CURRENT_YEAR_SCHEDULE, CLEANUP_SCHEDULE } from './config.js';

// Environment-based dry run flag
const DRY_RUN = process.env.MMDB_DRY_RUN === 'true';

/**
 * Scheduled MMDB ingestion function.
 *
 * Runs every 4 hours (6x daily) during initial backlog fill.
 * Change SCHEDULE_CRON to 'every 24 hours' once backlog is complete.
 */
export const mmdbIngest = onSchedule(
  {
    schedule: SCHEDULE_CRON,
    timeZone: SCHEDULE_TIMEZONE,
    timeoutSeconds: 540,
    memory: '512MiB',
    retryCount: 0, // Don't retry — function is idempotent but we don't want duplicate runs
  },
  async () => {
    // ─── Kill Switch ─────────────────────────────────────────────────────────
    if (isIngestionPaused()) {
      logger.info('Ingestion is paused via INGESTION_PAUSED env var — skipping scheduled run');
      return;
    }

    const startTime = Date.now();
    logger.info('MMDB ingestion triggered', {
      dryRun: DRY_RUN,
      schedule: SCHEDULE_CRON,
    });

    try {
      const result = await runIngestion(DRY_RUN);

      const durationMs = Date.now() - startTime;
      logger.info('MMDB ingestion completed', {
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        moviesIngested: result.moviesIngested,
        seriesIngested: result.seriesIngested,
        peopleIngested: result.peopleIngested,
        prsCreated: result.prsCreated,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 10), // Log first 10 errors
      });

      if (result.errors.length > 0) {
        logger.warn(`Ingestion completed with ${result.errors.length} errors`);
      }
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error('MMDB ingestion failed', {
        durationMs,
        error: error.message,
        stack: error.stack,
      });
      throw error; // Re-throw to mark the function execution as failed
    }
  }
);

/**
 * HTTP endpoint for manually triggering ingestion.
 *
 * POST /mmdbIngestManual
 * Headers:
 *   x-api-key: <your INGEST_API_KEY>
 * Query params:
 *   ?dryRun=true  — log actions without creating PRs
 *
 * Example:
 *   curl -X POST \
 *     -H "x-api-key: $INGEST_API_KEY" \
 *     "https://us-central1-mv-mmdb.cloudfunctions.net/mmdbIngestManual"
 */
export const mmdbIngestManual = onRequest(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    invoker: 'public',
  },
  async (req, res) => {
    // ─── Kill Switch ─────────────────────────────────────────────────────────
    if (isIngestionPaused()) {
      logger.info('Ingestion is paused via INGESTION_PAUSED env var — skipping manual run');
      res.status(200).json({ paused: true });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed. Use POST.' });
      return;
    }

    const apiKey = process.env.INGEST_API_KEY;
    const providedKey = req.headers['x-api-key'];

    if (!apiKey || providedKey !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const dryRun = req.query.dryRun === 'true' || DRY_RUN;
    const mode = req.query.mode as string | undefined;
    const startTime = Date.now();

    logger.info('MMDB manual ingestion triggered', { dryRun, mode: mode || 'backlog' });

    try {
      const result = mode === 'currentYear'
        ? await runCurrentYearIngestion(dryRun)
        : await runIngestion(dryRun);

      const durationMs = Date.now() - startTime;

      res.status(200).json({
        success: true,
        dryRun,
        durationSeconds: Math.round(durationMs / 1000),
        moviesIngested: result.moviesIngested,
        seriesIngested: result.seriesIngested,
        peopleIngested: result.peopleIngested,
        prsCreated: result.prsCreated,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 20),
      });
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error('Manual ingestion failed', { error: error.message, durationMs });

      res.status(500).json({
        success: false,
        dryRun,
        durationSeconds: Math.round(durationMs / 1000),
        error: error.message,
      });
    }
  }
);

/**
 * Scheduled current-year ingestion function.
 *
 * Runs nightly at 2 AM to ingest movies/series released in the current year.
 * Shares the concurrency lock with mmdbIngest — only one can run at a time.
 */
export const mmdbIngestCurrentYear = onSchedule(
  {
    schedule: CURRENT_YEAR_SCHEDULE,
    timeZone: SCHEDULE_TIMEZONE,
    timeoutSeconds: 540,
    memory: '512MiB',
    retryCount: 0,
  },
  async () => {
    // ─── Kill Switch ─────────────────────────────────────────────────────────
    if (isIngestionPaused()) {
      logger.info('Ingestion is paused via INGESTION_PAUSED env var — skipping current-year run');
      return;
    }

    const startTime = Date.now();
    logger.info('MMDB current-year ingestion triggered', {
      dryRun: DRY_RUN,
      schedule: CURRENT_YEAR_SCHEDULE,
    });

    try {
      const result = await runCurrentYearIngestion(DRY_RUN);

      const durationMs = Date.now() - startTime;
      logger.info('MMDB current-year ingestion completed', {
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        moviesIngested: result.moviesIngested,
        seriesIngested: result.seriesIngested,
        peopleIngested: result.peopleIngested,
        prsCreated: result.prsCreated,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 10),
      });

      if (result.errors.length > 0) {
        logger.warn(`Current-year ingestion completed with ${result.errors.length} errors`);
      }
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error('MMDB current-year ingestion failed', {
        durationMs,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
);

/**
 * Scheduled Q-ID cleanup function.
 *
 * Runs weekly on Sunday at 4 AM to remove entries with Wikidata Q-ID titles
 * (no human-readable label) from year repos. Only deletes entries without
 * external IDs (IMDb/TMDB). Entries with external IDs are logged for future
 * re-resolution.
 */
export const mmdbCleanupQIds = onSchedule(
  {
    schedule: CLEANUP_SCHEDULE,
    timeZone: SCHEDULE_TIMEZONE,
    timeoutSeconds: 540,
    memory: '256MiB',
    retryCount: 0,
  },
  async () => {
    if (isIngestionPaused()) {
      logger.info('Ingestion is paused — skipping Q-ID cleanup');
      return;
    }

    const startTime = Date.now();
    logger.info('Q-ID cleanup triggered', { schedule: CLEANUP_SCHEDULE });

    try {
      const results = await runCleanup(DRY_RUN);

      const durationMs = Date.now() - startTime;
      const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
      const totalScanned = results.reduce((sum, r) => sum + r.scanned, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

      logger.info('Q-ID cleanup completed', {
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        reposChecked: results.length,
        totalScanned,
        totalDeleted,
        prsCreated: results.filter(r => r.prCreated).map(r => r.prCreated),
        totalErrors,
      });
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error('Q-ID cleanup failed', {
        durationMs,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
);
