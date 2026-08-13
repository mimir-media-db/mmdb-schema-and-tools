/**
 * Configuration constants for the MMDB ingestion pipeline.
 */

/** Maximum number of titles (movies + series) to ingest per run */
export const MAX_TITLES_PER_RUN = 100;

/** Number of backlog titles to fetch per run */
export const BACKLOG_LIMIT = 60;

/** Number of recent titles to fetch per run */
export const RECENT_LIMIT = 40;

/** Delay between Wikidata API queries in milliseconds */
export const WIKIDATA_RATE_LIMIT_MS = 1000;

/** GitHub organization name */
export const GITHUB_ORG = 'mimir-media-db';

/** People repository name */
export const PEOPLE_REPO = 'mmdb-people';

/** Cloud Function schedule (cron expression) — 3 times daily for initial backlog fill */
export const SCHEDULE_CRON = 'every 8 hours';

/** Cloud Function timezone */
export const SCHEDULE_TIMEZONE = 'America/Chicago';

/** Maximum people to fetch per run (based on newly ingested movies) */
export const MAX_PEOPLE_PER_QUERY = 200;

/** Default starting year for backlog processing */
export const DEFAULT_START_YEAR = 2010;

/** Current year ceiling — don't process years beyond this */
export const MAX_YEAR = new Date().getFullYear();

/** Branch name prefix for ingestion PRs */
export const BRANCH_PREFIX = 'mmdb-ingest';

/** Lock timeout in milliseconds — stale locks older than this are broken (10 min) */
export const LOCK_TIMEOUT_MS = 600_000;

/** Number of consecutive empty runs before auto-pausing ingestion */
export const MAX_EMPTY_RUNS = 3;

/** Maximum results from a single Wikidata query before we consider it garbage */
export const MAX_RESULTS_SANITY = 2000;
