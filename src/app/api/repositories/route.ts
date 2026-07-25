import { z } from 'zod';
import { ConflictError } from '@/core/errors';
import { getStore } from '@/db';
import { getRepository } from '@/features/github/client';
import { created, handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const connectSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  installationId: z.string().max(64).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

/** `GET /api/repositories` — connected repositories. */
export const GET = handler(
  async ({ query }) => {
    const page = await getStore().listRepositories({ limit: query.limit, offset: query.offset });

    // The encrypted token must never leave the server, even to an authorised
    // API client — nothing downstream has a legitimate use for it.
    return ok({
      ...page,
      items: page.items.map(({ encryptedToken: _token, ...repository }) => repository),
    });
  },
  { querySchema: listSchema },
);

/**
 * `POST /api/repositories` — connect a repository.
 *
 * Verifies access through the GitHub API before storing anything, so a typo or
 * a missing installation fails immediately rather than at the first webhook.
 */
export const POST = handler(
  async ({ body, log }) => {
    const store = getStore();
    const fullName = `${body.owner}/${body.repo}`;

    const existing = await store.getRepositoryByFullName(fullName);
    if (existing) {
      throw new ConflictError(`${fullName} is already connected`);
    }

    const metadata = await getRepository(
      { owner: body.owner, repo: body.repo },
      body.installationId ? { installationId: body.installationId } : undefined,
    );

    const repository = await store.upsertRepository({
      organizationId: null,
      githubId: metadata.githubId,
      owner: body.owner,
      name: body.repo,
      fullName: metadata.fullName,
      defaultBranch: metadata.defaultBranch,
      private: metadata.private,
      encryptedToken: null,
      installationId: body.installationId ?? null,
      config: body.config,
      active: true,
    });

    log.info('Repository connected', { repository: fullName });

    const { encryptedToken: _token, ...safe } = repository;
    return created(safe);
  },
  { bodySchema: connectSchema, rateLimit: 20 },
);
