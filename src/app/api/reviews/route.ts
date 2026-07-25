import { z } from 'zod';
import { getStore } from '@/db';
import { runReview } from '@/server/services/review-service';
import { accepted, handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// A full review does real work: fetch the PR, read files, run ten analyzers.
export const maxDuration = 120;

const createSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  pullNumber: z.number().int().positive(),
  /** Skip posting to GitHub — useful for previewing a review. */
  dryRun: z.boolean().default(false),
  notify: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).optional(),
});

const listSchema = z.object({
  repositoryId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** `GET /api/reviews` — recent reviews, newest first. */
export const GET = handler(
  async ({ query }) => {
    const page = await getStore().listReviews(query.repositoryId, {
      limit: query.limit,
      offset: query.offset,
    });
    return ok(page);
  },
  { querySchema: listSchema },
);

/**
 * `POST /api/reviews` — analyse a pull request.
 *
 * Runs synchronously and returns the full result. Reviews take seconds, not
 * minutes, and a synchronous response means a CI step can act on the verdict
 * without polling.
 */
export const POST = handler(
  async ({ body, log }) => {
    log.info('Review requested', {
      repository: `${body.owner}/${body.repo}`,
      pullNumber: body.pullNumber,
    });

    const outcome = await runReview({
      owner: body.owner,
      repo: body.repo,
      pullNumber: body.pullNumber,
      publish: !body.dryRun,
      notify: body.notify && !body.dryRun,
      persist: !body.dryRun,
      ...(body.config ? { configOverride: body.config } : {}),
    });

    const blocked = outcome.review.gates.some((gate) => gate.status === 'failed' && gate.blocking);

    const payload = {
      review: outcome.review,
      published: outcome.published,
      commentUrl: outcome.commentUrl,
      notificationsSent: outcome.notifications,
      configSource: outcome.configSource,
      blocked,
    };

    // 202 signals "analysed, but the gates say do not merge" without making it
    // an error — the request itself succeeded.
    return blocked ? accepted(payload) : ok(payload);
  },
  { bodySchema: createSchema, rateLimit: 30 },
);
