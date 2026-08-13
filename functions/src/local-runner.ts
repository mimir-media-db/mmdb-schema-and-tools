/**
 * Local runner for MMDB ingestion — runs without Firebase deployment.
 * State is stored in mmdb-meta repo via GitHub API.
 *
 * Usage:
 *   yarn ingest:local          # dry run by default
 *   yarn ingest:local --live   # actually create PRs
 */

import { runIngestion } from './ingestion/orchestrator.js';

const args = process.argv.slice(2);
const dryRun = !args.includes('--live');

console.log(`\n🚀 MMDB Local Ingestion`);
console.log(`   Mode: ${dryRun ? '🧪 DRY RUN (no PRs)' : '⚡ LIVE (will create PRs)'}\n`);

const start = Date.now();

runIngestion(dryRun)
  .then((result) => {
    const duration = Math.round((Date.now() - start) / 1000);
    console.log(`\n✅ Ingestion complete (${duration}s)`);
    console.log(`   Movies:  ${result.moviesIngested}`);
    console.log(`   Series:  ${result.seriesIngested}`);
    console.log(`   People:  ${result.peopleIngested}`);
    console.log(`   PRs:     ${result.prsCreated.length ? result.prsCreated.join(', ') : 'none'}`);
    if (result.errors.length > 0) {
      console.log(`   Errors:  ${result.errors.length}`);
      result.errors.slice(0, 10).forEach(e => console.log(`     - ${e}`));
    }
  })
  .catch((error) => {
    console.error(`\n❌ Ingestion failed: ${error.message}`);
    process.exit(1);
  });
