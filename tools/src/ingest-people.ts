#!/usr/bin/env node
import { buildPersonQueryFromMovies, queryWikidata, parsePersonResults } from './ingestion/wikidata-client.js';
import { normalizePerson } from './ingestion/normalizer.js';
import { GitHubClient } from './ingestion/github-client.js';
import { loadSchema } from './shared-config.js';

async function main() {
  const args = process.argv.slice(2);
  const limit = parseInt(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '10');
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.error('Error: GITHUB_TOKEN environment variable required');
    process.exit(1);
  }
  
  console.log(`Starting people ingestion (limit: ${limit})\n`);
  
  const github = new GitHubClient(token);
  const validator = loadSchema('person-v1');
  const repo = 'mmdb-people';
  
  // Get existing people from master
  console.log('Checking for existing people in master...');
  const existingIds = await github.getExistingPeopleIds(repo);
  console.log(`Found ${existingIds.size} existing people\n`);
  
  // Get all movie Wikidata IDs
  console.log('Fetching movie Wikidata IDs from repos...');
  const movieWikidataIds = await github.getAllMovieWikidataIds();
  console.log(`Found ${movieWikidataIds.length} movies with Wikidata IDs\n`);
  
  if (movieWikidataIds.length === 0) {
    console.log('No movies found with Wikidata IDs');
    return;
  }
  
  // Query Wikidata for cast members - process in batches to avoid query size limits
  const batchSize = 50;
  const allPeople: any[] = [];
  
  for (let i = 0; i < movieWikidataIds.length; i += batchSize) {
    const batch = movieWikidataIds.slice(i, i + batchSize);
    console.log(`Querying Wikidata for cast members (batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(movieWikidataIds.length/batchSize)})...`);
    
    const sparql = buildPersonQueryFromMovies(batch, limit * 3);
    const results = await queryWikidata(sparql);
    const people = parsePersonResults(results);
    
    allPeople.push(...people);
    console.log(`Found ${people.length} people in this batch`);
    
    // Stop if we have enough
    if (allPeople.length >= limit * 3) {
      break;
    }
    
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log(`\nTotal people found: ${allPeople.length}\n`);
  
  if (allPeople.length === 0) {
    console.log('No people to process');
    return;
  }
  
  // Filter and validate people
  const peopleToAdd: any[] = [];
  let skipped = 0;
  
  for (const wikiPerson of allPeople) {
    // Stop if we have enough
    if (peopleToAdd.length >= limit) {
      break;
    }
    
    const person = normalizePerson(wikiPerson);
    
    // Skip if normalizer rejected (ancient person, etc.)
    if (!person) {
      skipped++;
      continue;
    }

    // Check for duplicates in master
    if (existingIds.has(person.id)) {
      skipped++;
      continue;
    }
    
    // Validate
    if (!validator.validate(person)) {
      console.log(`✗ Skipping ${person.name}: validation failed`);
      console.log(validator.errors);
      skipped++;
      continue;
    }
    
    peopleToAdd.push(person);
    console.log(`✓ Will add ${person.name} (${person.id})`);
  }
  
  // Create PR if we have people
  if (peopleToAdd.length === 0) {
    console.log(`\nNo new people to add (${skipped} skipped)`);
    return;
  }
  
  console.log(`\nReady to add ${peopleToAdd.length} people (${skipped} skipped)`);
  console.log('PR creation disabled for testing');
  
  // TODO: Uncomment when ready for production
  // // Create branch
  // const branchName = `ingest-people-${Date.now()}`;
  // console.log(`\nCreating branch: ${branchName}`);
  // await github.createBranch(repo, branchName);
  // 
  // // Add people to PR
  // let added = 0;
  // for (const person of peopleToAdd) {
  //   await github.addPersonToPR(repo, branchName, person);
  //   added++;
  // }
  // 
  // // Create PR
  // console.log(`\nCreating pull request...`);
  // const prNumber = await github.createPullRequest(
  //   repo,
  //   `Add ${added} people`,
  //   branchName,
  //   'master',
  //   `Automated ingestion from Wikidata.\n\nPeople added: ${added}\nPeople skipped: ${skipped} (duplicates or validation failures)`
  // );
  // 
  // console.log(`✓ Pull request created: #${prNumber}`);
  // 
  // console.log(`\nIngestion complete. Added: ${added}, Skipped: ${skipped}`);
}

main().catch(error => {
  console.error('Ingestion failed:', error);
  process.exit(1);
});
