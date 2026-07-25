import { generateId } from '@/core/crypto';
import { logger } from '@/core/logger';
import {
  type Commendation,
  type Finding,
  type FindingSource,
  type ReviewCategory,
  type ReviewSummary,
  type Severity,
  SEVERITIES,
  REVIEW_CATEGORIES,
  compareSeverity,
  countBySeverity,
} from '@/core/types';
import type { AIProvider } from './provider';
import { extractJson } from './provider';
import { buildReviewMessages, type ReviewPromptInput } from './prompts';

/**
 * Narration turns structured analysis into the prose a human reads.
 *
 * Two implementations satisfy the same interface:
 *
 *   - {@link TemplateNarrator} composes summaries from the findings
 *     themselves. Deterministic, instant, free, and always available.
 *   - {@link AiNarrator} asks a model for a richer summary and additional
 *     findings, and falls back to the template narrator on any failure.
 *
 * Callers never branch on which one they have.
 */

export interface NarrationInput extends ReviewPromptInput {
  readonly score: number;
  readonly verdict: ReviewSummary['verdict'];
}

export interface NarrationOutput {
  readonly summary: ReviewSummary;
  /** Extra findings contributed by the model. Empty for the template narrator. */
  readonly findings: readonly Finding[];
  readonly commendations: readonly Commendation[];
  readonly engine: FindingSource;
}

export interface Narrator {
  readonly kind: FindingSource;
  narrate(input: NarrationInput): Promise<NarrationOutput>;
}

function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeScale(added: number, removed: number, files: number): string {
  const total = added + removed;
  if (total === 0) return 'no line changes';
  const size =
    total < 50 ? 'a small' : total < 250 ? 'a moderate' : total < 800 ? 'a large' : 'a very large';
  return `${size} change (${pluralise(files, 'file')}, +${added}/−${removed})`;
}

/**
 * Deterministic narrator.
 *
 * Everything it says is derived from the findings and metrics, so its output
 * is reproducible and can be asserted on in tests — which is exactly what you
 * want from the component that decides what a reviewer reads first.
 */
export class TemplateNarrator implements Narrator {
  readonly kind = 'static' as const;

  async narrate(input: NarrationInput): Promise<NarrationOutput> {
    const counts = countBySeverity(input.staticFindings);
    const added = input.files.reduce((sum, file) => sum + file.additions, 0);
    const removed = input.files.reduce((sum, file) => sum + file.deletions, 0);

    return {
      summary: {
        verdict: input.verdict,
        score: input.score,
        headline: this.headline(input, counts, added, removed),
        highlights: this.highlights(input),
        concerns: this.concerns(input.staticFindings),
      },
      findings: [],
      commendations: this.commendations(input),
      engine: 'static',
    };
  }

  private headline(
    input: NarrationInput,
    counts: Record<Severity, number>,
    added: number,
    removed: number,
  ): string {
    const scale = describeScale(added, removed, input.files.length);
    const blocking = counts.critical + counts.high;

    if (blocking > 0) {
      const worst = counts.critical > 0 ? 'critical' : 'high-severity';
      return (
        `This is ${scale}. Analysis found ${pluralise(blocking, `${worst} issue`)} that should be ` +
        `resolved before merging, alongside ${pluralise(
          counts.medium + counts.low,
          'lower-severity note',
        )}.`
      );
    }

    if (counts.medium > 0) {
      return `This is ${scale}. No blocking problems were found, but ${pluralise(
        counts.medium,
        'medium-severity issue',
      )} ${counts.medium === 1 ? 'is' : 'are'} worth addressing before merge.`;
    }

    if (input.staticFindings.length > 0) {
      return `This is ${scale}. Nothing blocking was found — only ${pluralise(
        input.staticFindings.length,
        'minor note',
      )} that you can take or leave.`;
    }

    return `This is ${scale}. Analysis found no issues.`;
  }

  private highlights(input: NarrationInput): string[] {
    const highlights: string[] = [];

    const testFiles = input.files.filter((file) =>
      /\.(test|spec)\.|(^|\/)(tests?|__tests__)\//i.test(file.path),
    );
    if (testFiles.length > 0) {
      highlights.push(
        `Includes ${pluralise(testFiles.length, 'test file')} — changes are covered by tests.`,
      );
    }

    const docFiles = input.files.filter((file) => /\.(md|mdx|rst)$/i.test(file.path));
    if (docFiles.length > 0) {
      highlights.push(`Documentation was updated alongside the code (${docFiles.length} file(s)).`);
    }

    const deletions = input.files.reduce((sum, file) => sum + file.deletions, 0);
    const additions = input.files.reduce((sum, file) => sum + file.additions, 0);
    if (deletions > additions && deletions > 50) {
      highlights.push(
        `Net reduction of ${deletions - additions} lines — this change removes more than it adds.`,
      );
    }

    if (input.files.length > 0 && input.files.length <= 5 && additions + deletions < 200) {
      highlights.push('Focused change: small and easy to review in one sitting.');
    }

    return highlights;
  }

  private concerns(findings: readonly Finding[]): string[] {
    const byCategory = new Map<ReviewCategory, Finding[]>();
    for (const finding of findings) {
      if (finding.severity === 'info' || finding.severity === 'low') continue;
      const bucket = byCategory.get(finding.category) ?? [];
      bucket.push(finding);
      byCategory.set(finding.category, bucket);
    }

    return [...byCategory.entries()]
      .sort((a, b) => {
        const worstA = a[1].slice().sort((x, y) => compareSeverity(x.severity, y.severity))[0];
        const worstB = b[1].slice().sort((x, y) => compareSeverity(x.severity, y.severity))[0];
        return compareSeverity(worstA?.severity ?? 'info', worstB?.severity ?? 'info');
      })
      .slice(0, 5)
      .map(([category, items]) => {
        const worst = items.slice().sort((a, b) => compareSeverity(a.severity, b.severity))[0];
        return `**${category}** — ${pluralise(items.length, 'issue')}, most severe: ${worst?.title ?? 'unknown'}`;
      });
  }

  private commendations(input: NarrationInput): Commendation[] {
    const commendations: Commendation[] = [];

    const testFiles = input.files.filter((file) =>
      /\.(test|spec)\.|(^|\/)(tests?|__tests__)\//i.test(file.path),
    );
    const sourceFiles = input.files.filter(
      (file) => !testFiles.includes(file) && /\.[cm]?[jt]sx?$|\.py$|\.go$|\.rs$/.test(file.path),
    );

    if (testFiles.length > 0 && sourceFiles.length > 0) {
      const ratio = testFiles.length / sourceFiles.length;
      if (ratio >= 0.5) {
        commendations.push({
          title: 'Strong test coverage',
          description: `${testFiles.length} test file(s) for ${sourceFiles.length} source file(s) — the change ships with its own verification.`,
        });
      }
    }

    if (input.staticFindings.length === 0 && input.files.length > 0) {
      commendations.push({
        title: 'Clean static analysis',
        description: 'No issues detected across security, complexity, and correctness checks.',
      });
    }

    const typed = input.files.filter((file) => /\.tsx?$/.test(file.path));
    if (typed.length > 0 && !input.staticFindings.some((f) => f.rule.includes('any-type'))) {
      commendations.push({
        title: 'Type-safe throughout',
        description: 'TypeScript changes avoid `any` escape hatches.',
      });
    }

    return commendations.slice(0, 4);
  }
}

interface AiReviewPayload {
  headline?: string;
  highlights?: string[];
  concerns?: string[];
  findings?: Array<{
    rule?: string;
    category?: string;
    severity?: string;
    title?: string;
    description?: string;
    path?: string;
    line?: number;
    suggestion?: string;
    confidence?: number;
  }>;
  commendations?: Array<{ title?: string; description?: string }>;
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

function isCategory(value: unknown): value is ReviewCategory {
  return typeof value === 'string' && (REVIEW_CATEGORIES as readonly string[]).includes(value);
}

/**
 * AI-enriched narrator.
 *
 * The model's output is validated field by field and clamped. In particular
 * AI findings are capped at `high` severity: a model must never be able to
 * manufacture a `critical` finding, because criticals fail the build and the
 * model's input includes attacker-controlled text.
 */
export class AiNarrator implements Narrator {
  readonly kind = 'hybrid' as const;

  constructor(
    private readonly provider: AIProvider,
    private readonly fallback: Narrator = new TemplateNarrator(),
  ) {}

  async narrate(input: NarrationInput): Promise<NarrationOutput> {
    const base = await this.fallback.narrate(input);
    const log = logger().child({ component: 'ai-narrator', provider: this.provider.name });

    try {
      const response = await this.provider.complete({
        messages: buildReviewMessages(input),
        json: true,
        temperature: 0.2,
      });

      const payload = extractJson<AiReviewPayload>(response.content);
      if (!payload) {
        log.warn('Model response was not parseable JSON; using deterministic summary');
        return base;
      }

      const findings = this.parseFindings(
        payload.findings ?? [],
        input.files.map((f) => f.path),
      );

      log.info('AI enrichment applied', {
        model: response.model,
        addedFindings: findings.length,
        tokens: response.usage?.totalTokens,
      });

      return {
        summary: {
          verdict: base.summary.verdict,
          score: base.summary.score,
          headline:
            typeof payload.headline === 'string' && payload.headline.trim().length > 20
              ? payload.headline.trim()
              : base.summary.headline,
          highlights: this.strings(payload.highlights, base.summary.highlights),
          concerns: this.strings(payload.concerns, base.summary.concerns),
        },
        findings,
        commendations: this.parseCommendations(payload.commendations, base.commendations),
        engine: 'hybrid',
      };
    } catch (error) {
      // Enrichment is best-effort by design: the deterministic result is
      // already complete and correct, so an LLM outage must not fail the run.
      log.warn('AI enrichment failed; falling back to deterministic summary', { error });
      return base;
    }
  }

  private strings(value: unknown, fallback: readonly string[]): string[] {
    if (!Array.isArray(value)) return [...fallback];
    const cleaned = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 8);
    return cleaned.length > 0 ? cleaned : [...fallback];
  }

  private parseFindings(
    raw: NonNullable<AiReviewPayload['findings']>,
    knownPaths: readonly string[],
  ): Finding[] {
    const paths = new Set(knownPaths);

    return raw
      .filter((item) => typeof item.title === 'string' && typeof item.description === 'string')
      .slice(0, 25)
      .map<Finding>((item) => {
        const severity = isSeverity(item.severity) ? item.severity : 'low';

        return {
          id: generateId(),
          rule:
            typeof item.rule === 'string' && item.rule.length > 0 ? item.rule : 'ai/observation',
          category: isCategory(item.category) ? item.category : 'maintainability',
          // Clamp: only the deterministic engine may raise a critical.
          severity: severity === 'critical' ? 'high' : severity,
          title: String(item.title).slice(0, 200),
          description: String(item.description).slice(0, 4000),
          // Drop locations the model hallucinated — a comment on a file that is
          // not in the diff is guaranteed to be wrong.
          ...(item.path && paths.has(item.path)
            ? {
                location: {
                  path: item.path,
                  ...(typeof item.line === 'number' && item.line > 0 ? { line: item.line } : {}),
                },
              }
            : {}),
          ...(item.suggestion ? { suggestion: { description: String(item.suggestion) } } : {}),
          source: 'ai',
          confidence:
            typeof item.confidence === 'number' ? Math.min(Math.max(item.confidence, 0), 0.9) : 0.6,
        };
      });
  }

  private parseCommendations(
    raw: AiReviewPayload['commendations'],
    fallback: readonly Commendation[],
  ): Commendation[] {
    if (!Array.isArray(raw)) return [...fallback];

    const parsed = raw
      .filter((item) => typeof item?.title === 'string' && typeof item?.description === 'string')
      .slice(0, 4)
      .map<Commendation>((item) => ({
        title: String(item.title).slice(0, 120),
        description: String(item.description).slice(0, 500),
      }));

    return parsed.length > 0 ? parsed : [...fallback];
  }
}
