import { generateId } from '@/core/crypto';
import type { Finding } from '@/core/types';
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
  paginate,
} from './store';

/**
 * In-memory {@link DataStore}.
 *
 * This is a first-class adapter, not a test double: it is what runs when no
 * `DATABASE_URL` is configured, which is how most people will first try the
 * platform. It therefore implements the full contract — including ordering,
 * pagination and the one-health-snapshot-per-day rule — so behaviour does not
 * change when someone later points at Postgres.
 *
 * Everything is deep-cloned on the way in and out. Without that, a caller
 * mutating a returned object would silently corrupt "persisted" state, a bug
 * class that simply cannot happen against a real database.
 */
export class MemoryStore implements DataStore {
  readonly kind = 'memory' as const;

  private readonly repositories = new Map<string, RepositoryRecord>();
  private readonly pullRequests = new Map<string, PullRequestRecord>();
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly findings = new Map<string, FindingRecord>();
  private readonly healthSnapshots = new Map<string, HealthSnapshotRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly runs = new Map<string, AnalysisRunRecord>();
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly deliveries = new Set<string>();

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  private sortedDesc<T extends { createdAt: Date }>(items: T[]): T[] {
    return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // --- Repositories --------------------------------------------------------

  async listRepositories(options: ListOptions = {}): Promise<Page<RepositoryRecord>> {
    const items = [...this.repositories.values()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    );
    return paginate(this.clone(items), options);
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    const found = this.repositories.get(id);
    return found ? this.clone(found) : null;
  }

  async getRepositoryByFullName(fullName: string): Promise<RepositoryRecord | null> {
    const needle = fullName.toLowerCase();
    for (const repo of this.repositories.values()) {
      if (repo.fullName.toLowerCase() === needle) return this.clone(repo);
    }
    return null;
  }

  async upsertRepository(input: RepositoryInput): Promise<RepositoryRecord> {
    const existing = await this.getRepositoryByFullName(input.fullName);
    const now = new Date();

    const record: RepositoryRecord = {
      ...input,
      id: existing?.id ?? input.id ?? generateId(),
      lastAnalyzedAt: input.lastAnalyzedAt ?? existing?.lastAnalyzedAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.repositories.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async updateRepository(
    id: string,
    patch: Partial<Omit<RepositoryRecord, 'id' | 'createdAt'>>,
  ): Promise<RepositoryRecord | null> {
    const existing = this.repositories.get(id);
    if (!existing) return null;
    const updated: RepositoryRecord = { ...existing, ...patch, id, updatedAt: new Date() };
    this.repositories.set(id, this.clone(updated));
    return this.clone(updated);
  }

  async deleteRepository(id: string): Promise<boolean> {
    if (!this.repositories.delete(id)) return false;

    // Emulate ON DELETE CASCADE so orphan rows cannot accumulate.
    for (const [key, pr] of this.pullRequests)
      if (pr.repositoryId === id) this.pullRequests.delete(key);
    for (const [key, review] of this.reviews)
      if (review.repositoryId === id) this.reviews.delete(key);
    for (const [key, finding] of this.findings)
      if (finding.repositoryId === id) this.findings.delete(key);
    for (const [key, snap] of this.healthSnapshots)
      if (snap.repositoryId === id) this.healthSnapshots.delete(key);
    for (const [key, artifact] of this.artifacts)
      if (artifact.repositoryId === id) this.artifacts.delete(key);
    for (const [key, run] of this.runs) if (run.repositoryId === id) this.runs.delete(key);

    return true;
  }

  // --- Pull requests -------------------------------------------------------

  async upsertPullRequest(input: PullRequestInput): Promise<PullRequestRecord> {
    const existing = await this.getPullRequest(input.repositoryId, input.number);
    const now = new Date();
    const record: PullRequestRecord = {
      ...input,
      id: existing?.id ?? input.id ?? generateId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.pullRequests.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async listPullRequests(
    repositoryId: string | undefined,
    options: ListOptions & { state?: PullRequestRecord['state'] } = {},
  ): Promise<Page<PullRequestRecord>> {
    let items = [...this.pullRequests.values()];
    if (repositoryId) items = items.filter((pr) => pr.repositoryId === repositoryId);
    if (options.state) items = items.filter((pr) => pr.state === options.state);
    return paginate(this.clone(this.sortedDesc(items)), options);
  }

  async getPullRequest(repositoryId: string, number: number): Promise<PullRequestRecord | null> {
    for (const pr of this.pullRequests.values()) {
      if (pr.repositoryId === repositoryId && pr.number === number) return this.clone(pr);
    }
    return null;
  }

  // --- Reviews -------------------------------------------------------------

  async createReview(input: ReviewInput): Promise<ReviewRecord> {
    const now = new Date();
    const record: ReviewRecord = {
      ...input,
      id: input.id ?? generateId(),
      createdAt: now,
      updatedAt: now,
    };
    this.reviews.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async updateReview(id: string, patch: Partial<ReviewRecord>): Promise<ReviewRecord | null> {
    const existing = this.reviews.get(id);
    if (!existing) return null;
    const updated: ReviewRecord = { ...existing, ...patch, id, updatedAt: new Date() };
    this.reviews.set(id, this.clone(updated));
    return this.clone(updated);
  }

  async getReview(id: string): Promise<ReviewRecord | null> {
    const found = this.reviews.get(id);
    return found ? this.clone(found) : null;
  }

  async listReviews(
    repositoryId: string | undefined,
    options: ListOptions = {},
  ): Promise<Page<ReviewRecord>> {
    let items = [...this.reviews.values()];
    if (repositoryId) items = items.filter((review) => review.repositoryId === repositoryId);
    return paginate(this.clone(this.sortedDesc(items)), options);
  }

  // --- Findings ------------------------------------------------------------

  async saveFindings(
    reviewId: string,
    repositoryId: string,
    findings: readonly Finding[],
  ): Promise<FindingRecord[]> {
    const now = new Date();
    const records = findings.map<FindingRecord>((finding) => ({
      ...finding,
      id: finding.id || generateId(),
      reviewId,
      repositoryId,
      dismissedAt: null,
      dismissedReason: null,
      createdAt: now,
    }));

    for (const record of records) this.findings.set(record.id, this.clone(record));
    return this.clone(records);
  }

  async listFindings(query: FindingQuery = {}): Promise<Page<FindingRecord>> {
    let items = [...this.findings.values()];

    if (query.repositoryId) items = items.filter((f) => f.repositoryId === query.repositoryId);
    if (query.reviewId) items = items.filter((f) => f.reviewId === query.reviewId);
    if (query.severity) items = items.filter((f) => f.severity === query.severity);
    if (query.category) items = items.filter((f) => f.category === query.category);
    if (query.since) items = items.filter((f) => f.createdAt >= query.since!);
    if (!query.includeDismissed) items = items.filter((f) => f.dismissedAt === null);

    return paginate(this.clone(this.sortedDesc(items)), query);
  }

  async dismissFinding(id: string, reason: string): Promise<FindingRecord | null> {
    const existing = this.findings.get(id);
    if (!existing) return null;
    const updated: FindingRecord = {
      ...existing,
      dismissedAt: new Date(),
      dismissedReason: reason,
    };
    this.findings.set(id, this.clone(updated));
    return this.clone(updated);
  }

  // --- Health --------------------------------------------------------------

  async saveHealthSnapshot(
    input: Omit<HealthSnapshotRecord, 'id'> & { id?: string },
  ): Promise<HealthSnapshotRecord> {
    // Mirror the unique (repository, day) index: same-day writes replace.
    const day = input.computedAt.toISOString().slice(0, 10);
    for (const [key, snapshot] of this.healthSnapshots) {
      if (
        snapshot.repositoryId === input.repositoryId &&
        snapshot.computedAt.toISOString().slice(0, 10) === day
      ) {
        this.healthSnapshots.delete(key);
      }
    }

    const record: HealthSnapshotRecord = { ...input, id: input.id ?? generateId() };
    this.healthSnapshots.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async listHealthSnapshots(repositoryId: string, limit = 30): Promise<HealthSnapshotRecord[]> {
    const items = [...this.healthSnapshots.values()]
      .filter((snapshot) => snapshot.repositoryId === repositoryId)
      .sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime())
      .slice(-limit);
    return this.clone(items);
  }

  async latestHealthSnapshot(repositoryId: string): Promise<HealthSnapshotRecord | null> {
    const items = await this.listHealthSnapshots(repositoryId, 1000);
    const last = items[items.length - 1];
    return last ? this.clone(last) : null;
  }

  // --- Artifacts -----------------------------------------------------------

  async saveArtifact(
    input: Omit<ArtifactRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ArtifactRecord> {
    const record: ArtifactRecord = {
      ...input,
      id: input.id ?? generateId(),
      createdAt: new Date(),
    };
    this.artifacts.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async listArtifacts(
    repositoryId: string,
    kind?: ArtifactKind,
    options: ListOptions = {},
  ): Promise<Page<ArtifactRecord>> {
    let items = [...this.artifacts.values()].filter((a) => a.repositoryId === repositoryId);
    if (kind) items = items.filter((a) => a.kind === kind);
    return paginate(this.clone(this.sortedDesc(items)), options);
  }

  // --- Runs ----------------------------------------------------------------

  async createRun(
    input: Omit<AnalysisRunRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<AnalysisRunRecord> {
    const record: AnalysisRunRecord = {
      ...input,
      id: input.id ?? generateId(),
      createdAt: new Date(),
    };
    this.runs.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async updateRun(
    id: string,
    patch: Partial<AnalysisRunRecord>,
  ): Promise<AnalysisRunRecord | null> {
    const existing = this.runs.get(id);
    if (!existing) return null;
    const updated: AnalysisRunRecord = { ...existing, ...patch, id };
    this.runs.set(id, this.clone(updated));
    return this.clone(updated);
  }

  async listRuns(
    repositoryId: string | undefined,
    options: ListOptions = {},
  ): Promise<Page<AnalysisRunRecord>> {
    let items = [...this.runs.values()];
    if (repositoryId) items = items.filter((run) => run.repositoryId === repositoryId);
    return paginate(this.clone(this.sortedDesc(items)), options);
  }

  // --- Notifications -------------------------------------------------------

  async recordNotification(
    input: Omit<NotificationRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<NotificationRecord> {
    const record: NotificationRecord = {
      ...input,
      id: input.id ?? generateId(),
      createdAt: new Date(),
    };
    this.notifications.set(record.id, this.clone(record));
    return this.clone(record);
  }

  async listNotifications(options: ListOptions = {}): Promise<Page<NotificationRecord>> {
    const items = this.sortedDesc([...this.notifications.values()]);
    return paginate(this.clone(items), options);
  }

  // --- Webhooks ------------------------------------------------------------

  async markWebhookDelivery(
    deliveryId: string,
    _event?: string,
    _action?: string,
  ): Promise<boolean> {
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.add(deliveryId);
    // Bound memory growth on long-running processes.
    if (this.deliveries.size > 10_000) {
      const oldest = this.deliveries.values().next();
      if (!oldest.done) this.deliveries.delete(oldest.value);
    }
    return true;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /** Test helper: wipes all state. */
  reset(): void {
    this.repositories.clear();
    this.pullRequests.clear();
    this.reviews.clear();
    this.findings.clear();
    this.healthSnapshots.clear();
    this.artifacts.clear();
    this.runs.clear();
    this.notifications.clear();
    this.deliveries.clear();
  }
}
