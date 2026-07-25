import { createHash } from 'node:crypto';
import type { Finding } from '@/core/types';
import { addedLines } from '@/features/github/diff';
import { type AnalysisContext, type Analyzer, createFinding, isCommentLine } from '../types';

/**
 * Duplicate code detection.
 *
 * Uses normalised rolling-window hashing: each window of consecutive
 * significant lines is normalised (identifiers and literals collapsed) and
 * hashed, and identical hashes indicate structurally identical code even when
 * variable names differ. That catches copy-paste-and-rename, which exact
 * matching misses and which is the form duplication usually takes.
 */

const WINDOW_SIZE = 6;
const MIN_LINE_LENGTH = 12;

/**
 * Collapses names and values so `const userTotal = a + 1` and
 * `const orderSum = b + 2` hash identically. Keeps structure — keywords,
 * operators, punctuation — which is what makes two blocks "the same code".
 */
export function normalizeLine(line: string): string {
  return (
    line
      .trim()
      .replace(/["'`](?:[^"'`\\]|\\.)*["'`]/g, 'S')
      .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
      // Preserve control-flow keywords; collapse everything else to a token.
      .replace(
        /\b(?!if|else|for|while|return|const|let|var|function|class|await|async|try|catch|throw|new|switch|case|break|continue|import|export|from|def|end|do|then|elif|type|interface)[A-Za-z_$][\w$]*\b/g,
        'I',
      )
      .replace(/\s+/g, ' ')
  );
}

interface Window {
  readonly hash: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sample: string;
}

function significantLines(
  content: Array<{ text: string; line: number }>,
): Array<{ text: string; line: number }> {
  return content.filter(
    (entry) =>
      entry.text.trim().length >= MIN_LINE_LENGTH &&
      !isCommentLine(entry.text) &&
      // Import blocks and closing braces are legitimately repetitive.
      !/^\s*(?:import|from|use|require|package|#include)\b/.test(entry.text) &&
      !/^\s*[)}\]};,]+\s*$/.test(entry.text),
  );
}

export const duplicationAnalyzer: Analyzer = {
  id: 'duplication',
  description: 'Finds copy-pasted blocks within and across changed files',
  categories: ['maintainability'],

  analyze(context: AnalysisContext): Finding[] {
    const windows = new Map<string, Window[]>();

    for (const file of context.files) {
      if (/\.(test|spec)\.|\.(json|md|yaml|yml|lock)$/i.test(file.path)) continue;

      const lines = significantLines(
        addedLines(file).map((line) => ({ text: line.content, line: line.newLine ?? 0 })),
      );

      for (let index = 0; index + WINDOW_SIZE <= lines.length; index += 1) {
        const slice = lines.slice(index, index + WINDOW_SIZE);
        const normalised = slice.map((entry) => normalizeLine(entry.text)).join('\n');

        // A window that collapses to almost nothing carries no signal.
        if (normalised.replace(/[IN S]/g, '').length < 12) continue;

        const hash = createHash('sha1').update(normalised).digest('hex');
        const first = slice[0];
        const last = slice[slice.length - 1];
        if (!first || !last) continue;

        const bucket = windows.get(hash) ?? [];
        bucket.push({
          hash,
          path: file.path,
          startLine: first.line,
          endLine: last.line,
          sample: slice
            .slice(0, 4)
            .map((entry) => entry.text.trim())
            .join('\n'),
        });
        windows.set(hash, bucket);
      }
    }

    const findings: Finding[] = [];
    const reported = new Set<string>();

    for (const group of windows.values()) {
      if (group.length < 2) continue;

      // Overlapping windows within one file describe the same duplication.
      const distinct = group.filter((window, index) => {
        const previous = group[index - 1];
        return (
          !previous ||
          previous.path !== window.path ||
          window.startLine - previous.startLine > WINDOW_SIZE
        );
      });

      if (distinct.length < 2) continue;

      const primary = distinct[0];
      if (!primary) continue;

      // Windows starting one line apart cover the same duplicated region but
      // hash differently, so they land in separate groups. Suppress anything
      // overlapping an already-reported region rather than emitting the same
      // block once per starting offset.
      const overlapsReported = [...reported].some((entry) => {
        const separator = entry.lastIndexOf(':');
        return (
          entry.slice(0, separator) === primary.path &&
          Math.abs(Number(entry.slice(separator + 1)) - primary.startLine) < WINDOW_SIZE * 2
        );
      });
      if (overlapsReported) continue;
      reported.add(`${primary.path}:${primary.startLine}`);

      const locations = distinct
        .slice(0, 6)
        .map((window) => `- \`${window.path}:${window.startLine}–${window.endLine}\``);

      const crossFile = new Set(distinct.map((window) => window.path)).size > 1;

      findings.push(
        createFinding({
          rule: 'maintainability/duplicate-code',
          category: 'maintainability',
          severity: distinct.length >= 4 ? 'medium' : 'low',
          title: `Duplicated block repeated ${distinct.length} times`,
          description: [
            `A structurally identical block of ${WINDOW_SIZE}+ lines appears ${distinct.length} times${
              crossFile ? ' across multiple files' : ' within the same file'
            }.`,
            '',
            '**Locations:**',
            ...locations,
            '',
            '**Sample:**',
            '```',
            primary.sample,
            '```',
            '',
            'Duplication is only worth removing when the copies must change together. If they represent the same rule, extract it; if they merely look alike today, leaving them separate is the better call.',
          ].join('\n'),
          location: { path: primary.path, line: primary.startLine },
          confidence: 0.65,
        }),
      );
    }

    return findings.slice(0, 10);
  },
};
