/**
 * Configuration constants for the MMDB ingestion pipeline.
 */

/** Maximum number of titles (movies + series) to ingest per run */
export const MAX_TITLES_PER_RUN = 200;

/** Number of backlog titles to fetch per run (total: forward + backward) */
export const BACKLOG_LIMIT = 200;

/** Backlog budget split: titles for forward pass (2010 → current year) */
export const FORWARD_BACKLOG_LIMIT = 100;

/** Backlog budget split: titles for backward pass (2009 → 1888) */
export const BACKWARD_BACKLOG_LIMIT = 100;

/** Number of recent titles to fetch per run */
export const RECENT_LIMIT = 100;

/** Delay between Wikidata API queries in milliseconds */
export const WIKIDATA_RATE_LIMIT_MS = 500;

/** GitHub organization name */
export const GITHUB_ORG = 'mimir-media-db';

/** People repository name */
export const PEOPLE_REPO = 'mmdb-people';

/** Cloud Function schedule (cron expression) — 6 times daily for backlog fill */
export const SCHEDULE_CRON = 'every 4 hours';

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

/** Maximum repos to create per ingestion run */
export const MAX_REPOS_PER_RUN = 1;

/** Current year ingestion: movies per run */
export const CURRENT_YEAR_MOVIES_LIMIT = 100;

/** Current year ingestion: series per run */
export const CURRENT_YEAR_SERIES_LIMIT = 50;

/** Nightly schedule for current year */
export const CURRENT_YEAR_SCHEDULE = 'every day 02:00';

/** Minimum year for repo creation (first motion picture) */
export const MIN_YEAR = 1888;

/** Minimum year for backward backlog (first films ever made) */
export const MIN_BACKLOG_YEAR = 1888;

/** Maximum run duration in milliseconds before graceful shutdown (8 min, hard limit is 9 min) */
export const RUN_TIMEOUT_MS = 480_000;

/** Current year full scan limit — fetch all titles for dedup (no offset pagination) */
export const CURRENT_YEAR_FULL_SCAN_LIMIT = 2000;

/** Hours to look back for recently modified films in the catch-up pass */
export const RECENT_MODIFIED_HOURS = 48;

/** Maximum recently modified titles to fetch in catch-up pass */
export const RECENT_MODIFIED_LIMIT = 200;

/** Languages for Wikidata label service (priority order) */
export const LABEL_LANGUAGES = 'en,es,fr,de,pt,it,ja,ko,zh,ar,hi,ru';

/** Weekly cleanup schedule */
export const CLEANUP_SCHEDULE = 'every sunday 04:00';

/** Year repos to check for cleanup (current year + last 2) */
export const CLEANUP_YEAR_RANGE = 3;
