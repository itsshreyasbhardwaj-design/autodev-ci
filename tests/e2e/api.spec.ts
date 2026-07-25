import { expect, test } from '@playwright/test';

/**
 * REST API contract tests.
 *
 * Exercised over real HTTP against the production build, so they cover the
 * middleware chain — validation, error shaping, rate-limit headers — that unit
 * tests of the handlers alone would miss.
 */

test.describe('GET /api/health', () => {
  test('reports status, storage adapter and capabilities', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.storage.adapter).toBe('memory');
    expect(body.storage.healthy).toBe(true);
    expect(body.engine).toBe('deterministic');
    expect(body.capabilities).toHaveProperty('persistentStorage');
  });

  test('attaches a request id and rate limit headers', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.headers()['x-request-id']).toBeTruthy();
    expect(response.headers()['ratelimit-limit']).toBeTruthy();
  });
});

test.describe('validation', () => {
  test('rejects a request body missing required fields', async ({ request }) => {
    const response = await request.post('/api/reviews', { data: { owner: 'acme' } });
    expect(response.status()).toBe(422);

    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.requestId).toBeTruthy();

    const paths = body.error.details.issues.map((issue: { path: string }) => issue.path);
    expect(paths).toContain('repo');
    expect(paths).toContain('pullNumber');
  });

  test('rejects a body that is not JSON', async ({ request }) => {
    const response = await request.post('/api/reviews', {
      data: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status()).toBe(422);
  });

  test('rejects an out-of-range query parameter', async ({ request }) => {
    const response = await request.get('/api/reviews?limit=9999');
    expect(response.status()).toBe(422);
  });
});

test.describe('collections', () => {
  test('returns an empty page in the standard envelope', async ({ request }) => {
    const response = await request.get('/api/reviews');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ items: [], total: 0, offset: 0 });
    expect(typeof body.limit).toBe('number');
  });

  test('never exposes stored credentials on the repositories endpoint', async ({ request }) => {
    const response = await request.get('/api/repositories');
    const body = await response.json();

    expect(response.status()).toBe(200);
    for (const item of body.items) {
      expect(item).not.toHaveProperty('encryptedToken');
    }
  });

  test('returns findings with severity counts', async ({ request }) => {
    const response = await request.get('/api/findings');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('counts');
    expect(Array.isArray(body.items)).toBe(true);
  });
});

test.describe('webhook endpoint', () => {
  test('describes itself on GET', async ({ request }) => {
    const response = await request.get('/api/webhooks/github');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.endpoint).toBe('github-webhook');
    expect(body.supportedEvents).toContain('pull_request');
  });

  test('rejects a delivery with no event header', async ({ request }) => {
    const response = await request.post('/api/webhooks/github', { data: {} });
    expect(response.status()).toBe(400);
  });

  test('acknowledges an event it does not act on', async ({ request }) => {
    const response = await request.post('/api/webhooks/github', {
      headers: { 'x-github-event': 'issues', 'x-github-delivery': `test-${Date.now()}` },
      data: { action: 'opened' },
    });

    // Anything other than 2xx makes GitHub retry and eventually disable the
    // webhook, so unhandled events must still be acknowledged.
    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe('ignored');
  });

  test('treats a repeated delivery id as a duplicate', async ({ request }) => {
    const deliveryId = `dup-${Date.now()}`;
    const headers = { 'x-github-event': 'issues', 'x-github-delivery': deliveryId };

    const first = await request.post('/api/webhooks/github', {
      headers,
      data: { action: 'opened' },
    });
    const second = await request.post('/api/webhooks/github', {
      headers,
      data: { action: 'opened' },
    });

    expect((await first.json()).status).toBe('ignored');
    expect((await second.json()).status).toBe('duplicate');
  });
});

test.describe('AI streaming', () => {
  test('streams an explanation as server-sent events', async ({ request }) => {
    const response = await request.post('/api/ai/explain', {
      data: { subject: 'Hardcoded AWS access key found in src/s3.ts', language: 'typescript' },
    });

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('data: ');
    expect(body).toContain('[DONE]');
  });
});

test.describe('security headers', () => {
  test('sets a strict header set on HTML responses', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("object-src 'none'");
  });

  test('does not advertise the framework', async ({ request }) => {
    const response = await request.get('/');
    expect(response.headers()).not.toHaveProperty('x-powered-by');
  });
});
