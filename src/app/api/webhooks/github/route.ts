import { NextResponse } from 'next/server';
import { env } from '@/core/env';
import { errorMessage, toAppError } from '@/core/errors';
import { logger } from '@/core/logger';
import { getStore } from '@/db';
import {
  readWebhookHeaders,
  routeWebhook,
  verifyWebhookSignature,
} from '@/features/github/webhooks';
import { runReview } from '@/server/services/review-service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GitHub webhook receiver.
 *
 * This route deliberately does **not** use the standard `handler` wrapper.
 * Webhooks have different rules from the REST API: signature verification
 * replaces bearer auth, the raw body must be read before parsing, and GitHub
 * must receive a 2xx quickly or it will retry and eventually disable the
 * delivery. So the flow is: verify → dedupe → acknowledge → process.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const log = logger().child({ component: 'github-webhook' });
  const { event, signature, deliveryId } = readWebhookHeaders(request.headers);

  if (!event) {
    return NextResponse.json({ error: 'Missing X-GitHub-Event header' }, { status: 400 });
  }

  // The signature covers the exact bytes GitHub sent. Parsing first and
  // re-serialising would change them and break verification.
  const rawBody = await request.text();

  try {
    await verifyWebhookSignature(rawBody, signature, env().GITHUB_WEBHOOK_SECRET);
  } catch (error) {
    log.warn('Rejected webhook with invalid signature', { event, deliveryId });
    const appError = toAppError(error);
    return NextResponse.json(appError.toJSON(), { status: appError.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON' }, { status: 400 });
  }

  // GitHub retries deliveries; processing one twice would post a duplicate
  // review. The unique index on delivery id makes this check atomic.
  if (deliveryId) {
    const isNew = await getStore().markWebhookDelivery(deliveryId, event);
    if (!isNew) {
      log.info('Ignoring duplicate delivery', { deliveryId, event });
      return NextResponse.json({ status: 'duplicate', deliveryId }, { status: 200 });
    }
  }

  const decision = routeWebhook(event, payload);

  if (decision.kind === 'ignored') {
    log.debug('Webhook ignored', { event, reason: decision.reason });
    return NextResponse.json({ status: 'ignored', reason: decision.reason }, { status: 200 });
  }

  switch (decision.kind) {
    case 'analyze-pull-request': {
      const { repository, pull_request: pullRequest, installation } = decision.event;

      log.info('Pull request analysis triggered', {
        repository: repository.full_name,
        pullNumber: pullRequest.number,
        action: decision.event.action,
      });

      try {
        const outcome = await runReview({
          owner: repository.owner.login,
          repo: repository.name,
          pullNumber: pullRequest.number,
          ...(installation ? { auth: { installationId: String(installation.id) } } : {}),
        });

        return NextResponse.json(
          {
            status: 'analyzed',
            reviewId: outcome.review.id,
            verdict: outcome.review.summary.verdict,
            score: outcome.review.summary.score,
            findings: outcome.review.findings.length,
            published: outcome.published,
          },
          { status: 200 },
        );
      } catch (error) {
        // Return 200 with an error body rather than 5xx: GitHub would retry a
        // 5xx, and a review that failed on a malformed diff will fail again.
        // The failure is recorded for the dashboard instead.
        log.error('Review failed for webhook delivery', {
          repository: repository.full_name,
          pullNumber: pullRequest.number,
          error: errorMessage(error),
        });

        await getStore()
          .createRun({
            repositoryId: null,
            kind: 'review',
            status: 'failed',
            trigger: 'webhook',
            startedAt: new Date(),
            finishedAt: new Date(),
            durationMs: null,
            error: errorMessage(error),
            payload: { repository: repository.full_name, pullNumber: pullRequest.number },
          })
          .catch(() => {});

        return NextResponse.json({ status: 'failed', error: errorMessage(error) }, { status: 200 });
      }
    }

    case 'pull-request-closed': {
      const { repository, pull_request: pullRequest } = decision.event;
      const store = getStore();
      const record = await store.getRepositoryByFullName(repository.full_name);

      if (record) {
        await store.upsertPullRequest({
          repositoryId: record.id,
          number: pullRequest.number,
          title: pullRequest.title,
          author: pullRequest.user?.login ?? 'unknown',
          baseRef: pullRequest.base.ref,
          headRef: pullRequest.head.ref,
          headSha: pullRequest.head.sha,
          state: pullRequest.merged ? 'merged' : 'closed',
          draft: pullRequest.draft,
          additions: pullRequest.additions,
          deletions: pullRequest.deletions,
          changedFiles: pullRequest.changed_files,
          url: pullRequest.html_url ?? null,
        });
      }

      return NextResponse.json({ status: 'recorded' }, { status: 200 });
    }

    case 'push':
    case 'release':
    case 'installation': {
      // These are acknowledged and recorded. Changelog and release generation
      // are explicit actions rather than automatic ones, because writing to a
      // repository without being asked is not behaviour a maintainer wants.
      log.info('Webhook recorded', { event, kind: decision.kind });
      return NextResponse.json({ status: 'recorded', kind: decision.kind }, { status: 200 });
    }

    default:
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }
}

/** GitHub sends a GET when validating a webhook URL in the UI. */
export function GET(): NextResponse {
  return NextResponse.json({
    endpoint: 'github-webhook',
    signatureVerification: env().capabilities.webhookVerification ? 'enabled' : 'disabled',
    supportedEvents: ['pull_request', 'push', 'release', 'installation'],
  });
}
