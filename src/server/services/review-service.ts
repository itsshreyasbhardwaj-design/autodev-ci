import { logger } from '@/core/logger';
import type { ReviewResult } from '@/core/types';
import { getStore } from '@/db';
import type { DataStore, RepositoryRecord } from '@/db';
import { buildContext, detectDocumentationDrift, reviewPullRequest } from '@/features/analysis';
import { type AutodevConfig, loadConfig, mergeConfig } from '@/features/config';
import {
  type GitHubAuth,
  type RepoTarget,
  getFileContent,
  loadPullRequestContext,
} from '@/features/github/client';
import { publishReview } from '@/features/github/publish';
import { dispatch, reviewNotification } from '@/features/notifications';

/**
 * Review orchestration.
 *
 * Sits between the transport layers (webhook, REST API, CLI) and the pure
 * analysis engine. Owns everything the engine deliberately does not: fetching
 * from GitHub, resolving configuration, persistence, publishing and
 * notification. Keeping that split means the engine stays a pure function and
 * this layer stays free of analysis logic.
 */

export interface ReviewRequest {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly auth?: Partial<GitHubAuth>;
  /** Post results to GitHub. */
  readonly publish?: boolean;
  /** Send configured notifications. */
  readonly notify?: boolean;
  /** Persist the review and its findings. */
  readonly persist?: boolean;
  /** Overrides merged over the repository's `.autodev.yml`. */
  readonly configOverride?: Record<string, unknown>;
}

export interface ReviewOutcome {
  readonly review: ReviewResult;
  readonly published: boolean;
  readonly commentUrl: string | null;
  readonly notifications: number;
  readonly configSource: string | null;
}

/**
 * Loads `.autodev.yml` from the head commit of the PR.
 *
 * Reading it from the head rather than the base is deliberate: a PR that
 * tightens the review rules should be reviewed under the new rules, which is
 * what a maintainer expects when they open exactly that PR.
 */
async function resolveConfig(
  target: RepoTarget,
  ref: string,
  auth: Partial<GitHubAuth> | undefined,
  override: Record<string, unknown> | undefined,
): Promise<{ config: AutodevConfig; source: string | null }> {
  const { config, source } = await loadConfig((path) => getFileContent(target, path, ref, auth));
  return {
    config: override && Object.keys(override).length > 0 ? mergeConfig(config, override) : config,
    source,
  };
}

/** Fetches head-revision contents for the files worth deep-analysing. */
async function loadFileContents(
  target: RepoTarget,
  ref: string,
  paths: readonly string[],
  auth: Partial<GitHubAuth> | undefined,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();

  // Bounded: full-file fetches are one API call each, and the marginal value
  // drops off quickly after the largest handful of changed files.
  const limited = paths.slice(0, 25);

  await Promise.all(
    limited.map(async (path) => {
      try {
        const content = await getFileContent(target, path, ref, auth);
        if (content !== null && content.length < 400_000) contents.set(path, content);
      } catch {
        // A missing or unreadable file simply means the analyzers fall back to
        // diff-only mode for it.
      }
    }),
  );

  return contents;
}

/** Records the review and its findings, returning the persisted repository. */
async function persistReview(
  store: DataStore,
  result: ReviewResult,
  installationId: string | null,
): Promise<RepositoryRecord> {
  const repository = await store.upsertRepository({
    organizationId: null,
    githubId: result.repository.fullName,
    owner: result.repository.owner,
    name: result.repository.name,
    fullName: result.repository.fullName,
    defaultBranch: result.repository.defaultBranch ?? 'main',
    private: false,
    encryptedToken: null,
    installationId,
    config: {},
    active: true,
  });

  const pullRequest = await store.upsertPullRequest({
    repositoryId: repository.id,
    number: result.pullRequest.number,
    title: result.pullRequest.title,
    author: result.pullRequest.author,
    baseRef: result.pullRequest.baseRef,
    headRef: result.pullRequest.headRef,
    headSha: result.pullRequest.headSha,
    state: 'open',
    draft: result.pullRequest.draft ?? false,
    additions: result.metrics.linesAdded,
    deletions: result.metrics.linesRemoved,
    changedFiles: result.metrics.filesAnalyzed,
    url: result.pullRequest.url ?? null,
  });

  const review = await store.createReview({
    repositoryId: repository.id,
    pullRequestId: pullRequest.id,
    headSha: result.pullRequest.headSha,
    status: 'completed',
    verdict: result.summary.verdict,
    score: result.summary.score,
    engine: result.engine,
    summary: result.summary,
    commendations: [...result.commendations],
    gates: [...result.gates],
    metrics: { ...result.metrics },
    error: null,
    durationMs: result.metrics.durationMs,
  });

  await store.saveFindings(review.id, repository.id, result.findings);
  await store.updateRepository(repository.id, { lastAnalyzedAt: new Date() });

  return repository;
}

/**
 * Runs a complete review for a pull request.
 *
 * Analysis always completes even when publishing or notification fails —
 * those are reported in the outcome rather than thrown, because a stored
 * review that could not be posted is still a useful result.
 */
export async function runReview(request: ReviewRequest): Promise<ReviewOutcome> {
  const target: RepoTarget = { owner: request.owner, repo: request.repo };
  const log = logger().child({
    repository: `${request.owner}/${request.repo}`,
    pullNumber: request.pullNumber,
  });

  const prContext = await loadPullRequestContext(target, request.pullNumber, request.auth);

  const { config, source } = await resolveConfig(
    target,
    prContext.pullRequest.headSha,
    request.auth,
    request.configOverride,
  );

  if (!config.review.enabled) {
    log.info('Review is disabled for this repository; skipping');
    throw new Error('Review is disabled in .autodev.yml for this repository');
  }

  // Full contents let the complexity and duplication analyzers see whole
  // functions rather than diff fragments.
  const interesting = [...prContext.files]
    .filter((file) => !file.binary && file.status !== 'removed')
    .sort((a, b) => b.additions - a.additions)
    .map((file) => file.path);

  const fileContents = await loadFileContents(
    target,
    prContext.pullRequest.headSha,
    interesting,
    request.auth,
  );

  const context = buildContext({
    repository: prContext.repository,
    pullRequest: prContext.pullRequest,
    allFiles: prContext.files,
    config,
    fileContents,
  });

  const result = await reviewPullRequest({ context });

  // Documentation drift is computed against the repository's watched docs, so
  // it needs their contents rather than only the diff.
  let withDocs = result;
  if (config.docs.enabled) {
    const documents = await Promise.all(
      ['README.md', 'docs/README.md', 'CHANGELOG.md'].map(async (path) => {
        const content = await getFileContent(
          target,
          path,
          prContext.pullRequest.headSha,
          request.auth,
        );
        return content ? { path, content } : null;
      }),
    );

    const driftFindings = detectDocumentationDrift({
      files: prContext.files,
      documents: documents.filter((doc): doc is { path: string; content: string } => doc !== null),
    });

    if (driftFindings.length > 0) {
      withDocs = { ...result, findings: [...result.findings, ...driftFindings] };
    }
  }

  let published = false;
  let commentUrl: string | null = null;

  if (request.publish !== false && config.notifications.githubComment) {
    try {
      const outcome = await publishReview({
        target,
        pullNumber: request.pullNumber,
        result: withDocs,
        files: prContext.files,
        config: config.review,
        ...(request.auth ? { auth: request.auth } : {}),
      });
      published = outcome.commentId !== null;
      commentUrl = outcome.commentId
        ? `https://github.com/${target.owner}/${target.repo}/pull/${request.pullNumber}#issuecomment-${outcome.commentId}`
        : null;
    } catch (error) {
      log.error('Failed to publish review to GitHub', { error });
    }
  }

  if (request.persist !== false) {
    try {
      await persistReview(getStore(), withDocs, null);
    } catch (error) {
      log.error('Failed to persist review', { error });
    }
  }

  let notifications = 0;
  if (request.notify !== false) {
    const results = await dispatch(reviewNotification(withDocs), {
      config: config.notifications,
    });
    notifications = results.filter((entry) => entry.delivered).length;
  }

  return { review: withDocs, published, commentUrl, notifications, configSource: source };
}
