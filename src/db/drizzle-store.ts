import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { generateId } from '@/core/crypto';
import type { Finding, HealthGrade, Severity } from '@/core/types';
import * as schema from './schema';
import {
  type AnalysisRunRecord,
  type ArtifactKind,
  type ArtifactRecord,
  type DataStore,
  type FindingQuery,
  type FindingRecord,
  type HealthSnapshotRecord,
  type ListOptions,
  type NotificationRecord,
  type Page,
  type PullRequestInput,
  type PullRequestRecord,
  type RepositoryInput,
  type RepositoryRecord,
  type ReviewInput,
  type ReviewRecord,
  type ReviewStatus,
} from './store';

export type Database = PostgresJsDatabase<typeof schema>;

function bounds(options: ListOptions = {}): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(options.limit ?? 20, 1), 100),
    offset: Math.max(options.offset ?? 0, 0),
  };
}

/** Row -> domain mappers. Kept explicit so schema drift surfaces as a type error. */
function toRepository(row: schema.RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    githubId: row.githubId,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    private: row.private,
    encryptedToken: row.encryptedToken,
    installationId: row.installationId,
    config: row.config,
    active: row.active,
    lastAnalyzedAt: row.lastAnalyzedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPullRequest(row: schema.PullRequestRow): PullRequestRecord {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    number: row.number,
    title: row.title,
    author: row.author,
    baseRef: row.baseRef,
    headRef: row.headRef,
    headSha: row.headSha,
    state: row.state as PullRequestRecord['state'],
    draft: row.draft,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toReview(row: schema.ReviewRow): ReviewRecord {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    pullRequestId: row.pullRequestId,
    headSha: row.headSha,
    status: row.status as ReviewStatus,
    verdict: row.verdict,
    score: row.score,
    engine: row.engine,
    summary: row.summary ?? null,
    commendations: row.commendations,
    gates: row.gates,
    metrics: row.metrics,
    error: row.error,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFinding(row: schema.FindingRow): FindingRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    repositoryId: row.repositoryId,
    rule: row.rule,
    category: row.category as Finding['category'],
    severity: row.severity,
    title: row.title,
    description: row.description,
    location: row.filePath
      ? {
          path: row.filePath,
          ...(row.line !== null ? { line: row.line } : {}),
          ...(row.endLine !== null ? { endLine: row.endLine } : {}),
          ...(row.diffPosition !== null ? { diffPosition: row.diffPosition } : {}),
        }
      : undefined,
    suggestion: row.suggestion ?? undefined,
    source: row.source as Finding['source'],
    confidence: row.confidence,
    references: row.references,
    dismissedAt: row.dismissedAt,
    dismissedReason: row.dismissedReason,
    createdAt: row.createdAt,
  };
}

/**
 * PostgreSQL-backed {@link DataStore}.
 *
 * Writes that must be atomic — a review plus its findings — go through
 * transactions so a crash mid-write cannot leave a review with a partial
 * finding set.
 */
export class DrizzleStore implements DataStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  // --- Repositories --------------------------------------------------------

  async listRepositories(options: ListOptions = {}): Promise<Page<RepositoryRecord>> {
    const { limit, offset } = bounds(options);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.repositories)
        .orderBy(schema.repositories.fullName)
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.repositories),
    ]);
    return { items: rows.map(toRepository), total: totals?.value ?? 0, limit, offset };
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id))
      .limit(1);
    return row ? toRepository(row) : null;
  }

  async getRepositoryByFullName(fullName: string): Promise<RepositoryRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.repositories)
      .where(sql`lower(${schema.repositories.fullName}) = lower(${fullName})`)
      .limit(1);
    return row ? toRepository(row) : null;
  }

  async upsertRepository(input: RepositoryInput): Promise<RepositoryRecord> {
    const [row] = await this.db
      .insert(schema.repositories)
      .values({
        id: input.id ?? generateId(),
        organizationId: input.organizationId,
        githubId: input.githubId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        private: input.private,
        encryptedToken: input.encryptedToken,
        installationId: input.installationId,
        config: input.config,
        active: input.active,
        lastAnalyzedAt: input.lastAnalyzedAt ?? null,
      })
      .onConflictDoUpdate({
        target: schema.repositories.fullName,
        set: {
          owner: input.owner,
          name: input.name,
          defaultBranch: input.defaultBranch,
          private: input.private,
          installationId: input.installationId,
          config: input.config,
          active: input.active,
          updatedAt: new Date(),
          // Deliberately not overwriting `encryptedToken` with null on an
          // upsert driven by a webhook payload, which carries no credentials.
          ...(input.encryptedToken ? { encryptedToken: input.encryptedToken } : {}),
        },
      })
      .returning();

    if (!row) throw new Error('Failed to upsert repository');
    return toRepository(row);
  }

  async updateRepository(
    id: string,
    patch: Partial<Omit<RepositoryRecord, 'id' | 'createdAt'>>,
  ): Promise<RepositoryRecord | null> {
    const [row] = await this.db
      .update(schema.repositories)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.repositories.id, id))
      .returning();
    return row ? toRepository(row) : null;
  }

  async deleteRepository(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.repositories)
      .where(eq(schema.repositories.id, id))
      .returning({ id: schema.repositories.id });
    return rows.length > 0;
  }

  // --- Pull requests -------------------------------------------------------

  async upsertPullRequest(input: PullRequestInput): Promise<PullRequestRecord> {
    const [row] = await this.db
      .insert(schema.pullRequests)
      .values({
        id: input.id ?? generateId(),
        repositoryId: input.repositoryId,
        number: input.number,
        title: input.title,
        author: input.author,
        baseRef: input.baseRef,
        headRef: input.headRef,
        headSha: input.headSha,
        state: input.state,
        draft: input.draft,
        additions: input.additions,
        deletions: input.deletions,
        changedFiles: input.changedFiles,
        url: input.url,
      })
      .onConflictDoUpdate({
        target: [schema.pullRequests.repositoryId, schema.pullRequests.number],
        set: {
          title: input.title,
          headSha: input.headSha,
          state: input.state,
          draft: input.draft,
          additions: input.additions,
          deletions: input.deletions,
          changedFiles: input.changedFiles,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error('Failed to upsert pull request');
    return toPullRequest(row);
  }

  async listPullRequests(
    repositoryId: string | undefined,
    options: ListOptions & { state?: PullRequestRecord['state'] } = {},
  ): Promise<Page<PullRequestRecord>> {
    const { limit, offset } = bounds(options);
    const filters = [
      repositoryId ? eq(schema.pullRequests.repositoryId, repositoryId) : undefined,
      options.state ? eq(schema.pullRequests.state, options.state) : undefined,
    ].filter(Boolean);
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.pullRequests)
        .where(where)
        .orderBy(desc(schema.pullRequests.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.pullRequests).where(where),
    ]);

    return { items: rows.map(toPullRequest), total: totals?.value ?? 0, limit, offset };
  }

  async getPullRequest(repositoryId: string, number: number): Promise<PullRequestRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.pullRequests)
      .where(
        and(
          eq(schema.pullRequests.repositoryId, repositoryId),
          eq(schema.pullRequests.number, number),
        ),
      )
      .limit(1);
    return row ? toPullRequest(row) : null;
  }

  // --- Reviews -------------------------------------------------------------

  async createReview(input: ReviewInput): Promise<ReviewRecord> {
    const [row] = await this.db
      .insert(schema.reviews)
      .values({
        id: input.id ?? generateId(),
        repositoryId: input.repositoryId,
        pullRequestId: input.pullRequestId,
        headSha: input.headSha,
        status: input.status,
        verdict: input.verdict,
        score: input.score,
        engine: input.engine,
        summary: input.summary,
        commendations: input.commendations,
        gates: input.gates,
        metrics: input.metrics,
        error: input.error,
        durationMs: input.durationMs,
      })
      .returning();

    if (!row) throw new Error('Failed to create review');
    return toReview(row);
  }

  async updateReview(id: string, patch: Partial<ReviewRecord>): Promise<ReviewRecord | null> {
    const { id: _ignored, createdAt: _createdAt, ...rest } = patch;
    const [row] = await this.db
      .update(schema.reviews)
      .set({ ...rest, updatedAt: new Date() })
      .where(eq(schema.reviews.id, id))
      .returning();
    return row ? toReview(row) : null;
  }

  async getReview(id: string): Promise<ReviewRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.id, id))
      .limit(1);
    return row ? toReview(row) : null;
  }

  async listReviews(
    repositoryId: string | undefined,
    options: ListOptions = {},
  ): Promise<Page<ReviewRecord>> {
    const { limit, offset } = bounds(options);
    const where = repositoryId ? eq(schema.reviews.repositoryId, repositoryId) : undefined;

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.reviews)
        .where(where)
        .orderBy(desc(schema.reviews.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.reviews).where(where),
    ]);

    return { items: rows.map(toReview), total: totals?.value ?? 0, limit, offset };
  }

  // --- Findings ------------------------------------------------------------

  async saveFindings(
    reviewId: string,
    repositoryId: string,
    findings: readonly Finding[],
  ): Promise<FindingRecord[]> {
    if (findings.length === 0) return [];

    const rows = await this.db
      .insert(schema.findings)
      .values(
        findings.map((finding) => ({
          id: finding.id || generateId(),
          reviewId,
          repositoryId,
          rule: finding.rule,
          category: finding.category,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          filePath: finding.location?.path ?? null,
          line: finding.location?.line ?? null,
          endLine: finding.location?.endLine ?? null,
          diffPosition: finding.location?.diffPosition ?? null,
          suggestion: finding.suggestion ?? null,
          source: finding.source,
          confidence: finding.confidence,
          references: [...(finding.references ?? [])],
        })),
      )
      .returning();

    return rows.map(toFinding);
  }

  async listFindings(query: FindingQuery = {}): Promise<Page<FindingRecord>> {
    const { limit, offset } = bounds(query);
    const filters = [
      query.repositoryId ? eq(schema.findings.repositoryId, query.repositoryId) : undefined,
      query.reviewId ? eq(schema.findings.reviewId, query.reviewId) : undefined,
      query.severity ? eq(schema.findings.severity, query.severity as Severity) : undefined,
      query.category ? eq(schema.findings.category, query.category) : undefined,
      query.since ? gte(schema.findings.createdAt, query.since) : undefined,
      query.includeDismissed ? undefined : isNull(schema.findings.dismissedAt),
    ].filter(Boolean);
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.findings)
        .where(where)
        .orderBy(desc(schema.findings.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.findings).where(where),
    ]);

    return { items: rows.map(toFinding), total: totals?.value ?? 0, limit, offset };
  }

  async dismissFinding(id: string, reason: string): Promise<FindingRecord | null> {
    const [row] = await this.db
      .update(schema.findings)
      .set({ dismissedAt: new Date(), dismissedReason: reason })
      .where(eq(schema.findings.id, id))
      .returning();
    return row ? toFinding(row) : null;
  }

  // --- Health --------------------------------------------------------------

  async saveHealthSnapshot(
    input: Omit<HealthSnapshotRecord, 'id'> & { id?: string },
  ): Promise<HealthSnapshotRecord> {
    // The table has a unique (repository_id, date_trunc('day', computed_at))
    // index. Drizzle's `onConflictDoUpdate` cannot target an expression index,
    // so the same-day replace is done explicitly inside a transaction — the
    // index still guarantees correctness under concurrent writers.
    const row = await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.healthSnapshots)
        .where(
          and(
            eq(schema.healthSnapshots.repositoryId, input.repositoryId),
            sql`date_trunc('day', ${schema.healthSnapshots.computedAt}) = date_trunc('day', ${input.computedAt}::timestamptz)`,
          ),
        );

      const [inserted] = await tx
        .insert(schema.healthSnapshots)
        .values({
          id: input.id ?? generateId(),
          repositoryId: input.repositoryId,
          score: input.score,
          grade: input.grade,
          dimensions: input.dimensions,
          recommendations: input.recommendations,
          computedAt: input.computedAt,
        })
        .returning();

      return inserted;
    });

    if (!row) throw new Error('Failed to save health snapshot');
    return {
      id: row.id,
      repositoryId: row.repositoryId,
      score: row.score,
      grade: row.grade as HealthGrade,
      dimensions: row.dimensions,
      recommendations: row.recommendations,
      computedAt: row.computedAt,
    };
  }

  async listHealthSnapshots(repositoryId: string, limit = 30): Promise<HealthSnapshotRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.healthSnapshots)
      .where(eq(schema.healthSnapshots.repositoryId, repositoryId))
      .orderBy(desc(schema.healthSnapshots.computedAt))
      .limit(limit);

    // Query descending for the index, return ascending for charting.
    return rows.reverse().map((row) => ({
      id: row.id,
      repositoryId: row.repositoryId,
      score: row.score,
      grade: row.grade as HealthGrade,
      dimensions: row.dimensions,
      recommendations: row.recommendations,
      computedAt: row.computedAt,
    }));
  }

  async latestHealthSnapshot(repositoryId: string): Promise<HealthSnapshotRecord | null> {
    const rows = await this.listHealthSnapshots(repositoryId, 1);
    return rows[0] ?? null;
  }

  // --- Artifacts -----------------------------------------------------------

  async saveArtifact(
    input: Omit<ArtifactRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ArtifactRecord> {
    const [row] = await this.db
      .insert(schema.artifacts)
      .values({
        id: input.id ?? generateId(),
        repositoryId: input.repositoryId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        subject: input.subject,
        metadata: input.metadata,
        pullRequestNumber: input.pullRequestNumber,
      })
      .returning();

    if (!row) throw new Error('Failed to save artifact');
    return {
      id: row.id,
      repositoryId: row.repositoryId,
      kind: row.kind as ArtifactKind,
      title: row.title,
      content: row.content,
      subject: row.subject,
      metadata: row.metadata,
      pullRequestNumber: row.pullRequestNumber,
      createdAt: row.createdAt,
    };
  }

  async listArtifacts(
    repositoryId: string,
    kind?: ArtifactKind,
    options: ListOptions = {},
  ): Promise<Page<ArtifactRecord>> {
    const { limit, offset } = bounds(options);
    const where = kind
      ? and(eq(schema.artifacts.repositoryId, repositoryId), eq(schema.artifacts.kind, kind))
      : eq(schema.artifacts.repositoryId, repositoryId);

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.artifacts)
        .where(where)
        .orderBy(desc(schema.artifacts.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.artifacts).where(where),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        kind: row.kind as ArtifactKind,
        title: row.title,
        content: row.content,
        subject: row.subject,
        metadata: row.metadata,
        pullRequestNumber: row.pullRequestNumber,
        createdAt: row.createdAt,
      })),
      total: totals?.value ?? 0,
      limit,
      offset,
    };
  }

  // --- Runs ----------------------------------------------------------------

  async createRun(
    input: Omit<AnalysisRunRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<AnalysisRunRecord> {
    const [row] = await this.db
      .insert(schema.analysisRuns)
      .values({
        id: input.id ?? generateId(),
        repositoryId: input.repositoryId,
        kind: input.kind,
        status: input.status,
        trigger: input.trigger,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs: input.durationMs,
        error: input.error,
        payload: input.payload,
      })
      .returning();

    if (!row) throw new Error('Failed to create run');
    return row as AnalysisRunRecord;
  }

  async updateRun(
    id: string,
    patch: Partial<AnalysisRunRecord>,
  ): Promise<AnalysisRunRecord | null> {
    const { id: _ignored, createdAt: _createdAt, ...rest } = patch;
    const [row] = await this.db
      .update(schema.analysisRuns)
      .set(rest)
      .where(eq(schema.analysisRuns.id, id))
      .returning();
    return (row as AnalysisRunRecord | undefined) ?? null;
  }

  async listRuns(
    repositoryId: string | undefined,
    options: ListOptions = {},
  ): Promise<Page<AnalysisRunRecord>> {
    const { limit, offset } = bounds(options);
    const where = repositoryId ? eq(schema.analysisRuns.repositoryId, repositoryId) : undefined;

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.analysisRuns)
        .where(where)
        .orderBy(desc(schema.analysisRuns.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.analysisRuns).where(where),
    ]);

    return { items: rows as AnalysisRunRecord[], total: totals?.value ?? 0, limit, offset };
  }

  // --- Notifications -------------------------------------------------------

  async recordNotification(
    input: Omit<NotificationRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<NotificationRecord> {
    const [row] = await this.db
      .insert(schema.notifications)
      .values({
        id: input.id ?? generateId(),
        repositoryId: input.repositoryId,
        channel: input.channel,
        event: input.event,
        status: input.status,
        target: input.target,
        payload: input.payload,
        error: input.error,
        attempts: input.attempts,
        deliveredAt: input.deliveredAt,
      })
      .returning();

    if (!row) throw new Error('Failed to record notification');
    return row as NotificationRecord;
  }

  async listNotifications(options: ListOptions = {}): Promise<Page<NotificationRecord>> {
    const { limit, offset } = bounds(options);
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(schema.notifications)
        .orderBy(desc(schema.notifications.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ value: count() }).from(schema.notifications),
    ]);
    return { items: rows as NotificationRecord[], total: totals?.value ?? 0, limit, offset };
  }

  // --- Webhooks ------------------------------------------------------------

  async markWebhookDelivery(deliveryId: string, event: string, action?: string): Promise<boolean> {
    // The unique index on delivery_id makes this the atomic dedupe point:
    // a concurrent duplicate delivery conflicts and returns zero rows.
    const rows = await this.db
      .insert(schema.webhookDeliveries)
      .values({ deliveryId, event, action: action ?? null })
      .onConflictDoNothing({ target: schema.webhookDeliveries.deliveryId })
      .returning({ id: schema.webhookDeliveries.id });

    return rows.length > 0;
  }

  async ping(): Promise<boolean> {
    await this.db.execute(sql`select 1`);
    return true;
  }
}
