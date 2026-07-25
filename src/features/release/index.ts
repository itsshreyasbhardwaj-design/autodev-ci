import type { RepositoryRef } from '@/core/types';
import type { ChangelogConfig } from '@/features/config';
import {
  type ParsedCommit,
  type RawCommit,
  type ReleaseKind,
  generateChangelog,
  parseCommits,
} from '@/features/changelog';

/**
 * Release assistant.
 *
 * Produces the five documents a team actually needs at release time: notes,
 * an upgrade guide, a breaking-change summary, a migration guide and a
 * deployment checklist. All of it is derived from commit data and the change
 * set, so it works with no model configured; the AI narrator, when available,
 * rewrites the prose but never changes the facts.
 */

export interface ReleaseInput {
  readonly repository: RepositoryRef;
  readonly commits: readonly RawCommit[];
  readonly version?: string;
  readonly previousVersion?: string;
  readonly config: ChangelogConfig;
  /** Paths changed since the previous release. Sharpens the checklist. */
  readonly changedPaths?: readonly string[];
}

export interface ReleasePlan {
  readonly version: string;
  readonly previousVersion: string | null;
  readonly releaseKind: ReleaseKind;
  readonly releaseNotes: string;
  readonly upgradeGuide: string;
  readonly breakingChangeSummary: string;
  readonly migrationGuide: string;
  readonly deploymentChecklist: string;
  readonly hasBreakingChanges: boolean;
  readonly contributors: readonly string[];
  readonly commitCount: number;
}

/** Signals that imply a specific operational step at deploy time. */
interface DeploymentSignal {
  readonly test: (paths: readonly string[], commits: readonly ParsedCommit[]) => boolean;
  readonly item: string;
}

const DEPLOYMENT_SIGNALS: readonly DeploymentSignal[] = [
  {
    test: (paths) => paths.some((path) => /migrations?\//i.test(path) || /\.sql$/.test(path)),
    item: 'Run database migrations **before** deploying application code, and confirm they are backwards compatible with the currently running version.',
  },
  {
    test: (paths) =>
      paths.some((path) => /\.env\.example$|config\/.*\.(?:ya?ml|json|toml)$/.test(path)),
    item: 'Apply new or changed environment variables in every environment before rollout.',
  },
  {
    test: (paths) =>
      paths.some((path) =>
        /(?:package|pnpm-lock|yarn\.lock|requirements|go\.sum|Cargo\.lock)/.test(path),
      ),
    item: 'Dependencies changed — rebuild artefacts from a clean install rather than an incremental one.',
  },
  {
    test: (paths) => paths.some((path) => /Dockerfile|docker-compose|\.k8s\/|helm\//i.test(path)),
    item: 'Container or orchestration configuration changed — rebuild and republish images, and verify resource limits.',
  },
  {
    test: (paths) => paths.some((path) => /^(?:src\/)?app\/api\/|routes?\//.test(path)),
    item: 'API surface changed — verify client compatibility and check for consumers pinned to the old contract.',
  },
  {
    test: (_paths, commits) => commits.some((commit) => commit.type === 'perf'),
    item: 'Performance changes included — capture before/after latency metrics to confirm the improvement in production.',
  },
  {
    test: (_paths, commits) => commits.some((commit) => commit.breaking),
    item: 'Breaking changes included — announce the release ahead of time and confirm the rollback path works.',
  },
  {
    test: (paths) => paths.some((path) => /\.github\/workflows\//.test(path)),
    item: 'CI workflows changed — confirm the pipeline is green on the release branch before tagging.',
  },
];

const BASE_CHECKLIST: readonly string[] = [
  'All CI checks pass on the release commit.',
  'The version number is updated in the manifest and the changelog.',
  'A rollback plan is written down and the previous artefact is still deployable.',
  'Monitoring and alerting cover the changed code paths.',
  'The release is tagged and the tag is pushed.',
];

function renderUpgradeGuide(
  repository: RepositoryRef,
  version: string,
  previousVersion: string | null,
  breaking: readonly string[],
  commits: readonly ParsedCommit[],
): string {
  const lines: string[] = [`# Upgrading to ${version}`, ''];

  if (previousVersion) {
    lines.push(`This guide covers upgrading from \`${previousVersion}\` to \`${version}\`.`, '');
  }

  if (breaking.length === 0) {
    lines.push(
      '## This is a drop-in upgrade',
      '',
      'No breaking changes were detected. Update the dependency and redeploy:',
      '',
      '```bash',
      `npm install ${repository.name}@${version}`,
      '```',
      '',
    );
  } else {
    lines.push(
      '## Before you upgrade',
      '',
      `This release contains ${breaking.length} breaking change(s). Read the migration guide before updating.`,
      '',
      '1. Review the breaking changes listed below.',
      '2. Apply the migration steps in a branch.',
      '3. Run your test suite against the new version.',
      '4. Deploy to a staging environment before production.',
      '',
      '## Breaking changes',
      '',
      ...breaking.map((change, index) => `${index + 1}. ${change}`),
      '',
    );
  }

  const features = commits.filter((commit) => commit.type === 'feat');
  if (features.length > 0) {
    lines.push(
      '## New in this release',
      '',
      ...features
        .slice(0, 10)
        .map((commit) => `- ${commit.scope ? `**${commit.scope}:** ` : ''}${commit.subject}`),
      '',
    );
  }

  return lines.join('\n');
}

function renderMigrationGuide(version: string, breakingCommits: readonly ParsedCommit[]): string {
  if (breakingCommits.length === 0) {
    return [
      `# Migration guide — ${version}`,
      '',
      'No migration is required. This release is backwards compatible with the previous version.',
      '',
    ].join('\n');
  }

  const lines: string[] = [
    `# Migration guide — ${version}`,
    '',
    `${breakingCommits.length} change(s) in this release require action.`,
    '',
  ];

  breakingCommits.forEach((commit, index) => {
    const title = commit.scope ? `${commit.scope}: ${commit.subject}` : commit.subject;
    lines.push(`## ${index + 1}. ${title}`, '');

    if (commit.breakingDescription) {
      lines.push('**What changed**', '', commit.breakingDescription, '');
    }

    // The commit body often carries the "how to migrate" detail; surface it
    // rather than making the reader dig through git log.
    const body = commit.body
      .split('\n')
      .filter((line) => !/^BREAKING[- ]CHANGE:/i.test(line.trim()) && line.trim().length > 0)
      .join('\n')
      .trim();

    if (body.length > 0) {
      lines.push('**Details**', '', body, '');
    }

    lines.push(
      '**Action required**',
      '',
      `- [ ] Update call sites affected by this change${commit.pullRequest ? ` (see #${commit.pullRequest})` : ''}.`,
      '- [ ] Run the test suite to catch remaining usages.',
      '',
    );
  });

  return lines.join('\n');
}

function renderBreakingSummary(version: string, breaking: readonly string[]): string {
  if (breaking.length === 0) {
    return `No breaking changes in ${version}.`;
  }

  return [
    `## Breaking changes in ${version}`,
    '',
    ...breaking.map((change) => `- ${change}`),
    '',
    `${breaking.length} change(s) require action from consumers before upgrading.`,
  ].join('\n');
}

function renderDeploymentChecklist(
  version: string,
  paths: readonly string[],
  commits: readonly ParsedCommit[],
): string {
  const conditional = DEPLOYMENT_SIGNALS.filter((signal) => signal.test(paths, commits)).map(
    (signal) => signal.item,
  );

  return [
    `# Deployment checklist — ${version}`,
    '',
    '## Before deploying',
    '',
    ...BASE_CHECKLIST.map((item) => `- [ ] ${item}`),
    ...(conditional.length > 0
      ? ['', '## Specific to this release', '', ...conditional.map((item) => `- [ ] ${item}`)]
      : []),
    '',
    '## After deploying',
    '',
    '- [ ] Error rates and latency are within normal bounds.',
    '- [ ] A key user flow has been verified manually.',
    '- [ ] The release notes are published.',
    '',
  ].join('\n');
}

/** Builds the complete release plan. */
export function planRelease(input: ReleaseInput): ReleasePlan {
  const parsed = parseCommits(input.commits);
  const breakingCommits = parsed.filter((commit) => commit.breaking);

  const changelog = generateChangelog({
    repository: input.repository,
    commits: input.commits,
    ...(input.version ? { version: input.version } : {}),
    ...(input.previousVersion ? { previousVersion: input.previousVersion } : {}),
    config: input.config,
  });

  const paths = input.changedPaths ?? [];

  return {
    version: changelog.version,
    previousVersion: changelog.previousVersion,
    releaseKind: changelog.releaseKind,
    releaseNotes: changelog.markdown,
    upgradeGuide: renderUpgradeGuide(
      input.repository,
      changelog.version,
      changelog.previousVersion,
      changelog.breakingChanges,
      parsed,
    ),
    breakingChangeSummary: renderBreakingSummary(changelog.version, changelog.breakingChanges),
    migrationGuide: renderMigrationGuide(changelog.version, breakingCommits),
    deploymentChecklist: renderDeploymentChecklist(changelog.version, paths, parsed),
    hasBreakingChanges: changelog.breakingChanges.length > 0,
    contributors: changelog.contributors,
    commitCount: changelog.commitCount,
  };
}
