import {
  type Finding,
  type GateResult,
  type GateStatus,
  SEVERITY_RANK,
  type Severity,
  countBySeverity,
} from '@/core/types';
import type { QualityGatesConfig } from '@/features/config';
import { type FileDiff, isDocFile, isTestFile } from '@/features/github/diff';

/**
 * Quality gates.
 *
 * A gate turns findings and metrics into a merge decision. Two rules govern
 * the design:
 *
 * 1. **Only high-confidence, deterministic findings can block.** An AI-sourced
 *    or low-confidence finding is reported, never enforced. A gate a team
 *    cannot trust is a gate they disable.
 * 2. **Every failure states the number and the threshold.** "Too complex" is
 *    an argument; "complexity 22, threshold 15" is a fact someone can act on.
 */

export interface GateInput {
  readonly findings: readonly Finding[];
  readonly files: readonly FileDiff[];
  readonly config: QualityGatesConfig;
  /** Minimum confidence for a finding to be allowed to block. */
  readonly blockingConfidence: number;
}

function gate(
  id: string,
  name: string,
  status: GateStatus,
  message: string,
  extra: { blocking?: boolean; observed?: number; threshold?: number } = {},
): GateResult {
  return {
    id,
    name,
    status,
    message,
    blocking: extra.blocking ?? true,
    ...(extra.observed !== undefined ? { observed: extra.observed } : {}),
    ...(extra.threshold !== undefined ? { threshold: extra.threshold } : {}),
  };
}

/** Findings trustworthy enough to fail a build. */
export function blockingFindings(
  findings: readonly Finding[],
  minConfidence: number,
): readonly Finding[] {
  return findings.filter(
    (finding) => finding.source === 'static' && finding.confidence >= minConfidence,
  );
}

export function evaluateGates(input: GateInput): GateResult[] {
  const { config, files, blockingConfidence } = input;

  if (!config.enabled) {
    return [
      gate('gates', 'Quality gates', 'skipped', 'Quality gates are disabled for this repository.', {
        blocking: false,
      }),
    ];
  }

  const results: GateResult[] = [];
  const enforceable = blockingFindings(input.findings, blockingConfidence);
  const counts = countBySeverity(enforceable);

  // --- Severity gate ------------------------------------------------------

  const failRank = SEVERITY_RANK[config.failOnSeverity];
  const warnRank = SEVERITY_RANK[config.warnOnSeverity];

  const failing = enforceable.filter((f) => SEVERITY_RANK[f.severity] >= failRank);
  const warning = enforceable.filter(
    (f) => SEVERITY_RANK[f.severity] >= warnRank && SEVERITY_RANK[f.severity] < failRank,
  );

  if (failing.length > 0) {
    results.push(
      gate(
        'severity',
        'Finding severity',
        'failed',
        `${failing.length} finding(s) at or above "${config.failOnSeverity}" severity must be resolved.`,
        { observed: failing.length, threshold: 0 },
      ),
    );
  } else if (warning.length > 0) {
    results.push(
      gate(
        'severity',
        'Finding severity',
        'warning',
        `${warning.length} finding(s) at "${config.warnOnSeverity}" severity — review before merging.`,
        { blocking: false, observed: warning.length, threshold: 0 },
      ),
    );
  } else {
    results.push(
      gate('severity', 'Finding severity', 'passed', 'No blocking findings.', {
        observed: 0,
        threshold: 0,
      }),
    );
  }

  // --- Security gate ------------------------------------------------------

  const securityFindings = enforceable.filter(
    (f) => f.category === 'security' && (f.severity === 'critical' || f.severity === 'high'),
  );

  results.push(
    securityFindings.length > 0
      ? gate(
          'security',
          'Security scan',
          'failed',
          `${securityFindings.length} security issue(s) detected, including ${counts.critical} critical.`,
          { observed: securityFindings.length, threshold: 0 },
        )
      : gate('security', 'Security scan', 'passed', 'No high-severity security issues.', {
          observed: 0,
          threshold: 0,
        }),
  );

  // --- Change size --------------------------------------------------------

  const sourceFiles = files.filter((file) => !isTestFile(file.path) && !isDocFile(file.path));
  const changedFiles = files.length;

  results.push(
    changedFiles > config.maxChangedFiles
      ? gate(
          'change-size',
          'Change size',
          'warning',
          `${changedFiles} files changed (soft limit ${config.maxChangedFiles}). Large changes receive less careful review.`,
          { blocking: false, observed: changedFiles, threshold: config.maxChangedFiles },
        )
      : gate('change-size', 'Change size', 'passed', `${changedFiles} file(s) changed.`, {
          blocking: false,
          observed: changedFiles,
          threshold: config.maxChangedFiles,
        }),
  );

  // --- Test coverage ------------------------------------------------------

  const testFiles = files.filter((file) => isTestFile(file.path));
  const sourceLines = sourceFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);

  if (config.requireTests && sourceLines > 0 && testFiles.length === 0) {
    results.push(
      gate(
        'tests',
        'Test coverage',
        'failed',
        `${sourceLines} lines of source changed with no test changes, and tests are required for this repository.`,
        { observed: 0, threshold: 1 },
      ),
    );
  } else if (testFiles.length === 0 && sourceLines > config.maxUntestedLines) {
    results.push(
      gate(
        'tests',
        'Test coverage',
        'warning',
        `${sourceLines} lines changed without tests (threshold ${config.maxUntestedLines}).`,
        { blocking: false, observed: sourceLines, threshold: config.maxUntestedLines },
      ),
    );
  } else {
    results.push(
      gate(
        'tests',
        'Test coverage',
        'passed',
        testFiles.length > 0
          ? `${testFiles.length} test file(s) changed alongside the code.`
          : 'Change is below the untested-lines threshold.',
        { blocking: false, observed: testFiles.length, threshold: 1 },
      ),
    );
  }

  // --- Documentation ------------------------------------------------------

  const docFiles = files.filter((file) => isDocFile(file.path));
  const docFindings = input.findings.filter((f) => f.category === 'documentation');

  if (config.requireDocs && docFindings.length > 0 && docFiles.length === 0) {
    results.push(
      gate(
        'docs',
        'Documentation',
        'failed',
        `${docFindings.length} documentation drift signal(s) detected and no documentation was updated.`,
        { observed: docFiles.length, threshold: 1 },
      ),
    );
  } else if (docFindings.length > 0 && docFiles.length === 0) {
    results.push(
      gate(
        'docs',
        'Documentation',
        'warning',
        `${docFindings.length} documentation drift signal(s) — docs may be out of date.`,
        { blocking: false, observed: docFiles.length, threshold: 1 },
      ),
    );
  } else {
    results.push(
      gate('docs', 'Documentation', 'passed', 'No documentation drift detected.', {
        blocking: false,
        observed: docFiles.length,
        threshold: 0,
      }),
    );
  }

  // --- Duplication --------------------------------------------------------

  const duplicates = input.findings.filter((f) => f.rule === 'maintainability/duplicate-code');

  results.push(
    duplicates.length > config.maxDuplicateBlocks
      ? gate(
          'duplication',
          'Code duplication',
          'warning',
          `${duplicates.length} duplicated block(s) introduced (threshold ${config.maxDuplicateBlocks}).`,
          { blocking: false, observed: duplicates.length, threshold: config.maxDuplicateBlocks },
        )
      : gate(
          'duplication',
          'Code duplication',
          'passed',
          `${duplicates.length} duplicated block(s).`,
          {
            blocking: false,
            observed: duplicates.length,
            threshold: config.maxDuplicateBlocks,
          },
        ),
  );

  // --- Complexity ---------------------------------------------------------

  const complexityFindings = enforceable.filter(
    (f) => f.rule === 'maintainability/cyclomatic-complexity',
  );

  results.push(
    complexityFindings.length > 0
      ? gate(
          'complexity',
          'Complexity',
          complexityFindings.some((f) => f.severity === 'high') ? 'warning' : 'passed',
          `${complexityFindings.length} function(s) exceed complexity ${config.maxFunctionComplexity}.`,
          {
            blocking: false,
            observed: complexityFindings.length,
            threshold: config.maxFunctionComplexity,
          },
        )
      : gate(
          'complexity',
          'Complexity',
          'passed',
          'All changed functions are within the complexity budget.',
          {
            blocking: false,
            observed: 0,
            threshold: config.maxFunctionComplexity,
          },
        ),
  );

  return results;
}

/** True when any blocking gate failed. */
export function gatesBlocked(gates: readonly GateResult[]): boolean {
  return gates.some((result) => result.status === 'failed' && result.blocking);
}

export function gateSummary(gates: readonly GateResult[]): {
  passed: number;
  warnings: number;
  failed: number;
  blocked: boolean;
} {
  return {
    passed: gates.filter((g) => g.status === 'passed').length,
    warnings: gates.filter((g) => g.status === 'warning').length,
    failed: gates.filter((g) => g.status === 'failed').length,
    blocked: gatesBlocked(gates),
  };
}

/**
 * Computes a 0–100 quality score for the change.
 *
 * Starts at 100 and subtracts weighted penalties. Deliberately not a curve or
 * a ratio: a single critical security finding should sink the score of a
 * 2,000-line PR just as hard as a 20-line one, because it is equally serious
 * in both.
 */
export function computeScore(
  findings: readonly Finding[],
  gates: readonly GateResult[],
  files: readonly FileDiff[],
): number {
  const penalty: Record<Severity, number> = {
    critical: 25,
    high: 12,
    medium: 5,
    low: 1.5,
    info: 0.25,
  };

  let score = 100;

  for (const finding of findings) {
    // Confidence scales the penalty: an uncertain finding costs less.
    score -= penalty[finding.severity] * Math.max(0.3, finding.confidence);
  }

  for (const result of gates) {
    if (result.status === 'failed' && result.blocking) score -= 10;
    else if (result.status === 'warning') score -= 3;
  }

  // Small credit for shipping tests with the change.
  if (files.some((file) => isTestFile(file.path))) score += 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}
