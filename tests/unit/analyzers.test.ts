import { describe, expect, it } from 'vitest';
import type { Finding } from '@/core/types';
import {
  complexityAnalyzer,
  cyclomaticComplexity,
  extractFunctions,
} from '@/features/analysis/analyzers/complexity';
import { dependenciesAnalyzer } from '@/features/analysis/analyzers/dependencies';
import { duplicationAnalyzer, normalizeLine } from '@/features/analysis/analyzers/duplication';
import { errorHandlingAnalyzer } from '@/features/analysis/analyzers/error-handling';
import { maintainabilityAnalyzer } from '@/features/analysis/analyzers/maintainability';
import { performanceAnalyzer } from '@/features/analysis/analyzers/performance';
import { promptInjectionAnalyzer } from '@/features/analysis/analyzers/prompt-injection';
import {
  looksLikePlaceholder,
  secretsAnalyzer,
  shannonEntropy,
} from '@/features/analysis/analyzers/secrets';
import { securityAnalyzer } from '@/features/analysis/analyzers/security';
import { testingAnalyzer } from '@/features/analysis/analyzers/testing';
import { contextFrom, contextOf, diffOf, fakeSecret } from '../fixtures';

/** Convenience: run an analyzer and return the rules it fired. */
async function rulesFrom(
  analyzer: { analyze: (context: never) => Finding[] | Promise<Finding[]> },
  context: unknown,
): Promise<string[]> {
  const findings = await analyzer.analyze(context as never);
  return findings.map((finding) => finding.rule);
}

describe('secrets analyzer', () => {
  it('flags a hardcoded AWS access key as critical', async () => {
    const context = contextFrom({
      path: 'src/aws.ts',
      added: [`const key = "${fakeSecret.aws}";`],
    });

    const findings = await secretsAnalyzer.analyze(context);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('security/hardcoded-secret.aws-access-key');
    expect(findings[0]!.severity).toBe('critical');
    // The value must never be echoed back in full.
    expect(findings[0]!.description).not.toContain(fakeSecret.aws);
    expect(findings[0]!.description).toContain('AKIA');
  });

  it.each([
    ['GitHub token', `const t = "${fakeSecret.github}";`],
    ['Stripe key', `const s = "${fakeSecret.stripe}";`],
    ['Slack token', `const s = "${fakeSecret.slack}";`],
    ['private key', 'const pem = `-----BEGIN RSA PRIVATE KEY-----`;'],
    ['database URL', 'const db = "postgresql://admin:hunter2@prod-db-01.internal:5432/app";'],
  ])('detects a %s', async (_label, line) => {
    const findings = await secretsAnalyzer.analyze(
      contextFrom({ path: 'src/config.ts', added: [line] }),
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.category).toBe('security');
  });

  it.each([
    'const key = process.env.API_KEY;',
    'const key = "your-api-key-here";',
    'const key = "xxxxxxxxxxxxxxxx";',
    'const password = "changeme";',
    'const token = "${SECRET_TOKEN}";',
    'const example = "example-secret-value";',
  ])('does not flag the placeholder %s', async (line) => {
    const findings = await secretsAnalyzer.analyze(
      contextFrom({ path: 'src/config.ts', added: [line] }),
    );
    expect(findings).toEqual([]);
  });

  it('skips .env.example files entirely', async () => {
    const findings = await secretsAnalyzer.analyze(
      contextFrom({
        path: '.env.example',
        added: [`AWS_ACCESS_KEY_ID=${fakeSecret.aws}`],
      }),
    );
    expect(findings).toEqual([]);
  });

  it('honours the configured allowlist', async () => {
    const context = contextOf({
      files: diffOf({ path: 'src/a.ts', added: [`const k = "${fakeSecret.aws}";`] }),
      config: {
        security: {
          enabled: true,
          secretScanning: true,
          dependencyAudit: true,
          promptInjection: true,
          allowlist: [fakeSecret.aws],
        },
      },
    });

    expect(await secretsAnalyzer.analyze(context)).toEqual([]);
  });

  it('reports one finding per secret even when it appears twice in a file', async () => {
    const findings = await secretsAnalyzer.analyze(
      contextFrom({
        path: 'src/a.ts',
        added: [`const a = "${fakeSecret.github}";`, `const b = "${fakeSecret.github}";`],
      }),
    );
    expect(findings).toHaveLength(1);
  });

  it('computes Shannon entropy', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    // A random-looking key scores well above the 3.2 threshold.
    expect(shannonEntropy('kJ8xQ2mNp5vR7tW1zY4bC6dF')).toBeGreaterThan(3.5);
    expect(shannonEntropy('password')).toBeLessThan(3.2);
  });

  it('recognises placeholder shapes', () => {
    expect(looksLikePlaceholder('your-api-key')).toBe(true);
    expect(looksLikePlaceholder('process.env.FOO')).toBe(true);
    expect(looksLikePlaceholder('xxxxxx')).toBe(true);
    expect(looksLikePlaceholder('kJ8xQ2mNp5vR7tW1zY4bC6dF')).toBe(false);
  });
});

describe('security analyzer', () => {
  it.each([
    ['security/code-injection-eval', 'const r = eval(userInput);'],
    ['security/tls-verification-disabled', 'const agent = { rejectUnauthorized: false };'],
    ['security/weak-hash', "const h = createHash('md5').update(x).digest();"],
    ['security/jwt-none-algorithm', "jwt.verify(token, key, { algorithms: ['none'] });"],
    ['security/unsafe-deserialization', 'const data = pickle.loads(payload);'],
  ])('detects %s', async (rule, line) => {
    const rules = await rulesFrom(
      securityAnalyzer,
      contextFrom({ path: 'src/app.ts', added: [line] }),
    );
    expect(rules).toContain(rule);
  });

  it('detects SQL built by interpolation', async () => {
    const rules = await rulesFrom(
      securityAnalyzer,
      contextFrom({
        path: 'src/db.ts',
        added: ['const rows = await db.query(`SELECT * FROM users WHERE id = ${userId}`);'],
      }),
    );
    expect(rules).toContain('security/sql-injection');
  });

  it('does not flag a parameterised query', async () => {
    const rules = await rulesFrom(
      securityAnalyzer,
      contextFrom({
        path: 'src/db.ts',
        added: ['const rows = await db.query("SELECT * FROM users WHERE id = $1", [userId]);'],
      }),
    );
    expect(rules).not.toContain('security/sql-injection');
  });

  it('does not flag innerHTML when the value is sanitised', async () => {
    const rules = await rulesFrom(
      securityAnalyzer,
      contextFrom({
        path: 'src/render.ts',
        added: ['el.innerHTML = DOMPurify.sanitize(userHtml);'],
      }),
    );
    expect(rules).not.toContain('security/xss-inner-html');
  });

  it('ignores matches that appear only inside a comment', async () => {
    const rules = await rulesFrom(
      securityAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['// never use eval() here'] }),
    );
    expect(rules).not.toContain('security/code-injection-eval');
  });

  it('produces nothing when security analysis is disabled', async () => {
    const context = contextOf({
      files: diffOf({ path: 'src/a.ts', added: ['eval(x);'] }),
      config: {
        security: {
          enabled: false,
          secretScanning: true,
          dependencyAudit: true,
          promptInjection: true,
          allowlist: [],
        },
      },
    });
    expect(await securityAnalyzer.analyze(context)).toEqual([]);
  });
});

describe('error handling analyzer', () => {
  it('flags an empty catch block', async () => {
    const rules = await rulesFrom(
      errorHandlingAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['try { risky(); } catch (e) {}'] }),
    );
    expect(rules).toContain('error-handling/empty-catch');
  });

  it('flags JSON.parse with no guard', async () => {
    const rules = await rulesFrom(
      errorHandlingAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['const data = JSON.parse(body);'] }),
    );
    expect(rules).toContain('error-handling/unhandled-json-parse');
  });

  it('flags `any` in TypeScript', async () => {
    const rules = await rulesFrom(
      errorHandlingAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['function f(x: any) { return x; }'] }),
    );
    expect(rules).toContain('maintainability/any-type');
  });

  it('leaves test files alone', async () => {
    const findings = await errorHandlingAnalyzer.analyze(
      contextFrom({ path: 'src/a.test.ts', added: ['try { risky(); } catch (e) {}'] }),
    );
    expect(findings).toEqual([]);
  });
});

describe('performance analyzer', () => {
  it('detects an N+1 query pattern', async () => {
    const rules = await rulesFrom(
      performanceAnalyzer,
      contextFrom({
        path: 'src/orders.ts',
        added: [
          'for (const order of orders) {',
          '  const user = await db.findUnique({ where: { id: order.userId } });',
          '  results.push(user);',
          '}',
        ],
      }),
    );
    expect(rules).toContain('performance/n-plus-one');
  });

  it('detects object spread inside reduce', async () => {
    const rules = await rulesFrom(
      performanceAnalyzer,
      contextFrom({
        path: 'src/a.ts',
        added: ['const map = items.reduce((acc, item) => ({ ...acc, [item.id]: item }), {});'],
      }),
    );
    expect(rules).toContain('performance/spread-in-reduce');
  });

  it('flags synchronous filesystem calls in application code', async () => {
    const rules = await rulesFrom(
      performanceAnalyzer,
      contextFrom({ path: 'src/api/handler.ts', added: ['const data = readFileSync(path);'] }),
    );
    expect(rules).toContain('performance/sync-io-in-request-path');
  });

  it('allows synchronous filesystem calls in scripts', async () => {
    const rules = await rulesFrom(
      performanceAnalyzer,
      contextFrom({ path: 'scripts/build.ts', added: ['const data = readFileSync(path);'] }),
    );
    expect(rules).not.toContain('performance/sync-io-in-request-path');
  });
});

describe('complexity analyzer', () => {
  it('counts decision points', () => {
    expect(cyclomaticComplexity('function f() { return 1; }')).toBe(1);
    expect(cyclomaticComplexity('if (a) { } if (b) { }')).toBe(3);
    expect(cyclomaticComplexity('if (a && b || c) { }')).toBe(4);
  });

  it('does not count operators inside string literals', () => {
    expect(cyclomaticComplexity('const s = "a && b || c";')).toBe(1);
  });

  it('extracts function blocks with their metrics', () => {
    const source = [
      'export function calculate(a, b, c, d, e, f, g) {',
      '  if (a) { return 1; }',
      '  if (b) { return 2; }',
      '  return 0;',
      '}',
    ].join('\n');

    const blocks = extractFunctions(source, 'typescript');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.name).toBe('calculate');
    expect(blocks[0]!.parameters).toBe(7);
    expect(blocks[0]!.complexity).toBeGreaterThan(2);
  });

  it('flags a function over the complexity budget', async () => {
    const body = Array.from({ length: 20 }, (_, index) => `  if (x === ${index}) return ${index};`);
    const source = ['function huge(x) {', ...body, '  return -1;', '}'].join('\n');

    const rules = await rulesFrom(
      complexityAnalyzer,
      contextOf({
        files: diffOf({ path: 'src/huge.ts', added: source.split('\n') }),
      }),
    );

    expect(rules).toContain('maintainability/cyclomatic-complexity');
  });

  it('flags too many parameters', async () => {
    const rules = await rulesFrom(
      complexityAnalyzer,
      contextFrom({
        path: 'src/a.ts',
        added: ['function wide(a, b, c, d, e, f, g, h) {', '  return a;', '}'],
      }),
    );
    expect(rules).toContain('readability/too-many-parameters');
  });
});

describe('duplication analyzer', () => {
  it('normalises identifiers and literals but keeps structure', () => {
    const a = normalizeLine('const userTotal = price + 1;');
    const b = normalizeLine('const orderSum = amount + 2;');
    expect(a).toBe(b);

    // Different structure must not collapse to the same shape.
    expect(normalizeLine('if (a) return b;')).not.toBe(normalizeLine('const a = b;'));
  });

  it('detects a block duplicated across two files', async () => {
    const block = [
      'const config = loadConfiguration(path);',
      'const validated = validateSchema(config);',
      'if (!validated.success) {',
      '  logger.error("configuration is invalid");',
      '  throw new ConfigError(validated.error);',
      '}',
      'return validated.data;',
    ];

    const findings = await duplicationAnalyzer.analyze(
      contextOf({
        files: diffOf({ path: 'src/a.ts', added: block }, { path: 'src/b.ts', added: block }),
      }),
    );

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.rule).toBe('maintainability/duplicate-code');
  });

  it('reports an overlapping duplicated region only once', async () => {
    // Ten identical lines produce several overlapping windows; without
    // dedupe this reported the same block once per starting offset.
    const block = Array.from(
      { length: 10 },
      (_, index) => `  processItem(collection[${index}], options);`,
    );

    const findings = await duplicationAnalyzer.analyze(
      contextOf({
        files: diffOf({ path: 'src/a.ts', added: block }, { path: 'src/b.ts', added: block }),
      }),
    );

    expect(findings).toHaveLength(1);
  });

  it('ignores import blocks and test files', async () => {
    const imports = Array.from(
      { length: 8 },
      (_, index) => `import { thing${index} } from './mod${index}';`,
    );

    const findings = await duplicationAnalyzer.analyze(
      contextOf({
        files: diffOf({ path: 'src/a.ts', added: imports }, { path: 'src/b.ts', added: imports }),
      }),
    );

    expect(findings).toEqual([]);
  });
});

describe('dependencies analyzer', () => {
  it('flags a wildcard version range as high severity', async () => {
    const findings = await dependenciesAnalyzer.analyze(
      contextFrom({ path: 'package.json', added: ['    "lodash": "*",'] }),
    );

    const unpinned = findings.find((finding) => finding.rule === 'dependencies/unpinned-version');
    expect(unpinned).toBeDefined();
    expect(unpinned!.severity).toBe('high');
  });

  it('flags a plain-HTTP dependency as critical', async () => {
    const findings = await dependenciesAnalyzer.analyze(
      contextFrom({
        path: 'package.json',
        added: ['    "thing": "http://example.com/thing.tgz",'],
      }),
    );

    const insecure = findings.find((finding) => finding.rule === 'dependencies/insecure-protocol');
    expect(insecure?.severity).toBe('critical');
  });

  it('rates an unpinned git dependency higher than a pinned one', async () => {
    const unpinned = await dependenciesAnalyzer.analyze(
      contextFrom({
        path: 'package.json',
        added: ['    "lib": "git+https://github.com/a/b.git",'],
      }),
    );
    const pinned = await dependenciesAnalyzer.analyze(
      contextFrom({
        path: 'package.json',
        added: ['    "lib": "git+https://github.com/a/b.git#a1b2c3d4e5f6789",'],
      }),
    );

    expect(unpinned.find((f) => f.rule === 'dependencies/git-dependency')?.severity).toBe('high');
    expect(pinned.find((f) => f.rule === 'dependencies/git-dependency')?.severity).toBe('low');
  });

  it('warns when a manifest changes without its lockfile', async () => {
    const findings = await dependenciesAnalyzer.analyze(
      contextFrom({ path: 'package.json', added: ['    "left-pad": "^1.0.0",'] }),
    );
    expect(findings.map((f) => f.rule)).toContain('dependencies/lockfile-not-updated');
  });

  it('stays quiet when the lockfile changed too', async () => {
    const context = contextOf({
      files: diffOf(
        { path: 'package.json', added: ['    "zod": "^4.0.0",'] },
        { path: 'pnpm-lock.yaml', added: ['  zod: 4.0.0'] },
      ),
    });

    const findings = await dependenciesAnalyzer.analyze(context);
    expect(findings.map((f) => f.rule)).not.toContain('dependencies/lockfile-not-updated');
  });

  it('flags a newly added install script', async () => {
    const findings = await dependenciesAnalyzer.analyze(
      contextFrom({ path: 'package.json', added: ['    "postinstall": "node ./setup.js",'] }),
    );
    expect(findings.map((f) => f.rule)).toContain('dependencies/install-script');
  });
});

describe('prompt injection analyzer', () => {
  it('flags user input interpolated into a prompt', async () => {
    const rules = await rulesFrom(
      promptInjectionAnalyzer,
      contextFrom({
        path: 'src/agent.ts',
        added: [
          'const messages = [{ role: "user", content: `Summarise: ${req.body.text}` }];',
          'await openai.chat.completions.create({ messages, max_tokens: 500 });',
        ],
      }),
    );

    expect(rules).toContain('security/prompt-injection.user-input-in-prompt');
  });

  it('flags model output executed as code', async () => {
    const rules = await rulesFrom(
      promptInjectionAnalyzer,
      contextFrom({
        path: 'src/llm-runner.ts',
        added: [
          'const completion = await anthropic.messages.create(params);',
          'const result = eval(completion.content);',
        ],
      }),
    );

    expect(rules).toContain('security/prompt-injection.llm-output-to-eval');
  });

  it('produces nothing for a file with no AI code path', async () => {
    const findings = await promptInjectionAnalyzer.analyze(
      contextFrom({
        path: 'src/math.ts',
        added: ['export const add = (a: number, b: number) => a + b;'],
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe('testing analyzer', () => {
  it('flags a focused test as high severity', async () => {
    const findings = await testingAnalyzer.analyze(
      contextFrom({ path: 'src/a.test.ts', added: ['it.only("does a thing", () => {});'] }),
    );

    const focused = findings.find((finding) => finding.rule === 'testing/focused-test');
    expect(focused?.severity).toBe('high');
  });

  it('flags a skipped test at low severity', async () => {
    const rules = await rulesFrom(
      testingAnalyzer,
      contextFrom({
        path: 'src/a.test.ts',
        added: ['it.skip("later", () => { expect(1).toBe(1); });'],
      }),
    );
    expect(rules).toContain('testing/skipped-test');
  });

  it('notes substantial source changes shipped without tests', async () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `export const value${index} = ${index};`,
    );
    const rules = await rulesFrom(
      testingAnalyzer,
      contextFrom({ path: 'src/values.ts', added: lines }),
    );
    expect(rules).toContain('testing/no-tests-changed');
  });

  it('stays quiet when tests accompany the change', async () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `export const value${index} = ${index};`,
    );
    const context = contextOf({
      files: diffOf(
        { path: 'src/values.ts', added: lines },
        { path: 'src/values.test.ts', added: ['it("works", () => { expect(value0).toBe(0); });'] },
      ),
    });

    const rules = (await testingAnalyzer.analyze(context)).map((finding) => finding.rule);
    expect(rules).not.toContain('testing/no-tests-changed');
  });
});

describe('maintainability analyzer', () => {
  it('flags a leftover console.log', async () => {
    const rules = await rulesFrom(
      maintainabilityAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['console.log("here", user);'] }),
    );
    expect(rules).toContain('best-practices/debug-statement');
  });

  it('allows console.error, which is real logging', async () => {
    const rules = await rulesFrom(
      maintainabilityAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['console.error("request failed", error);'] }),
    );
    expect(rules).not.toContain('best-practices/debug-statement');
  });

  it('flags a TODO with no owner but accepts an attributed one', async () => {
    const anonymous = await rulesFrom(
      maintainabilityAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['// TODO: fix this later'] }),
    );
    expect(anonymous).toContain('maintainability/todo-without-owner');

    const attributed = await rulesFrom(
      maintainabilityAnalyzer,
      contextFrom({ path: 'src/a.ts', added: ['// TODO(@alice, #482): fix this later'] }),
    );
    expect(attributed).not.toContain('maintainability/todo-without-owner');
  });

  it('flags a deep relative import', async () => {
    const rules = await rulesFrom(
      maintainabilityAnalyzer,
      contextFrom({ path: 'src/a/b/c.ts', added: ["import { x } from '../../../shared/x';"] }),
    );
    expect(rules).toContain('architecture/deep-relative-import');
  });

  it('caps repeated findings from a single rule', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `console.log(${index});`);
    const findings = await maintainabilityAnalyzer.analyze(
      contextFrom({ path: 'src/a.ts', added: lines }),
    );

    const debugFindings = findings.filter((f) => f.rule === 'best-practices/debug-statement');
    expect(debugFindings.length).toBeLessThanOrEqual(5);
  });
});
