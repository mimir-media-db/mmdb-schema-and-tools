#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { buildMovieQuery, queryWikidata, parseMovieResults } from './ingestion/wikidata-client.js';
import { normalizeMovie } from './ingestion/normalizer.js';
import { GitHubClient } from './ingestion/github-client.js';
import { loadSchema } from './shared-config.js';

interface IngestionState {
  year: number;
  offset: number;
  totalProcessed: number;
  lastRun: string;
}

const STATE_FILE = '.ingestion-state.json';

function loadState(year: number): IngestionState {
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (state.year === year) {
      return state;
    }
  }
  
  return {
    year,
    offset: 0,
    totalProcessed: 0,
    lastRun: new Date().toISOString()
  };
}

function saveState(state: IngestionState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function main() {
  const args = process.argv.slice(2);
  const year = parseInt(args.find(arg => arg.startsWith('--year='))?.split('=')[1] || '2010');
  const limit = parseInt(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '10');
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable required');
    process.exit(1);
  }
  
  console.log(`Starting ingestion for year ${year} (limit: ${limit})\n`);
  
  const state = loadState(year);
  const github = new GitHubClient(token);
  const validator = loadSchema('movie-v1');
  
  // Query Wikidata
  console.log('Querying Wikidata...');
  const sparql = buildMovieQuery(year, limit, state.offset);
  const results = await queryWikidata(sparql);
  const movies = parseMovieResults(results);
  
  console.log(`Found ${movies.length} movies\n`);
  
  if (movies.length === 0) {
    console.log('No more movies to process');
    return;
  }
  
  // Create branch
  const branchName = `ingest-${year}-${Date.now()}`;
  const repo = `mmdb-${year}`;
  
  console.log(`Creating branch: ${branchName}`);
  await github.createBranch(repo, branchName);
  
  // Get existing movie IDs to prevent duplicates
  console.log('Checking for existing movies...');
  const existingIds = await github.getExistingMovieIds(repo);
  console.log(`Found ${existingIds.size} existing movies\n`);
  
  // Process movies
  let added = 0;
  let skipped = 0;
  for (const wikiMovie of movies) {
    const movie = normalizeMovie(wikiMovie);
    
    // Check for duplicates
    if (existingIds.has(movie.id)) {
      console.log(`⊘ Skipping ${movie.title}: already exists (${movie.id})`);
      skipped++;
      continue;
    }
    
    // Validate
    if (!validator.validate(movie)) {
      console.log(`✗ Skipping ${movie.title}: validation failed`);
      console.log(validator.errors);
      skipped++;
      continue;
    }
    
    // Add to PR
    await github.addMovieToPR(repo, branchName, movie);
    console.log(`✓ Added ${movie.title} (${movie.id})`);
    added++;
  }
  
  // Create PR
  if (added > 0) {
    console.log(`\nCreating pull request...`);
    const prNumber = await github.createPullRequest(
      repo,
      `Add ${added} movies from ${year}`,
      branchName,
      'master',
      `Automated ingestion from Wikidata.\n\nMovies added: ${added}\nMovies skipped: ${skipped} (duplicates or validation failures)`
    );
    
    console.log(`✓ Pull request created: #${prNumber}`);
  } else {
    console.log(`\nNo new movies to add (${skipped} skipped)`);
  }
  
  // Update state
  state.offset += limit;
  state.totalProcessed += added;
  state.lastRun = new Date().toISOString();
  saveState(state);
  
  console.log(`\nIngestion complete. Added: ${added}, Skipped: ${skipped}`);
}

main().catch(error => {
  console.error('Ingestion failed:', error);
  process.exit(1);
});
