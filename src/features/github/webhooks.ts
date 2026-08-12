import { verify } from '@octokit/webhooks-methods';
import { z } from 'zod';
import { UnauthorizedError } from '@/core/errors';
import { logger } from '@/core/logger';

/**
 * Webhook ingestion.
 *
 * Signature verification happens against the *raw* request body. Parsing the
 * JSON first and re-serialising it would change byte-for-byte formatting and
 * invalidate the HMAC, so the route must hand us `await request.text()` before
 * anything touches it.
 */

export const SUPPORTED_EVENTS = [
  'pull_request',
  'pull_request_review',
  'push',
  'release',
  'installation',
  'installation_repositories',
  'ping',
] as const;

export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

/** Pull request actions that should trigger a fresh analysis. */
export const ANALYZABLE_PR_ACTIONS = [
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
] as const;

const repositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean().default(false),
  default_branch: z.string().default('main'),
  owner: z.object({ login: z.string() }),
});

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional().default(false),
  state: z.string(),
  merged: z.boolean().optional(),
  html_url: z.string().optional(),
  additions: z.number().optional().default(0),
  deletions: z.number().optional().default(0),
  changed_files: z.number().optional().default(0),
  user: z.object({ login: z.string() }).nullable().optional(),
  base: z.object({ ref: z.string(), sha: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
});

export const pullRequestEventSchema = z.object({
  action: z.string(),
  number: z.number().optional(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  installation: z.object({ id: z.number() }).optional(),
});

export const pushEventSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: repositorySchema,
  commits: z
    .array(
      z.object({
        id: z.string(),
        message: z.string(),
        author: z.object({ name: z.string(), username: z.string().optional() }),
      }),
    )
    .default([]),
  installation: z.object({ id: z.number() }).optional(),
});

export const releaseEventSchema = z.object({
  action: z.string(),
  release: z.object({
    tag_name: z.string(),
    name: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
  }),
  repository: repositorySchema,
  installation: z.object({ id: z.number() }).optional(),
});

export const installationEventSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string() }).nullable().optional(),
  }),
  repositories: z
    .array(z.object({ id: z.number(), name: z.string(), full_name: z.string() }))
    .optional(),
  repositories_added: z
    .array(z.object({ id: z.number(), name: z.string(), full_name: z.string() }))
    .optional(),
});

export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;
export type PushEvent = z.infer<typeof pushEventSchema>;
export type ReleaseEvent = z.infer<typeof releaseEventSchema>;
export type InstallationEvent = z.infer<typeof installationEventSchema>;

export interface WebhookHeaders {
  readonly event: string | null;
  readonly signature: string | null;
  readonly deliveryId: string | null;
}

export function readWebhookHeaders(headers: Headers): WebhookHeaders {
  return {
    event: headers.get('x-github-event'),
    signature: headers.get('x-hub-signature-256'),
    deliveryId: headers.get('x-github-delivery'),
  };
}

/**
 * Verifies the `X-Hub-Signature-256` HMAC.
 *
 * Throws when a secret is configured but the signature is absent or wrong. If
 * no secret is configured, that's the local-development path: we log loudly
 * and allow the request, since refusing would make the platform impossible to
 * try. In production, an unset secret means signature verification is
 * silently disabled — so this refuses instead, rather than only warning.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
  isProduction: boolean,
): Promise<void> {
  if (!secret) {
    if (isProduction) {
      throw new UnauthorizedError(
        'GITHUB_WEBHOOK_SECRET is not configured — refusing to accept unverified webhooks in production.',
      );
    }
    logger().warn(
      'Webhook received without GITHUB_WEBHOOK_SECRET configured — signature not verified. Do not run this way in production.',
    );
    return;
  }

  if (!signature) {
    throw new UnauthorizedError('Missing X-Hub-Signature-256 header');
  }

  // `verify` is constant-time internally.
  const valid = await verify(secret, rawBody, signature);
  if (!valid) {
    throw new UnauthorizedError('Webhook signature verification failed');
  }
}

export type WebhookDecision =
  | { readonly kind: 'analyze-pull-request'; readonly event: PullRequestEvent }
  | { readonly kind: 'pull-request-closed'; readonly event: PullRequestEvent }
  | { readonly kind: 'push'; readonly event: PushEvent }
  | { readonly kind: 'release'; readonly event: ReleaseEvent }
  | { readonly kind: 'installation'; readonly event: InstallationEvent }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * Decides what to do with a delivery.
 *
 * Kept as a pure function separate from the HTTP route so the routing rules —
 * which are the part that actually carries product behaviour — are directly
 * unit-testable without constructing requests.
 */
export function routeWebhook(event: string, payload: unknown): WebhookDecision {
  switch (event) {
    case 'ping':
      return { kind: 'ignored', reason: 'ping' };

    case 'pull_request': {
      const parsed = pullRequestEventSchema.safeParse(payload);
      if (!parsed.success) return { kind: 'ignored', reason: 'malformed pull_request payload' };

      const { action, pull_request: pr } = parsed.data;

      if (action === 'closed') return { kind: 'pull-request-closed', event: parsed.data };

      if (!(ANALYZABLE_PR_ACTIONS as readonly string[]).includes(action)) {
        return { kind: 'ignored', reason: `pull_request action "${action}"` };
      }

      // Draft PRs are work in progress; reviewing them is noise until the
      // author marks them ready (which fires `ready_for_review`).
      if (pr.draft && action !== 'ready_for_review') {
        return { kind: 'ignored', reason: 'draft pull request' };
      }

      return { kind: 'analyze-pull-request', event: parsed.data };
    }

    case 'push': {
      const parsed = pushEventSchema.safeParse(payload);
      if (!parsed.success) return { kind: 'ignored', reason: 'malformed push payload' };
      // Branch deletions arrive as a push to the null SHA.
      if (/^0+$/.test(parsed.data.after)) return { kind: 'ignored', reason: 'branch deleted' };
      return { kind: 'push', event: parsed.data };
    }

    case 'release': {
      const parsed = releaseEventSchema.safeParse(payload);
      if (!parsed.success) return { kind: 'ignored', reason: 'malformed release payload' };
      if (!['published', 'created', 'prereleased'].includes(parsed.data.action)) {
        return { kind: 'ignored', reason: `release action "${parsed.data.action}"` };
      }
      return { kind: 'release', event: parsed.data };
    }

    case 'installation':
    case 'installation_repositories': {
      const parsed = installationEventSchema.safeParse(payload);
      if (!parsed.success) return { kind: 'ignored', reason: 'malformed installation payload' };
      return { kind: 'installation', event: parsed.data };
    }

    default:
      return { kind: 'ignored', reason: `unsupported event "${event}"` };
  }
}
