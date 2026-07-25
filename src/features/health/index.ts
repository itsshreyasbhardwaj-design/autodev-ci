import {
  type Finding,
  type HealthDimension,
  type HealthReport,
  type RepositoryRef,
  scoreToGrade,
} from '@/core/types';

/**
 * Repository health scoring.
 *
 * Seven weighted dimensions produce a 0–100 score. The weights encode a
 * position: security and testing matter most because their absence causes
 * incidents, while dependency freshness matters least because a slightly old
 * dependency is usually fine. Every dimension reports the signals it used, so
 * a score is always explainable rather than a black-box number a team learns
 * to ignore.
 */

export interface HealthInput {
  readonly repository: RepositoryRef;
  /** Paths present at the repository root. */
  readonly rootEntries: readonly string[];
  /** All tracked file paths, when available. Improves testing and docs signals. */
  readonly allPaths?: readonly string[];
  /** Findings from recent reviews, used for the security and quality scores. */
  readonly recentFindings?: readonly Finding[];
  /** Fraction of recent CI runs that succeeded, 0–1. */
  readonly ciSuccessRate?: number;
  /** Number of dependencies more than one major version behind. */
  readonly outdatedDependencies?: number;
  readonly totalDependencies?: number;
  /** Days since the most recent commit. */
  readonly daysSinceLastCommit?: number;
  readonly hasLicense?: boolean;
  readonly openIssues?: number;
}

interface DimensionSpec {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly evaluate: (input: HealthInput) => { score: number; detail: string; signals: string[] };
}

function has(entries: readonly string[], ...names: string[]): boolean {
  const lower = entries.map((entry) => entry.toLowerCase());
  return names.some((name) => lower.includes(name.toLowerCase()));
}

function countMatching(paths: readonly string[] | undefined, pattern: RegExp): number {
  return (paths ?? []).filter((path) => pattern.test(path)).length;
}

const DIMENSIONS: readonly DimensionSpec[] = [
  {
    id: 'documentation',
    label: 'Documentation',
    weight: 0.18,
    evaluate: (input) => {
      const signals: string[] = [];
      let score = 0;

      const checks: Array<[boolean, number, string]> = [
        [has(input.rootEntries, 'README.md', 'README.rst', 'README'), 35, 'README present'],
        [has(input.rootEntries, 'CONTRIBUTING.md'), 15, 'Contributing guide present'],
        [
          has(input.rootEntries, 'LICENSE', 'LICENSE.md', 'LICENSE.txt') ||
            Boolean(input.hasLicense),
          15,
          'License present',
        ],
        [has(input.rootEntries, 'CHANGELOG.md'), 12, 'Changelog maintained'],
        [has(input.rootEntries, 'SECURITY.md'), 10, 'Security policy present'],
        [has(input.rootEntries, 'CODE_OF_CONDUCT.md'), 5, 'Code of conduct present'],
        [
          has(input.rootEntries, 'docs') || countMatching(input.allPaths, /^docs\//) > 0,
          8,
          'Dedicated docs directory',
        ],
      ];

      for (const [present, points, label] of checks) {
        if (present) {
          score += points;
          signals.push(label);
        }
      }

      const missing = checks.filter(([present]) => !present).length;

      return {
        score: Math.min(100, score),
        detail:
          missing === 0
            ? 'All standard project documents are present.'
            : `${missing} standard document(s) missing.`,
        signals,
      };
    },
  },
  {
    id: 'testing',
    label: 'Testing',
    weight: 0.22,
    evaluate: (input) => {
      const signals: string[] = [];
      const testFiles = countMatching(
        input.allPaths,
        /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rb)$/,
      );
      const sourceFiles = countMatching(input.allPaths, /\.(?:[cm]?[jt]sx?|py|go|rb|java|rs)$/);

      if (input.allPaths === undefined) {
        return {
          score: 50,
          detail: 'File listing unavailable — testing could not be assessed.',
          signals: [],
        };
      }

      if (testFiles === 0) {
        return { score: 0, detail: 'No test files found in the repository.', signals: [] };
      }

      signals.push(`${testFiles} test file(s)`);

      // Ratio of test files to source files. 1:3 is treated as a healthy floor
      // and 1:1 as excellent; beyond that there are diminishing returns.
      const ratio = sourceFiles === 0 ? 1 : testFiles / sourceFiles;
      const ratioScore = Math.min(100, Math.round((ratio / 0.5) * 80));

      if (ratio >= 0.5) signals.push('Strong test-to-source ratio');
      else if (ratio >= 0.25) signals.push('Moderate test-to-source ratio');

      const hasCiTests = countMatching(input.allPaths, /^\.github\/workflows\//) > 0;
      if (hasCiTests) signals.push('Tests wired into CI');

      return {
        score: Math.min(100, ratioScore + (hasCiTests ? 20 : 0)),
        detail: `${testFiles} test file(s) for ${sourceFiles} source file(s) (ratio ${ratio.toFixed(2)}).`,
        signals,
      };
    },
  },
  {
    id: 'security',
    label: 'Security',
    weight: 0.22,
    evaluate: (input) => {
      const signals: string[] = [];
      let score = 100;

      const findings = input.recentFindings ?? [];
      const security = findings.filter((finding) => finding.category === 'security');

      const critical = security.filter((f) => f.severity === 'critical').length;
      const high = security.filter((f) => f.severity === 'high').length;
      const medium = security.filter((f) => f.severity === 'medium').length;

      score -= critical * 30 + high * 12 + medium * 4;

      if (critical > 0) signals.push(`${critical} critical finding(s)`);
      if (high > 0) signals.push(`${high} high-severity finding(s)`);

      if (has(input.rootEntries, 'SECURITY.md')) {
        score += 5;
        signals.push('Security policy published');
      }
      if (countMatching(input.allPaths, /^\.github\/dependabot\.ya?ml$/) > 0) {
        score += 5;
        signals.push('Automated dependency updates enabled');
      }
      if (countMatching(input.allPaths, /^\.github\/workflows\/.*(?:codeql|security|scan)/i) > 0) {
        score += 5;
        signals.push('Security scanning in CI');
      }

      if (security.length === 0) signals.push('No open security findings');

      return {
        score: Math.max(0, Math.min(100, score)),
        detail:
          security.length === 0
            ? 'No security findings in recent analysis.'
            : `${security.length} security finding(s) across recent reviews.`,
        signals,
      };
    },
  },
  {
    id: 'code-quality',
    label: 'Code quality',
    weight: 0.15,
    evaluate: (input) => {
      const findings = input.recentFindings ?? [];
      const quality = findings.filter((finding) =>
        [
          'maintainability',
          'readability',
          'correctness',
          'error-handling',
          'architecture',
        ].includes(finding.category),
      );

      const signals: string[] = [];
      let score = 100;

      for (const finding of quality) {
        score -=
          finding.severity === 'critical'
            ? 15
            : finding.severity === 'high'
              ? 7
              : finding.severity === 'medium'
                ? 3
                : 1;
      }

      const hasLinter = has(
        input.rootEntries,
        '.eslintrc.json',
        'eslint.config.js',
        'eslint.config.mjs',
        '.ruff.toml',
        '.golangci.yml',
        'biome.json',
      );
      if (hasLinter) {
        score += 8;
        signals.push('Linter configured');
      }

      const hasFormatter = has(
        input.rootEntries,
        '.prettierrc',
        '.prettierrc.json',
        '.editorconfig',
      );
      if (hasFormatter) {
        score += 4;
        signals.push('Formatter configured');
      }

      const hasTypes = has(input.rootEntries, 'tsconfig.json', 'mypy.ini', 'py.typed');
      if (hasTypes) {
        score += 8;
        signals.push('Static typing enabled');
      }

      if (quality.length === 0) signals.push('No outstanding quality findings');

      return {
        score: Math.max(0, Math.min(100, score)),
        detail: `${quality.length} maintainability finding(s) in recent reviews.`,
        signals,
      };
    },
  },
  {
    id: 'ci-stability',
    label: 'CI stability',
    weight: 0.1,
    evaluate: (input) => {
      const signals: string[] = [];
      const workflows = countMatching(input.allPaths, /^\.github\/workflows\/.+\.ya?ml$/);

      if (workflows === 0) {
        return { score: 0, detail: 'No CI workflows configured.', signals: [] };
      }

      signals.push(`${workflows} workflow(s) configured`);

      if (input.ciSuccessRate === undefined) {
        return {
          score: 65,
          detail: `${workflows} workflow(s) configured; run history unavailable.`,
          signals,
        };
      }

      const rate = Math.max(0, Math.min(1, input.ciSuccessRate));
      if (rate >= 0.95) signals.push('CI is consistently green');
      else if (rate < 0.7) signals.push('CI fails frequently');

      return {
        score: Math.round(rate * 100),
        detail: `${Math.round(rate * 100)}% of recent CI runs succeeded.`,
        signals,
      };
    },
  },
  {
    id: 'dependencies',
    label: 'Dependency freshness',
    weight: 0.08,
    evaluate: (input) => {
      const signals: string[] = [];

      if (input.totalDependencies === undefined || input.outdatedDependencies === undefined) {
        const hasLockfile = has(
          input.rootEntries,
          'package-lock.json',
          'pnpm-lock.yaml',
          'yarn.lock',
          'poetry.lock',
          'Cargo.lock',
          'go.sum',
        );
        if (hasLockfile) signals.push('Lockfile committed');
        return {
          score: hasLockfile ? 70 : 40,
          detail: hasLockfile
            ? 'Lockfile present; version currency not measured.'
            : 'No lockfile found — builds are not reproducible.',
          signals,
        };
      }

      if (input.totalDependencies === 0) {
        return {
          score: 100,
          detail: 'No third-party dependencies.',
          signals: ['Zero dependencies'],
        };
      }

      const stale = input.outdatedDependencies / input.totalDependencies;
      if (stale < 0.1) signals.push('Dependencies are current');
      else if (stale > 0.4) signals.push('Many dependencies are a major version behind');

      return {
        score: Math.round(Math.max(0, 100 - stale * 150)),
        detail: `${input.outdatedDependencies} of ${input.totalDependencies} dependencies are a major version behind.`,
        signals,
      };
    },
  },
  {
    id: 'maintenance',
    label: 'Maintenance activity',
    weight: 0.05,
    evaluate: (input) => {
      const signals: string[] = [];

      if (input.daysSinceLastCommit === undefined) {
        return { score: 70, detail: 'Commit activity unavailable.', signals };
      }

      const days = input.daysSinceLastCommit;
      let score: number;

      if (days <= 7) {
        score = 100;
        signals.push('Actively maintained');
      } else if (days <= 30) {
        score = 85;
        signals.push('Recently updated');
      } else if (days <= 90) {
        score = 60;
      } else if (days <= 365) {
        score = 30;
        signals.push('No commits in over three months');
      } else {
        score = 10;
        signals.push('Appears unmaintained');
      }

      return { score, detail: `Last commit ${days} day(s) ago.`, signals };
    },
  },
];

/** Computes the weighted health report for a repository. */
export function computeHealth(input: HealthInput): HealthReport {
  const dimensions: HealthDimension[] = DIMENSIONS.map((spec) => {
    const { score, detail, signals } = spec.evaluate(input);
    return {
      id: spec.id,
      label: spec.label,
      score: Math.round(Math.max(0, Math.min(100, score))),
      weight: spec.weight,
      detail,
      signals,
    };
  });

  const total = dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0);
  const score = Math.round(total);

  return {
    repository: input.repository,
    score,
    grade: scoreToGrade(score),
    dimensions,
    recommendations: buildRecommendations(dimensions, input),
    computedAt: new Date().toISOString(),
  };
}

/**
 * Produces the highest-leverage next actions.
 *
 * Ordered by `weight × (100 − score)` — the points a fix is actually worth —
 * rather than by raw score, so a team is told to fix the thing that moves the
 * number most, not merely the lowest-scoring thing.
 */
function buildRecommendations(
  dimensions: readonly HealthDimension[],
  input: HealthInput,
): string[] {
  const advice: Record<string, string> = {
    documentation:
      'Add the missing standard documents (README, CONTRIBUTING, SECURITY, LICENSE) — they are the first thing a new contributor looks for.',
    testing:
      'Increase test coverage. Start with the modules that change most often; they carry the most regression risk.',
    security:
      'Resolve outstanding security findings, and enable Dependabot and a code-scanning workflow.',
    'code-quality':
      'Configure a linter, a formatter and static typing so quality issues are caught before review.',
    'ci-stability':
      'Add CI workflows for build, lint, test and type checking, and keep the main branch green.',
    dependencies:
      'Update dependencies that are a major version behind, and commit a lockfile for reproducible builds.',
    maintenance:
      'The repository has not been updated recently. Note its status in the README if it is intentionally dormant.',
  };

  const ranked = [...dimensions]
    .map((dimension) => ({
      dimension,
      opportunity: dimension.weight * (100 - dimension.score),
    }))
    .filter((entry) => entry.opportunity > 1.5)
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, 4);

  const recommendations = ranked.map(
    (entry) => advice[entry.dimension.id] ?? `Improve ${entry.dimension.label.toLowerCase()}.`,
  );

  if (recommendations.length === 0) {
    recommendations.push(
      'Repository health is strong across every dimension. Keep it there by running these checks in CI.',
    );
  }

  if (!has(input.rootEntries, 'LICENSE', 'LICENSE.md') && !input.hasLicense) {
    recommendations.unshift(
      'Add a LICENSE file. Without one the code is legally "all rights reserved" and nobody can safely use it.',
    );
  }

  return recommendations;
}

/** Direction and magnitude of change between two scores. */
export function healthTrend(
  current: number,
  previous: number | undefined,
): { direction: 'up' | 'down' | 'flat'; delta: number } {
  if (previous === undefined) return { direction: 'flat', delta: 0 };
  const delta = current - previous;
  if (Math.abs(delta) < 1) return { direction: 'flat', delta: 0 };
  return { direction: delta > 0 ? 'up' : 'down', delta };
}
