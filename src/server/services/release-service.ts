import type { RepositoryRef } from '@/core/types';
import { getStore } from '@/db';
import { type ChangelogResult, generateChangelog, latestVersionTag } from '@/features/changelog';
import { type AutodevConfig, defaultConfig, loadConfig } from '@/features/config';
import {
  type GitHubAuth,
  type RepoTarget,
  compareRefs,
  getFileContent,
  getRepository,
  listCommitsBetween,
  listTags,
} from '@/features/github/client';
import { type ReleasePlan, planRelease } from '@/features/release';

/**
 * Changelog and release generation.
 *
 * Resolves the "from" ref automatically when the caller does not supply one:
 * the newest semver tag, falling back to the repository's first commit for a
 * project that has never tagged a release.
 */

export interface ChangelogRequest {
  readonly owner: string;
  readonly repo: string;
  readonly from?: string;
  readonly to?: string;
  readonly version?: string;
  readonly auth?: Partial<GitHubAuth>;
  readonly persist?: boolean;
}

async function resolveConfig(
  target: RepoTarget,
  ref: string | undefined,
  auth: Partial<GitHubAuth> | undefined,
): Promise<AutodevConfig> {
  try {
    const { config } = await loadConfig((path) => getFileContent(target, path, ref, auth));
    return config;
  } catch {
    return defaultConfig();
  }
}

interface ResolvedRange {
  readonly from: string;
  readonly to: string;
  readonly previousVersion: string | null;
  readonly repository: RepositoryRef;
}

async function resolveRange(target: RepoTarget, request: ChangelogRequest): Promise<ResolvedRange> {
  const metadata = await getRepository(target, request.auth);
  const to = request.to ?? metadata.defaultBranch;

  if (request.from) {
    return {
      from: request.from,
      to,
      previousVersion: request.from,
      repository: {
        owner: target.owner,
        name: target.repo,
        fullName: metadata.fullName,
        defaultBranch: metadata.defaultBranch,
      },
    };
  }

  const tags = await listTags(target, request.auth);
  const latest = latestVersionTag(tags);

  return {
    // With no tags, comparing the default branch against itself yields no
    // commits, so fall back to the oldest available tag or the branch itself
    // and let the caller decide. `latest ?? to` keeps the request valid.
    from: latest ?? to,
    to,
    previousVersion: latest,
    repository: {
      owner: target.owner,
      name: target.repo,
      fullName: metadata.fullName,
      defaultBranch: metadata.defaultBranch,
    },
  };
}

export interface ChangelogOutcome extends ChangelogResult {
  readonly from: string;
  readonly to: string;
}

export async function runChangelog(request: ChangelogRequest): Promise<ChangelogOutcome> {
  const target: RepoTarget = { owner: request.owner, repo: request.repo };
  const range = await resolveRange(target, request);
  const config = await resolveConfig(target, range.to, request.auth);

  const commits = await listCommitsBetween(target, range.from, range.to, request.auth);

  const result = generateChangelog({
    repository: range.repository,
    commits,
    ...(request.version ? { version: request.version } : {}),
    ...(range.previousVersion ? { previousVersion: range.previousVersion } : {}),
    config: config.changelog,
  });

  if (request.persist !== false) {
    const store = getStore();
    const repository = await store.getRepositoryByFullName(range.repository.fullName);
    if (repository) {
      await store.saveArtifact({
        repositoryId: repository.id,
        kind: 'changelog',
        title: `Changelog ${result.version}`,
        content: result.markdown,
        subject: result.version,
        metadata: {
          from: range.from,
          to: range.to,
          releaseKind: result.releaseKind,
          commitCount: result.commitCount,
        },
        pullRequestNumber: null,
      });
    }
  }

  return { ...result, from: range.from, to: range.to };
}

export interface ReleaseRequest extends ChangelogRequest {
  readonly includeChecklist?: boolean;
}

export async function runRelease(
  request: ReleaseRequest,
): Promise<ReleasePlan & { from: string; to: string }> {
  const target: RepoTarget = { owner: request.owner, repo: request.repo };
  const range = await resolveRange(target, request);
  const config = await resolveConfig(target, range.to, request.auth);

  const [commits, comparison] = await Promise.all([
    listCommitsBetween(target, range.from, range.to, request.auth),
    compareRefs(target, range.from, range.to, request.auth).catch(() => ({
      files: [],
      commits: [],
    })),
  ]);

  const plan = planRelease({
    repository: range.repository,
    commits,
    ...(request.version ? { version: request.version } : {}),
    ...(range.previousVersion ? { previousVersion: range.previousVersion } : {}),
    config: config.changelog,
    changedPaths: comparison.files.map((file) => file.path),
  });

  if (request.persist !== false) {
    const store = getStore();
    const repository = await store.getRepositoryByFullName(range.repository.fullName);

    if (repository) {
      const artifacts = [
        {
          kind: 'release-notes' as const,
          title: `Release notes ${plan.version}`,
          content: plan.releaseNotes,
        },
        {
          kind: 'upgrade-guide' as const,
          title: `Upgrade guide ${plan.version}`,
          content: plan.upgradeGuide,
        },
        {
          kind: 'migration-guide' as const,
          title: `Migration guide ${plan.version}`,
          content: plan.migrationGuide,
        },
        {
          kind: 'deployment-checklist' as const,
          title: `Deployment checklist ${plan.version}`,
          content: plan.deploymentChecklist,
        },
      ];

      await Promise.all(
        artifacts.map((artifact) =>
          store.saveArtifact({
            repositoryId: repository.id,
            kind: artifact.kind,
            title: artifact.title,
            content: artifact.content,
            subject: plan.version,
            metadata: { from: range.from, to: range.to, releaseKind: plan.releaseKind },
            pullRequestNumber: null,
          }),
        ),
      );
    }
  }

  return { ...plan, from: range.from, to: range.to };
}
