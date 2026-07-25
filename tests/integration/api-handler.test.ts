import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '@/core/errors';
import { resetEnvCache } from '@/core/env';
import { handler, ok, resetRateLimiter } from '@/server/api';
import { formatNumber, gradeColor, relativeTime, spineStyle } from '@/lib/utils';

/**
 * Tests for the API middleware chain.
 *
 * Every route depends on this wrapper for authentication, rate limiting,
 * validation and error shaping, so a regression here would affect all of them
 * at once.
 */

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

const noParams = { params: Promise.resolve({}) };

beforeEach(() => {
  resetRateLimiter();
});

describe('request handling', () => {
  it('returns the handler response with a request id', async () => {
    const route = handler(async () => ok({ hello: 'world' }));
    const response = await route(request('http://localhost/api/test'), noParams);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: 'world' });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('propagates an inbound request id for tracing', async () => {
    const route = handler(async () => ok({}));
    const response = await route(
      request('http://localhost/api/test', { headers: { 'x-request-id': 'trace-123' } }),
      noParams,
    );

    expect(response.headers.get('x-request-id')).toBe('trace-123');
  });

  it('exposes rate limit headers', async () => {
    const route = handler(async () => ok({}));
    const response = await route(request('http://localhost/api/test'), noParams);

    expect(response.headers.get('RateLimit-Limit')).toBeTruthy();
    expect(response.headers.get('RateLimit-Remaining')).toBeTruthy();
  });

  it('passes route params through', async () => {
    const route = handler(async ({ params }) => ok({ id: params.id }));
    const response = await route(request('http://localhost/api/x/7'), {
      params: Promise.resolve({ id: '7' }),
    });

    expect(await response.json()).toEqual({ id: '7' });
  });
});

describe('validation', () => {
  const bodySchema = z.object({ name: z.string().min(1), count: z.number().int() });

  it('accepts a valid body and hands the parsed value to the handler', async () => {
    const route = handler(async ({ body }) => ok(body), { bodySchema });

    const response = await route(
      request('http://localhost/api/test', {
        method: 'POST',
        body: JSON.stringify({ name: 'a', count: 2 }),
      }),
      noParams,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'a', count: 2 });
  });

  it('rejects an invalid body with field-level detail', async () => {
    const route = handler(async () => ok({}), { bodySchema });

    const response = await route(
      request('http://localhost/api/test', { method: 'POST', body: JSON.stringify({ name: '' }) }),
      noParams,
    );

    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload.error.code).toBe('VALIDATION_FAILED');
    expect(payload.error.details.issues.map((issue: { path: string }) => issue.path)).toContain(
      'count',
    );
  });

  it('rejects a body that is not JSON', async () => {
    const route = handler(async () => ok({}), { bodySchema });
    const response = await route(
      request('http://localhost/api/test', { method: 'POST', body: 'oops' }),
      noParams,
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.message).toMatch(/valid JSON/);
  });

  it('validates and coerces query parameters', async () => {
    const querySchema = z.object({ limit: z.coerce.number().int().max(100) });
    const route = handler(async ({ query }) => ok(query), { querySchema });

    const good = await route(request('http://localhost/api/test?limit=10'), noParams);
    expect(await good.json()).toEqual({ limit: 10 });

    const bad = await route(request('http://localhost/api/test?limit=500'), noParams);
    expect(bad.status).toBe(422);
  });
});

describe('authentication', () => {
  it('is open when no API keys are configured', async () => {
    const route = handler(async ({ principal }) => ok({ principal }));
    const response = await route(request('http://localhost/api/test'), noParams);

    expect(response.status).toBe(200);
    expect((await response.json()).principal).toBe('anonymous');
  });

  it('rejects a missing or wrong bearer token once keys are configured', async () => {
    process.env.AUTODEV_API_KEYS = 'secret-key-one,secret-key-two';
    resetEnvCache();

    const route = handler(async ({ principal }) => ok({ principal }));

    const missing = await route(request('http://localhost/api/test'), noParams);
    expect(missing.status).toBe(401);

    const wrong = await route(
      request('http://localhost/api/test', { headers: { authorization: 'Bearer nope' } }),
      noParams,
    );
    expect(wrong.status).toBe(401);
  });

  it('accepts a valid key and identifies the caller by fingerprint', async () => {
    process.env.AUTODEV_API_KEYS = 'secret-key-one';
    resetEnvCache();

    const route = handler(async ({ principal }) => ok({ principal }));
    const response = await route(
      request('http://localhost/api/test', {
        headers: { authorization: 'Bearer secret-key-one' },
      }),
      noParams,
    );

    expect(response.status).toBe(200);
    const { principal } = await response.json();
    // The raw key must never appear in the identity we log and rate-limit on.
    expect(principal).not.toBe('secret-key-one');
    expect(principal).toHaveLength(16);
  });

  it('can be forced open for a public endpoint such as health', async () => {
    process.env.AUTODEV_API_KEYS = 'secret-key-one';
    resetEnvCache();

    const route = handler(async () => ok({ status: 'ok' }), { auth: false });
    const response = await route(request('http://localhost/api/health'), noParams);

    expect(response.status).toBe(200);
  });
});

describe('error shaping', () => {
  it('maps a typed error to its status and code', async () => {
    const route = handler(async () => {
      throw new NotFoundError('Repository');
    });

    const response = await route(request('http://localhost/api/test'), noParams);
    expect(response.status).toBe(404);

    const payload = await response.json();
    expect(payload.error.code).toBe('NOT_FOUND');
    expect(payload.error.message).toBe('Repository not found');
  });

  it('never leaks an internal error message to the client', async () => {
    const route = handler(async () => {
      throw new Error('connection string is postgres://user:hunter2@db');
    });

    const response = await route(request('http://localhost/api/test'), noParams);
    expect(response.status).toBe(500);

    const payload = await response.json();
    expect(payload.error.message).toBe('An unexpected internal error occurred.');
    expect(JSON.stringify(payload)).not.toContain('hunter2');
    // The request id is still returned so the failure is traceable in logs.
    expect(payload.requestId).toBeTruthy();
  });
});

describe('presentation helpers', () => {
  it('formats relative time in compact units', () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 30_000))).toBe('just now');
    expect(relativeTime(new Date(now - 5 * 60_000))).toBe('5m ago');
    expect(relativeTime(new Date(now - 3 * 3_600_000))).toBe('3h ago');
    expect(relativeTime(new Date(now - 2 * 86_400_000))).toBe('2d ago');
    expect(relativeTime('not a date')).toBe('unknown');
  });

  it('formats numbers with separators', () => {
    expect(formatNumber(12_480)).toBe('12,480');
  });

  it('maps grades to distinct colours', () => {
    const grades = ['A', 'B', 'C', 'D', 'F'].map(gradeColor);
    expect(new Set(grades).size).toBe(5);
  });

  it('produces a severity spine custom property', () => {
    expect(spineStyle('critical')).toEqual({ '--spine-color': 'var(--color-sev-critical)' });
  });
});
