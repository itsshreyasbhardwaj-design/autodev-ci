import type {
  Commendation,
  Finding,
  GateResult,
  HealthDimension,
  HealthGrade,
  ReviewSummary,
  Severity,
} from '@/core/types';

/**
 * Storage port.
 *
 * The application depends on this interface, never on Drizzle directly. Two
 * adapters implement it: an in-memory store (so AutoDev CI runs with zero
 * infrastructure — evaluation, CI, the CLI) and a Postgres store. Because both
 * satisfy the same contract, the integration test suite runs against either.
 */

export interface RepositoryRecord {
  id: string;
  organizationId: string | null;
  githubId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  encryptedToken: string | null;
  installationId: string | null;
  config: Record<string, unknown>;
  active: boolean;
  lastAnalyzedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RepositoryInput = Omit<
  RepositoryRecord,
  'id' | 'createdAt' | 'updatedAt' | 'lastAnalyzedAt'
> &
  Partial<Pick<RepositoryRecord, 'id' | 'lastAnalyzedAt'>>;

export interface PullRequestRecord {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PullRequestInput = Omit<PullRequestRecord, 'id' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<PullRequestRecord, 'id'>>;

export type ReviewStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ReviewRecord {
  id: string;
  repositoryId: string;
  pullRequestId: string | null;
  headSha: string;
  status: ReviewStatus;
  verdict: string | null;
  score: number | null;
  engine: string;
  summary: ReviewSummary | null;
  commendations: Commendation[];
  gates: GateResult[];
  metrics: Record<string, unknown>;
  error: string | null;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReviewInput = Omit<ReviewRecord, 'id' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<ReviewRecord, 'id'>>;

export interface FindingRecord extends Finding {
  reviewId: string;
  repositoryId: string;
  dismissedAt: Date | null;
  dismissedReason: string | null;
  createdAt: Date;
}

export interface HealthSnapshotRecord {
  id: string;
  repositoryId: string;
  score: number;
  grade: HealthGrade;
  dimensions: HealthDimension[];
  recommendations: string[];
  computedAt: Date;
}

export type ArtifactKind =
  | 'changelog'
  | 'release-notes'
  | 'docs-suggestion'
  | 'migration-guide'
  | 'upgrade-guide'
  | 'deployment-checklist';

export interface ArtifactRecord {
  id: string;
  repositoryId: string;
  kind: ArtifactKind;
  title: string;
  content: string;
  subject: string | null;
  metadata: Record<string, unknown>;
  pullRequestNumber: number | null;
  createdAt: Date;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface AnalysisRunRecord {
  id: string;
  repositoryId: string | null;
  kind: string;
  status: RunStatus;
  trigger: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface NotificationRecord {
  id: string;
  repositoryId: string | null;
  channel: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  target: string | null;
  payload: Record<string, unknown>;
  error: string | null;
  attempts: number;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export interface FindingQuery extends ListOptions {
  readonly repositoryId?: string;
  readonly reviewId?: string;
  readonly severity?: Severity;
  readonly category?: string;
  readonly includeDismissed?: boolean;
  readonly since?: Date;
}

export interface DataStore {
  /** `memory` or `postgres`; surfaced on the health endpoint. */
  readonly kind: 'memory' | 'postgres';

  // Repositories
  listRepositories(options?: ListOptions): Promise<Page<RepositoryRecord>>;
  getRepository(id: string): Promise<RepositoryRecord | null>;
  getRepositoryByFullName(fullName: string): Promise<RepositoryRecord | null>;
  upsertRepository(input: RepositoryInput): Promise<RepositoryRecord>;
  updateRepository(
    id: string,
    patch: Partial<Omit<RepositoryRecord, 'id' | 'createdAt'>>,
  ): Promise<RepositoryRecord | null>;
  deleteRepository(id: string): Promise<boolean>;

  // Pull requests
  upsertPullRequest(input: PullRequestInput): Promise<PullRequestRecord>;
  listPullRequests(
    repositoryId: string | undefined,
    options?: ListOptions & { state?: PullRequestRecord['state'] },
  ): Promise<Page<PullRequestRecord>>;
  getPullRequest(repositoryId: string, number: number): Promise<PullRequestRecord | null>;

  // Reviews
  createReview(input: ReviewInput): Promise<ReviewRecord>;
  updateReview(id: string, patch: Partial<ReviewRecord>): Promise<ReviewRecord | null>;
  getReview(id: string): Promise<ReviewRecord | null>;
  listReviews(repositoryId: string | undefined, options?: ListOptions): Promise<Page<ReviewRecord>>;

  // Findings
  saveFindings(
    reviewId: string,
    repositoryId: string,
    findings: readonly Finding[],
  ): Promise<FindingRecord[]>;
  listFindings(query?: FindingQuery): Promise<Page<FindingRecord>>;
  dismissFinding(id: string, reason: string): Promise<FindingRecord | null>;

  // Health
  saveHealthSnapshot(
    input: Omit<HealthSnapshotRecord, 'id'> & { id?: string },
  ): Promise<HealthSnapshotRecord>;
  listHealthSnapshots(repositoryId: string, limit?: number): Promise<HealthSnapshotRecord[]>;
  latestHealthSnapshot(repositoryId: string): Promise<HealthSnapshotRecord | null>;

  // Artifacts
  saveArtifact(
    input: Omit<ArtifactRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ArtifactRecord>;
  listArtifacts(
    repositoryId: string,
    kind?: ArtifactKind,
    options?: ListOptions,
  ): Promise<Page<ArtifactRecord>>;

  // Runs
  createRun(
    input: Omit<AnalysisRunRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<AnalysisRunRecord>;
  updateRun(id: string, patch: Partial<AnalysisRunRecord>): Promise<AnalysisRunRecord | null>;
  listRuns(
    repositoryId: string | undefined,
    options?: ListOptions,
  ): Promise<Page<AnalysisRunRecord>>;

  // Notifications
  recordNotification(
    input: Omit<NotificationRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<NotificationRecord>;
  listNotifications(options?: ListOptions): Promise<Page<NotificationRecord>>;

  // Webhook idempotency
  /** Returns true if this delivery is new; false if already processed. */
  markWebhookDelivery(deliveryId: string, event: string, action?: string): Promise<boolean>;

  /** Liveness probe used by `/api/health`. */
  ping(): Promise<boolean>;
}

export function emptyPage<T>(limit = 20, offset = 0): Page<T> {
  return { items: [], total: 0, limit, offset };
}

export function paginate<T>(items: readonly T[], options: ListOptions = {}): Page<T> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}
