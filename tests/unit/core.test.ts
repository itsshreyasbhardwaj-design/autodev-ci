import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency, retry, settleWithConcurrency, withTimeout } from '@/core/async';
import { TtlCache } from '@/core/cache';
import { decrypt, encrypt, fingerprint, hmacSha256, safeEqual } from '@/core/crypto';
import { createEnv } from '@/core/env';
import { AppError, GitHubError, RateLimitError, toAppError } from '@/core/errors';
import { createLogger, sanitize, type LogRecord } from '@/core/logger';
import { MemoryRateLimitStore, createRateLimiter } from '@/core/rate-limit';
import { attempt, err, ok, partition, unwrapOr } from '@/core/result';
import { countBySeverity, scoreToGrade, severityAtLeast } from '@/core/types';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('env', () => {
  it('boots from a completely empty environment', () => {
    const env = createEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.capabilities.persistentStorage).toBe(false);
    expect(env.capabilities.github).toBe(false);
    expect(env.AUTODEV_AI_PROVIDER).toBe('deterministic');
  });

  it('derives capabilities from what is configured', () => {
    const env = createEnv({
      DATABASE_URL: 'postgresql://localhost:5432/db',
      GITHUB_TOKEN: 'ghp_x',
      GITHUB_WEBHOOK_SECRET: 's',
      AUTODEV_AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      ENCRYPTION_KEY: KEY,
      AUTODEV_API_KEYS: 'a,b , c',
    });

    expect(env.capabilities.persistentStorage).toBe(true);
    expect(env.capabilities.githubPat).toBe(true);
    expect(env.capabilities.github).toBe(true);
    expect(env.capabilities.webhookVerification).toBe(true);
    expect(env.capabilities.aiEnrichment).toBe(true);
    expect(env.capabilities.encryption).toBe(true);
    expect(env.apiKeys).toEqual(['a', 'b', 'c']);
  });

  it('requires both app id and private key before claiming GitHub App support', () => {
    const partial = createEnv({ GITHUB_APP_ID: '123' });
    expect(partial.capabilities.githubApp).toBe(false);

    const complete = createEnv({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'pem' });
    expect(complete.capabilities.githubApp).toBe(true);
  });

  it('does not claim AI enrichment when the key is missing', () => {
    const env = createEnv({ AUTODEV_AI_PROVIDER: 'openrouter' });
    expect(env.capabilities.aiEnrichment).toBe(false);
  });

  it('rejects a malformed DATABASE_URL rather than silently ignoring it', () => {
    expect(() => createEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => createEnv({ ENCRYPTION_KEY: 'dG9vLXNob3J0' })).toThrow(/32 bytes/);
  });

  it('treats an empty string as unset', () => {
    const env = createEnv({ GITHUB_TOKEN: '', DATABASE_URL: '' });
    expect(env.capabilities.githubPat).toBe(false);
    expect(env.capabilities.persistentStorage).toBe(false);
  });
});

describe('crypto', () => {
  it('round-trips a value', () => {
    const secret = 'ghp_supersecrettoken';
    expect(decrypt(encrypt(secret, KEY), KEY)).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    // A fresh nonce per encryption is what stops identical plaintexts from
    // being identifiable in the database.
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('refuses to decrypt with the wrong key', () => {
    const other = Buffer.alloc(32, 9).toString('base64');
    expect(() => decrypt(encrypt('secret', KEY), other)).toThrow(/wrong key or corrupted/);
  });

  it('detects tampering with the ciphertext', () => {
    const encrypted = encrypt('secret', KEY);
    const parts = encrypted.split('.');
    parts[3] = Buffer.from('tampered-payload').toString('base64url');
    expect(() => decrypt(parts.join('.'), KEY)).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decrypt('not-an-envelope', KEY)).toThrow(/malformed/);
    expect(() => decrypt('v2.a.b.c', KEY)).toThrow(/unsupported version/);
  });

  it('compares strings safely regardless of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('short', 'much-much-longer')).toBe(false);
  });

  it('fingerprints deterministically without revealing the input', () => {
    const value = 'super-secret-api-key';
    expect(fingerprint(value)).toBe(fingerprint(value));
    expect(fingerprint(value)).not.toContain('secret');
    expect(fingerprint(value)).toHaveLength(16);
  });

  it('computes a stable HMAC', () => {
    expect(hmacSha256('payload', 'secret')).toBe(hmacSha256('payload', 'secret'));
    expect(hmacSha256('payload', 'secret')).not.toBe(hmacSha256('payload', 'other'));
  });
});

describe('errors', () => {
  it('hides internal messages from API clients but keeps 4xx messages', () => {
    const internal = new AppError('database connection string is postgres://u:p@h', {
      status: 500,
    });
    expect(internal.toJSON().error.message).toBe('An unexpected internal error occurred.');

    const client = new AppError('Repository not found', { status: 404, expose: true });
    expect(client.toJSON().error.message).toBe('Repository not found');
  });

  it('maps upstream GitHub status codes sensibly', () => {
    expect(new GitHubError('nope', { status: 404 }).status).toBe(404);
    // A GitHub 500 is our upstream problem, surfaced as 502 and retryable.
    expect(new GitHubError('boom', { status: 500 }).status).toBe(502);
    expect(new GitHubError('boom', { status: 500 }).retryable).toBe(true);
    expect(new GitHubError('nope', { status: 404 }).retryable).toBe(false);
  });

  it('carries retry-after on rate limit errors', () => {
    const error = new RateLimitError(30);
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.toJSON().error.details).toEqual({ retryAfterSeconds: 30 });
  });

  it('normalises unknown thrown values', () => {
    expect(toAppError('a string').message).toBe('a string');
    expect(toAppError(new TypeError('bad')).message).toBe('bad');
    const existing = new AppError('keep me');
    expect(toAppError(existing)).toBe(existing);
  });
});

describe('logger', () => {
  function capture() {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) });
    return { records, logger };
  }

  it('redacts sensitive keys at any depth', () => {
    const { records, logger } = capture();
    logger.info('request', {
      githubToken: 'ghp_secret',
      nested: { apiKey: 'k', authorization: 'Bearer x', safe: 'visible' },
    });

    const fields = records[0]!.fields as Record<string, unknown>;
    expect(fields.githubToken).toBe('[redacted]');
    const nested = fields.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('[redacted]');
    expect(nested.authorization).toBe('[redacted]');
    expect(nested.safe).toBe('visible');
  });

  it('survives circular references', () => {
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;
    expect(() => sanitize(circular)).not.toThrow();
    expect((sanitize(circular) as Record<string, unknown>).self).toBe('[circular]');
  });

  it('respects the level threshold', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ level: 'warn', sink: (record) => records.push(record) });
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    expect(records.map((record) => record.level)).toEqual(['warn']);
  });

  it('merges child bindings into every record', () => {
    const { records, logger } = capture();
    logger.child({ requestId: 'abc' }).info('hello', { extra: 1 });
    expect(records[0]!.fields).toMatchObject({ requestId: 'abc', extra: 1 });
  });

  it('serialises Errors rather than emitting an empty object', () => {
    const { records, logger } = capture();
    logger.error('failed', { error: new Error('boom') });
    const error = (records[0]!.fields as Record<string, unknown>).error as Record<string, unknown>;
    expect(error.message).toBe('boom');
    expect(error.name).toBe('Error');
  });
});

describe('rate limiter', () => {
  it('allows requests up to the limit and rejects beyond it', async () => {
    const limiter = createRateLimiter({ limit: 3, store: new MemoryRateLimitStore() });

    for (let index = 0; index < 3; index += 1) {
      expect((await limiter.check('client')).allowed).toBe(true);
    }

    const blocked = await limiter.check('client');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks keys independently', async () => {
    const limiter = createRateLimiter({ limit: 1, store: new MemoryRateLimitStore() });
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('b')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(false);
  });

  it('slides the window as time passes', async () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: 1000,
      store: new MemoryRateLimitStore(),
    });

    await limiter.check('c');
    await limiter.check('c');
    expect((await limiter.check('c')).allowed).toBe(false);

    vi.advanceTimersByTime(1100);
    expect((await limiter.check('c')).allowed).toBe(true);
  });

  it('allows everything when disabled', async () => {
    const limiter = createRateLimiter({ limit: 1, disabled: true });
    await limiter.check('x');
    expect((await limiter.check('x')).allowed).toBe(true);
  });
});

describe('cache', () => {
  it('serves a value within its TTL and drops it after', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');

    vi.advanceTimersByTime(1500);
    expect(cache.get('k')).toBeUndefined();
  });

  it('collapses concurrent misses into a single computation', async () => {
    const cache = new TtlCache<number>();
    const factory = vi.fn(async () => 42);

    const results = await Promise.all([
      cache.getOrCompute('k', factory),
      cache.getOrCompute('k', factory),
      cache.getOrCompute('k', factory),
    ]);

    // Without single-flight this would issue three upstream calls.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(results).toEqual([42, 42, 42]);
  });

  it('evicts once the entry cap is reached', () => {
    const cache = new TtlCache<number>({ maxEntries: 3 });
    for (let index = 0; index < 10; index += 1) cache.set(`k${index}`, index);
    expect(cache.stats.size).toBeLessThanOrEqual(3);
  });

  it('does not cache a rejected computation', async () => {
    const cache = new TtlCache<string>();
    await expect(
      cache.getOrCompute('k', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('async helpers', () => {
  it('times out a slow promise', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 20, 'Slow op')).rejects.toThrow(/timed out after 20ms/);
  });

  it('retries until success', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { attempts: 5, baseDelayMs: 1 },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('stops retrying when shouldRetry says no', async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error('permanent');
        },
        { attempts: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('permanent');

    expect(attempts).toBe(1);
  });

  it('bounds concurrency while preserving output order', async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it('isolates failures when settling', async () => {
    const outcomes = await settleWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('bad');
      return value;
    });

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
  });
});

describe('result', () => {
  it('models success and failure', () => {
    expect(unwrapOr(ok(1), 0)).toBe(1);
    expect(unwrapOr(err(new Error('x')), 0)).toBe(0);
  });

  it('captures thrown errors', async () => {
    const result = await attempt(() => {
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
  });

  it('partitions mixed results', () => {
    const { values, errors } = partition([ok(1), err('e'), ok(2)]);
    expect(values).toEqual([1, 2]);
    expect(errors).toEqual(['e']);
  });
});

describe('domain types', () => {
  it('orders severities', () => {
    expect(severityAtLeast('critical', 'high')).toBe(true);
    expect(severityAtLeast('low', 'high')).toBe(false);
    expect(severityAtLeast('high', 'high')).toBe(true);
  });

  it('counts by severity', () => {
    const counts = countBySeverity([
      { severity: 'critical' },
      { severity: 'critical' },
      { severity: 'low' },
    ] as never);

    expect(counts.critical).toBe(2);
    expect(counts.low).toBe(1);
    expect(counts.high).toBe(0);
  });

  it('maps scores to grades', () => {
    expect(scoreToGrade(95)).toBe('A');
    expect(scoreToGrade(85)).toBe('B');
    expect(scoreToGrade(72)).toBe('C');
    expect(scoreToGrade(61)).toBe('D');
    expect(scoreToGrade(20)).toBe('F');
  });
});
