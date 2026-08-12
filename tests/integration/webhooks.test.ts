import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UnauthorizedError } from '@/core/errors';
import { MemoryStore } from '@/db/memory-store';
import {
  ANALYZABLE_PR_ACTIONS,
  routeWebhook,
  verifyWebhookSignature,
} from '@/features/github/webhooks';

const SECRET = 'webhook-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    pull_request: {
      number: 7,
      title: 'Add feature',
      body: 'Description',
      draft: false,
      state: 'open',
      additions: 10,
      deletions: 2,
      changed_files: 3,
      html_url: 'https://github.com/acme/widgets/pull/7',
      user: { login: 'dev' },
      base: { ref: 'main', sha: 'b'.repeat(40) },
      head: { ref: 'feature', sha: 'a'.repeat(40) },
    },
    repository: {
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      private: false,
      default_branch: 'main',
      owner: { login: 'acme' },
    },
    installation: { id: 99 },
    ...overrides,
  };
}

describe('webhook signature verification', () => {
  it('accepts a correctly signed body', async () => {
    const body = JSON.stringify(pullRequestPayload());
    await expect(
      verifyWebhookSignature(body, sign(body), SECRET, false),
    ).resolves.toBeUndefined();
  });

  it('rejects a body signed with the wrong secret', async () => {
    const body = JSON.stringify(pullRequestPayload());
    await expect(
      verifyWebhookSignature(body, sign(body, 'wrong'), SECRET, false),
    ).rejects.toThrow(UnauthorizedError);
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify(pullRequestPayload());
    const signature = sign(body);
    const tampered = body.replace('"number":7', '"number":8');
    await expect(verifyWebhookSignature(tampered, signature, SECRET, false)).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it('rejects a missing signature when a secret is configured', async () => {
    await expect(verifyWebhookSignature('{}', null, SECRET, false)).rejects.toThrow(
      /Missing X-Hub-Signature-256/,
    );
  });

  it('allows unsigned deliveries when no secret is configured outside production', async () => {
    await expect(
      verifyWebhookSignature('{}', null, undefined, false),
    ).resolves.toBeUndefined();
  });

  it('refuses unsigned deliveries when no secret is configured in production', async () => {
    await expect(verifyWebhookSignature('{}', null, undefined, true)).rejects.toThrow(
      UnauthorizedError,
    );
  });
});

describe('webhook routing', () => {
  it.each([...ANALYZABLE_PR_ACTIONS])('analyses a pull request on "%s"', (action) => {
    const decision = routeWebhook('pull_request', pullRequestPayload({ action }));
    expect(decision.kind).toBe('analyze-pull-request');
  });

  it('ignores actions that do not change the code', () => {
    for (const action of ['labeled', 'assigned', 'edited', 'review_requested']) {
      const decision = routeWebhook('pull_request', pullRequestPayload({ action }));
      expect(decision.kind).toBe('ignored');
    }
  });

  it('ignores a draft pull request until it is marked ready', () => {
    const draft = pullRequestPayload({
      action: 'opened',
      pull_request: { ...pullRequestPayload().pull_request, draft: true },
    });
    expect(routeWebhook('pull_request', draft).kind).toBe('ignored');

    const ready = pullRequestPayload({
      action: 'ready_for_review',
      pull_request: { ...pullRequestPayload().pull_request, draft: true },
    });
    expect(routeWebhook('pull_request', ready).kind).toBe('analyze-pull-request');
  });

  it('records a closed pull request rather than analysing it', () => {
    const decision = routeWebhook('pull_request', pullRequestPayload({ action: 'closed' }));
    expect(decision.kind).toBe('pull-request-closed');
  });

  it('ignores a push that deletes a branch', () => {
    const decision = routeWebhook('push', {
      ref: 'refs/heads/feature',
      before: 'a'.repeat(40),
      after: '0'.repeat(40),
      repository: pullRequestPayload().repository,
      commits: [],
    });
    expect(decision.kind).toBe('ignored');
  });

  it('accepts a real push', () => {
    const decision = routeWebhook('push', {
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      repository: pullRequestPayload().repository,
      commits: [{ id: 'b'.repeat(40), message: 'feat: thing', author: { name: 'dev' } }],
    });
    expect(decision.kind).toBe('push');
  });

  it('ignores unsupported events and malformed payloads', () => {
    expect(routeWebhook('issues', {}).kind).toBe('ignored');
    expect(routeWebhook('ping', {}).kind).toBe('ignored');
    expect(routeWebhook('pull_request', { nonsense: true }).kind).toBe('ignored');
  });

  it('routes a published release', () => {
    const decision = routeWebhook('release', {
      action: 'published',
      release: { tag_name: 'v1.2.0', name: 'v1.2.0', body: '', draft: false, prerelease: false },
      repository: pullRequestPayload().repository,
    });
    expect(decision.kind).toBe('release');
  });
});

describe('delivery idempotency', () => {
  it('processes a delivery once and treats a replay as a duplicate', async () => {
    const store = new MemoryStore();

    expect(await store.markWebhookDelivery('delivery-1', 'pull_request')).toBe(true);
    // GitHub retries deliveries; without this check a retry would post a
    // second review on the same commit.
    expect(await store.markWebhookDelivery('delivery-1', 'pull_request')).toBe(false);
    expect(await store.markWebhookDelivery('delivery-2', 'pull_request')).toBe(true);
  });
});
