#!/usr/bin/env node
import { buildPersonQuery, queryWikidata, parsePersonResults } from './ingestion/wikidata-client.js';
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
  
  // Get people from pending PRs
  console.log('Checking for people in pending PRs...');
  const pendingIds = await github.getPeopleInPendingPRs(repo);
  console.log(`Found ${pendingIds.size} people in pending PRs\n`);
  
  // Query Wikidata - fetch 3x to account for duplicates
  console.log('Querying Wikidata...');
  const sparql = buildPersonQuery(limit * 3, 0);
  const results = await queryWikidata(sparql);
  const people = parsePersonResults(results);
  
  console.log(`Found ${people.length} people from Wikidata\n`);
  
  if (people.length === 0) {
    console.log('No people to process');
    return;
  }
  
  // Filter and validate people
  const peopleToAdd: any[] = [];
  let skipped = 0;
  
  for (const wikiPerson of people) {
    // Stop if we have enough
    if (peopleToAdd.length >= limit) {
      break;
    }
    
    const person = normalizePerson(wikiPerson);
    
    // Check for duplicates in master
    if (existingIds.has(person.id)) {
      console.log(`⊘ Skipping ${person.name}: already exists in master (${person.id})`);
      skipped++;
      continue;
    }
    
    // Check for duplicates in pending PRs
    if (pendingIds.has(person.id)) {
      console.log(`⊘ Skipping ${person.name}: already in pending PR (${person.id})`);
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
  
  // Create branch
  const branchName = `ingest-people-${Date.now()}`;
  console.log(`\nCreating branch: ${branchName}`);
  await github.createBranch(repo, branchName);
  
  // Add people to PR
  let added = 0;
  for (const person of peopleToAdd) {
    await github.addPersonToPR(repo, branchName, person);
    added++;
  }
  
  // Create PR
  console.log(`\nCreating pull request...`);
  const prNumber = await github.createPullRequest(
    repo,
    `Add ${added} people`,
    branchName,
    'master',
    `Automated ingestion from Wikidata.\n\nPeople added: ${added}\nPeople skipped: ${skipped} (duplicates or validation failures)`
  );
  
  console.log(`✓ Pull request created: #${prNumber}`);
  
  console.log(`\nIngestion complete. Added: ${added}, Skipped: ${skipped}`);
}

main().catch(error => {
  console.error('Ingestion failed:', error);
  process.exit(1);
});
