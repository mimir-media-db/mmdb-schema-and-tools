/**
 * Progress tracker for long-running operations.
 */
export function createProgress(total, label = 'Progress') {
  let current = 0;
  const startTime = Date.now();
  
  return {
    tick(stepLabel = '') {
      current++;
      const pct = Math.round((current / total) * 100);
      const elapsed = Date.now() - startTime;
      const avgPerItem = elapsed / current;
      const remaining = Math.round((total - current) * avgPerItem / 1000);
      const eta = remaining > 60 ? `${Math.floor(remaining/60)}m ${remaining%60}s` : `${remaining}s`;
      const bar = '█'.repeat(Math.floor(pct/5)) + '░'.repeat(20 - Math.floor(pct/5));
      process.stdout.write(`\r[${bar}] ${pct}% (${current}/${total}) ETA: ${eta} ${stepLabel}`.padEnd(100) + '\r');
    },
    done() {
      const elapsed = Date.now() - startTime;
      const duration = elapsed > 60000 ? `${Math.floor(elapsed/60000)}m ${Math.floor((elapsed%60000)/1000)}s` : `${Math.floor(elapsed/1000)}s`;
      process.stdout.write('\n');
      return duration;
    },
    log(msg) {
      // Print message on new line without breaking progress bar
      process.stdout.write('\n');
      console.log(msg);
    }
  };
}

/**
 * Track download progress for fetch responses.
 * @param {Response} response - fetch Response object
 * @param {string} label - what's being downloaded
 * @returns {Promise<Buffer>} downloaded content
 */
export async function trackDownload(response, label = 'Downloading') {
  const contentLength = parseInt(response.headers.get('content-length') || '0');
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength > 0) {
      const pct = Math.round((received / contentLength) * 100);
      const mb = (received / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r  ${label}: ${mb}MB (${pct}%)`.padEnd(60) + '\r');
    } else {
      const mb = (received / 1024 / 1024).toFixed(1);
      process.stdout.write(`\r  ${label}: ${mb}MB`.padEnd(60) + '\r');
    }
  }
  process.stdout.write('\n');
  return Buffer.concat(chunks);
}
