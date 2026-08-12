import { readFileSync } from 'fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('='))
);

const res = await fetch(`${env.FUNCTION_URL}?dryRun=true`, {
  method: 'POST',
  headers: { 'x-api-key': env.INGEST_API_KEY },
  signal: AbortSignal.timeout(600_000), // 10 minutes
});

console.log(await res.json());
