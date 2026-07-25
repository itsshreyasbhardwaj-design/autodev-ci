import type { Finding } from '@/core/types';
import { addedLines } from '@/features/github/diff';
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
 * Performance analysis.
 *
 * Focused on the small number of patterns that reliably turn into production
 * incidents — N+1 queries, awaits inside loops, unbounded queries — rather
 * than micro-optimisations that do not matter and would only add noise.
 */

interface Rule {
  readonly id: string;
  readonly title: string;
  readonly severity: Finding['severity'];
  readonly confidence: number;
  readonly pattern: RegExp;
  readonly unless?: RegExp;
  readonly description: string;
  readonly suggestion: string;
}

const LINE_RULES: readonly Rule[] = [
  {
    id: 'unbounded-query',
    title: 'Query without a row limit',
    severity: 'medium',
    confidence: 0.6,
    pattern: /\.(?:findMany|findAll|find|select)\s*\(\s*(?:\)|\{\s*\})/,
    unless: /limit|take|first|top|per_page|maxResults/i,
    description:
      'This query has no limit. It is fine against a development dataset and becomes a memory and latency problem once the table grows.',
    suggestion: 'Add an explicit `limit`/`take`, and paginate at the API boundary.',
  },
  {
    id: 'select-star',
    title: 'SELECT * in a query',
    severity: 'low',
    confidence: 0.7,
    pattern: /\bSELECT\s+\*\s+FROM\b/i,
    description:
      'Selecting every column transfers data you do not use and silently changes shape whenever a column is added.',
    suggestion: 'List the columns the caller actually needs.',
  },
  {
    id: 'sync-io-in-request-path',
    title: 'Synchronous filesystem call',
    severity: 'medium',
    confidence: 0.75,
    pattern: /\b(?:readFileSync|writeFileSync|existsSync|readdirSync|execSync)\s*\(/,
    unless: /(?:^|\/)(?:scripts?|bin|cli|tools?|config)\//,
    description:
      'Synchronous I/O blocks the Node.js event loop. Under concurrency every other in-flight request waits for this call to finish.',
    suggestion: 'Use the promise-based API from `node:fs/promises`.',
  },
  {
    id: 'regex-in-loop',
    title: 'Regular expression compiled inside a loop',
    severity: 'low',
    confidence: 0.55,
    pattern: /\bnew RegExp\s*\(/,
    description:
      'Constructing a RegExp recompiles the pattern on every call. When the pattern is constant this is pure overhead.',
    suggestion: 'Hoist the RegExp to module scope, or use a literal.',
  },
  {
    id: 'array-includes-in-loop',
    title: 'Linear lookup inside iteration',
    severity: 'low',
    confidence: 0.5,
    pattern: /\.(?:forEach|map|filter)\s*\([^)]*\)\s*[\s\S]{0,80}?\.(?:includes|indexOf|find)\s*\(/,
    description:
      'A linear search nested inside iteration is O(n·m). This is invisible at 10 items and dominates runtime at 10,000.',
    suggestion: 'Build a `Set` or `Map` once before the loop and look up in O(1).',
  },
  {
    id: 'spread-in-reduce',
    title: 'Object spread inside reduce',
    severity: 'medium',
    confidence: 0.8,
    pattern: /\.reduce\s*\(\s*\([^)]*\)\s*=>\s*\(?\s*\{\s*\.\.\./,
    description:
      'Spreading the accumulator on every iteration copies the whole object each time, making the reduce O(n²).',
    suggestion: 'Mutate the accumulator inside the reducer, or build a Map and convert once.',
  },
  {
    id: 'await-in-loop',
    title: 'Sequential await inside a loop',
    severity: 'medium',
    confidence: 0.7,
    pattern: /^\s*(?:for|while)\s*[({][\s\S]{0,200}?\bawait\b/,
    description:
      'Each iteration waits for the previous one. For independent operations this multiplies total latency by the iteration count.',
    suggestion:
      'If the operations are independent, collect the promises and `await Promise.all(...)`. Keep the sequential form when order matters or to bound concurrency.',
  },
];

/**
 * N+1 detection needs more than one line of context: a loop construct
 * followed, within a short window, by a database or network call.
 */
const LOOP_PATTERN = /\b(?:for\s*\(|for\s+\w+\s+(?:of|in)\b|while\s*\(|\.forEach\s*\(|\.map\s*\()/;
const IO_CALL_PATTERN =
  /\b(?:await\s+)?(?:\w+\.)?(?:findUnique|findFirst|findOne|findById|query|execute|get|fetch|select|save|insert|update|load)\s*\(/;

function detectNPlusOne(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const file of context.files) {
    if (!isJsLike(file) && !['python', 'ruby', 'go', 'java'].includes(file.language)) continue;
    if (/\.(test|spec)\./.test(file.path)) continue;

    const lines = addedLines(file);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;

      const code = stripLiterals(line.content);
      if (!LOOP_PATTERN.test(code)) continue;

      // Scan a short window for an I/O call. Beyond ~6 lines the association
      // becomes speculative and the false-positive rate climbs.
      const window = lines.slice(index + 1, index + 7);
      const ioLine = window.find((candidate) => {
        const stripped = stripLiterals(candidate.content);
        return (
          IO_CALL_PATTERN.test(stripped) &&
          // Contiguity check: skip if the "loop" and the call are far apart in
          // the real file, which happens when the diff is fragmented.
          candidate.newLine !== undefined &&
          line.newLine !== undefined &&
          candidate.newLine - line.newLine <= 8
        );
      });

      if (!ioLine) continue;

      findings.push(
        createFinding({
          rule: 'performance/n-plus-one',
          category: 'performance',
          severity: 'high',
          title: 'Possible N+1 query pattern',
          description: [
            'A data-access call appears inside a loop. Each iteration issues its own round trip, so total latency scales with collection size — the classic N+1 problem.',
            '',
            '```' + file.language,
            `${line.content.trim()}`,
            `  ...`,
            `${ioLine.content.trim()}`,
            '```',
            '',
            'This is usually invisible in development, where the collection has three items, and severe in production where it has three thousand.',
          ].join('\n'),
          location: lineLocation(file, line),
          suggestion: {
            description:
              'Fetch all records in one query before the loop (a batched `WHERE id IN (...)`, a join, or a DataLoader) and look them up from memory.',
          },
          confidence: 0.6,
          references: ['https://www.sqlite.org/np1queryprob.html'],
        }),
      );
    }
  }

  return findings;
}

export const performanceAnalyzer: Analyzer = {
  id: 'performance',
  description: 'Detects query and loop patterns that degrade under real load',
  categories: ['performance'],

  analyze(context: AnalysisContext): Finding[] {
    const findings: Finding[] = [...detectNPlusOne(context)];
    const seen = new Set<string>();

    for (const { file, line, code } of addedCodeLines(context.files)) {
      if (/\.(test|spec)\./.test(file.path)) continue;
      const stripped = stripLiterals(code);

      for (const rule of LINE_RULES) {
        if (!rule.pattern.test(stripped)) continue;
        if (rule.unless?.test(code) || rule.unless?.test(file.path)) continue;

        const key = `${file.path}:${line.newLine}:${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push(
          createFinding({
            rule: `performance/${rule.id}`,
            category: 'performance',
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
