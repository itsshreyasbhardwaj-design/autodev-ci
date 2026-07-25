import type { Finding } from '@/core/types';
import { addedLines, type FileDiff } from '@/features/github/diff';
import {
  type AnalysisContext,
  type Analyzer,
  createFinding,
  isCommentLine,
  isJsLike,
  stripLiterals,
} from '../types';

/**
 * Complexity and structural analysis.
 *
 * Cyclomatic complexity is approximated by counting decision points rather
 * than building an AST. That trades exactness for working across every
 * language in one implementation, which is the right trade for a review bot:
 * the goal is to flag "this function has grown hard to test", and a count that
 * is off by one never changes that judgement.
 */

/** Tokens that introduce a branch, across the languages we support. */
const DECISION_PATTERNS: readonly RegExp[] = [
  /\bif\s*\(/g,
  /\belse\s+if\b/g,
  /\bfor\s*\(/g,
  /\bwhile\s*\(/g,
  /\bcase\s+[^:]+:/g,
  /\bcatch\s*\(/g,
  /\b(?:and|or)\b/g, // python / ruby
  /&&/g,
  /\|\|/g,
  /\?\?/g,
  /\?[^.:]/g, // ternary, excluding optional chaining
  /\.filter\(|\.some\(|\.every\(/g,
];

export function cyclomaticComplexity(source: string): number {
  const code = source
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .map(stripLiterals)
    .join('\n');

  let complexity = 1;
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0;
    complexity += (code.match(pattern) ?? []).length;
  }
  return complexity;
}

export interface FunctionBlock {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly source: string;
  readonly lineCount: number;
  readonly complexity: number;
  readonly parameters: number;
  readonly maxNesting: number;
}

const FUNCTION_SIGNATURES: readonly RegExp[] = [
  // function foo(...) / async function foo(...)
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
  // const foo = (...) => / const foo = async (...) =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(([^)]*)\)\s*(?::[^=]+)?=>/,
  // class method: foo(...) { / async foo(...) {
  /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::[^{]+)?\{/,
  // python / ruby
  /^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/,
  // go
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/,
];

/**
 * Extracts function blocks by brace balance (or indentation for Python).
 *
 * This is a heuristic scanner, not a parser. It is tolerant of failure: an
 * unrecognised construct simply yields no block, and no finding, rather than
 * a wrong one.
 */
export function extractFunctions(source: string, language: string): FunctionBlock[] {
  const lines = source.split('\n');
  const blocks: FunctionBlock[] = [];
  const indentBased = language === 'python';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    let name: string | undefined;
    let params = '';

    for (const pattern of FUNCTION_SIGNATURES) {
      const match = pattern.exec(line);
      if (match) {
        name = match[1];
        params = match[2] ?? '';
        break;
      }
    }

    if (!name) continue;
    // Skip control keywords that syntactically resemble a call.
    if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;

    let end = index;

    if (indentBased) {
      const baseIndent = line.length - line.trimStart().length;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor] ?? '';
        if (candidate.trim().length === 0) continue;
        const indent = candidate.length - candidate.trimStart().length;
        if (indent <= baseIndent) break;
        end = cursor;
      }
    } else {
      let depth = 0;
      let opened = false;
      for (let cursor = index; cursor < lines.length; cursor += 1) {
        const candidate = stripLiterals(lines[cursor] ?? '');
        for (const char of candidate) {
          if (char === '{') {
            depth += 1;
            opened = true;
          } else if (char === '}') depth -= 1;
        }
        end = cursor;
        if (opened && depth <= 0) break;
      }
      // Runaway scan means we failed to find the closing brace; skip it.
      if (!opened || end - index > 600) continue;
    }

    const body = lines.slice(index, end + 1).join('\n');

    blocks.push({
      name,
      startLine: index + 1,
      endLine: end + 1,
      source: body,
      lineCount: end - index + 1,
      complexity: cyclomaticComplexity(body),
      parameters: params.trim().length === 0 ? 0 : params.split(',').length,
      maxNesting: maxNestingDepth(body, indentBased),
    });

    index = end;
  }

  return blocks;
}

function maxNestingDepth(source: string, indentBased: boolean): number {
  if (indentBased) {
    let max = 0;
    for (const line of source.split('\n')) {
      if (line.trim().length === 0) continue;
      const indent = line.length - line.trimStart().length;
      max = Math.max(max, Math.floor(indent / 4));
    }
    return Math.max(0, max - 1);
  }

  let depth = 0;
  let max = 0;
  for (const char of stripLiterals(source)) {
    if (char === '{') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === '}') depth -= 1;
  }
  return Math.max(0, max - 1);
}

/** Reconstructs a rough head-revision view of a file from its diff. */
function reconstructFile(file: FileDiff, contents?: ReadonlyMap<string, string>): string | null {
  const full = contents?.get(file.path);
  if (full) return full;

  // Fall back to the added lines. Complexity of a partial view understates the
  // real number, so this direction only ever produces false negatives.
  const added = addedLines(file);
  return added.length > 0 ? added.map((line) => line.content).join('\n') : null;
}

const LONG_FUNCTION_LINES = 80;
const TOO_MANY_PARAMETERS = 6;
const DEEP_NESTING = 4;

export const complexityAnalyzer: Analyzer = {
  id: 'complexity',
  description: 'Flags functions that have grown difficult to test or reason about',
  categories: ['maintainability', 'readability'],

  analyze(context: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    const threshold = context.config.qualityGates.maxFunctionComplexity;

    for (const file of context.files) {
      if (!isJsLike(file) && !['python', 'go', 'ruby', 'java'].includes(file.language)) continue;

      const source = reconstructFile(file, context.fileContents);
      if (!source) continue;

      const changedLines = new Set(
        addedLines(file)
          .map((line) => line.newLine)
          .filter((line): line is number => line !== undefined),
      );
      const hasFullSource = context.fileContents?.has(file.path) ?? false;

      for (const block of extractFunctions(source, file.language)) {
        // With full source available, only report functions the PR touched.
        if (hasFullSource) {
          const touched = [...changedLines].some(
            (line) => line >= block.startLine && line <= block.endLine,
          );
          if (!touched) continue;
        }

        const location = { path: file.path, line: hasFullSource ? block.startLine : undefined };

        if (block.complexity > threshold) {
          findings.push(
            createFinding({
              rule: 'maintainability/cyclomatic-complexity',
              category: 'maintainability',
              severity: block.complexity > threshold * 1.8 ? 'high' : 'medium',
              title: `\`${block.name}\` has a cyclomatic complexity of ${block.complexity}`,
              description: [
                `\`${block.name}\` contains roughly ${block.complexity} independent paths (threshold: ${threshold}).`,
                '',
                'Each path is a separate case a test has to cover, and a separate way the function can behave unexpectedly.',
                '',
                '**What usually helps:** extract the branches of the largest conditional into named functions, replace flag parameters with distinct functions, or convert a long if/else chain into a lookup table.',
              ].join('\n'),
              location,
              confidence: 0.75,
              references: ['https://en.wikipedia.org/wiki/Cyclomatic_complexity'],
            }),
          );
        }

        if (block.lineCount > LONG_FUNCTION_LINES) {
          findings.push(
            createFinding({
              rule: 'maintainability/long-function',
              category: 'maintainability',
              severity: block.lineCount > LONG_FUNCTION_LINES * 2 ? 'medium' : 'low',
              title: `\`${block.name}\` is ${block.lineCount} lines long`,
              description: `Functions longer than ~${LONG_FUNCTION_LINES} lines are hard to hold in your head and usually do more than one thing. Look for a natural seam — often the boundary between gathering data and acting on it — and extract it.`,
              location,
              confidence: 0.7,
            }),
          );
        }

        if (block.parameters > TOO_MANY_PARAMETERS) {
          findings.push(
            createFinding({
              rule: 'readability/too-many-parameters',
              category: 'readability',
              severity: 'low',
              title: `\`${block.name}\` takes ${block.parameters} parameters`,
              description: `Long parameter lists are easy to call incorrectly, especially when several share a type. Group related parameters into a single options object so call sites become self-documenting.`,
              location,
              confidence: 0.8,
            }),
          );
        }

        if (block.maxNesting > DEEP_NESTING) {
          findings.push(
            createFinding({
              rule: 'readability/deep-nesting',
              category: 'readability',
              severity: 'low',
              title: `\`${block.name}\` nests ${block.maxNesting} levels deep`,
              description:
                'Deep nesting makes control flow hard to follow. Guard clauses and early returns usually flatten this considerably.',
              location,
              confidence: 0.75,
            }),
          );
        }
      }
    }

    return findings;
  },
};
