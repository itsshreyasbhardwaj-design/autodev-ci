import { describe, expect, it } from 'vitest';
import type { Finding } from '@/core/types';
import { buildContext, filterFindings, reviewPullRequest, runAnalyzers } from '@/features/analysis';
import type { Analyzer } from '@/features/analysis/types';
import { TemplateNarrator } from '@/features/ai/narrator';
import { defaultConfig } from '@/features/config';
import { buildInlineComments, renderReviewComment } from '@/features/github/publish';
import { computeScore, evaluateGates, gatesBlocked } from '@/features/quality-gates';
import { diffOf, fakeSecret, pullRequest, repository } from '../fixtures';

/**
 * End-to-end tests for the review pipeline.
 *
 * These exercise the real analyzers against realistic diffs, so they cover the
 * interaction between analysis, filtering, gating and rendering — the part
 * most likely to break when any single component changes.
 */

const narrator = new TemplateNarrator();

function contextFor(files: ReturnType<typeof diffOf>, config = defaultConfig()) {
  return buildContext({ repository, pullRequest, allFiles: files, config });
}

describe('review pipeline', () => {
  it('produces a blocking review for a change containing a secret', async () => {
    const files = diffOf({
      path: 'src/storage.ts',
      status: 'added',
      added: [
        'import { S3Client } from "@aws-sdk/client-s3";',
        '',
        'const client = new S3Client({',
        '  credentials: {',
        `    accessKeyId: "${fakeSecret.aws}",`,
        '    secretAccessKey: process.env.AWS_SECRET,',
        '  },',
        '});',
      ],
    });

    const result = await reviewPullRequest({ context: contextFor(files), narrator });

    const secretFinding = result.findings.find((finding) =>
      finding.rule.startsWith('security/hardcoded-secret'),
    );
    expect(secretFinding).toBeDefined();
    expect(secretFinding!.severity).toBe('critical');

    expect(gatesBlocked(result.gates)).toBe(true);
    expect(result.summary.score).toBeLessThan(80);
    expect(result.summary.headline).toContain('critical');
  });

  it('approves a clean, well-tested change', async () => {
    const files = diffOf(
      {
        path: 'src/money.ts',
        status: 'added',
        added: ['export function addCents(a: number, b: number): number {', '  return a + b;', '}'],
      },
      {
        path: 'src/money.test.ts',
        status: 'added',
        added: [
          'import { addCents } from "./money";',
          '',
          'it("adds cents", () => {',
          '  expect(addCents(1, 2)).toBe(3);',
          '});',
        ],
      },
    );

    const result = await reviewPullRequest({ context: contextFor(files), narrator });

    expect(gatesBlocked(result.gates)).toBe(false);
    expect(result.summary.verdict).toBe('approve');
    expect(result.summary.score).toBeGreaterThanOrEqual(95);
    expect(result.commendations.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same input yields the same findings and score', async () => {
    const files = diffOf({
      path: 'src/a.ts',
      added: ['const r = eval(input);', 'console.log(r);', 'const x: any = r;'],
    });

    const first = await reviewPullRequest({ context: contextFor(files), narrator });
    const second = await reviewPullRequest({ context: contextFor(files), narrator });

    // Ids and timestamps differ per run; everything that drives a decision
    // must not. This property is what makes the gates trustworthy.
    expect(second.summary.score).toBe(first.summary.score);
    expect(second.summary.verdict).toBe(first.summary.verdict);
    expect(second.findings.map((f) => f.rule).sort()).toEqual(
      first.findings.map((f) => f.rule).sort(),
    );
  });

  it('sorts findings by severity, most severe first', async () => {
    const files = diffOf({
      path: 'src/a.ts',
      added: ['// TODO: clean up', `const key = "${fakeSecret.github}";`, 'console.log("debug");'],
    });

    const result = await reviewPullRequest({ context: contextFor(files), narrator });
    const severities = result.findings.map((finding) => finding.severity);

    const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    for (let index = 1; index < severities.length; index += 1) {
      expect(rank[severities[index - 1]!]).toBeGreaterThanOrEqual(rank[severities[index]!]);
    }
  });

  it('honours minSeverity, disabledRules and ignore globs', async () => {
    const config = defaultConfig();
    const files = diffOf(
      { path: 'src/a.ts', added: ['console.log("x");', '// TODO: later'] },
      { path: 'vendor/lib.ts', added: [`const key = "${fakeSecret.github}";`] },
    );

    const tuned = {
      ...config,
      review: {
        ...config.review,
        minSeverity: 'medium' as const,
        disabledRules: ['best-practices/debug-statement'],
        ignore: ['vendor/**'],
      },
    };

    const result = await reviewPullRequest({
      context: buildContext({ repository, pullRequest, allFiles: files, config: tuned }),
      narrator,
    });

    const rules = result.findings.map((finding) => finding.rule);
    expect(rules).not.toContain('best-practices/debug-statement');
    expect(rules).not.toContain('maintainability/todo-without-owner');
    // The vendored file is excluded, so its secret is never reported.
    expect(rules.some((rule) => rule.startsWith('security/hardcoded-secret'))).toBe(false);
  });

  it('completes the review when a single analyzer throws', async () => {
    const exploding: Analyzer = {
      id: 'exploding',
      description: 'always fails',
      categories: ['correctness'],
      analyze() {
        throw new Error('analyzer bug');
      },
    };

    const files = diffOf({
      path: 'src/a.ts',
      added: [`const key = "${fakeSecret.githubShort}";`],
    });
    const context = contextFor(files);

    const { findings, failures } = await runAnalyzers(context, [
      exploding,
      ...(await import('@/features/analysis')).ANALYZERS,
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.analyzer).toBe('exploding');
    // The other analyzers still produced results.
    expect(findings.length).toBeGreaterThan(0);
  });

  it('excludes binary and generated files from analysis', async () => {
    const files = diffOf(
      { path: 'src/real.ts', added: ['const a = 1;'] },
      { path: 'pnpm-lock.yaml', added: [`token: "${fakeSecret.github}"`] },
    );

    const context = contextFor(files);
    expect(context.files.map((file) => file.path)).toEqual(['src/real.ts']);
  });
});

describe('quality gates', () => {
  it('does not let a low-confidence finding block a merge', () => {
    const lowConfidence: Finding = {
      id: '1',
      rule: 'security/ssrf',
      category: 'security',
      severity: 'critical',
      title: 'Possible SSRF',
      description: '',
      source: 'static',
      confidence: 0.3,
    };

    const gates = evaluateGates({
      findings: [lowConfidence],
      files: [],
      config: defaultConfig().qualityGates,
      blockingConfidence: 0.7,
    });

    expect(gatesBlocked(gates)).toBe(false);
  });

  it('never lets an AI-sourced finding block a merge', () => {
    // Structural defence: model output is influenced by attacker-controlled
    // PR text, so it must not be able to fail someone's build.
    const aiFinding: Finding = {
      id: '1',
      rule: 'ai/observation',
      category: 'security',
      severity: 'critical',
      title: 'Model thinks this is bad',
      description: '',
      source: 'ai',
      confidence: 1,
    };

    const gates = evaluateGates({
      findings: [aiFinding],
      files: [],
      config: defaultConfig().qualityGates,
      blockingConfidence: 0.7,
    });

    expect(gatesBlocked(gates)).toBe(false);
  });

  it('fails when tests are required and none changed', () => {
    const config = defaultConfig().qualityGates;
    const gates = evaluateGates({
      findings: [],
      files: diffOf({ path: 'src/a.ts', added: ['const a = 1;'] }),
      config: { ...config, requireTests: true },
      blockingConfidence: 0.7,
    });

    const testGate = gates.find((gate) => gate.id === 'tests');
    expect(testGate?.status).toBe('failed');
    expect(gatesBlocked(gates)).toBe(true);
  });

  it('reports change size as a non-blocking warning', () => {
    const files = Array.from({ length: 100 }, (_, index) =>
      diffOf({ path: `src/f${index}.ts`, added: ['const a = 1;'] }),
    ).flat();

    const gates = evaluateGates({
      findings: [],
      files,
      config: defaultConfig().qualityGates,
      blockingConfidence: 0.7,
    });

    const sizeGate = gates.find((gate) => gate.id === 'change-size');
    expect(sizeGate?.status).toBe('warning');
    expect(sizeGate?.blocking).toBe(false);
    expect(gatesBlocked(gates)).toBe(false);
  });

  it('scores a clean change near 100 and a critical one much lower', () => {
    const clean = computeScore([], [], diffOf({ path: 'a.test.ts', added: ['x'] }));
    expect(clean).toBe(100);

    const critical = computeScore(
      [
        {
          id: '1',
          rule: 'security/x',
          category: 'security',
          severity: 'critical',
          title: 't',
          description: '',
          source: 'static',
          confidence: 1,
        },
      ],
      [],
      [],
    );

    expect(critical).toBeLessThan(80);
  });
});

describe('review rendering', () => {
  it('renders a complete Markdown comment with the update marker', async () => {
    const files = diffOf({
      path: 'src/a.ts',
      added: [`const key = "${fakeSecret.github}";`],
    });

    const result = await reviewPullRequest({ context: contextFor(files), narrator });
    const markdown = renderReviewComment(result, defaultConfig().review);

    expect(markdown).toContain('<!-- autodev-ci:review -->');
    expect(markdown).toContain('AutoDev CI');
    expect(markdown).toContain('Quality gates');
    expect(markdown).toContain(`${result.summary.score}/100`);
    // The secret itself must never be echoed into a public PR comment.
    expect(markdown).not.toContain(fakeSecret.github);
  });

  it('drops inline comments whose line is not present in the diff', () => {
    const files = diffOf({ path: 'src/a.ts', added: ['const a = 1;'] });

    const findings: Finding[] = [
      {
        id: '1',
        rule: 'x/y',
        category: 'correctness',
        severity: 'high',
        title: 'In the diff',
        description: 'd',
        location: { path: 'src/a.ts', line: 1 },
        source: 'static',
        confidence: 1,
      },
      {
        id: '2',
        rule: 'x/z',
        category: 'correctness',
        severity: 'high',
        title: 'Not in the diff',
        description: 'd',
        location: { path: 'src/a.ts', line: 9999 },
        source: 'static',
        confidence: 1,
      },
    ];

    const { comments, skipped } = buildInlineComments(findings, files, 20);

    expect(comments).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.title).toBe('Not in the diff');
  });

  it('respects the inline comment cap', () => {
    const files = diffOf({
      path: 'src/a.ts',
      added: Array.from({ length: 30 }, (_, index) => `const v${index} = ${index};`),
    });

    const findings: Finding[] = Array.from({ length: 30 }, (_, index) => ({
      id: String(index),
      rule: 'x/y',
      category: 'correctness',
      severity: 'medium',
      title: `Finding ${index}`,
      description: 'd',
      location: { path: 'src/a.ts', line: index + 1 },
      source: 'static',
      confidence: 1,
    }));

    const { comments, skipped } = buildInlineComments(findings, files, 5);
    expect(comments).toHaveLength(5);
    expect(skipped).toHaveLength(25);
  });
});

describe('filterFindings', () => {
  it('silences a whole rule namespace when the prefix is disabled', () => {
    const config = defaultConfig();
    const context = buildContext({
      repository,
      pullRequest,
      allFiles: [],
      config: { ...config, review: { ...config.review, disabledRules: ['security'] } },
    });

    const findings: Finding[] = [
      {
        id: '1',
        rule: 'security/hardcoded-secret.aws-access-key',
        category: 'security',
        severity: 'critical',
        title: 't',
        description: '',
        source: 'static',
        confidence: 1,
      },
      {
        id: '2',
        rule: 'performance/n-plus-one',
        category: 'performance',
        severity: 'high',
        title: 't',
        description: '',
        source: 'static',
        confidence: 1,
      },
    ];

    const filtered = filterFindings(findings, context);
    expect(filtered.map((finding) => finding.rule)).toEqual(['performance/n-plus-one']);
  });
});
