import { readFileSync } from 'fs';
import http from 'http';
import https from 'https';

const isDry = process.argv.includes('--dry');

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('='))
);

const dryParam = isDry ? '&dryRun=true' : '';
const url = `${env.FUNCTION_URL}?mode=currentYear${dryParam}`;

console.log(`Triggering current-year ingestion${isDry ? ' (dry run)' : ''}...`);
console.log(`URL: ${url}`);
console.log('Waiting up to 10 minutes for response...\n');

// Use raw https.request for full timeout control
const result = await new Promise((resolve, reject) => {
  const urlObj = new URL(url);
  const req = https.request({
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    method: 'POST',
    headers: { 'x-api-key': env.INGEST_API_KEY },
    timeout: 600_000,
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => resolve(JSON.parse(data)));
  });
  req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (10 min)')); });
  req.on('error', reject);
  req.end();
});

console.log(result);
