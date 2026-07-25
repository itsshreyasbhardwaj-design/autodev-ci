import { settleWithConcurrency } from '@/core/async';
import { generateId } from '@/core/crypto';
import { logger } from '@/core/logger';
import {
  type AnalysisMetrics,
  type Finding,
  type ReviewResult,
  SEVERITY_RANK,
  type Verdict,
  compareSeverity,
} from '@/core/types';
import { isIgnored } from '@/features/config';
import {
  analyzableFiles,
  isDocFile,
  isTestFile,
  totalAdditions,
  totalDeletions,
} from '@/features/github/diff';
import { getNarrator } from '@/features/ai';
import type { Narrator } from '@/features/ai/narrator';
import { computeScore, evaluateGates, gatesBlocked } from '@/features/quality-gates';
import { complexityAnalyzer } from './analyzers/complexity';
import { dependenciesAnalyzer } from './analyzers/dependencies';
import { duplicationAnalyzer } from './analyzers/duplication';
import { errorHandlingAnalyzer } from './analyzers/error-handling';
import { maintainabilityAnalyzer } from './analyzers/maintainability';
import { performanceAnalyzer } from './analyzers/performance';
import { promptInjectionAnalyzer } from './analyzers/prompt-injection';
import { secretsAnalyzer } from './analyzers/secrets';
import { securityAnalyzer } from './analyzers/security';
import { testingAnalyzer } from './analyzers/testing';
import type { AnalysisContext, Analyzer } from './types';

export * from './types';
export { detectDocumentationDrift } from './docs-drift';

/** Every analyzer, in the order their findings are reported. */
export const ANALYZERS: readonly Analyzer[] = [
  secretsAnalyzer,
  securityAnalyzer,
  promptInjectionAnalyzer,
  errorHandlingAnalyzer,
  performanceAnalyzer,
  complexityAnalyzer,
  duplicationAnalyzer,
  dependenciesAnalyzer,
  testingAnalyzer,
  maintainabilityAnalyzer,
];

export interface RunAnalysisOptions {
  readonly context: AnalysisContext;
  /** Defaults to the configured narrator. Injected in tests. */
  readonly narrator?: Narrator;
  readonly analyzers?: readonly Analyzer[];
}

/**
 * Runs every applicable analyzer and returns the raw findings.
 *
 * Analyzers run concurrently and are individually fault-isolated: one throwing
 * degrades the review by exactly one analyzer instead of losing the whole run.
 * That property is why a regex bug in a new rule cannot take CI down.
 */
export async function runAnalyzers(
  context: AnalysisContext,
  analyzers: readonly Analyzer[] = ANALYZERS,
): Promise<{ findings: Finding[]; failures: Array<{ analyzer: string; error: Error }> }> {
  const enabledCategories = new Set(context.config.review.categories);
  const applicable = analyzers.filter((analyzer) =>
    analyzer.categories.some((category) => enabledCategories.has(category)),
  );

  const outcomes = await settleWithConcurrency(applicable, 4, async (analyzer) =>
    analyzer.analyze(context),
  );

  const findings: Finding[] = [];
  const failures: Array<{ analyzer: string; error: Error }> = [];

  for (const outcome of outcomes) {
    if (outcome.ok) {
      findings.push(...outcome.value);
    } else {
      failures.push({ analyzer: outcome.item.id, error: outcome.error });
      logger().error('Analyzer failed', { analyzer: outcome.item.id, error: outcome.error });
    }
  }

  return { findings, failures };
}

/**
 * Applies repository configuration to a raw finding list: drops disabled
 * rules, ignored paths, and anything below the configured severity floor,
 * then sorts by severity so the most important item is always first.
 */
export function filterFindings(findings: readonly Finding[], context: AnalysisContext): Finding[] {
  const { review } = context.config;
  const enabledCategories = new Set(review.categories);
  const minRank = SEVERITY_RANK[review.minSeverity];
  const disabled = new Set(review.disabledRules);

  return findings
    .filter((finding) => {
      if (!enabledCategories.has(finding.category)) return false;
      if (SEVERITY_RANK[finding.severity] < minRank) return false;
      // A disabled entry matches either the exact rule or its namespace,
      // so `disabledRules: ["security"]` silences the whole family.
      if (disabled.has(finding.rule)) return false;
      if (
        [...disabled].some(
          (prefix) =>
            finding.rule.startsWith(`${prefix}/`) || finding.rule.startsWith(`${prefix}.`),
        )
      ) {
        return false;
      }
      if (finding.location && isIgnored(finding.location.path, review.ignore)) return false;
      return true;
    })
    .sort((a, b) => {
      const bySeverity = compareSeverity(a.severity, b.severity);
      if (bySeverity !== 0) return bySeverity;
      // Then by confidence, so the most certain findings lead within a tier.
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (a.location?.path ?? '').localeCompare(b.location?.path ?? '');
    });
}

/** Decides the review verdict from the gates and the findings. */
export function determineVerdict(
  findings: readonly Finding[],
  gates: ReturnType<typeof evaluateGates>,
  requestChangesOnFailure: boolean,
): Verdict {
  if (gatesBlocked(gates)) {
    return requestChangesOnFailure ? 'request-changes' : 'comment';
  }
  if (findings.length === 0) return 'approve';
  // Anything medium or above is worth a human deciding, so we comment rather
  // than approve; below that the change is fine as-is.
  return findings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.medium)
    ? 'comment'
    : 'approve';
}

/**
 * Runs a full pull-request review: analyzers, gates, scoring and narration.
 *
 * This is the single entry point used by the webhook handler, the REST API and
 * the CLI, so all three produce byte-identical results for the same input.
 */
export async function reviewPullRequest(options: RunAnalysisOptions): Promise<ReviewResult> {
  const startedAt = performance.now();
  const { context } = options;

  const log = logger().child({
    repository: context.repository.fullName,
    pullNumber: context.pullRequest.number,
  });

  const { findings: raw, failures } = await runAnalyzers(context, options.analyzers);
  const findings = filterFindings(raw, context);

  const gates = evaluateGates({
    findings,
    files: context.allFiles,
    config: context.config.qualityGates,
    blockingConfidence: context.config.review.blockingConfidence,
  });

  const score = computeScore(findings, gates, context.allFiles);
  const verdict = determineVerdict(findings, gates, context.config.review.requestChangesOnFailure);

  const narrator = options.narrator ?? getNarrator();
  const narration = await narrator.narrate({
    repository: context.repository,
    pullRequest: context.pullRequest,
    files: context.files,
    staticFindings: findings,
    score,
    verdict,
  });

  // AI findings are appended after filtering so they can never be the reason a
  // gate failed — the gates were already evaluated above.
  const allFindings = [...findings, ...filterFindings(narration.findings, context)].sort((a, b) =>
    compareSeverity(a.severity, b.severity),
  );

  const durationMs = Math.round(performance.now() - startedAt);

  const metrics: AnalysisMetrics = {
    filesAnalyzed: context.files.length,
    linesAdded: totalAdditions(context.allFiles),
    linesRemoved: totalDeletions(context.allFiles),
    testFilesChanged: context.allFiles.filter((file) => isTestFile(file.path)).length,
    docFilesChanged: context.allFiles.filter((file) => isDocFile(file.path)).length,
    durationMs,
  };

  if (failures.length > 0) {
    log.warn('Some analyzers failed; review is partial', {
      failed: failures.map((failure) => failure.analyzer),
    });
  }

  log.info('Review complete', {
    findings: allFindings.length,
    score,
    verdict,
    engine: narration.engine,
    durationMs,
  });

  return {
    id: generateId(),
    repository: context.repository,
    pullRequest: context.pullRequest,
    summary: narration.summary,
    findings: allFindings,
    commendations: context.config.review.commendations ? narration.commendations : [],
    metrics,
    gates,
    engine: narration.engine,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Builds an {@link AnalysisContext} from a loaded pull request, applying the
 * repository's ignore rules before any analyzer sees the files.
 */
export function buildContext(
  input: Omit<AnalysisContext, 'files'> & { files?: readonly AnalysisContext['files'][number][] },
): AnalysisContext {
  const candidates = analyzableFiles(input.allFiles);
  const files = candidates.filter((file) => !isIgnored(file.path, input.config.review.ignore));

  return {
    repository: input.repository,
    pullRequest: input.pullRequest,
    allFiles: input.allFiles,
    files,
    config: input.config,
    ...(input.fileContents ? { fileContents: input.fileContents } : {}),
  };
}
