#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

interface IndexEntry {
  id: string;
  [key: string]: any;
}

function buildMovieIndex(moviesPath: string): IndexEntry[] {
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

function buildSeriesIndex(seriesPath: string): IndexEntry[] {
  const index: IndexEntry[] = [];
  const dirs = readdirSync(seriesPath);
  
  for (const dir of dirs) {
    const dirPath = join(seriesPath, dir);
    const stat = statSync(dirPath);
    
    if (stat.isDirectory()) {
      const metaPath = join(dirPath, 'meta.json');
      try {
        const content = JSON.parse(readFileSync(metaPath, 'utf-8'));
        
        index.push({
          id: content.id,
          title: content.title,
          start_year: content.start_year,
          end_year: content.end_year,
          path: `data/series/${dir}/meta.json`
        });
      } catch {
        // Skip if meta.json doesn't exist
      }
    }
  }
  
  return index.sort((a, b) => a.id.localeCompare(b.id));
}

function buildPeopleIndex(peoplePath: string): IndexEntry[] {
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

main();
