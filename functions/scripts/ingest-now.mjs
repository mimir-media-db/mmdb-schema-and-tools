import { readFileSync } from 'fs';
import https from 'https';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('='))
);

console.log('Triggering ingestion...');
console.log('Waiting up to 10 minutes for response...\n');

const result = await new Promise((resolve, reject) => {
  const urlObj = new URL(env.FUNCTION_URL);
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
