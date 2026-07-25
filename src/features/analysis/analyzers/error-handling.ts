import type { Finding } from '@/core/types';
import {
  type AnalysisContext,
  type Analyzer,
  addedCodeLines,
  createFinding,
  isJsLike,
  lineLocation,
  stripLiterals,
} from '../types';

/**
 * Error handling and edge-case analysis.
 *
 * The failures this catches — a swallowed exception, an unawaited promise, a
 * `JSON.parse` with no guard — are exactly the ones that pass code review and
 * then page someone at 3am, because nothing in the happy path exercises them.
 */

interface Rule {
  readonly id: string;
  readonly title: string;
  readonly severity: Finding['severity'];
  readonly category: Finding['category'];
  readonly confidence: number;
  readonly pattern: RegExp;
  readonly unless?: RegExp;
  readonly languages?: readonly string[];
  readonly description: string;
  readonly suggestion: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'empty-catch',
    title: 'Exception silently swallowed',
    severity: 'high',
    category: 'error-handling',
    confidence: 0.85,
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except[^:]*:\s*pass\b/,
    description:
      'An empty catch block discards the error entirely. When this code fails in production there will be no log line, no metric, and no stack trace — only a symptom somewhere else.',
    suggestion:
      'Log the error with context, re-throw it, or add a comment explaining precisely why it is safe to ignore.',
  },
  {
    id: 'catch-without-use',
    title: 'Caught error is never inspected',
    severity: 'medium',
    category: 'error-handling',
    confidence: 0.55,
    pattern: /catch\s*\(\s*(?:e|err|error|ex)\s*\)\s*\{\s*(?:return|continue|break)[^;]*;?\s*\}/,
    languages: ['javascript', 'typescript'],
    description:
      'The error is caught and immediately discarded by returning. Callers cannot distinguish "no result" from "the operation failed".',
    suggestion: 'Log the error, or return a Result type that carries the failure.',
  },
  {
    id: 'unhandled-json-parse',
    title: 'JSON.parse without error handling',
    severity: 'medium',
    category: 'error-handling',
    confidence: 0.6,
    pattern: /(?<!\.)\bJSON\.parse\s*\(/,
    unless: /try\s*\{|\.catch\(|safeParse|=>\s*\{[\s\S]*try/,
    languages: ['javascript', 'typescript'],
    description:
      '`JSON.parse` throws a SyntaxError on malformed input. When the input comes from a network response, a file or user data, that exception will eventually happen.',
    suggestion: 'Wrap in try/catch, or validate with a schema parser such as Zod.',
  },
  {
    id: 'floating-promise',
    title: 'Promise not awaited',
    severity: 'high',
    category: 'correctness',
    confidence: 0.6,
    pattern:
      /^\s*(?!(?:return|await|void|yield)\b)(?:[\w$.]+\.)?(?:fetch|save|update|delete|insert|send|write|publish|emit|commit|flush|dispatch)[A-Za-z]*\s*\([^)]*\)\s*;?\s*$/,
    unless: /await|\.then\(|\.catch\(|return|=|void /,
    languages: ['javascript', 'typescript'],
    description:
      'This call looks asynchronous but its result is not awaited. Rejections become unhandled promise rejections, and the surrounding function returns before the work completes.',
    suggestion: 'Add `await`, return the promise, or mark it deliberate with `void`.',
  },
  {
    id: 'process-exit-in-library',
    title: 'process.exit() outside an entry point',
    severity: 'medium',
    category: 'error-handling',
    confidence: 0.7,
    pattern: /\bprocess\.exit\s*\(/,
    languages: ['javascript', 'typescript'],
    description:
      '`process.exit` terminates immediately, skipping cleanup handlers and truncating buffered stdout. In library code it also makes the function impossible to test.',
    suggestion: 'Throw an error and let the entry point decide the exit code.',
  },
  {
    id: 'array-index-unchecked',
    title: 'Array access without a bounds check',
    severity: 'low',
    category: 'edge-cases',
    confidence: 0.45,
    pattern: /\[\s*(?:0|\w+\.length\s*-\s*1)\s*\]\s*\.\w+/,
    unless: /\?\.|\bif\s*\(|\?\?|at\(/,
    languages: ['javascript', 'typescript'],
    description:
      'Indexing an array and immediately dereferencing the result throws when the array is empty. Empty collections are the most commonly missed edge case in reviews.',
    suggestion: 'Use optional chaining (`arr[0]?.field`) or check the length first.',
  },
  {
    id: 'division-without-guard',
    title: 'Division without a zero check',
    severity: 'low',
    category: 'edge-cases',
    confidence: 0.4,
    pattern: /\/\s*(?:[a-z_$][\w$]*\.)?(?:length|count|total|size|n)\b/i,
    unless: /\|\||\?\?|Math\.max|>\s*0|if\s*\(/,
    description:
      'Dividing by a length or count yields Infinity or NaN when the collection is empty, and that value usually propagates silently into a metric or a UI.',
    suggestion: 'Guard the denominator, e.g. `total === 0 ? 0 : sum / total`.',
  },
  {
    id: 'missing-await-in-loop-cleanup',
    title: 'Resource opened without guaranteed cleanup',
    severity: 'medium',
    category: 'error-handling',
    confidence: 0.5,
    pattern: /\b(?:createReadStream|createWriteStream|open|connect|acquire)\s*\(/,
    unless: /try\s*\{|finally|using |with |defer |\.close\(\)|\.release\(\)|\.end\(\)/,
    description:
      'A handle acquired here has no visible cleanup path. If an error is thrown before the matching close, the resource leaks.',
    suggestion:
      'Release in a `finally` block, or use a scoped construct (`using`, `with`, `defer`).',
  },
  {
    id: 'swallowed-rejection',
    title: 'Promise rejection handler does nothing',
    severity: 'medium',
    category: 'error-handling',
    confidence: 0.8,
    pattern:
      /\.catch\s*\(\s*(?:\(\s*\w*\s*\)\s*=>\s*\{\s*\}|\(\s*\)\s*=>\s*\{\s*\}|console\.log)\s*\)/,
    languages: ['javascript', 'typescript'],
    description:
      'This rejection handler discards the error (or only logs it at info level), which hides failures from monitoring.',
    suggestion: 'Log at error level with context, or propagate the failure to the caller.',
  },
  {
    id: 'non-null-assertion',
    title: 'Non-null assertion bypasses the type checker',
    severity: 'low',
    category: 'correctness',
    confidence: 0.6,
    pattern: /[\w$)\]]!\s*\.(?![.\d])/,
    unless: /!==|!=/,
    languages: ['typescript'],
    description:
      '`!` tells TypeScript a value cannot be null without proving it. If the assumption is ever wrong the result is a runtime TypeError in a place the compiler said was safe.',
    suggestion: 'Narrow with an explicit check, or use optional chaining with a sensible default.',
  },
  {
    id: 'any-type',
    title: 'Explicit `any` weakens type safety',
    severity: 'low',
    category: 'maintainability',
    confidence: 0.8,
    pattern: /:\s*any\b|<any>|as\s+any\b/,
    languages: ['typescript'],
    description:
      '`any` disables type checking for every downstream use of the value, and the loss propagates silently through the call graph.',
    suggestion: 'Use `unknown` and narrow it, or write the concrete type.',
  },
];

export const errorHandlingAnalyzer: Analyzer = {
  id: 'error-handling',
  description: 'Finds swallowed errors, unhandled rejections and missed edge cases',
  categories: ['error-handling', 'correctness', 'edge-cases', 'maintainability'],

  analyze(context: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    const seen = new Set<string>();

    for (const { file, line, code } of addedCodeLines(context.files)) {
      // Tests deliberately construct failure paths and empty handlers.
      if (/\.(test|spec)\./.test(file.path)) continue;

      const stripped = stripLiterals(code);

      for (const rule of RULES) {
        if (rule.languages) {
          if (rule.languages.includes('typescript') && file.language !== 'typescript') continue;
          if (
            !rule.languages.includes(file.language) &&
            !(rule.languages.includes('javascript') && isJsLike(file))
          ) {
            continue;
          }
        }

        if (!rule.pattern.test(stripped)) continue;
        if (rule.unless?.test(code)) continue;

        const key = `${file.path}:${line.newLine}:${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

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
              code.trim().slice(0, 240),
              '```',
            ].join('\n'),
            location: lineLocation(file, line),
            suggestion: { description: rule.suggestion },
            confidence: rule.confidence,
          }),
        );
      }
    }

    return findings;
  },
};
