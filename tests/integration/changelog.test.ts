import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  generateChangelog,
  inferReleaseKind,
  latestVersionTag,
  parseCommit,
  parseCommits,
  parseVersion,
  prependToChangelog,
} from '@/features/changelog';
import { defaultConfig } from '@/features/config';
import { planRelease } from '@/features/release';
import { repository } from '../fixtures';

const config = defaultConfig().changelog;

function commit(message: string, author = 'alice', sha = 'a'.repeat(40)) {
  return { sha, message, author, date: '2026-01-01T00:00:00Z' };
}

describe('conventional commit parsing', () => {
  it('parses type, scope and subject', () => {
    const parsed = parseCommit(commit('feat(api): add pagination'));
    expect(parsed.type).toBe('feat');
    expect(parsed.scope).toBe('api');
    expect(parsed.subject).toBe('add pagination');
    expect(parsed.conventional).toBe(true);
    expect(parsed.breaking).toBe(false);
  });

  it('recognises both breaking-change forms', () => {
    expect(parseCommit(commit('feat(api)!: drop v1')).breaking).toBe(true);

    const footer = parseCommit(
      commit('feat: new auth\n\nBREAKING CHANGE: tokens are no longer accepted in query params'),
    );
    expect(footer.breaking).toBe(true);
    expect(footer.breakingDescription).toContain('query params');
  });

  it('extracts a pull request reference from the subject', () => {
    const parsed = parseCommit(commit('fix: handle empty input (#482)'));
    expect(parsed.pullRequest).toBe(482);
    expect(parsed.subject).toBe('handle empty input');
  });

  it('keeps non-conventional commits rather than dropping the work', () => {
    const parsed = parseCommit(commit('Update the readme a bit'));
    expect(parsed.conventional).toBe(false);
    expect(parsed.type).toBe('other');
    expect(parsed.subject).toBe('Update the readme a bit');
  });

  it('drops merge commits', () => {
    const commits = parseCommits([
      commit('Merge pull request #12 from acme/feature'),
      commit('feat: real work'),
    ]);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.type).toBe('feat');
  });
});

describe('semantic version inference', () => {
  it('maps commit types to release kinds', () => {
    expect(inferReleaseKind(parseCommits([commit('feat!: break it')]))).toBe('major');
    expect(inferReleaseKind(parseCommits([commit('feat: add it')]))).toBe('minor');
    expect(inferReleaseKind(parseCommits([commit('fix: patch it')]))).toBe('patch');
    expect(inferReleaseKind(parseCommits([commit('chore: tidy')]))).toBe('none');
  });

  it('bumps versions correctly', () => {
    const version = parseVersion('1.4.2')!;
    expect(bumpVersion(version, 'major')).toMatchObject({ major: 2, minor: 0, patch: 0 });
    expect(bumpVersion(version, 'minor')).toMatchObject({ major: 1, minor: 5, patch: 0 });
    expect(bumpVersion(version, 'patch')).toMatchObject({ major: 1, minor: 4, patch: 3 });
  });

  it('treats a breaking change before 1.0 as a minor bump', () => {
    // 0.x is explicitly unstable; jumping to 1.0.0 would signal a stability
    // promise the project has not made.
    const zeroVersion = parseVersion('0.3.1')!;
    expect(bumpVersion(zeroVersion, 'major')).toMatchObject({ major: 0, minor: 4, patch: 0 });
  });

  it('picks the newest semver tag, preferring stable over prerelease', () => {
    const tags = [
      { name: 'v1.2.0' },
      { name: 'v1.10.0' },
      { name: 'v1.10.0-beta.1' },
      { name: 'not-a-version' },
    ];
    expect(latestVersionTag(tags)).toBe('v1.10.0');
  });

  it('returns null when no tag is a version', () => {
    expect(latestVersionTag([{ name: 'latest' }, { name: 'stable' }])).toBeNull();
  });
});

describe('changelog generation', () => {
  it('groups commits into sections and leads with breaking changes', () => {
    const result = generateChangelog({
      repository,
      previousVersion: 'v1.0.0',
      commits: [
        commit('feat(api)!: remove the v1 endpoints\n\nBREAKING CHANGE: use /v2 instead'),
        commit('feat(ui): add a dark theme', 'bob'),
        commit('fix: correct the rounding', 'carol'),
        commit('chore: bump deps'),
      ],
      config,
    });

    expect(result.releaseKind).toBe('major');
    expect(result.version).toBe('2.0.0');

    // Breaking changes must appear before the feature list.
    const breakingIndex = result.markdown.indexOf('BREAKING CHANGES');
    const featureIndex = result.markdown.indexOf('Features');
    expect(breakingIndex).toBeGreaterThan(-1);
    expect(breakingIndex).toBeLessThan(featureIndex);

    expect(result.markdown).toContain('use /v2 instead');
    expect(result.contributors).toEqual(['alice', 'bob', 'carol']);
  });

  it('links commits and pull requests back to GitHub', () => {
    const result = generateChangelog({
      repository,
      commits: [commit('fix: thing (#42)')],
      config,
    });

    expect(result.markdown).toContain('https://github.com/acme/widgets/pull/42');
  });

  it('omits links when linkReferences is off', () => {
    const result = generateChangelog({
      repository,
      commits: [commit('fix: thing (#42)')],
      config: { ...config, linkReferences: false },
    });

    expect(result.markdown).not.toContain('https://github.com');
    expect(result.markdown).toContain('(#42)');
  });

  it('excludes bot accounts from the contributor list', () => {
    const result = generateChangelog({
      repository,
      commits: [commit('fix: a', 'dependabot[bot]'), commit('fix: b', 'alice')],
      config,
    });
    expect(result.contributors).toEqual(['alice']);
  });

  it('states plainly when there is nothing user-facing', () => {
    const result = generateChangelog({
      repository,
      commits: [commit('chore: reformat')],
      config: { ...config, includeTypes: ['feat', 'fix'] },
    });
    expect(result.markdown).toContain('No user-facing changes');
  });
});

describe('CHANGELOG.md updating', () => {
  it('creates a file with the standard header when none exists', () => {
    const output = prependToChangelog(null, '## 1.0.0 (2026-01-01)\n\n- first\n', '1.0.0');
    expect(output).toContain('# Changelog');
    expect(output).toContain('Keep a Changelog');
    expect(output).toContain('## 1.0.0');
  });

  it('inserts a new release above the previous one', () => {
    const existing = ['# Changelog', '', '## 1.0.0 (2026-01-01)', '', '- old thing', ''].join('\n');
    const output = prependToChangelog(existing, '## 1.1.0 (2026-02-01)\n\n- new thing\n', '1.1.0');

    expect(output.indexOf('## 1.1.0')).toBeLessThan(output.indexOf('## 1.0.0'));
    expect(output).toContain('- old thing');
  });

  it('replaces an existing section for the same version instead of duplicating', () => {
    const existing = [
      '# Changelog',
      '',
      '## 1.1.0 (2026-02-01)',
      '',
      '- draft entry',
      '',
      '## 1.0.0 (2026-01-01)',
      '',
      '- old thing',
      '',
    ].join('\n');

    const output = prependToChangelog(
      existing,
      '## 1.1.0 (2026-02-02)\n\n- final entry\n',
      '1.1.0',
    );

    expect(output).toContain('- final entry');
    expect(output).not.toContain('- draft entry');
    expect(output.match(/## 1\.1\.0/g)).toHaveLength(1);
    expect(output).toContain('- old thing');
  });
});

describe('release planning', () => {
  it('produces all five documents', () => {
    const plan = planRelease({
      repository,
      previousVersion: 'v1.0.0',
      commits: [
        commit('feat(auth)!: require OAuth\n\nBREAKING CHANGE: API keys are no longer accepted'),
        commit('perf: cache the token lookup'),
      ],
      config,
      changedPaths: ['migrations/001_add_oauth.sql', '.env.example'],
    });

    expect(plan.version).toBe('2.0.0');
    expect(plan.hasBreakingChanges).toBe(true);

    expect(plan.releaseNotes).toContain('BREAKING CHANGES');
    expect(plan.upgradeGuide).toContain('Before you upgrade');
    expect(plan.migrationGuide).toContain('API keys are no longer accepted');
    // The BREAKING CHANGE footer is the authoritative description of the
    // impact, so it wins over the commit subject.
    expect(plan.breakingChangeSummary).toContain('API keys are no longer accepted');
    expect(plan.breakingChangeSummary).toContain('**auth:**');

    // The checklist adapts to what actually changed.
    expect(plan.deploymentChecklist).toContain('database migrations');
    expect(plan.deploymentChecklist).toContain('environment variables');
    expect(plan.deploymentChecklist).toContain('before/after latency');
  });

  it('describes a patch release as a drop-in upgrade', () => {
    const plan = planRelease({
      repository,
      previousVersion: 'v1.0.0',
      commits: [commit('fix: correct an off-by-one')],
      config,
    });

    expect(plan.version).toBe('1.0.1');
    expect(plan.hasBreakingChanges).toBe(false);
    expect(plan.upgradeGuide).toContain('drop-in upgrade');
    expect(plan.migrationGuide).toContain('No migration is required');
  });
});
