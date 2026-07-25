import { z } from 'zod';
import { runRelease } from '@/server/services/release-service';
import { handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  from: z.string().max(255).optional(),
  to: z.string().max(255).optional(),
  version: z.string().max(64).optional(),
  persist: z.boolean().default(true),
});

/**
 * `POST /api/release` — build the complete release package.
 *
 * Returns release notes, an upgrade guide, a breaking-change summary, a
 * migration guide and a deployment checklist in one call, so a release
 * workflow needs a single request rather than five.
 */
export const POST = handler(
  async ({ body, log }) => {
    log.info('Release plan requested', { repository: `${body.owner}/${body.repo}` });

    const plan = await runRelease({
      owner: body.owner,
      repo: body.repo,
      ...(body.from ? { from: body.from } : {}),
      ...(body.to ? { to: body.to } : {}),
      ...(body.version ? { version: body.version } : {}),
      persist: body.persist,
    });

    return ok({
      version: plan.version,
      previousVersion: plan.previousVersion,
      releaseKind: plan.releaseKind,
      hasBreakingChanges: plan.hasBreakingChanges,
      commitCount: plan.commitCount,
      contributors: plan.contributors,
      range: { from: plan.from, to: plan.to },
      documents: {
        releaseNotes: plan.releaseNotes,
        upgradeGuide: plan.upgradeGuide,
        breakingChangeSummary: plan.breakingChangeSummary,
        migrationGuide: plan.migrationGuide,
        deploymentChecklist: plan.deploymentChecklist,
      },
    });
  },
  { bodySchema, rateLimit: 20 },
);
