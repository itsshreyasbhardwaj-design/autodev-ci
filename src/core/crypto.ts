import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigurationError } from './errors';

/**
 * Symmetric encryption for credentials at rest.
 *
 * GitHub installation tokens and PATs are stored encrypted with AES-256-GCM.
 * GCM is authenticated, so tampering with a ciphertext in the database is
 * detected on decrypt rather than silently yielding garbage.
 *
 * Serialised format (all base64url, dot-separated):
 *   v1.<iv>.<authTag>.<ciphertext>
 * The version prefix lets us rotate algorithms later without ambiguity.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size
const KEY_LENGTH = 32;
const VERSION = 'v1';

export function decodeKey(base64Key: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, 'base64');
  } catch (cause) {
    throw new ConfigurationError('ENCRYPTION_KEY is not valid base64', { cause: String(cause) });
  }
  if (key.length !== KEY_LENGTH) {
    throw new ConfigurationError(
      `ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes, got ${key.length}. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function encrypt(plaintext: string, base64Key: string): string {
  const key = decodeKey(base64Key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decrypt(serialised: string, base64Key: string): string {
  const key = decodeKey(base64Key);
  const parts = serialised.split('.');

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ConfigurationError('Ciphertext is malformed or uses an unsupported version');
  }

  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    // A GCM auth failure means the key is wrong or the data was tampered with.
    // Both are security-relevant, and neither should leak detail to a caller.
    throw new ConfigurationError('Failed to decrypt value: wrong key or corrupted ciphertext', {
      cause: String(cause),
    });
  }
}

/** Constant-time string comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which itself leaks length. Hash
  // both sides to a fixed width first so the comparison is always uniform.
  const hashA = createHmac('sha256', 'autodev-compare').update(bufA).digest();
  const hashB = createHmac('sha256', 'autodev-compare').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

/** HMAC-SHA256 hex digest, used for webhook signatures. */
export function hmacSha256(payload: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Stable, non-reversible identifier for an API key, safe to log and store. */
export function fingerprint(value: string): string {
  return createHmac('sha256', 'autodev-fingerprint').update(value).digest('hex').slice(0, 16);
}

export function generateId(): string {
  return randomUUID();
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
