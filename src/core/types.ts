/**
 * Shared domain vocabulary.
 *
 * Every analyzer — code quality, security, docs, performance — emits the same
 * {@link Finding} shape. That single decision is what lets the rest of the
 * platform (quality gates, health scoring, GitHub comment rendering, the REST
 * API, the dashboard) treat all analysis output uniformly instead of
 * special-casing each engine.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Ordering weight, highest severity first. Used for sorting and gating. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export const REVIEW_CATEGORIES = [
  'correctness',
  'security',
  'performance',
  'maintainability',
  'readability',
  'architecture',
  'error-handling',
  'edge-cases',
  'testing',
  'documentation',
  'best-practices',
  'dependencies',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

/** Where a finding came from. Lets the UI badge AI output distinctly. */
export type FindingSource = 'static' | 'ai' | 'hybrid';

export interface CodeLocation {
  readonly path: string;
  /** 1-indexed line in the head revision of the file. */
  readonly line?: number;
  readonly endLine?: number;
  /** Position within the PR diff, required for GitHub inline comments. */
  readonly diffPosition?: number;
}

export interface SuggestedFix {
  /** Short imperative description, e.g. "Await the promise". */
  readonly description: string;
  /** Replacement source for the referenced lines, rendered as a suggestion block. */
  readonly replacement?: string;
}

export interface Finding {
  readonly id: string;
  /** Stable rule identifier, e.g. `security/hardcoded-secret`. */
  readonly rule: string;
  readonly category: ReviewCategory;
  readonly severity: Severity;
  readonly title: string;
  /** Markdown body explaining the problem and why it matters. */
  readonly description: string;
  readonly location?: CodeLocation;
  readonly suggestion?: SuggestedFix;
  readonly source: FindingSource;
  /**
   * Analyzer's self-assessed confidence in `[0, 1]`. Low-confidence findings
   * are reported but never allowed to fail a quality gate.
   */
  readonly confidence: number;
  /** Reference links: CWE entries, docs, style guides. */
  readonly references?: readonly string[];
}

/** Recognition of something done well. Reviews that only criticise get ignored. */
export interface Commendation {
  readonly title: string;
  readonly description: string;
  readonly location?: CodeLocation;
}

export interface AnalysisMetrics {
  readonly filesAnalyzed: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Sum of cyclomatic complexity across changed functions, when computable. */
  readonly complexityDelta?: number;
  readonly testFilesChanged: number;
  readonly docFilesChanged: number;
  readonly durationMs: number;
}

export type Verdict = 'approve' | 'comment' | 'request-changes';

export interface ReviewSummary {
  readonly verdict: Verdict;
  /** 0–100 overall assessment of the change. */
  readonly score: number;
  /** Two to four sentences a reviewer can read in ten seconds. */
  readonly headline: string;
  readonly highlights: readonly string[];
  readonly concerns: readonly string[];
}

export interface ReviewResult {
  readonly id: string;
  readonly repository: RepositoryRef;
  readonly pullRequest: PullRequestRef;
  readonly summary: ReviewSummary;
  readonly findings: readonly Finding[];
  readonly commendations: readonly Commendation[];
  readonly metrics: AnalysisMetrics;
  readonly gates: readonly GateResult[];
  /** Which engine produced this: deterministic only, or AI-enriched. */
  readonly engine: FindingSource;
  readonly createdAt: string;
}

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly defaultBranch?: string;
}

export interface PullRequestRef {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly draft?: boolean;
  readonly url?: string;
  readonly body?: string;
}

export type GateStatus = 'passed' | 'warning' | 'failed' | 'skipped';

export interface GateResult {
  readonly id: string;
  readonly name: string;
  readonly status: GateStatus;
  readonly message: string;
  /** Whether a failure of this gate should block the merge. */
  readonly blocking: boolean;
  readonly observed?: number;
  readonly threshold?: number;
}

export interface HealthDimension {
  readonly id: string;
  readonly label: string;
  /** 0–100. */
  readonly score: number;
  /** Relative contribution to the overall score; weights sum to 1. */
  readonly weight: number;
  readonly detail: string;
  readonly signals: readonly string[];
}

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthReport {
  readonly repository: RepositoryRef;
  readonly score: number;
  readonly grade: HealthGrade;
  readonly dimensions: readonly HealthDimension[];
  readonly recommendations: readonly string[];
  readonly computedAt: string;
}

export function severityAtLeast(severity: Severity, floor: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function scoreToGrade(score: number): HealthGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
