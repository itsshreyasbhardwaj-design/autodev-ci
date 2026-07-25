import { z } from 'zod';
import { runChangelog } from '@/server/services/release-service';
import { handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const bodySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  /** Starting ref. Defaults to the newest semver tag. */
  from: z.string().max(255).optional(),
  /** Ending ref. Defaults to the default branch. */
  to: z.string().max(255).optional(),
  /** Explicit version. Otherwise inferred from the commits. */
  version: z.string().max(64).optional(),
  persist: z.boolean().default(true),
});

/**
 * `POST /api/changelog` — generate a changelog from Conventional Commits.
 *
 * Returns both the rendered Markdown and the structured sections, so callers
 * can render their own format without re-parsing the output.
 */
export const POST = handler(
  async ({ body, log }) => {
    log.info('Changelog requested', { repository: `${body.owner}/${body.repo}` });

    const result = await runChangelog({
      owner: body.owner,
      repo: body.repo,
      ...(body.from ? { from: body.from } : {}),
      ...(body.to ? { to: body.to } : {}),
      ...(body.version ? { version: body.version } : {}),
      persist: body.persist,
    });

    return ok({
      version: result.version,
      previousVersion: result.previousVersion,
      releaseKind: result.releaseKind,
      markdown: result.markdown,
      sections: result.sections,
      breakingChanges: result.breakingChanges,
      contributors: result.contributors,
      commitCount: result.commitCount,
      range: { from: result.from, to: result.to },
    });
  },
  { bodySchema, rateLimit: 30 },
);
