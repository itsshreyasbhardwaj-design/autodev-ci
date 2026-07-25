import type { RepositoryRef } from '@/core/types';
import type { ChangelogConfig } from '@/features/config';
import {
  type ParsedCommit,
  type RawCommit,
  type ReleaseKind,
  bumpVersion,
  formatVersion,
  inferReleaseKind,
  parseCommits,
  parseVersion,
} from './conventional';

export * from './conventional';

/**
 * Changelog generation.
 *
 * Written for the people *reading* the changelog rather than the people who
 * wrote the commits: breaking changes lead, sections appear in order of what
 * a user cares about, and commit-message shorthand is cleaned up into
 * sentences. Everything is derived from commit data, so it is reproducible and
 * needs no model.
 */

const SECTION_TITLES: Record<string, string> = {
  feat: '✨ Features',
  fix: '🐛 Bug fixes',
  perf: '⚡ Performance',
  refactor: '♻️ Refactoring',
  docs: '📚 Documentation',
  build: '📦 Build system',
  ci: '🔧 CI',
  test: '🧪 Tests',
  style: '💄 Styling',
  chore: '🧹 Chores',
  revert: '⏪ Reverts',
  other: '📝 Other changes',
};

/** Display order. Anything not listed falls to the end. */
const SECTION_ORDER = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'build',
  'ci',
  'test',
  'style',
  'revert',
  'chore',
  'other',
];

export interface ChangelogInput {
  readonly repository: RepositoryRef;
  readonly commits: readonly RawCommit[];
  readonly version?: string;
  readonly previousVersion?: string;
  readonly date?: string;
  readonly config: ChangelogConfig;
}

export interface ChangelogResult {
  readonly markdown: string;
  readonly version: string;
  readonly previousVersion: string | null;
  readonly releaseKind: ReleaseKind;
  readonly breakingChanges: readonly string[];
  readonly contributors: readonly string[];
  readonly commitCount: number;
  readonly sections: ReadonlyArray<{ type: string; title: string; entries: readonly string[] }>;
}

/** Capitalises the subject and strips a trailing period. */
function tidySubject(subject: string): string {
  const trimmed = subject.trim().replace(/\.$/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function commitLink(repository: RepositoryRef, sha: string, enabled: boolean): string {
  const short = sha.slice(0, 7);
  return enabled
    ? `([\`${short}\`](https://github.com/${repository.fullName}/commit/${sha}))`
    : `(\`${short}\`)`;
}

function pullRequestLink(repository: RepositoryRef, number: number, enabled: boolean): string {
  return enabled
    ? `([#${number}](https://github.com/${repository.fullName}/pull/${number}))`
    : `(#${number})`;
}

function renderEntry(
  commit: ParsedCommit,
  repository: RepositoryRef,
  config: ChangelogConfig,
): string {
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  const subject = tidySubject(commit.subject);
  const reference = commit.pullRequest
    ? pullRequestLink(repository, commit.pullRequest, config.linkReferences)
    : commitLink(repository, commit.sha, config.linkReferences);

  return `- ${scope}${subject} ${reference}`;
}

/**
 * Removes commits cancelled out by a later revert.
 *
 * A `revert: feat(x): add y` immediately followed into the same release by the
 * original `feat` means neither belongs in the changelog — the net change for
 * a user is nothing.
 */
function applyReverts(commits: readonly ParsedCommit[]): ParsedCommit[] {
  const reverted = new Set<string>();

  for (const commit of commits) {
    if (!commit.revert) continue;
    // Revert bodies conventionally carry `This reverts commit <sha>.`
    const shaMatch = /This reverts commit ([0-9a-f]{7,40})/i.exec(commit.body);
    if (shaMatch?.[1]) reverted.add(shaMatch[1]);

    // Fall back to matching the reverted subject text.
    const subjectMatch = /^(?:revert:?\s*)+["']?(.+?)["']?$/i.exec(commit.subject);
    const target = subjectMatch?.[1];
    if (target) {
      const original = commits.find(
        (candidate) => !candidate.revert && candidate.subject === target.trim(),
      );
      if (original) reverted.add(original.sha);
    }
  }

  if (reverted.size === 0) return [...commits];

  return commits.filter(
    (commit) => !reverted.has(commit.sha) && !(commit.revert && reverted.size > 0),
  );
}

export function generateChangelog(input: ChangelogInput): ChangelogResult {
  const { repository, config } = input;
  const parsed = applyReverts(parseCommits(input.commits));

  const releaseKind = inferReleaseKind(parsed);

  const previousVersion = input.previousVersion ?? null;
  const previousSemver = previousVersion ? parseVersion(previousVersion) : null;

  const version =
    input.version ??
    (previousSemver
      ? formatVersion(bumpVersion(previousSemver, releaseKind === 'none' ? 'patch' : releaseKind))
      : '0.1.0');

  const date = input.date ?? new Date().toISOString().slice(0, 10);

  // --- Breaking changes ---------------------------------------------------

  const breakingChanges = parsed
    .filter((commit) => commit.breaking)
    .map((commit) => {
      const scope = commit.scope ? `**${commit.scope}:** ` : '';
      const description = commit.breakingDescription ?? tidySubject(commit.subject);
      const reference = commit.pullRequest
        ? pullRequestLink(repository, commit.pullRequest, config.linkReferences)
        : commitLink(repository, commit.sha, config.linkReferences);
      return `${scope}${description} ${reference}`;
    });

  // --- Sections -----------------------------------------------------------

  const included = new Set(config.includeTypes);
  const grouped = new Map<string, ParsedCommit[]>();

  for (const commit of parsed) {
    const type = included.has(commit.type) ? commit.type : commit.conventional ? null : 'other';
    if (type === null) continue;
    const bucket = grouped.get(type) ?? [];
    bucket.push(commit);
    grouped.set(type, bucket);
  }

  const sections = SECTION_ORDER.filter((type) => grouped.has(type)).map((type) => {
    const commits = grouped.get(type) ?? [];

    if (config.groupByScope) {
      const byScope = new Map<string, ParsedCommit[]>();
      for (const commit of commits) {
        const scope = commit.scope ?? '_general';
        const bucket = byScope.get(scope) ?? [];
        bucket.push(commit);
        byScope.set(scope, bucket);
      }

      const entries: string[] = [];
      for (const [scope, scoped] of [...byScope.entries()].sort()) {
        if (scope !== '_general') entries.push(`- **${scope}**`);
        for (const commit of scoped) {
          const line = renderEntry({ ...commit, scope: null }, repository, config);
          entries.push(scope === '_general' ? line : `  ${line}`);
        }
      }
      return { type, title: SECTION_TITLES[type] ?? type, entries };
    }

    return {
      type,
      title: SECTION_TITLES[type] ?? type,
      entries: commits.map((commit) => renderEntry(commit, repository, config)),
    };
  });

  // --- Contributors -------------------------------------------------------

  const contributors = [...new Set(parsed.map((commit) => commit.author))]
    .filter((author) => author !== 'unknown' && !/\[bot\]$/.test(author))
    .sort((a, b) => a.localeCompare(b));

  // --- Render -------------------------------------------------------------

  const lines: string[] = [`## ${version} (${date})`, ''];

  if (breakingChanges.length > 0) {
    lines.push(
      '### ⚠️ BREAKING CHANGES',
      '',
      ...breakingChanges.map((change) => `- ${change}`),
      '',
    );
  }

  for (const section of sections) {
    if (section.entries.length === 0) continue;
    lines.push(`### ${section.title}`, '', ...section.entries, '');
  }

  if (sections.length === 0 && breakingChanges.length === 0) {
    lines.push('_No user-facing changes in this release._', '');
  }

  if (config.includeContributors && contributors.length > 0) {
    lines.push(
      '### 👥 Contributors',
      '',
      `Thanks to ${contributors.map((name) => `@${name}`).join(', ')} for contributing to this release.`,
      '',
    );
  }

  if (previousVersion && config.linkReferences) {
    lines.push(
      `**Full changelog:** [\`${previousVersion}...${version}\`](https://github.com/${repository.fullName}/compare/${previousVersion}...${version})`,
      '',
    );
  }

  return {
    markdown: lines.join('\n').trimEnd() + '\n',
    version,
    previousVersion,
    releaseKind,
    breakingChanges,
    contributors,
    commitCount: parsed.length,
    sections,
  };
}

const CHANGELOG_HEADER = `# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`;

/**
 * Inserts a new release section into an existing CHANGELOG.md.
 *
 * The new entry goes directly below the header and above the previous release,
 * which is where every changelog convention puts it and where readers look.
 * Re-running for a version already present replaces that section rather than
 * duplicating it, so the command is idempotent.
 */
export function prependToChangelog(
  existing: string | null,
  entry: string,
  version: string,
): string {
  if (!existing || existing.trim().length === 0) {
    return `${CHANGELOG_HEADER}\n${entry}`;
  }

  const versionHeading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}\\b`, 'm');

  if (versionHeading.test(existing)) {
    const lines = existing.split('\n');
    const startIndex = lines.findIndex((line) => versionHeading.test(line));
    let endIndex = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (/^##\s+/.test(lines[index] ?? '')) {
        endIndex = index;
        break;
      }
    }
    return [
      ...lines.slice(0, startIndex),
      ...entry.trimEnd().split('\n'),
      '',
      ...lines.slice(endIndex),
    ]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  // Insert after the header block, before the first existing release.
  const firstRelease = existing.search(/^##\s+/m);

  if (firstRelease === -1) {
    return `${existing.trimEnd()}\n\n${entry}`;
  }

  return `${existing.slice(0, firstRelease)}${entry}\n${existing.slice(firstRelease)}`.replace(
    /\n{3,}/g,
    '\n\n',
  );
}
