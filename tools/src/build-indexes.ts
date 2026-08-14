#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface IndexEntry {
  id: string;
  [key: string]: any;
}

export function buildMovieIndex(moviesPath: string): IndexEntry[] {
  const index: IndexEntry[] = [];
  const files = readdirSync(moviesPath);
  
  for (const file of files) {
    if (file.endsWith('.json') && file !== 'index.json') {
      const filePath = join(moviesPath, file);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      
      index.push({
        id: content.id,
        title: content.title,
        year: content.year,
        type: content.type,
        runtime_minutes: content.runtime_minutes,
        path: `data/movies/${file}`
      });
    }
  }
  
  return index.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildSeriesIndex(seriesPath: string): IndexEntry[] {
  const index: IndexEntry[] = [];
  const entries = readdirSync(seriesPath);
  
  for (const entry of entries) {
    if (entry === 'index.json') continue;
    
    const entryPath = join(seriesPath, entry);
    const stat = statSync(entryPath);
    
    if (stat.isFile() && entry.endsWith('.json')) {
      // Flat file format: data/series/name.json
      const content = JSON.parse(readFileSync(entryPath, 'utf-8'));
      index.push({
        id: content.id,
        title: content.title,
        start_year: content.start_year,
        end_year: content.end_year,
        path: `data/series/${entry}`
      });
    } else if (stat.isDirectory()) {
      // Directory format: data/series/name/meta.json (legacy)
      const metaPath = join(entryPath, 'meta.json');
      try {
        const content = JSON.parse(readFileSync(metaPath, 'utf-8'));
        index.push({
          id: content.id,
          title: content.title,
          start_year: content.start_year,
          end_year: content.end_year,
          path: `data/series/${entry}/meta.json`
        });
      } catch {
        // Skip if meta.json doesn't exist
      }
    }
  }
  
  return index.sort((a, b) => a.id.localeCompare(b.id));
}

export function buildPeopleIndex(peoplePath: string): IndexEntry[] {
  const index: IndexEntry[] = [];
  const files = readdirSync(peoplePath);
  
  for (const file of files) {
    if (file.endsWith('.json') && file !== 'index.json') {
      const filePath = join(peoplePath, file);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      
      index.push({
        id: content.id,
        name: content.name,
        birth_year: content.birth_year,
        path: `data/people/${file}`
      });
    }
  }
  
  return index.sort((a, b) => a.id.localeCompare(b.id));
}

function main() {
  const args = process.argv.slice(2);
  const repoPath = args.find(arg => arg.startsWith('--repo-path='))?.split('=')[1] || '.';
  const dataPath = resolve(repoPath, 'data');
  
  console.log(`Building indexes for: ${repoPath}\n`);
  
  const entityTypes = [
    { name: 'movies', builder: buildMovieIndex },
    { name: 'series', builder: buildSeriesIndex },
    { name: 'people', builder: buildPeopleIndex }
  ];
  
  for (const { name, builder } of entityTypes) {
    const entityPath = join(dataPath, name);
    
    try {
      statSync(entityPath);
      console.log(`Building ${name} index...`);
      
      const index = builder(entityPath);
      const indexPath = join(entityPath, 'index.json');
      
      writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
      console.log(`✓ ${name} index created (${index.length} entries)\n`);
    } catch {
      console.log(`⊘ ${name} directory not found, skipping\n`);
    }
  }
  
  console.log('✓ Index building complete');
}

// Run main only when executed directly
const isMainModule = process.argv[1]?.endsWith('build-indexes.js') ||
                     process.argv[1]?.endsWith('build-indexes.ts');
if (isMainModule) {
  main();
}
