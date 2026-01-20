#!/usr/bin/env node
import { buildMovieQuery, queryWikidata, parseMovieResults } from './ingestion/wikidata-client.js';
import { normalizeMovie } from './ingestion/normalizer.js';
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
  
  console.log(`Starting ingestion for year ${year} (limit: ${limit})\n`);
  
  const github = new GitHubClient(token);
  const validator = loadSchema('movie-v1');
  const repo = `mmdb-${year}`;
  
  // Get existing movies from master (source of truth)
  console.log('Checking for existing movies in master...');
  const existingIds = await github.getExistingMovieIds(repo);
  console.log(`Found ${existingIds.size} existing movies\n`);
  
  // Get movies from pending PRs (to avoid duplicates)
  console.log('Checking for movies in pending PRs...');
  const pendingIds = await github.getMoviesInPendingPRs(repo);
  console.log(`Found ${pendingIds.size} movies in pending PRs\n`);
  
  // Query Wikidata - fetch more than we need to account for duplicates
  console.log('Querying Wikidata...');
  const sparql = buildMovieQuery(year, limit * 3, 0); // Fetch 3x to ensure we get enough unique ones
  const results = await queryWikidata(sparql);
  const movies = parseMovieResults(results);
  
  console.log(`Found ${movies.length} movies from Wikidata\n`);
  
  if (movies.length === 0) {
    console.log('No more movies to process');
    return;
  }
  
  // Filter and validate movies
  const moviesToAdd: any[] = [];
  let skipped = 0;
  
  for (const wikiMovie of movies) {
    // Stop if we have enough movies
    if (moviesToAdd.length >= limit) {
      break;
    }
    
    const movie = normalizeMovie(wikiMovie);
    
    // Check for duplicates in master branch
    if (existingIds.has(movie.id)) {
      console.log(`⊘ Skipping ${movie.title}: already exists in master (${movie.id})`);
      skipped++;
      continue;
    }
    
    // Check for duplicates in pending PRs
    if (pendingIds.has(movie.id)) {
      console.log(`⊘ Skipping ${movie.title}: already in pending PR (${movie.id})`);
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
    
    moviesToAdd.push(movie);
    console.log(`✓ Will add ${movie.title} (${movie.id})`);
  }
  
  // Create PR if we have movies
  if (moviesToAdd.length === 0) {
    console.log(`\nNo new movies to add (${skipped} skipped)`);
    return;
  }
  
  // Create branch
  const branchName = `ingest-${year}-${Date.now()}`;
  console.log(`\nCreating branch: ${branchName}`);
  await github.createBranch(repo, branchName);
  
  // Add movies to PR
  let added = 0;
  for (const movie of moviesToAdd) {
    await github.addMovieToPR(repo, branchName, movie);
    added++;
  }
  
  // Create PR (we know added > 0 because we checked before creating branch)
  console.log(`\nCreating pull request...`);
  const prNumber = await github.createPullRequest(
    repo,
    `Add ${added} movies from ${year}`,
    branchName,
    'master',
    `Automated ingestion from Wikidata.\n\nMovies added: ${added}\nMovies skipped: ${skipped} (duplicates or validation failures)`
  );
  
  console.log(`✓ Pull request created: #${prNumber}`);
  
  console.log(`\nIngestion complete. Added: ${added}, Skipped: ${skipped}`);
}

main().catch(error => {
  console.error('Ingestion failed:', error);
  process.exit(1);
});
