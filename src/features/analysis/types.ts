import { generateId } from '@/core/crypto';
import type {
  CodeLocation,
  Finding,
  PullRequestRef,
  RepositoryRef,
  ReviewCategory,
  Severity,
  SuggestedFix,
} from '@/core/types';
import type { AutodevConfig } from '@/features/config';
import type { DiffLine, FileDiff } from '@/features/github/diff';

/**
 * The analyzer contract.
 *
 * Analyzers are pure functions of their context. No network, no database, no
 * clock. That constraint is what makes the review engine testable line by line
 * and makes two runs over the same commit produce identical output — which in
 * turn is what lets quality gates be trusted to block a merge.
 */

export interface AnalysisContext {
  readonly repository: RepositoryRef;
  readonly pullRequest: PullRequestRef;
  /** Files worth analysing: binaries, deletions and generated output removed. */
  readonly files: readonly FileDiff[];
  /** Every changed file, including the ones filtered out of `files`. */
  readonly allFiles: readonly FileDiff[];
  readonly config: AutodevConfig;
  /**
   * Optional full contents of changed files at the head revision, keyed by
   * path. Some checks (unbalanced try/catch, duplicate detection across a
   * whole file) need more than the diff hunks. Absent in diff-only mode.
   */
  readonly fileContents?: ReadonlyMap<string, string>;
}

export interface Analyzer {
  readonly id: string;
  readonly description: string;
  /** Categories this analyzer can emit; used to honour `review.categories`. */
  readonly categories: readonly ReviewCategory[];
  analyze(context: AnalysisContext): Finding[] | Promise<Finding[]>;
}

export interface FindingDraft {
  readonly rule: string;
  readonly category: ReviewCategory;
  readonly severity: Severity;
  readonly title: string;
  readonly description: string;
  readonly location?: CodeLocation;
  readonly suggestion?: SuggestedFix;
  readonly confidence?: number;
  readonly references?: readonly string[];
}

/** Builds a {@link Finding}, filling in the mechanical fields. */
export function createFinding(draft: FindingDraft): Finding {
  return {
    id: generateId(),
    rule: draft.rule,
    category: draft.category,
    severity: draft.severity,
    title: draft.title,
    description: draft.description,
    ...(draft.location ? { location: draft.location } : {}),
    ...(draft.suggestion ? { suggestion: draft.suggestion } : {}),
    source: 'static',
    confidence: draft.confidence ?? 0.9,
    ...(draft.references ? { references: draft.references } : {}),
  };
}

/** Location helper for a line produced by the diff parser. */
export function lineLocation(file: FileDiff, line: DiffLine): CodeLocation {
  return {
    path: file.path,
    ...(line.newLine !== undefined ? { line: line.newLine } : {}),
    diffPosition: line.position,
  };
}

/**
 * Strips string and comment content from a line before pattern matching.
 *
 * Without this, `// TODO: never use eval()` reports an `eval` finding. Naive
 * but effective for the single-line heuristics these analyzers use; anything
 * needing real accuracy would require a parser per language, which is a
 * deliberate non-goal.
 */
export function stripLiterals(line: string): string {
  return line
    .replace(/\\./g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\/.*$/, '')
    .replace(/#.*$/, '');
}

/** True when the line is entirely a comment. */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('--')
  );
}

/** Languages the JavaScript/TypeScript-specific analyzers apply to. */
export const JS_LANGUAGES = new Set(['javascript', 'typescript', 'vue', 'svelte']);

export function isJsLike(file: FileDiff): boolean {
  return JS_LANGUAGES.has(file.language);
}

/**
 * Iterates added lines across files, skipping pure-comment lines.
 *
 * Analyzers look at *added* lines only. Reporting pre-existing problems on
 * every unrelated PR is the fastest way to get a review bot muted.
 */
export function* addedCodeLines(
  files: readonly FileDiff[],
): Generator<{ file: FileDiff; line: DiffLine; code: string }> {
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== 'added') continue;
        if (isCommentLine(line.content)) continue;
        if (line.content.trim().length === 0) continue;
        yield { file, line, code: line.content };
      }
    }
  }
}
