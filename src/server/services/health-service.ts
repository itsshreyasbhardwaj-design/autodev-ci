import { logger } from '@/core/logger';
import type { HealthReport } from '@/core/types';
import { getStore } from '@/db';
import type { HealthSnapshotRecord } from '@/db';
import { computeHealth, healthTrend } from '@/features/health';
import {
  type GitHubAuth,
  type RepoTarget,
  getOctokit,
  getRepository,
  listRootEntries,
} from '@/features/github/client';

/**
 * Repository health computation.
 *
 * Gathers the signals health scoring needs from GitHub and the store, then
 * hands them to the pure {@link computeHealth} scorer. Every remote lookup
 * degrades to "unknown" rather than failing: a repository with Actions
 * disabled should still get a health score, just one that says CI stability
 * could not be measured.
 */

export interface HealthRequest {
  readonly owner: string;
  readonly repo: string;
  readonly auth?: Partial<GitHubAuth>;
  readonly persist?: boolean;
}

export interface HealthOutcome {
  readonly report: HealthReport;
  readonly trend: ReturnType<typeof healthTrend>;
  readonly history: readonly HealthSnapshotRecord[];
}

/** Lists tracked paths via the git tree API. Returns [] when unavailable. */
async function listAllPaths(
  target: RepoTarget,
  ref: string,
  auth: Partial<GitHubAuth> | undefined,
): Promise<string[]> {
  try {
    const octokit = getOctokit(auth);
    const { data } = await octokit.git.getTree({
      owner: target.owner,
      repo: target.repo,
      tree_sha: ref,
      recursive: 'true',
    });

    return data.tree
      .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
      .map((entry) => entry.path as string);
  } catch (error) {
    logger().debug('Could not list repository tree', { error });
    return [];
  }
}

/** Fraction of recent workflow runs on the default branch that succeeded. */
async function ciSuccessRate(
  target: RepoTarget,
  branch: string,
  auth: Partial<GitHubAuth> | undefined,
): Promise<number | undefined> {
  try {
    const octokit = getOctokit(auth);
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner: target.owner,
      repo: target.repo,
      branch,
      per_page: 50,
      status: 'completed',
    });

    const runs = data.workflow_runs;
    if (runs.length === 0) return undefined;

    const succeeded = runs.filter((run) => run.conclusion === 'success').length;
    return succeeded / runs.length;
  } catch {
    return undefined;
  }
}

export async function runHealthCheck(request: HealthRequest): Promise<HealthOutcome> {
  const target: RepoTarget = { owner: request.owner, repo: request.repo };
  const store = getStore();

  const metadata = await getRepository(target, request.auth);

  const [rootEntries, allPaths, successRate] = await Promise.all([
    listRootEntries(target, metadata.defaultBranch, request.auth),
    listAllPaths(target, metadata.defaultBranch, request.auth),
    ciSuccessRate(target, metadata.defaultBranch, request.auth),
  ]);

  // Findings from the last 30 days feed the security and quality dimensions.
  const existing = await store.getRepositoryByFullName(metadata.fullName);
  const recentFindings = existing
    ? (
        await store.listFindings({
          repositoryId: existing.id,
          since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          limit: 100,
        })
      ).items
    : [];

  const daysSinceLastCommit = metadata.pushedAt
    ? Math.floor((Date.now() - new Date(metadata.pushedAt).getTime()) / (24 * 60 * 60 * 1000))
    : undefined;

  const report = computeHealth({
    repository: {
      owner: target.owner,
      name: target.repo,
      fullName: metadata.fullName,
      defaultBranch: metadata.defaultBranch,
    },
    rootEntries,
    allPaths,
    recentFindings,
    hasLicense: metadata.license !== null,
    openIssues: metadata.openIssues,
    ...(successRate !== undefined ? { ciSuccessRate: successRate } : {}),
    ...(daysSinceLastCommit !== undefined ? { daysSinceLastCommit } : {}),
  });

  let history: HealthSnapshotRecord[] = [];

  if (request.persist !== false) {
    const repository =
      existing ??
      (await store.upsertRepository({
        organizationId: null,
        githubId: metadata.githubId,
        owner: target.owner,
        name: target.repo,
        fullName: metadata.fullName,
        defaultBranch: metadata.defaultBranch,
        private: metadata.private,
        encryptedToken: null,
        installationId: null,
        config: {},
        active: true,
      }));

    history = await store.listHealthSnapshots(repository.id, 30);

    await store.saveHealthSnapshot({
      repositoryId: repository.id,
      score: report.score,
      grade: report.grade,
      dimensions: [...report.dimensions],
      recommendations: [...report.recommendations],
      computedAt: new Date(),
    });
  }

  const previous = history[history.length - 1]?.score;

  return { report, trend: healthTrend(report.score, previous), history };
}
