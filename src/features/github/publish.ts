import { logger } from '@/core/logger';
import {
  type Finding,
  type GateResult,
  type ReviewResult,
  type Severity,
  compareSeverity,
  countBySeverity,
} from '@/core/types';
import type { ReviewConfig } from '@/features/config';
import { getOctokit, githubRequest, type GitHubAuth, type RepoTarget } from './client';
import { positionForLine, type FileDiff } from './diff';

/**
 * Rendering and publishing review output to GitHub.
 *
 * The comment format is deliberately scannable: a verdict line, a metrics
 * table, then findings grouped by severity. Reviewers skim bot comments, so
 * the most important information has to survive being read in five seconds.
 */

const SEVERITY_ICON: Record<Severity, string> = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: '🔵',
};

const GATE_ICON = {
  passed: '✅',
  warning: '⚠️',
  failed: '❌',
  skipped: '⏭️',
} as const;

const VERDICT_LABEL = {
  approve: '✅ Approve',
  comment: '💬 Comment',
  'request-changes': '🛑 Request changes',
} as const;

/**
 * Marker used to find and update this bot's previous comment instead of
 * posting a new one on every push. Without it a busy PR accumulates a dozen
 * near-identical bot comments.
 */
export const COMMENT_MARKER = '<!-- autodev-ci:review -->';

function severityBadge(counts: Record<Severity, number>): string {
  const parts = (['critical', 'high', 'medium', 'low', 'info'] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${SEVERITY_ICON[severity]} ${counts[severity]} ${severity}`);
  return parts.length > 0 ? parts.join(' · ') : '✨ No issues found';
}

function renderFinding(finding: Finding, index: number): string {
  const location = finding.location
    ? ` — \`${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ''}\``
    : '';

  const lines = [
    `**${index}. ${SEVERITY_ICON[finding.severity]} ${finding.title}**${location}`,
    '',
    finding.description,
  ];

  if (finding.suggestion) {
    lines.push('', `> **Suggested fix:** ${finding.suggestion.description}`);
    if (finding.suggestion.replacement) {
      lines.push('', '```suggestion', finding.suggestion.replacement, '```');
    }
  }

  if (finding.references && finding.references.length > 0) {
    lines.push('', `<sub>References: ${finding.references.join(' · ')}</sub>`);
  }

  lines.push(
    '',
    `<sub>\`${finding.rule}\` · confidence ${Math.round(finding.confidence * 100)}%</sub>`,
  );
  return lines.join('\n');
}

function renderGates(gates: readonly GateResult[]): string {
  if (gates.length === 0) return '';

  const rows = gates
    .map((gate) => {
      const observed =
        gate.observed !== undefined && gate.threshold !== undefined
          ? `${gate.observed} / ${gate.threshold}`
          : '—';
      return `| ${GATE_ICON[gate.status]} ${gate.name} | ${observed} | ${gate.message} |`;
    })
    .join('\n');

  return [
    '### Quality gates',
    '',
    '| Gate | Observed | Detail |',
    '| --- | --- | --- |',
    rows,
  ].join('\n');
}

/** Builds the full Markdown summary comment for a review. */
export function renderReviewComment(result: ReviewResult, config?: ReviewConfig): string {
  const counts = countBySeverity(result.findings);
  const maxInline = config?.maxInlineComments ?? 20;

  const sections: string[] = [
    COMMENT_MARKER,
    `## ${VERDICT_LABEL[result.summary.verdict]} · AutoDev CI`,
    '',
    result.summary.headline,
    '',
    `**Score:** ${result.summary.score}/100  |  ${severityBadge(counts)}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Files analyzed | ${result.metrics.filesAnalyzed} |`,
    `| Lines added | +${result.metrics.linesAdded} |`,
    `| Lines removed | −${result.metrics.linesRemoved} |`,
    `| Test files changed | ${result.metrics.testFilesChanged} |`,
    `| Docs changed | ${result.metrics.docFilesChanged} |`,
    `| Analysis time | ${(result.metrics.durationMs / 1000).toFixed(1)}s |`,
  ];

  const gates = renderGates(result.gates);
  if (gates) sections.push('', gates);

  if (result.summary.highlights.length > 0) {
    sections.push(
      '',
      '### Highlights',
      '',
      ...result.summary.highlights.map((item) => `- ${item}`),
    );
  }

  if (result.summary.concerns.length > 0) {
    sections.push('', '### Concerns', '', ...result.summary.concerns.map((item) => `- ${item}`));
  }

  // Findings that became inline comments are omitted here to avoid saying the
  // same thing twice on the same PR.
  const summarised = [...result.findings]
    .sort((a, b) => compareSeverity(a.severity, b.severity))
    .slice(config?.inlineComments === false ? 0 : maxInline);

  if (summarised.length > 0) {
    sections.push(
      '',
      `### Additional findings (${summarised.length})`,
      '',
      summarised.map((finding, index) => renderFinding(finding, index + 1)).join('\n\n---\n\n'),
    );
  }

  if (result.commendations.length > 0) {
    sections.push(
      '',
      '### What went well',
      '',
      ...result.commendations.map((item) => `- **${item.title}** — ${item.description}`),
    );
  }

  sections.push(
    '',
    '---',
    '',
    `<sub>Generated by [AutoDev CI](https://github.com/itsshreyasbhardwaj-design/autodev-ci) · engine: \`${result.engine}\` · ${result.createdAt}</sub>`,
  );

  return sections.join('\n');
}

export interface InlineComment {
  readonly path: string;
  readonly position: number;
  readonly body: string;
}

/**
 * Converts findings into inline review comments.
 *
 * Findings whose line is not present in the diff are dropped rather than
 * remapped: GitHub rejects out-of-diff positions, and a comment silently
 * relocated to a nearby line is actively misleading.
 */
export function buildInlineComments(
  findings: readonly Finding[],
  files: readonly FileDiff[],
  limit = 20,
): { comments: InlineComment[]; skipped: Finding[] } {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const comments: InlineComment[] = [];
  const skipped: Finding[] = [];

  const ordered = [...findings].sort((a, b) => compareSeverity(a.severity, b.severity));

  for (const finding of ordered) {
    if (comments.length >= limit) {
      skipped.push(finding);
      continue;
    }

    const location = finding.location;
    const file = location ? byPath.get(location.path) : undefined;

    if (!location || !file || location.line === undefined) {
      skipped.push(finding);
      continue;
    }

    const position = location.diffPosition ?? positionForLine(file, location.line);
    if (position === undefined) {
      skipped.push(finding);
      continue;
    }

    const body = [
      `${SEVERITY_ICON[finding.severity]} **${finding.title}**`,
      '',
      finding.description,
      ...(finding.suggestion?.replacement
        ? ['', '```suggestion', finding.suggestion.replacement, '```']
        : finding.suggestion
          ? ['', `**Suggested fix:** ${finding.suggestion.description}`]
          : []),
      '',
      `<sub>\`${finding.rule}\` · AutoDev CI</sub>`,
    ].join('\n');

    comments.push({ path: location.path, position, body });
  }

  return { comments, skipped };
}

export interface PublishOptions {
  readonly target: RepoTarget;
  readonly pullNumber: number;
  readonly result: ReviewResult;
  readonly files: readonly FileDiff[];
  readonly config: ReviewConfig;
  readonly auth?: Partial<GitHubAuth>;
  /** Render output without calling the API. */
  readonly dryRun?: boolean;
}

export interface PublishOutcome {
  readonly commentId: number | null;
  readonly inlineCount: number;
  readonly updated: boolean;
  readonly body: string;
}

/**
 * Posts (or updates) the review on GitHub.
 *
 * Inline comments go through the Reviews API in a single call so they land as
 * one review rather than N separate notifications. If that fails — most often
 * because a position went stale between analysis and publish — we fall back to
 * the summary comment alone rather than losing the whole review.
 */
export async function publishReview(options: PublishOptions): Promise<PublishOutcome> {
  const { target, pullNumber, result, files, config, auth, dryRun } = options;
  const body = renderReviewComment(result, config);

  if (dryRun) {
    return { commentId: null, inlineCount: 0, updated: false, body };
  }

  const octokit = getOctokit(auth);
  const log = logger().child({ repository: `${target.owner}/${target.repo}`, pullNumber });

  let inlineCount = 0;

  if (config.inlineComments) {
    const { comments } = buildInlineComments(result.findings, files, config.maxInlineComments);

    if (comments.length > 0) {
      try {
        await githubRequest('Create review with inline comments', () =>
          octokit.pulls.createReview({
            owner: target.owner,
            repo: target.repo,
            pull_number: pullNumber,
            commit_id: result.pullRequest.headSha,
            event:
              result.summary.verdict === 'request-changes' && config.requestChangesOnFailure
                ? 'REQUEST_CHANGES'
                : 'COMMENT',
            body: `${COMMENT_MARKER}\n### AutoDev CI found ${comments.length} inline ${comments.length === 1 ? 'note' : 'notes'}`,
            comments: comments.map((comment) => ({
              path: comment.path,
              position: comment.position,
              body: comment.body,
            })),
          }),
        );
        inlineCount = comments.length;
      } catch (error) {
        log.warn('Inline review failed; falling back to summary comment only', { error });
      }
    }
  }

  // Update our previous summary comment when one exists.
  const existing = await findExistingComment(target, pullNumber, auth);

  if (existing) {
    await githubRequest('Update review comment', () =>
      octokit.issues.updateComment({
        owner: target.owner,
        repo: target.repo,
        comment_id: existing,
        body,
      }),
    );
    log.info('Updated existing review comment', { commentId: existing, inlineCount });
    return { commentId: existing, inlineCount, updated: true, body };
  }

  const created = await githubRequest('Create review comment', () =>
    octokit.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: pullNumber,
      body,
    }),
  );

  log.info('Posted review comment', { commentId: created.data.id, inlineCount });
  return { commentId: created.data.id, inlineCount, updated: false, body };
}

async function findExistingComment(
  target: RepoTarget,
  pullNumber: number,
  auth?: Partial<GitHubAuth>,
): Promise<number | null> {
  const octokit = getOctokit(auth);
  try {
    const { data } = await octokit.issues.listComments({
      owner: target.owner,
      repo: target.repo,
      issue_number: pullNumber,
      per_page: 100,
    });
    const match = data.find((comment) => comment.body?.includes(COMMENT_MARKER));
    return match?.id ?? null;
  } catch {
    // Not being able to list comments is not fatal — we just post a new one.
    return null;
  }
}

export interface CreatePullRequestOptions {
  readonly target: RepoTarget;
  readonly branch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly auth?: Partial<GitHubAuth>;
}

/**
 * Creates a branch with the given file contents and opens a pull request.
 *
 * Documentation updates are always proposed this way rather than pushed to the
 * default branch — generated prose needs a human to read it before it becomes
 * the project's official documentation.
 */
export async function createFilePullRequest(
  options: CreatePullRequestOptions,
): Promise<{ number: number; url: string }> {
  const { target, branch, baseBranch, title, body, files, auth } = options;
  const octokit = getOctokit(auth);
  const { owner, repo } = target;

  const baseRef = await githubRequest('Read base branch', () =>
    octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` }),
  );
  const baseSha = baseRef.data.object.sha;

  const baseCommit = await githubRequest('Read base commit', () =>
    octokit.git.getCommit({ owner, repo, commit_sha: baseSha }),
  );

  const blobs = await Promise.all(
    files.map(async (file) => {
      const blob = await githubRequest('Create blob', () =>
        octokit.git.createBlob({ owner, repo, content: file.content, encoding: 'utf-8' }),
      );
      return {
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.data.sha,
      };
    }),
  );

  const tree = await githubRequest('Create tree', () =>
    octokit.git.createTree({ owner, repo, base_tree: baseCommit.data.tree.sha, tree: blobs }),
  );

  const commit = await githubRequest('Create commit', () =>
    octokit.git.createCommit({
      owner,
      repo,
      message: title,
      tree: tree.data.sha,
      parents: [baseSha],
    }),
  );

  await githubRequest('Create branch', () =>
    octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.data.sha }),
  );

  const pr = await githubRequest('Open pull request', () =>
    octokit.pulls.create({ owner, repo, title, body, head: branch, base: baseBranch }),
  );

  return { number: pr.data.number, url: pr.data.html_url };
}
