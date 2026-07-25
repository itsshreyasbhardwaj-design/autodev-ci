import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { TtlCache } from '@/core/cache';
import { env } from '@/core/env';
import { ConfigurationError, GitHubError } from '@/core/errors';
import { logger } from '@/core/logger';
import type { PullRequestRef, RepositoryRef } from '@/core/types';
import { buildFileDiffs, type FileDiff, type RawFileChange } from './diff';

/**
 * GitHub API access.
 *
 * Authentication has three modes, tried in order of privilege:
 *   1. GitHub App installation token — the production path. Scoped to a single
 *      installation, expires after an hour, refreshed automatically.
 *   2. GitHub App JWT — for app-level endpoints (listing installations).
 *   3. Personal Access Token — the development path.
 *
 * Clients are cached per credential because Octokit keeps rate-limit state and
 * connection pools on the instance; building a fresh one per request throws
 * that away and multiplies handshakes.
 */

const clientCache = new TtlCache<Octokit>({ ttlMs: 30 * 60_000, maxEntries: 64 });

/** GitHub App private keys are commonly stored base64-encoded to survive env vars. */
function normalisePrivateKey(raw: string): string {
  const withNewlines = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (withNewlines.includes('BEGIN') && withNewlines.includes('PRIVATE KEY')) {
    return withNewlines;
  }
  try {
    const decoded = Buffer.from(withNewlines, 'base64').toString('utf8');
    if (decoded.includes('PRIVATE KEY')) return decoded;
  } catch {
    // fall through to the error below
  }
  throw new ConfigurationError(
    'GITHUB_APP_PRIVATE_KEY must be a PEM private key (raw, with \\n escapes, or base64-encoded)',
  );
}

export interface GitHubAuth {
  readonly kind: 'installation' | 'app' | 'token';
  readonly installationId?: string;
  readonly token?: string;
}

function cacheKey(auth: GitHubAuth): string {
  return `${auth.kind}:${auth.installationId ?? auth.token?.slice(-8) ?? 'default'}`;
}

/** Statuses Octokit logs loudly that are a normal part of probing for
 *  optional files. Downgrading them keeps real problems visible. */
const EXPECTED_STATUS = / - (?:304|404) /;

function routeOctokitLog(message: string, level: 'warn' | 'error'): void {
  if (EXPECTED_STATUS.test(message)) {
    logger().debug(message, { source: 'octokit' });
    return;
  }
  logger()[level](message, { source: 'octokit' });
}

function baseOptions(): {
  baseUrl: string;
  userAgent: string;
  log: {
    debug: (m: string) => void;
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
} {
  return {
    baseUrl: env().GITHUB_API_URL,
    userAgent: 'autodev-ci',
    // Octokit logs every 404 at warn level. Probing for optional files —
    // `.autodev.yml`, `README.md` — legitimately 404s several times per run,
    // so those go to debug and only real problems reach warn.
    log: {
      debug: (message: string) => logger().debug(message, { source: 'octokit' }),
      info: (message: string) => logger().debug(message, { source: 'octokit' }),
      warn: (message: string) => routeOctokitLog(message, 'warn'),
      error: (message: string) => routeOctokitLog(message, 'error'),
    },
  };
}

function buildOctokit(auth: GitHubAuth): Octokit {
  const e = env();

  if (auth.kind === 'token') {
    const token = auth.token ?? e.GITHUB_TOKEN;
    if (!token) {
      throw new ConfigurationError(
        'No GitHub credentials configured. Set GITHUB_TOKEN, or configure a GitHub App.',
      );
    }
    return new Octokit({ ...baseOptions(), auth: token });
  }

  if (!e.GITHUB_APP_ID || !e.GITHUB_APP_PRIVATE_KEY) {
    throw new ConfigurationError(
      'GitHub App authentication requires GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY',
    );
  }

  return new Octokit({
    ...baseOptions(),
    authStrategy: createAppAuth,
    auth: {
      appId: e.GITHUB_APP_ID,
      privateKey: normalisePrivateKey(e.GITHUB_APP_PRIVATE_KEY),
      ...(e.GITHUB_APP_CLIENT_ID ? { clientId: e.GITHUB_APP_CLIENT_ID } : {}),
      ...(e.GITHUB_APP_CLIENT_SECRET ? { clientSecret: e.GITHUB_APP_CLIENT_SECRET } : {}),
      ...(auth.kind === 'installation' && auth.installationId
        ? { installationId: Number(auth.installationId) }
        : {}),
    },
  });
}

/**
 * Returns an authenticated Octokit for the given credentials, preferring the
 * GitHub App when both an installation and a PAT are available.
 */
export function getOctokit(auth?: Partial<GitHubAuth>): Octokit {
  const e = env();

  const resolved: GitHubAuth = auth?.token
    ? { kind: 'token', token: auth.token }
    : auth?.installationId
      ? { kind: 'installation', installationId: auth.installationId }
      : e.capabilities.githubApp && auth?.kind === 'app'
        ? { kind: 'app' }
        : e.capabilities.githubPat
          ? { kind: 'token' }
          : e.capabilities.githubApp
            ? { kind: 'app' }
            : { kind: 'token' };

  const key = cacheKey(resolved);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = buildOctokit(resolved);
  clientCache.set(key, client);
  return client;
}

/** Test helper: drops cached clients so credentials can be swapped. */
export function resetOctokitCache(): void {
  clientCache.clear();
}

interface OctokitLikeError {
  status?: number;
  message?: string;
  response?: { data?: { message?: string } };
}

/** Wraps an Octokit call, converting failures into {@link GitHubError}. */
export async function githubRequest<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const octokitError = error as OctokitLikeError;
    const status = octokitError.status ?? 502;
    const upstreamMessage =
      octokitError.response?.data?.message ?? octokitError.message ?? 'Unknown GitHub error';

    logger().warn('GitHub request failed', { operation, status, upstreamMessage });

    if (status === 403 && /rate limit/i.test(upstreamMessage)) {
      throw new GitHubError(
        `GitHub rate limit exceeded during ${operation}. Retry after the limit resets.`,
        { status: 429, cause: error },
      );
    }

    throw new GitHubError(`${operation} failed: ${upstreamMessage}`, { status, cause: error });
  }
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export interface PullRequestContext {
  readonly repository: RepositoryRef;
  readonly pullRequest: PullRequestRef;
  readonly files: readonly FileDiff[];
  readonly commits: readonly { sha: string; message: string; author: string }[];
}

export interface RepoTarget {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Loads everything an analysis run needs about a pull request in one place.
 *
 * File listings are paginated to 300 entries. Beyond that the review would be
 * unusable anyway, and unbounded pagination on a 5,000-file PR is a reliable
 * way to exhaust both the rate limit and the function timeout.
 */
export async function loadPullRequestContext(
  target: RepoTarget,
  pullNumber: number,
  auth?: Partial<GitHubAuth>,
): Promise<PullRequestContext> {
  const octokit = getOctokit(auth);
  const { owner, repo } = target;

  const pr = await githubRequest('Fetch pull request', () =>
    octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
  );

  const [files, commits] = await Promise.all([
    githubRequest('List pull request files', () =>
      octokit.paginate(
        octokit.pulls.listFiles,
        { owner, repo, pull_number: pullNumber, per_page: 100 },
        (response, done) => {
          // Stop paginating once we have enough to review meaningfully.
          if (response.data.length >= 100) return response.data;
          done();
          return response.data;
        },
      ),
    ),
    githubRequest('List pull request commits', () =>
      octokit.pulls.listCommits({ owner, repo, pull_number: pullNumber, per_page: 100 }),
    ),
  ]);

  const limitedFiles = files.slice(0, 300);
  if (files.length > limitedFiles.length) {
    logger().warn('Pull request exceeds the file analysis limit; truncating', {
      repository: `${owner}/${repo}`,
      pullNumber,
      totalFiles: files.length,
      analyzed: limitedFiles.length,
    });
  }

  return {
    repository: {
      owner,
      name: repo,
      fullName: `${owner}/${repo}`,
      defaultBranch: pr.data.base.repo.default_branch,
    },
    pullRequest: {
      number: pr.data.number,
      title: pr.data.title,
      author: pr.data.user?.login ?? 'unknown',
      baseRef: pr.data.base.ref,
      headRef: pr.data.head.ref,
      headSha: pr.data.head.sha,
      draft: pr.data.draft ?? false,
      url: pr.data.html_url,
      body: pr.data.body ?? '',
    },
    files: buildFileDiffs(limitedFiles as unknown as RawFileChange[]),
    commits: commits.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
    })),
  };
}

/** Fetches a file's contents at a ref. Returns null for missing files. */
export async function getFileContent(
  target: RepoTarget,
  path: string,
  ref?: string,
  auth?: Partial<GitHubAuth>,
): Promise<string | null> {
  const octokit = getOctokit(auth);
  try {
    const response = await octokit.repos.getContent({
      owner: target.owner,
      repo: target.repo,
      path,
      ...(ref ? { ref } : {}),
    });

    const data = response.data;
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if ((error as OctokitLikeError).status === 404) return null;
    throw new GitHubError(`Failed to read ${path}`, {
      status: (error as OctokitLikeError).status ?? 502,
      cause: error,
    });
  }
}

/** Lists paths at the repository root. Used by health scoring. */
export async function listRootEntries(
  target: RepoTarget,
  ref?: string,
  auth?: Partial<GitHubAuth>,
): Promise<string[]> {
  const octokit = getOctokit(auth);
  try {
    const response = await octokit.repos.getContent({
      owner: target.owner,
      repo: target.repo,
      path: '',
      ...(ref ? { ref } : {}),
    });
    return Array.isArray(response.data) ? response.data.map((entry) => entry.name) : [];
  } catch {
    return [];
  }
}

export async function getRepository(
  target: RepoTarget,
  auth?: Partial<GitHubAuth>,
): Promise<{
  fullName: string;
  defaultBranch: string;
  private: boolean;
  githubId: string;
  description: string | null;
  license: string | null;
  topics: string[];
  openIssues: number;
  stars: number;
  pushedAt: string | null;
  archived: boolean;
}> {
  const octokit = getOctokit(auth);
  const { data } = await githubRequest('Fetch repository', () =>
    octokit.repos.get({ owner: target.owner, repo: target.repo }),
  );

  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: data.private,
    githubId: String(data.id),
    description: data.description,
    license: data.license?.spdx_id ?? null,
    topics: data.topics ?? [],
    openIssues: data.open_issues_count,
    stars: data.stargazers_count,
    pushedAt: data.pushed_at,
    archived: data.archived,
  };
}

/** Compares two refs and returns the changed files as diffs. */
export async function compareRefs(
  target: RepoTarget,
  base: string,
  head: string,
  auth?: Partial<GitHubAuth>,
): Promise<{ files: FileDiff[]; commits: { sha: string; message: string; author: string }[] }> {
  const octokit = getOctokit(auth);
  const { data } = await githubRequest('Compare refs', () =>
    octokit.repos.compareCommitsWithBasehead({
      owner: target.owner,
      repo: target.repo,
      basehead: `${base}...${head}`,
      per_page: 100,
    }),
  );

  return {
    files: buildFileDiffs((data.files ?? []) as unknown as RawFileChange[]),
    commits: data.commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
    })),
  };
}

/** Lists commits between two refs, newest first. Input to changelog generation. */
export async function listCommitsBetween(
  target: RepoTarget,
  base: string,
  head: string,
  auth?: Partial<GitHubAuth>,
): Promise<{ sha: string; message: string; author: string; date: string }[]> {
  const octokit = getOctokit(auth);
  const { data } = await githubRequest('List commits between refs', () =>
    octokit.repos.compareCommitsWithBasehead({
      owner: target.owner,
      repo: target.repo,
      basehead: `${base}...${head}`,
      per_page: 250,
    }),
  );

  return data.commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message,
    author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
    date: commit.commit.author?.date ?? new Date().toISOString(),
  }));
}

export async function listTags(
  target: RepoTarget,
  auth?: Partial<GitHubAuth>,
): Promise<{ name: string; sha: string }[]> {
  const octokit = getOctokit(auth);
  const { data } = await githubRequest('List tags', () =>
    octokit.repos.listTags({ owner: target.owner, repo: target.repo, per_page: 50 }),
  );
  return data.map((tag) => ({ name: tag.name, sha: tag.commit.sha }));
}
