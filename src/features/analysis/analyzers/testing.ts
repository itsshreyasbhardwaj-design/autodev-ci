import type { Finding } from '@/core/types';
import { addedLines, isTestFile } from '@/features/github/diff';
import { type AnalysisContext, type Analyzer, createFinding, lineLocation } from '../types';

/**
 * Test coverage analysis.
 *
 * Real coverage numbers require running the suite, which a review bot cannot
 * do safely on untrusted code. What it *can* do is spot the structural signals
 * that correlate with missing tests: source changed with no test changed, a
 * new exported function with no test referencing it, and disabled tests
 * sneaking in.
 */

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|rs|php|cs|swift|scala)$/;

const EXPORT_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([a-z_][\w]*)\s*\(/,
  /^\s*func\s+([A-Z][\w]*)\s*\(/,
  /^\s*public\s+(?:static\s+)?[\w<>[\]]+\s+([a-z][\w]*)\s*\(/,
];

const SKIPPED_TEST =
  /\b(?:describe|it|test|context)\.(?:skip|todo)\s*\(|\bx(?:describe|it|test)\s*\(|@(?:Ignore|Disabled)\b|@pytest\.mark\.skip/;
const FOCUSED_TEST = /\b(?:describe|it|test)\.only\s*\(|\bf(?:describe|it|test)\s*\(/;
const ASSERTIONLESS =
  /\b(?:it|test)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/;

export const testingAnalyzer: Analyzer = {
  id: 'testing',
  description: 'Assesses whether changes are accompanied by tests',
  categories: ['testing'],

  analyze(context: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    const testFiles = context.allFiles.filter((file) => isTestFile(file.path));
    const sourceFiles = context.files.filter(
      (file) => !isTestFile(file.path) && SOURCE_EXTENSIONS.test(file.path),
    );

    // --- Disabled and focused tests -------------------------------------

    for (const file of testFiles) {
      for (const line of addedLines(file)) {
        if (FOCUSED_TEST.test(line.content)) {
          findings.push(
            createFinding({
              rule: 'testing/focused-test',
              category: 'testing',
              severity: 'high',
              title: 'Focused test would silently skip the rest of the suite',
              description:
                '`.only` / `fit` restricts the run to this test. Merged to the main branch it means CI is green while almost nothing is actually executed.',
              location: lineLocation(file, line),
              suggestion: { description: 'Remove `.only` before merging.' },
              confidence: 0.95,
            }),
          );
        }

        if (SKIPPED_TEST.test(line.content)) {
          findings.push(
            createFinding({
              rule: 'testing/skipped-test',
              category: 'testing',
              severity: 'low',
              title: 'Test is disabled',
              description:
                'A skipped test provides no protection but still looks like coverage in the file. If it is temporary, link the issue that will re-enable it; otherwise delete it.',
              location: lineLocation(file, line),
              confidence: 0.9,
            }),
          );
        }

        if (ASSERTIONLESS.test(line.content)) {
          findings.push(
            createFinding({
              rule: 'testing/empty-test',
              category: 'testing',
              severity: 'medium',
              title: 'Test body is empty',
              description:
                'A test with no assertions always passes. It adds a green tick without verifying anything.',
              location: lineLocation(file, line),
              confidence: 0.85,
            }),
          );
        }
      }
    }

    if (sourceFiles.length === 0) return findings;

    // --- Source changed with no accompanying test ------------------------

    const changedLines = sourceFiles.reduce(
      (sum, file) => sum + file.additions + file.deletions,
      0,
    );

    if (testFiles.length === 0 && changedLines >= 30) {
      findings.push(
        createFinding({
          rule: 'testing/no-tests-changed',
          category: 'testing',
          severity: changedLines >= 200 ? 'medium' : 'low',
          title: `${changedLines} lines of source changed with no test changes`,
          description: [
            `This pull request modifies ${sourceFiles.length} source file(s) (${changedLines} lines) without touching any test.`,
            '',
            'That is fine for refactors covered by existing tests, and a gap for new behaviour. Worth a sentence in the PR description either way, so a reviewer does not have to guess which it is.',
            '',
            'Files changed without test coverage:',
            ...sourceFiles.slice(0, 10).map((file) => `- \`${file.path}\``),
          ].join('\n'),
          confidence: 0.7,
        }),
      );
    }

    // --- New exported API with no test mentioning it ---------------------

    if (testFiles.length > 0) {
      const testContent = testFiles
        .flatMap((file) => addedLines(file).map((line) => line.content))
        .join('\n');

      const untested: Array<{ name: string; path: string }> = [];

      for (const file of sourceFiles) {
        for (const line of addedLines(file)) {
          for (const pattern of EXPORT_PATTERNS) {
            const match = pattern.exec(line.content);
            const name = match?.[1];
            if (!name || name.length < 3) continue;
            // A test that references the identifier at all is treated as
            // covering it. Verifying more than that requires executing code.
            if (!testContent.includes(name)) untested.push({ name, path: file.path });
          }
        }
      }

      if (untested.length > 0) {
        const unique = [...new Map(untested.map((item) => [item.name, item])).values()].slice(
          0,
          12,
        );
        findings.push(
          createFinding({
            rule: 'testing/untested-exports',
            category: 'testing',
            severity: 'low',
            title: `${unique.length} new export(s) are not referenced by any test`,
            description: [
              'These identifiers were added to the public surface of their module but do not appear in any changed test file:',
              '',
              ...unique.map((item) => `- \`${item.name}\` in \`${item.path}\``),
              '',
              'Public API is the part most expensive to change later, so it benefits most from having its contract pinned by a test.',
            ].join('\n'),
            confidence: 0.55,
          }),
        );
      }
    }

    return findings;
  },
};
