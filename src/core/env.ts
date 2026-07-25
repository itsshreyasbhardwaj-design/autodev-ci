import { z } from 'zod';

/**
 * Environment validation.
 *
 * Design goal: AutoDev CI must boot with an *empty* environment. Every
 * integration is optional and the platform degrades to a self-contained mode
 * (in-memory storage, deterministic analysis, dev auth) rather than crashing.
 * What we do enforce is that anything a user *did* set is well-formed — a
 * malformed key is a configuration bug and should fail loudly at startup, not
 * silently at 3am when a webhook arrives.
 */

/**
 * Normalises `FOO=` (an empty value in a `.env` file) to "not set".
 *
 * This runs *before* validation, which is what lets a blank variable be
 * treated as absent while a non-blank but malformed one still fails loudly.
 * Using `.catch(undefined)` instead would silently swallow real
 * misconfiguration — a typo'd DATABASE_URL would appear to be "no database".
 */
const blankToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    schema.optional(),
  );

const optionalString = blankToUndefined(z.string().trim().min(1));

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const port = z.coerce.number().int().positive().max(65_535);

const numericWithDefault = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback).catch(fallback);

const envSchema = z.object({
  // --- Application ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000').catch('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info').catch('info'),
  PORT: port.optional().catch(undefined),

  // --- Database ---
  DATABASE_URL: blankToUndefined(
    z
      .string()
      .refine(
        (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
        'DATABASE_URL must be a postgres:// or postgresql:// connection string',
      ),
  ),
  DATABASE_SSL: optionalString,
  DATABASE_POOL_MAX: numericWithDefault(10, 1, 100),

  // --- Encryption ---
  ENCRYPTION_KEY: blankToUndefined(
    z.string().refine((value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'ENCRYPTION_KEY must be 32 bytes encoded as base64 (openssl rand -base64 32)'),
  ),

  // --- GitHub App ---
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_CLIENT_ID: optionalString,
  GITHUB_APP_CLIENT_SECRET: optionalString,
  GITHUB_APP_PRIVATE_KEY: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,

  // --- GitHub PAT ---
  GITHUB_TOKEN: optionalString,
  GITHUB_API_URL: z.url().default('https://api.github.com').catch('https://api.github.com'),

  // --- Auth ---
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optionalString,
  CLERK_SECRET_KEY: optionalString,

  // --- AI ---
  AUTODEV_AI_PROVIDER: z
    .enum(['deterministic', 'openrouter'])
    .default('deterministic')
    .catch('deterministic'),
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_BASE_URL: z
    .url()
    .default('https://openrouter.ai/api/v1')
    .catch('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z
    .string()
    .default('anthropic/claude-sonnet-4.5')
    .catch('anthropic/claude-sonnet-4.5'),
  OPENROUTER_FALLBACK_MODEL: z.string().default('openai/gpt-4.1-mini').catch('openai/gpt-4.1-mini'),
  AI_MAX_OUTPUT_TOKENS: numericWithDefault(4000, 256, 32_000),
  AI_TIMEOUT_MS: numericWithDefault(60_000, 1_000, 600_000),

  // --- Background jobs ---
  TRIGGER_SECRET_KEY: optionalString,
  TRIGGER_PROJECT_ID: optionalString,

  // --- Notifications ---
  SLACK_WEBHOOK_URL: blankToUndefined(z.url()),
  TEAMS_WEBHOOK_URL: blankToUndefined(z.url()),
  GENERIC_WEBHOOK_URL: blankToUndefined(z.url()),
  SMTP_URL: optionalString,
  EMAIL_FROM: optionalString,

  // --- API ---
  AUTODEV_API_KEYS: optionalString,
  RATE_LIMIT_PER_MINUTE: numericWithDefault(60, 1, 100_000),
  AUTODEV_DISABLE_RATE_LIMIT: booleanish.default(false).catch(false),
});

export type RawEnv = z.infer<typeof envSchema>;

/**
 * Capability flags derived from the environment. Call sites branch on these
 * instead of re-checking individual variables, which keeps the "is this
 * configured?" logic in exactly one place.
 */
export interface Capabilities {
  /** Postgres is configured; otherwise storage is in-memory and ephemeral. */
  readonly persistentStorage: boolean;
  /** GitHub App credentials are complete — installation tokens are available. */
  readonly githubApp: boolean;
  /** A PAT is available as an auth fallback. */
  readonly githubPat: boolean;
  /** Any GitHub auth at all. */
  readonly github: boolean;
  /** Webhook deliveries can be signature-verified. */
  readonly webhookVerification: boolean;
  /** Clerk is configured; otherwise a development identity is used. */
  readonly managedAuth: boolean;
  /** LLM enrichment is available on top of the deterministic engine. */
  readonly aiEnrichment: boolean;
  /** Tokens can be encrypted at rest. */
  readonly encryption: boolean;
  /** Long-running work is offloaded to Trigger.dev rather than in-process. */
  readonly hostedJobs: boolean;
  /** At least one notification channel is wired up. */
  readonly notifications: boolean;
  /** The public REST API requires bearer tokens. */
  readonly apiAuth: boolean;
}

export interface Env extends RawEnv {
  readonly capabilities: Capabilities;
  readonly apiKeys: readonly string[];
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly isDevelopment: boolean;
}

function deriveCapabilities(env: RawEnv): Capabilities {
  const githubApp = Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
  const githubPat = Boolean(env.GITHUB_TOKEN);

  return {
    persistentStorage: Boolean(env.DATABASE_URL),
    githubApp,
    githubPat,
    github: githubApp || githubPat,
    webhookVerification: Boolean(env.GITHUB_WEBHOOK_SECRET),
    managedAuth: Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY),
    aiEnrichment: env.AUTODEV_AI_PROVIDER === 'openrouter' && Boolean(env.OPENROUTER_API_KEY),
    encryption: Boolean(env.ENCRYPTION_KEY),
    hostedJobs: Boolean(env.TRIGGER_SECRET_KEY),
    notifications: Boolean(env.SLACK_WEBHOOK_URL || env.TEAMS_WEBHOOK_URL || env.SMTP_URL),
    apiAuth: Boolean(env.AUTODEV_API_KEYS),
  };
}

function parseApiKeys(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return Object.freeze(
    raw
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  );
}

/**
 * Parses `source` into a validated {@link Env}. Exported separately from the
 * singleton so tests can build isolated environments without mutating
 * `process.env`.
 */
export function createEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const parsed = result.data;

  return Object.freeze({
    ...parsed,
    capabilities: Object.freeze(deriveCapabilities(parsed)),
    apiKeys: parseApiKeys(parsed.AUTODEV_API_KEYS),
    isProduction: parsed.NODE_ENV === 'production',
    isTest: parsed.NODE_ENV === 'test',
    isDevelopment: parsed.NODE_ENV === 'development',
  });
}

let cached: Env | undefined;

/**
 * The process-wide environment. Lazily parsed so importing this module never
 * throws at module-load time (which would break Next.js build-time analysis).
 */
export function env(): Env {
  cached ??= createEnv();
  return cached;
}

/** Test helper: drops the memoised environment so the next `env()` re-reads. */
export function resetEnvCache(): void {
  cached = undefined;
}

/**
 * Human-readable startup summary. Logged once on boot so operators can see at
 * a glance which features are live without leaking any secret values.
 */
export function describeCapabilities(e: Env = env()): string {
  const rows: Array<[string, boolean, string]> = [
    ['Storage', e.capabilities.persistentStorage, 'PostgreSQL'],
    ['GitHub', e.capabilities.githubApp, 'GitHub App'],
    ['GitHub', e.capabilities.githubPat, 'Personal Access Token'],
    ['Webhooks', e.capabilities.webhookVerification, 'signature verification'],
    ['Auth', e.capabilities.managedAuth, 'Clerk'],
    ['AI', e.capabilities.aiEnrichment, 'OpenRouter enrichment'],
    ['Secrets', e.capabilities.encryption, 'AES-256-GCM at rest'],
    ['Jobs', e.capabilities.hostedJobs, 'Trigger.dev'],
    ['Notify', e.capabilities.notifications, 'outbound channels'],
    ['API', e.capabilities.apiAuth, 'bearer token auth'],
  ];

  return rows
    .map(([group, enabled, label]) => `${enabled ? '✓' : '·'} ${group.padEnd(8)} ${label}`)
    .join('\n');
}
