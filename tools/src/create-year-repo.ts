#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const README_TEMPLATE = (year: string) => `# MMDB ${year}

> Media metadata for titles released in ${year}.

## Structure

\`\`\`
data/
  movies/
    index.json
  series/
    index.json
\`\`\`

## Contributing

See [mmdb-schema-and-tools](https://github.com/mimir-media-db/mmdb-schema-and-tools) for contribution guidelines.

## License

MIT
`;

const WORKFLOW_TEMPLATE = `name: Validate and Build

on:
  pull_request:
    branches: [master]
  push:
    branches: [master]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          path: repo
      
      - uses: actions/checkout@v4
        with:
          repository: mimir-media-db/mmdb-schema-and-tools
          path: tools
      
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      
      - name: Build tools
        run: |
          cd tools
          npm install
          npm run build
      
      - name: Install dependencies
        run: |
          cd repo
          npm install
      
      - name: Validate
        run: |
          cd repo
          ../tools/dist/validate-repo.js
      
      - name: Build indexes
        run: |
          cd repo
          ../tools/dist/build-indexes.js
      
      - name: Check for index changes
        id: check_changes
        run: |
          cd repo
          git diff --exit-code data/*/index.json || echo "changed=true" >> $GITHUB_OUTPUT
      
      - name: Commit index updates
        if: steps.check_changes.outputs.changed == 'true' && github.event_name == 'push'
        run: |
          cd repo
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/*/index.json
          git commit -m "Update indexes [skip ci]"
          git push
`;

function main() {
  const args = process.argv.slice(2);
  const year = args.find(arg => arg.startsWith('--year='))?.split('=')[1];
  const outputPath = args.find(arg => arg.startsWith('--output='))?.split('=')[1] || '.';
  
  if (!year) {
    console.error('Error: --year parameter is required');
    console.log('Usage: create-year-repo --year=YYYY [--output=path]');
    process.exit(1);
  }
  
  const repoPath = join(outputPath, `mmdb-${year}`);
  
  console.log(`Creating repository: ${repoPath}\n`);
  
  // Create directory structure
  mkdirSync(join(repoPath, 'data', 'movies'), { recursive: true });
  mkdirSync(join(repoPath, 'data', 'series'), { recursive: true });
  mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
  
  // Create empty index files
  writeFileSync(join(repoPath, 'data', 'movies', 'index.json'), '[]\\n', 'utf-8');
  writeFileSync(join(repoPath, 'data', 'series', 'index.json'), '[]\\n', 'utf-8');
  
  // Create README
  writeFileSync(join(repoPath, 'README.md'), README_TEMPLATE(year), 'utf-8');
  
  // Create workflow
  writeFileSync(join(repoPath, '.github', 'workflows', 'validate.yml'), WORKFLOW_TEMPLATE, 'utf-8');
  
  // Create .gitignore
  writeFileSync(join(repoPath, '.gitignore'), 'node_modules/\\n.DS_Store\\n', 'utf-8');
  
  console.log('✓ Repository structure created');
  console.log('\\nNext steps:');
  console.log(`  cd ${repoPath}`);
  console.log('  git init');
  console.log('  git add .');
  console.log('  git commit -m "Initial commit"');
}

main();
