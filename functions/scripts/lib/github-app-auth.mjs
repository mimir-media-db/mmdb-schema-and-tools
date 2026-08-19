/**
 * GitHub App Authentication Helper
 *
 * Generates a GitHub App installation access token using Node.js built-in crypto.
 * Same flow as @octokit/auth-app but with zero dependencies.
 *
 * Steps:
 * 1. Create JWT signed with App private key (RS256)
 * 2. POST /app/installations/{id}/access_tokens with the JWT
 * 3. Return the installation token
 */

import { createSign, createPrivateKey } from 'crypto';

/**
 * Base64url encode a buffer or string.
 */
function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

/**
 * Create a signed JWT (RS256) for GitHub App authentication.
 * Uses createPrivateKey to handle both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY) formats.
 */
function createJWT(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: String(appId),
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // createPrivateKey handles both PKCS#1 and PKCS#8 PEM formats
  const keyObject = createPrivateKey(privateKey);

  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(keyObject, 'base64url');

  return `${signingInput}.${signature}`;
}

/**
 * Normalize a PEM private key that may have escaped newlines or surrounding quotes.
 */
function normalizePrivateKey(raw) {
  let key = raw;
  // Strip surrounding quotes
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Replace literal \n (two chars: backslash + n) with actual newlines
  key = key.replace(/\\n/g, '\n');

  // If it's PKCS#1 (BEGIN RSA PRIVATE KEY), convert to PKCS#8 for OpenSSL 3.x compat
  if (key.includes('BEGIN RSA PRIVATE KEY')) {
    key = pkcs1ToPkcs8(key);
  }

  return key;
}

/**
 * Convert a PKCS#1 PEM private key to PKCS#8 format.
 * Required for Node.js 17+ with OpenSSL 3.x which doesn't support PKCS#1 directly.
 */
function pkcs1ToPkcs8(pkcs1Pem) {
  const body = pkcs1Pem
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const pkcs1Der = Buffer.from(body, 'base64');

  // PKCS#8 wraps PKCS#1 with: SEQUENCE { version, AlgorithmIdentifier, OCTET STRING { pkcs1 } }
  const rsaOid = Buffer.from('06092a864886f70d010101', 'hex'); // OID 1.2.840.113549.1.1.1
  const nullParam = Buffer.from('0500', 'hex');

  const algoIdContent = Buffer.concat([rsaOid, nullParam]);
  const algoId = Buffer.concat([Buffer.from([0x30, algoIdContent.length]), algoIdContent]);
  const octetString = wrapAsn1(0x04, pkcs1Der);
  const version = Buffer.from('020100', 'hex');

  const pkcs8Content = Buffer.concat([version, algoId, octetString]);
  const pkcs8Der = wrapAsn1(0x30, pkcs8Content);

  const b64 = pkcs8Der.toString('base64');
  const lines = b64.match(/.{1,64}/g);
  return '-----BEGIN PRIVATE KEY-----\n' + lines.join('\n') + '\n-----END PRIVATE KEY-----';
}

/**
 * Wrap content in an ASN.1 TLV (Tag-Length-Value).
 */
function wrapAsn1(tag, content) {
  const len = content.length;
  let header;
  if (len < 128) {
    header = Buffer.from([tag, len]);
  } else if (len < 256) {
    header = Buffer.from([tag, 0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.from([tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, content]);
}

/**
 * Generates a GitHub App installation access token.
 *
 * @param {string} appId - GitHub App ID
 * @param {string} privateKey - PEM private key (may have escaped newlines)
 * @param {string} installationId - GitHub App Installation ID
 * @returns {Promise<string>} Installation access token (ghs_xxx...)
 */
export async function getInstallationToken(appId, privateKey, installationId) {
  const normalizedKey = normalizePrivateKey(privateKey);
  const jwt = createJWT(appId, normalizedKey);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to get installation token: ${response.status} ${response.statusText}\n${body}`
    );
  }

  const data = await response.json();
  return data.token;
}

/**
 * Creates a self-refreshing token manager for GitHub App auth.
 * Tokens auto-refresh after 50 minutes (GitHub expires them at 60).
 *
 * @param {string} appId - GitHub App ID
 * @param {string} privateKey - PEM private key
 * @param {string} installationId - GitHub App Installation ID
 * @returns {{getToken: () => Promise<string>, invalidate: () => void}}
 */
export function createTokenManager(appId, privateKey, installationId) {
  let token = null;
  let tokenCreatedAt = 0;
  const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

  return {
    async getToken() {
      const now = Date.now();
      if (!token || (now - tokenCreatedAt) > TOKEN_TTL_MS) {
        token = await getInstallationToken(appId, privateKey, installationId);
        tokenCreatedAt = now;
      }
      return token;
    },
    invalidate() {
      token = null;
      tokenCreatedAt = 0;
    },
  };
}

/**
 * Load GitHub auth token from .env file.
 * Prefers GitHub App auth, falls back to PAT.
 *
 * @param {string} envPath - Path to .env file
 * @returns {Promise<{token: string, manager: object|null, method: string}>}
 */
export async function loadGitHubAuth(envPath) {
  const { readFileSync } = await import('fs');

  let envVars = {};
  try {
    const envContent = readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      envVars[key] = value;
    }
  } catch {
    // .env not found — rely on environment variables
  }

  // Merge with process.env (env file takes precedence for App credentials)
  const appId = envVars.GITHUB_APP_ID || process.env.GITHUB_APP_ID;
  const privateKey = envVars.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = envVars.GITHUB_APP_INSTALLATION_ID || process.env.GITHUB_APP_INSTALLATION_ID;

  if (appId && privateKey && installationId) {
    const manager = createTokenManager(appId, privateKey, installationId);
    const token = await manager.getToken();
    return { token, manager, method: 'GitHub App (mimir-media-db[bot])' };
  }

  // Fallback to PAT (no manager needed, PATs don't expire during a run)
  const pat = envVars.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (pat) {
    // Strip surrounding quotes from PAT if present
    const cleanPat = pat.replace(/^["']|["']$/g, '');
    return { token: cleanPat, manager: null, method: 'Personal token (fallback)' };
  }

  return { token: null, manager: null, method: null };
}
