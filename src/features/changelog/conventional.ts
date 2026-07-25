/**
 * Conventional Commits parser.
 *
 * Implements the v1.0.0 specification, including the two ways a commit can
 * declare a breaking change (a `!` after the type/scope, or a
 * `BREAKING CHANGE:` footer). Non-conforming messages are not discarded —
 * they are returned with `conventional: false` so the changelog can still list
 * them under "Other changes" rather than silently dropping work.
 */

export interface ParsedCommit {
  readonly sha: string;
  readonly type: string;
  readonly scope: string | null;
  readonly subject: string;
  readonly body: string;
  readonly breaking: boolean;
  readonly breakingDescription: string | null;
  /** True when the message matched the Conventional Commits grammar. */
  readonly conventional: boolean;
  readonly author: string;
  readonly date: string;
  /** PR number parsed from the subject, e.g. `(#123)`. */
  readonly pullRequest: number | null;
  readonly footers: Readonly<Record<string, string>>;
  /** True for revert commits, which cancel out earlier entries. */
  readonly revert: boolean;
}

export interface RawCommit {
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly date?: string;
}

const HEADER = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+(?<subject>.+)$/;
const PR_REFERENCE = /\(#(\d+)\)\s*$/;
const FOOTER_LINE = /^(?<key>BREAKING[- ]CHANGE|[A-Za-z-]+)(?::\s+|\s+#)(?<value>.+)$/;

/** Commit types recognised by the spec plus the common community additions. */
export const KNOWN_TYPES = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

export function parseCommit(commit: RawCommit): ParsedCommit {
  const lines = commit.message.split('\n');
  const header = (lines[0] ?? '').trim();
  const rest = lines.slice(1).join('\n').trim();

  const match = HEADER.exec(header);
  const prMatch = PR_REFERENCE.exec(header);
  const pullRequest = prMatch?.[1] ? Number(prMatch[1]) : null;

  // Footers are the trailing block of `Key: value` lines.
  const footers: Record<string, string> = {};
  let breakingDescription: string | null = null;

  for (const line of rest.split('\n')) {
    const footerMatch = FOOTER_LINE.exec(line.trim());
    if (!footerMatch?.groups) continue;

    const key = footerMatch.groups.key ?? '';
    const value = footerMatch.groups.value ?? '';

    if (/^BREAKING[- ]CHANGE$/i.test(key)) {
      breakingDescription = value.trim();
    } else {
      footers[key.toLowerCase()] = value.trim();
    }
  }

  if (!match?.groups) {
    return {
      sha: commit.sha,
      type: 'other',
      scope: null,
      subject: header.replace(PR_REFERENCE, '').trim() || header,
      body: rest,
      breaking: breakingDescription !== null,
      breakingDescription,
      conventional: false,
      author: commit.author,
      date: commit.date ?? new Date().toISOString(),
      pullRequest,
      footers,
      revert: /^revert[\s:]/i.test(header),
    };
  }

  const type = (match.groups.type ?? 'other').toLowerCase();

  return {
    sha: commit.sha,
    type,
    scope: match.groups.scope?.trim() ?? null,
    subject: (match.groups.subject ?? '').replace(PR_REFERENCE, '').trim(),
    body: rest,
    breaking: match.groups.breaking === '!' || breakingDescription !== null,
    breakingDescription,
    conventional: true,
    author: commit.author,
    date: commit.date ?? new Date().toISOString(),
    pullRequest,
    footers,
    revert: type === 'revert',
  };
}

export function parseCommits(commits: readonly RawCommit[]): ParsedCommit[] {
  return (
    commits
      .map(parseCommit)
      // Merge commits carry no independent meaning in a changelog.
      .filter((commit) => !/^Merge (?:pull request|branch|remote-tracking)/i.test(commit.subject))
  );
}

export type ReleaseKind = 'major' | 'minor' | 'patch' | 'none';

/**
 * Infers the semantic version bump implied by a set of commits.
 *
 * Follows the spec: any breaking change is major, any `feat` is minor,
 * `fix`/`perf` is patch, and everything else implies no release.
 */
export function inferReleaseKind(commits: readonly ParsedCommit[]): ReleaseKind {
  if (commits.some((commit) => commit.breaking)) return 'major';
  if (commits.some((commit) => commit.type === 'feat')) return 'minor';
  if (commits.some((commit) => ['fix', 'perf', 'revert'].includes(commit.type))) return 'patch';
  return 'none';
}

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | null;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): SemVer | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function formatVersion(version: SemVer): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

/**
 * Applies a release kind to a version.
 *
 * Pre-1.0 handling follows the ecosystem convention rather than the letter of
 * semver: while major is 0 a breaking change bumps the minor, because 0.x is
 * explicitly unstable and bumping to 1.0.0 would signal a stability promise
 * the project has not made.
 */
export function bumpVersion(current: SemVer, kind: ReleaseKind): SemVer {
  if (kind === 'none') return current;

  const preRelease = current.major === 0;

  if (kind === 'major') {
    return preRelease
      ? { major: 0, minor: current.minor + 1, patch: 0, prerelease: null }
      : { major: current.major + 1, minor: 0, patch: 0, prerelease: null };
  }

  if (kind === 'minor') {
    return { major: current.major, minor: current.minor + 1, patch: 0, prerelease: null };
  }

  return { major: current.major, minor: current.minor, patch: current.patch + 1, prerelease: null };
}

/** Picks the highest semver-looking tag from a tag list. */
export function latestVersionTag(tags: readonly { name: string }[]): string | null {
  const versions = tags
    .map((tag) => ({ tag: tag.name, version: parseVersion(tag.name) }))
    .filter((entry): entry is { tag: string; version: SemVer } => entry.version !== null)
    // Stable releases sort above prereleases of the same version.
    .sort((a, b) => {
      if (a.version.major !== b.version.major) return b.version.major - a.version.major;
      if (a.version.minor !== b.version.minor) return b.version.minor - a.version.minor;
      if (a.version.patch !== b.version.patch) return b.version.patch - a.version.patch;
      if (a.version.prerelease === b.version.prerelease) return 0;
      if (a.version.prerelease === null) return -1;
      if (b.version.prerelease === null) return 1;
      return b.version.prerelease.localeCompare(a.version.prerelease);
    });

  return versions[0]?.tag ?? null;
}
