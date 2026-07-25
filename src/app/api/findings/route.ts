import { z } from 'zod';
import { NotFoundError } from '@/core/errors';
import { SEVERITIES } from '@/core/types';
import { getStore } from '@/db';
import { handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const listSchema = z.object({
  repositoryId: z.string().uuid().optional(),
  reviewId: z.string().uuid().optional(),
  severity: z.enum(SEVERITIES).optional(),
  category: z.string().max(64).optional(),
  includeDismissed: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const dismissSchema = z.object({
  findingId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});

/** `GET /api/findings` — query findings across repositories and reviews. */
export const GET = handler(
  async ({ query }) => {
    const page = await getStore().listFindings({
      ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
      ...(query.reviewId ? { reviewId: query.reviewId } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.since ? { since: query.since } : {}),
      includeDismissed: query.includeDismissed,
      limit: query.limit,
      offset: query.offset,
    });

    const counts = page.items.reduce<Record<string, number>>((accumulator, finding) => {
      accumulator[finding.severity] = (accumulator[finding.severity] ?? 0) + 1;
      return accumulator;
    }, {});

    return ok({ ...page, counts });
  },
  { querySchema: listSchema },
);

/**
 * `POST /api/findings` — dismiss a finding with a reason.
 *
 * Dismissals are recorded rather than deleted so the audit trail survives:
 * "we accepted this risk on purpose" is information a future reviewer needs.
 */
export const POST = handler(
  async ({ body, log }) => {
    const finding = await getStore().dismissFinding(body.findingId, body.reason);
    if (!finding) throw new NotFoundError('Finding');

    log.info('Finding dismissed', { findingId: body.findingId, rule: finding.rule });
    return ok(finding);
  },
  { bodySchema: dismissSchema },
);
