import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  Commendation,
  Finding,
  GateResult,
  HealthDimension,
  ReviewSummary,
  Severity,
} from '@/core/types';

/**
 * PostgreSQL schema (Supabase-compatible).
 *
 * Two conventions worth calling out:
 *
 * 1. Findings live in their own table rather than only inside the review's
 *    JSON blob. Aggregate queries — "critical security findings across all
 *    repos this month" — are the product's main read pattern, and they need
 *    real columns and indexes to stay fast.
 * 2. Analysis payloads are additionally stored as `jsonb` snapshots. Analyzer
 *    output evolves; keeping the raw result means an old review still renders
 *    correctly after the schema moves on.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

// ---------------------------------------------------------------------------
// Accounts and repositories
// ---------------------------------------------------------------------------

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Clerk organization id, or a synthetic id in self-hosted mode. */
    externalId: varchar('external_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    githubInstallationId: varchar('github_installation_id', { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organizations_external_id_idx').on(table.externalId),
    index('organizations_installation_idx').on(table.githubInstallationId),
  ],
);

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    githubId: varchar('github_id', { length: 64 }).notNull(),
    owner: varchar('owner', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 512 }).notNull(),
    defaultBranch: varchar('default_branch', { length: 255 }).default('main').notNull(),
    private: boolean('private').default(false).notNull(),
    /** Encrypted PAT for repos connected without the GitHub App. */
    encryptedToken: text('encrypted_token'),
    installationId: varchar('installation_id', { length: 64 }),
    /** Per-repository overrides merged over `.autodev.yml` and the defaults. */
    config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
    active: boolean('active').default(true).notNull(),
    lastAnalyzedAt: timestamp('last_analyzed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('repositories_full_name_idx').on(table.fullName),
    index('repositories_org_idx').on(table.organizationId),
    index('repositories_active_idx').on(table.active),
  ],
);

// ---------------------------------------------------------------------------
// Pull requests and reviews
// ---------------------------------------------------------------------------

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    author: varchar('author', { length: 255 }).notNull(),
    baseRef: varchar('base_ref', { length: 255 }).notNull(),
    headRef: varchar('head_ref', { length: 255 }).notNull(),
    headSha: varchar('head_sha', { length: 64 }).notNull(),
    state: varchar('state', { length: 32 }).default('open').notNull(),
    draft: boolean('draft').default(false).notNull(),
    additions: integer('additions').default(0).notNull(),
    deletions: integer('deletions').default(0).notNull(),
    changedFiles: integer('changed_files').default(0).notNull(),
    url: text('url'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('pull_requests_repo_number_idx').on(table.repositoryId, table.number),
    index('pull_requests_state_idx').on(table.state),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    pullRequestId: uuid('pull_request_id').references(() => pullRequests.id, {
      onDelete: 'cascade',
    }),
    /** The exact commit reviewed, so stale reviews are detectable. */
    headSha: varchar('head_sha', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    verdict: varchar('verdict', { length: 32 }),
    score: integer('score'),
    /** `static` | `ai` | `hybrid`. */
    engine: varchar('engine', { length: 16 }).default('static').notNull(),
    summary: jsonb('summary').$type<ReviewSummary | null>(),
    commendations: jsonb('commendations').$type<Commendation[]>().default([]).notNull(),
    gates: jsonb('gates').$type<GateResult[]>().default([]).notNull(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().default({}).notNull(),
    /** Populated when `status = 'failed'`. */
    error: text('error'),
    durationMs: integer('duration_ms'),
    ...timestamps,
  },
  (table) => [
    index('reviews_repo_idx').on(table.repositoryId),
    index('reviews_pr_idx').on(table.pullRequestId),
    index('reviews_created_idx').on(table.createdAt),
    index('reviews_status_idx').on(table.status),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .references(() => reviews.id, { onDelete: 'cascade' })
      .notNull(),
    repositoryId: uuid('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    rule: varchar('rule', { length: 128 }).notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    severity: varchar('severity', { length: 16 }).$type<Severity>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    filePath: text('file_path'),
    line: integer('line'),
    endLine: integer('end_line'),
    diffPosition: integer('diff_position'),
    suggestion: jsonb('suggestion').$type<Finding['suggestion'] | null>(),
    source: varchar('source', { length: 16 }).default('static').notNull(),
    confidence: real('confidence').default(1).notNull(),
    references: jsonb('references').$type<string[]>().default([]).notNull(),
    /** Set when a maintainer dismisses the finding, with a reason. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('findings_review_idx').on(table.reviewId),
    index('findings_repo_severity_idx').on(table.repositoryId, table.severity),
    index('findings_rule_idx').on(table.rule),
    index('findings_created_idx').on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Repository health over time
// ---------------------------------------------------------------------------

export const healthSnapshots = pgTable(
  'health_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    score: integer('score').notNull(),
    grade: varchar('grade', { length: 2 }).notNull(),
    dimensions: jsonb('dimensions').$type<HealthDimension[]>().default([]).notNull(),
    recommendations: jsonb('recommendations').$type<string[]>().default([]).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('health_repo_computed_idx').on(table.repositoryId, table.computedAt),
    // One snapshot per repo per day keeps the trend chart clean and bounds growth.
    uniqueIndex('health_repo_day_idx').on(
      table.repositoryId,
      sql`date_trunc('day', ${table.computedAt})`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Generated artifacts (changelogs, docs PRs, release notes)
// ---------------------------------------------------------------------------

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .references(() => repositories.id, { onDelete: 'cascade' })
      .notNull(),
    /** `changelog` | `release-notes` | `docs-suggestion` | `migration-guide`. */
    kind: varchar('kind', { length: 32 }).notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    /** Version, ref range, or PR number this artifact describes. */
    subject: varchar('subject', { length: 255 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    /** PR number opened to apply this artifact, when applicable. */
    pullRequestNumber: integer('pull_request_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('artifacts_repo_kind_idx').on(table.repositoryId, table.kind),
    index('artifacts_created_idx').on(table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Operational tables
// ---------------------------------------------------------------------------

export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).default('queued').notNull(),
    trigger: varchar('trigger', { length: 32 }).default('manual').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    error: text('error'),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('runs_repo_idx').on(table.repositoryId),
    index('runs_status_idx').on(table.status),
    index('runs_created_idx').on(table.createdAt),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 32 }).notNull(),
    event: varchar('event', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    target: text('target'),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    error: text('error'),
    attempts: integer('attempts').default(0).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('notifications_repo_idx').on(table.repositoryId),
    index('notifications_status_idx').on(table.status),
  ],
);

/**
 * Idempotency ledger for webhook deliveries. GitHub retries deliveries and can
 * send duplicates; recording each delivery id makes replays a no-op instead of
 * a duplicate review.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryId: varchar('delivery_id', { length: 128 }).notNull(),
    event: varchar('event', { length: 64 }).notNull(),
    action: varchar('action', { length: 64 }),
    repositoryFullName: varchar('repository_full_name', { length: 512 }),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('webhook_delivery_id_idx').on(table.deliveryId),
    index('webhook_processed_idx').on(table.processedAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const organizationRelations = relations(organizations, ({ many }) => ({
  repositories: many(repositories),
}));

export const repositoryRelations = relations(repositories, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [repositories.organizationId],
    references: [organizations.id],
  }),
  pullRequests: many(pullRequests),
  reviews: many(reviews),
  healthSnapshots: many(healthSnapshots),
  artifacts: many(artifacts),
}));

export const pullRequestRelations = relations(pullRequests, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [pullRequests.repositoryId],
    references: [repositories.id],
  }),
  reviews: many(reviews),
}));

export const reviewRelations = relations(reviews, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [reviews.repositoryId],
    references: [repositories.id],
  }),
  pullRequest: one(pullRequests, {
    fields: [reviews.pullRequestId],
    references: [pullRequests.id],
  }),
  findings: many(findings),
}));

export const findingRelations = relations(findings, ({ one }) => ({
  review: one(reviews, { fields: [findings.reviewId], references: [reviews.id] }),
  repository: one(repositories, {
    fields: [findings.repositoryId],
    references: [repositories.id],
  }),
}));

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type NewPullRequestRow = typeof pullRequests.$inferInsert;
export type ReviewRow = typeof reviews.$inferSelect;
export type NewReviewRow = typeof reviews.$inferInsert;
export type FindingRow = typeof findings.$inferSelect;
export type NewFindingRow = typeof findings.$inferInsert;
export type HealthSnapshotRow = typeof healthSnapshots.$inferSelect;
export type NewHealthSnapshotRow = typeof healthSnapshots.$inferInsert;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifactRow = typeof artifacts.$inferInsert;
export type AnalysisRunRow = typeof analysisRuns.$inferSelect;
export type NewAnalysisRunRow = typeof analysisRuns.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;
export type NewNotificationRow = typeof notifications.$inferInsert;
