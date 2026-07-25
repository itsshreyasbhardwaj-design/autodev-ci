import { z } from 'zod';
import { NotFoundError } from '@/core/errors';
import { getStore } from '@/db';
import { handler, noContent, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const patchSchema = z.object({
  active: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  installationId: z.string().max(64).nullable().optional(),
});

/** `GET /api/repositories/:id` — one repository with its latest health snapshot. */
export const GET = handler(async ({ params }) => {
  const store = getStore();
  const id = params.id ?? '';

  const repository = await store.getRepository(id);
  if (!repository) throw new NotFoundError('Repository');

  const [health, reviews] = await Promise.all([
    store.latestHealthSnapshot(id),
    store.listReviews(id, { limit: 5 }),
  ]);

  const { encryptedToken: _token, ...safe } = repository;

  return ok({ repository: safe, health, recentReviews: reviews.items });
});

/** `PATCH /api/repositories/:id` — update configuration or pause analysis. */
export const PATCH = handler(
  async ({ params, body, log }) => {
    const store = getStore();
    const id = params.id ?? '';

    const updated = await store.updateRepository(id, {
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
      ...(body.installationId !== undefined ? { installationId: body.installationId } : {}),
    });

    if (!updated) throw new NotFoundError('Repository');

    log.info('Repository updated', { repository: updated.fullName });

    const { encryptedToken: _token, ...safe } = updated;
    return ok(safe);
  },
  { bodySchema: patchSchema },
);

/** `DELETE /api/repositories/:id` — disconnect and remove all stored analysis. */
export const DELETE = handler(async ({ params, log }) => {
  const deleted = await getStore().deleteRepository(params.id ?? '');
  if (!deleted) throw new NotFoundError('Repository');

  log.info('Repository disconnected', { repositoryId: params.id });
  return noContent();
});
