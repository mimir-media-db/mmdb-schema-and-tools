#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { loadSchema, getSchemaForEntity } from './shared-config.js';

interface ValidationResult {
  valid: boolean;
  errors: Array<{ file: string; errors: any[] }>;
}

function validateFile(filePath: string, entityType: string): { valid: boolean; errors: any[] } {
  try {
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    const schemaVersion = content.schema_version || 1;
    const schemaName = getSchemaForEntity(entityType, schemaVersion);
    const validator = loadSchema(schemaName);
    
    const valid = validator.validate(content);
    return { valid, errors: validator.errors || [] };
  } catch (error) {
    return { valid: false, errors: [{ message: (error as Error).message }] };
  }
}

function validateDirectory(dirPath: string, entityType: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [] };
  
  try {
    const files = readdirSync(dirPath);
    
    for (const file of files) {
      const filePath = join(dirPath, file);
      const stat = statSync(filePath);
      
      if (stat.isDirectory()) {
        const subResult = validateDirectory(filePath, entityType);
        if (!subResult.valid) {
          result.valid = false;
          result.errors.push(...subResult.errors);
        }
      } else if (file.endsWith('.json') && file !== 'index.json') {
        const fileResult = validateFile(filePath, entityType);
        if (!fileResult.valid) {
          result.valid = false;
          result.errors.push({ file: filePath, errors: fileResult.errors });
        }
      }
    }
  } catch (error) {
    result.valid = false;
    result.errors.push({ file: dirPath, errors: [{ message: (error as Error).message }] });
  }
  
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const repoPath = args.find(arg => arg.startsWith('--repo-path='))?.split('=')[1] || '.';
  const dataPath = resolve(repoPath, 'data');
  
  console.log(`Validating repository: ${repoPath}\n`);
  
  let allValid = true;
  const entityTypes = [
    { dir: 'movies', type: 'movie' },
    { dir: 'series', type: 'series' },
    { dir: 'people', type: 'person' }
  ];
  
  for (const { dir, type } of entityTypes) {
    const entityPath = join(dataPath, dir);
    
    try {
      statSync(entityPath);
      console.log(`Validating ${dir}...`);
      
      const result = validateDirectory(entityPath, type);
      
      if (result.valid) {
        console.log(`✓ ${dir} validation passed\n`);
      } else {
        console.log(`✗ ${dir} validation failed:`);
        result.errors.forEach(({ file, errors }) => {
          console.log(`  ${file}:`);
          errors.forEach(err => console.log(`    - ${err.message || JSON.stringify(err)}`));
        });
        console.log();
        allValid = false;
      }
    } catch {
      console.log(`⊘ ${dir} directory not found, skipping\n`);
    }
  }
  
  if (allValid) {
    console.log('✓ All validations passed');
    process.exit(0);
  } else {
    console.log('✗ Validation failed');
    process.exit(1);
  }
}

main();
