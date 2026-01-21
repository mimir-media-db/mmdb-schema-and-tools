#!/usr/bin/env node
import { buildSeriesQuery, queryWikidata, parseSeriesResults } from './ingestion/wikidata-client.js';
import { normalizeSeries } from './ingestion/normalizer.js';
import { GitHubClient } from './ingestion/github-client.js';
import { loadSchema } from './shared-config.js';

async function main() {
  const args = process.argv.slice(2);
  const year = parseInt(args.find(arg => arg.startsWith('--year='))?.split('=')[1] || '2010');
  const limit = parseInt(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '10');
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable required');
    process.exit(1);
  }
  
  console.log(`Starting series ingestion for ${year} (limit: ${limit})\n`);
  
  const github = new GitHubClient(token);
  const validator = loadSchema('series-v1');
  const repo = `mmdb-${year}`;
  
  // Get existing series from master
  console.log('Checking for existing series in master...');
  const existingIds = await github.getExistingSeriesIds(repo);
  console.log(`Found ${existingIds.size} existing series\n`);
  
  // Query Wikidata - fetch 3x to account for duplicates
  console.log('Querying Wikidata...');
  const sparql = buildSeriesQuery(year, limit * 3, 0);
  const results = await queryWikidata(sparql);
  const seriesList = parseSeriesResults(results);
  
  console.log(`Found ${seriesList.length} series from Wikidata\n`);
  
  if (seriesList.length === 0) {
    console.log('No series to process');
    return;
  }
  
  // Filter and validate series
  const seriesToAdd: any[] = [];
  let skipped = 0;
  
  for (const wikiSeries of seriesList) {
    // Stop if we have enough
    if (seriesToAdd.length >= limit) {
      break;
    }
    
    const series = normalizeSeries(wikiSeries);
    
    // Check for duplicates in master
    if (existingIds.has(series.id)) {
      skipped++;
      continue;
    }
    
    // Validate
    if (!validator.validate(series)) {
      console.log(`✗ Skipping ${series.title}: validation failed`);
      console.log(validator.errors);
      skipped++;
      continue;
    }
    
    seriesToAdd.push(series);
    console.log(`✓ Will add ${series.title} (${series.id})`);
  }
  
  // Create PR if we have series
  if (seriesToAdd.length === 0) {
    console.log(`\nNo new series to add (${skipped} skipped)`);
    return;
  }
  
  console.log(`\nReady to add ${seriesToAdd.length} series (${skipped} skipped)`);
  console.log('PR creation disabled for testing');
  
  // TODO: Uncomment when ready for production
  // const branchName = `ingest-series-${Date.now()}`;
  // console.log(`\nCreating branch: ${branchName}`);
  // await github.createBranch(repo, branchName);
  // 
  // let added = 0;
  // for (const series of seriesToAdd) {
  //   await github.addSeriesToPR(repo, branchName, series);
  //   added++;
  // }
  // 
  // console.log(`\nCreating pull request...`);
  // const prNumber = await github.createPullRequest(
  //   repo,
  //   `Add ${added} series`,
  //   branchName,
  //   'master',
  //   `Automated ingestion from Wikidata.\n\nSeries added: ${added}\nSeries skipped: ${skipped}`
  // );
  // 
  // console.log(`✓ Pull request created: #${prNumber}`);
}

main().catch(error => {
  console.error('Ingestion failed:', error);
  process.exit(1);
});
