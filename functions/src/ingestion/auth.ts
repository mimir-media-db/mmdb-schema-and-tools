/**
 * Centralized Octokit factory with GitHub App + PAT fallback.
 */

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { logger } from 'firebase-functions/v2';

/**
 * Wrap content in an ASN.1 TLV (Tag-Length-Value).
 */
function wrapAsn1(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let header: Buffer;
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
 * Convert a PKCS#1 PEM private key to PKCS#8 format.
 * Required for Node.js 17+ with OpenSSL 3.x which doesn't support PKCS#1 directly
 * in some auth libraries. Wraps the PKCS#1 DER payload in a PKCS#8 envelope.
 */
export function convertPkcs1ToPkcs8(pem: string): string {
  const body = pem
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
  const lines = b64.match(/.{1,64}/g) ?? [];
  return '-----BEGIN PRIVATE KEY-----\n' + lines.join('\n') + '\n-----END PRIVATE KEY-----';
}

/**
 * Creates an authenticated Octokit instance.
 * Prefers GitHub App auth (production) with PAT fallback (local dev).
 */
export function createOctokit(): Octokit {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  if (appId && privateKey && installationId) {
    logger.info('Using GitHub App authentication');

    // Normalize: handle escaped newlines and surrounding quotes
    let normalizedKey = privateKey.replace(/\\n/g, '\n').replace(/"/g, '');

    // Convert PKCS#1 (BEGIN RSA PRIVATE KEY) to PKCS#8 for Node.js 17+ / OpenSSL 3.x
    if (normalizedKey.includes('BEGIN RSA PRIVATE KEY')) {
      normalizedKey = convertPkcs1ToPkcs8(normalizedKey);
    }

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey: normalizedKey,
        installationId: Number(installationId),
      },
    });
  }

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    logger.info('Using PAT authentication (fallback)');
    return new Octokit({ auth: token });
  }

  throw new Error('No GitHub authentication configured. Set GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY+GITHUB_APP_INSTALLATION_ID or GITHUB_TOKEN.');
}
