import type { PullRequestRef, RepositoryRef } from '@/core/types';
import type { AutodevConfig } from '@/features/config';
import { defaultConfig } from '@/features/config';
import { buildFileDiffs, type FileDiff, type RawFileChange } from '@/features/github/diff';
import type { AnalysisContext } from '@/features/analysis/types';

/**
 * Test fixtures.
 *
 * `diffOf` is the workhorse: it turns a list of added lines into a real
 * unified patch and runs it through the production parser, so analyzer tests
 * exercise the same code path as production rather than a hand-built object
 * that could drift from what the parser actually produces.
 */

export const repository: RepositoryRef = {
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  defaultBranch: 'main',
};

export const pullRequest: PullRequestRef = {
  number: 42,
  title: 'Add widget pricing',
  author: 'dev',
  baseRef: 'main',
  headRef: 'feature/pricing',
  headSha: 'a'.repeat(40),
  draft: false,
  url: 'https://github.com/acme/widgets/pull/42',
  body: 'Adds pricing to widgets.',
};

/** Builds a patch where every supplied line is an addition. */
export function patchFromAdditions(lines: readonly string[], startLine = 1): string {
  const header = `@@ -0,0 +${startLine},${lines.length} @@`;
  return [header, ...lines.map((line) => `+${line}`)].join('\n');
}

/**
 * Builds a patch with context, additions and removals.
 * Each entry is prefixed with ' ', '+' or '-' exactly as in a unified diff.
 */
export function patchFromLines(lines: readonly string[], oldStart = 1, newStart = 1): string {
  const oldCount = lines.filter((line) => !line.startsWith('+')).length;
  const newCount = lines.filter((line) => !line.startsWith('-')).length;
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines].join('\n');
}

export interface FileSpec {
  readonly path: string;
  readonly added?: readonly string[];
  readonly patch?: string;
  readonly status?: RawFileChange['status'];
  readonly additions?: number;
  readonly deletions?: number;
}

/** Produces {@link FileDiff}s through the real parser. */
export function diffOf(...specs: readonly FileSpec[]): FileDiff[] {
  return buildFileDiffs(
    specs.map((spec) => {
      const patch = spec.patch ?? patchFromAdditions(spec.added ?? []);
      return {
        filename: spec.path,
        status: spec.status ?? 'modified',
        additions: spec.additions ?? spec.added?.length ?? 0,
        deletions: spec.deletions ?? 0,
        patch,
      };
    }),
  );
}

export interface ContextOptions {
  readonly files: readonly FileDiff[];
  readonly config?: Partial<AutodevConfig>;
  readonly fileContents?: Record<string, string>;
}

/** Builds an {@link AnalysisContext} with sane defaults. */
export function contextOf(options: ContextOptions): AnalysisContext {
  const base = defaultConfig();

  return {
    repository,
    pullRequest,
    allFiles: options.files,
    files: options.files,
    config: { ...base, ...options.config } as AutodevConfig,
    ...(options.fileContents
      ? { fileContents: new Map(Object.entries(options.fileContents)) }
      : {}),
  };
}

/** Convenience: build a context from file specs in one call. */
export function contextFrom(...specs: readonly FileSpec[]): AnalysisContext {
  return contextOf({ files: diffOf(...specs) });
}

/**
 * Credential-shaped strings for analyzer tests.
 *
 * Assembled from parts at runtime rather than written as literals. These
 * values are synthetic, but a contiguous token-shaped string in the source
 * would trip GitHub's push protection and leave a scannable string in the
 * repository history. Joining the parts keeps the tests meaningful — the
 * analyzer still sees a complete token — without committing one.
 */
export const fakeSecret = {
  github: ['ghp', '1234567890abcdefghijklmnopqrstuvwx'].join('_'),
  githubShort: ['ghp', '1234567890abcdefghijklmnopq'].join('_'),
  stripe: ['sk', 'live', '51H8xKjLkKqRsTuVwXyZaBcDeFg'].join('_'),
  slack: ['xoxb', '123456789012', 'abcdefghijklmno'].join('-'),
  aws: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
} as const;
