import type { Finding } from '@/core/types';
import { addedLines, isTestFile } from '@/features/github/diff';
import {
  type AnalysisContext,
  type Analyzer,
  addedCodeLines,
  createFinding,
  isCommentLine,
  isJsLike,
  lineLocation,
  stripLiterals,
} from '../types';

/**
 * Maintainability, readability and architecture checks.
 *
 * These are the things a thoughtful human reviewer mentions and a linter does
 * not: leftover debugging output, magic numbers, TODOs without an owner,
 * imports that cross an architectural boundary, and commented-out code.
 */

interface Rule {
  readonly id: string;
  readonly title: string;
  readonly severity: Finding['severity'];
  readonly category: Finding['category'];
  readonly confidence: number;
  readonly pattern: RegExp;
  readonly unless?: RegExp;
  readonly description: string;
  readonly suggestion?: string;
  /** Match the raw line: the pattern depends on string or comment contents. */
  readonly raw?: boolean;
  /** Rule applies to comment lines, which the code pass skips. */
  readonly comments?: boolean;
}

const RULES: readonly Rule[] = [
  {
    id: 'debug-statement',
    title: 'Debugging statement left in the code',
    severity: 'medium',
    category: 'best-practices',
    confidence: 0.85,
    pattern:
      /\bdebugger\b|\bconsole\.(?:log|debug|dir|trace)\s*\(|\bprint\s*\(|\bbinding\.pry\b|\bdd\s*\(/,
    unless: /console\.(?:error|warn|info)|logger\.|eslint-disable/,
    description:
      'Debug output left in production code clutters logs and can leak internal state (arguments, tokens, user records) into a log aggregator where it is retained.',
    suggestion: 'Remove it, or route through the structured logger at an appropriate level.',
  },
  {
    id: 'todo-without-owner',
    raw: true,
    comments: true,
    title: 'TODO without an owner or issue link',
    severity: 'low',
    category: 'maintainability',
    confidence: 0.8,
    pattern: /\b(?:TODO|FIXME|HACK|XXX)\b(?!\s*[([]\s*(?:@\w+|#\d+|[A-Z]+-\d+))/,
    description:
      'An unattributed TODO has no owner and no deadline, so in practice it becomes permanent. The information about *why* it was deferred is lost with the context.',
    suggestion:
      'Add an owner and issue reference: `TODO(@alice, #482): ...` — or open the issue and delete the comment.',
  },
  {
    id: 'commented-out-code',
    raw: true,
    comments: true,
    title: 'Commented-out code',
    severity: 'low',
    category: 'maintainability',
    confidence: 0.6,
    pattern:
      /^\s*(?:\/\/|#)\s*(?:(?:const|let|var|function|class|import|export|return|if|for|while)\b|[\w.]+\s*\([^)]*\)\s*;?\s*$)/,
    unless: /eslint|prettier|@ts-|type:|noqa|pragma|Example|e\.g\./i,
    description:
      'Commented-out code is dead weight: readers cannot tell whether it is a work in progress, a rollback plan, or forgotten. Version control already remembers it.',
    suggestion: 'Delete it. `git log` has the history if it is ever needed.',
  },
  {
    id: 'magic-number',
    title: 'Unexplained numeric literal',
    severity: 'low',
    category: 'readability',
    confidence: 0.4,
    pattern: /[=<>+\-*/(,]\s*(?:\d{4,}|86400|3600|1024|604800|2592000)\b/,
    unless: /(?:const|final|static|#define|enum)\s|20\d\d|version|port|status|\.length|http/i,
    description:
      'A bare numeric constant does not say what it means. `86400` and `SECONDS_PER_DAY` compile to the same thing; only one survives being read six months later.',
    suggestion: 'Extract to a named constant.',
  },
  {
    id: 'deep-relative-import',
    raw: true,
    title: 'Deep relative import crosses module boundaries',
    severity: 'low',
    category: 'architecture',
    confidence: 0.85,
    pattern: /from\s+['"](?:\.\.\/){3,}|require\s*\(\s*['"](?:\.\.\/){3,}/,
    description:
      'An import reaching three or more directories upward signals that the module boundary is in the wrong place, and it breaks whenever a file moves.',
    suggestion:
      'Use a path alias (`@/...`), or move the shared code somewhere both sides can import cleanly.',
  },
  {
    id: 'barrel-import-cycle-risk',
    raw: true,
    title: 'Import from a parent barrel file',
    severity: 'low',
    category: 'architecture',
    confidence: 0.5,
    pattern: /from\s+['"]\.\.?['"]\s*;?$|from\s+['"]\.\.?\/index['"]/,
    description:
      'Importing from a parent `index` file inside the same module is a common source of circular imports, which surface as confusing `undefined` values at runtime rather than as errors.',
    suggestion: 'Import directly from the defining module.',
  },
  {
    id: 'mutable-module-state',
    title: 'Mutable module-level state',
    severity: 'medium',
    category: 'architecture',
    confidence: 0.5,
    pattern: /^(?:export\s+)?(?:let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/,
    unless: /^\s*(?:let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:undefined|null)\s*;?\s*$/,
    description:
      'Module-level mutable state is shared across every importer and, in a serverless runtime, persists between requests on a warm instance. That makes it a source of cross-request data leaks and test-order dependencies.',
    suggestion: 'Scope the state to a request, or hold it in an explicitly constructed object.',
  },
  {
    id: 'empty-interface',
    title: 'Empty type declaration',
    severity: 'low',
    category: 'maintainability',
    confidence: 0.8,
    pattern: /^\s*(?:export\s+)?interface\s+\w+\s*(?:extends\s+[\w<>,\s]+)?\{\s*\}/,
    description:
      'An empty interface accepts any object, which is almost never the intent and silently disables the type checking a reader assumes is there.',
    suggestion: 'Declare the members, or use a type alias to the type being extended.',
  },
];

/** Signals that the change touches architectural boundaries worth noting. */
function architecturalObservations(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  const sourceFiles = context.files.filter((file) => !isTestFile(file.path));
  const newFiles = sourceFiles.filter((file) => file.status === 'added');

  // A very large single file added in one go is worth flagging: it is the
  // hardest kind of change to review carefully.
  for (const file of newFiles) {
    if (file.additions > 600) {
      findings.push(
        createFinding({
          rule: 'architecture/large-new-file',
          category: 'architecture',
          severity: 'low',
          title: `New file \`${file.path}\` is ${file.additions} lines`,
          description:
            'A large new file is difficult to review carefully in one pass, and usually indicates several responsibilities that could be separated. If it must stay whole, calling out the intended structure in the PR description helps reviewers a lot.',
          location: { path: file.path },
          confidence: 0.7,
        }),
      );
    }
  }

  // Very wide PRs are a review-quality problem regardless of content.
  if (sourceFiles.length > 40) {
    findings.push(
      createFinding({
        rule: 'architecture/wide-change',
        category: 'architecture',
        severity: 'low',
        title: `This pull request touches ${sourceFiles.length} source files`,
        description: [
          'Review quality drops sharply with change size — reviewers skim once a diff stops fitting in working memory.',
          '',
          'If this is a mechanical change (a rename, a codemod), say so in the description so reviewers know they can scan it. If it is not, splitting it into reviewable pieces will get you better feedback.',
        ].join('\n'),
        confidence: 0.8,
      }),
    );
  }

  return findings;
}

export const maintainabilityAnalyzer: Analyzer = {
  id: 'maintainability',
  description: 'Reviews readability, leftover debug code and architectural boundaries',
  categories: ['maintainability', 'readability', 'architecture', 'best-practices'],

  analyze(context: AnalysisContext): Finding[] {
    const findings: Finding[] = architecturalObservations(context);
    const seen = new Set<string>();
    // Cap per-rule output; twelve "magic number" comments help nobody.
    const perRuleCount = new Map<string, number>();

    /*
     * Two passes over the diff.
     *
     * `addedCodeLines` deliberately skips comment-only lines so that
     * `// never use eval()` does not trip the security rules. But two rules
     * here — unattributed TODOs and commented-out code — exist precisely to
     * look at comments, so they need their own pass over the raw added lines.
     */
    const codePass = [...addedCodeLines(context.files)].map((entry) => ({
      ...entry,
      commentOnly: false,
    }));

    const commentPass = context.files.flatMap((file) =>
      addedLines(file)
        .filter((line) => isCommentLine(line.content))
        .map((line) => ({ file, line, code: line.content, commentOnly: true })),
    );

    for (const { file, line, code, commentOnly } of [...codePass, ...commentPass]) {
      const isTest = isTestFile(file.path);
      const stripped = stripLiterals(code);

      for (const rule of RULES) {
        // A comment line only ever matches comment rules, and vice versa.
        if (commentOnly !== Boolean(rule.comments)) continue;

        // Debug output and magic numbers are normal and expected in tests.
        if (isTest && ['debug-statement', 'magic-number', 'commented-out-code'].includes(rule.id)) {
          continue;
        }
        if (['empty-interface', 'barrel-import-cycle-risk'].includes(rule.id) && !isJsLike(file)) {
          continue;
        }

        const subject = rule.raw ? code : stripped;

        if (!rule.pattern.test(subject)) continue;
        if (rule.unless?.test(code)) continue;

        const count = perRuleCount.get(rule.id) ?? 0;
        if (count >= 5) continue;

        const key = `${file.path}:${line.newLine}:${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perRuleCount.set(rule.id, count + 1);

        findings.push(
          createFinding({
            rule: `${rule.category}/${rule.id}`,
            category: rule.category,
            severity: rule.severity,
            title: rule.title,
            description: [
              rule.description,
              '',
              '```' + file.language,
              code.trim().slice(0, 200),
              '```',
            ].join('\n'),
            location: lineLocation(file, line),
            ...(rule.suggestion ? { suggestion: { description: rule.suggestion } } : {}),
            confidence: rule.confidence,
          }),
        );
      }
    }

    // Long-line check is separate: it is per-file, not per-rule-per-line.
    for (const file of context.files) {
      if (!isJsLike(file) && !['python', 'go', 'java'].includes(file.language)) continue;
      const longLines = addedLines(file).filter((line) => line.content.length > 160);
      if (longLines.length >= 5) {
        findings.push(
          createFinding({
            rule: 'readability/long-lines',
            category: 'readability',
            severity: 'info',
            title: `${longLines.length} lines exceed 160 characters in \`${file.path}\``,
            description:
              'Very long lines force horizontal scrolling in side-by-side diffs, which is where most review happens. A formatter configured with a print width usually resolves this repository-wide.',
            location: { path: file.path },
            confidence: 0.9,
          }),
        );
      }
    }

    return findings;
  },
};
