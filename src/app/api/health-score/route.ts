import { z } from 'zod';
import { runHealthCheck } from '@/server/services/health-service';
import { handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const querySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  persist: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

/**
 * `GET /api/health-score?owner=…&repo=…`
 *
 * Computes the seven-dimension repository health score, returning the trend
 * against the previous snapshot and the full history for charting.
 */
export const GET = handler(
  async ({ query, log }) => {
    log.info('Health score requested', { repository: `${query.owner}/${query.repo}` });

    const outcome = await runHealthCheck({
      owner: query.owner,
      repo: query.repo,
      persist: query.persist,
    });

    return ok({
      report: outcome.report,
      trend: outcome.trend,
      history: outcome.history.map((snapshot) => ({
        score: snapshot.score,
        grade: snapshot.grade,
        computedAt: snapshot.computedAt,
      })),
    });
  },
  { querySchema, rateLimit: 30 },
);
