# Contributing to AutoDev CI

Thanks for being here. This document covers what you need to be productive
quickly, and what a good change looks like in this codebase.

## Getting set up

```bash
git clone https://github.com/itsshreyasbhardwaj-design/autodev-ci.git
cd autodev-ci
pnpm install
pnpm dev
```

Requires **Node ≥ 20.11** and **pnpm 11**. Nothing else — no database, no API
keys, no accounts. The app boots into a self-contained mode with in-memory
storage and the deterministic analysis engine.

Before opening a pull request:

```bash
pnpm verify        # typecheck + lint + tests
pnpm test:e2e      # Playwright, against a production build
```

## The one thing to understand first

Analyzers are **pure functions of the diff**. No network, no clock, no shared
mutable state, no randomness.

This is not a stylistic preference. It is what makes a run reproducible, which
is what makes it defensible for a finding to block someone's merge. A change
that introduces I/O into an analyzer will be asked to move that I/O into the
service layer.

The corollary: the language model never decides anything. It writes prose and
proposes non-blocking observations. Severities, gates, scores and verdicts come
from deterministic code. Please keep that boundary intact — it is the product's
central claim.

## Adding an analyzer

An analyzer is roughly 40 lines plus a test. Create
`src/features/analysis/analyzers/your-rule.ts`:

```ts
import type { Finding } from '@/core/types';
import {
  type AnalysisContext,
  type Analyzer,
  addedCodeLines,
  createFinding,
  lineLocation,
  stripLiterals,
} from '../types';

export const yourAnalyzer: Analyzer = {
  id: 'your-analyzer',
  description: 'One line describing what this catches',
  categories: ['correctness'],

  analyze(context: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const { file, line, code } of addedCodeLines(context.files)) {
      if (!/your-pattern/.test(stripLiterals(code))) continue;

      findings.push(
        createFinding({
          rule: 'correctness/your-rule',
          category: 'correctness',
          severity: 'medium',
          title: 'Short imperative title',
          description: 'What is wrong, and why it matters in practice.',
          location: lineLocation(file, line),
          suggestion: { description: 'What to do instead.' },
          confidence: 0.8,
        }),
      );
    }

    return findings;
  },
};
```

Register it in the `ANALYZERS` array in `src/features/analysis/index.ts`, then
add tests in `tests/unit/analyzers.test.ts`.

### Writing a rule that people will not disable

The failure mode for a review bot is not missing something — it is being noisy
enough that a team turns it off. Concretely:

- **Prefer precision over recall.** A rule that fires on shapes which are wrong
  in essentially every context is worth ten rules that are right half the time.
- **Set `confidence` honestly.** Below `blockingConfidence` (0.7 by default) a
  finding reports but never blocks, which is the right home for a heuristic.
- **Use `unless` for the legitimate cases.** `innerHTML` with `DOMPurify.sanitize`
  is fine; the rule should say so rather than making the user add an ignore.
- **Match against `stripLiterals(code)` by default** so `// never use eval()`
  does not trip an `eval` rule. Set `raw: true` only when the pattern genuinely
  needs the string contents, such as `createHash('md5')`.
- **Skip test files** where the pattern is normal in tests.
- **Write the description for someone who does not already know the problem.**
  State what is wrong, why it matters, and what to do — in that order.

Every rule needs a test proving both that it fires on the bad case _and_ that it
stays quiet on a plausible good one. The second half is the one that keeps this
tool usable.

## Project layout

| Directory       | Contains                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| `src/core/`     | Cross-cutting: env, logger, errors, crypto, cache, rate limiting, domain types |
| `src/db/`       | Drizzle schema plus the `DataStore` port and its two adapters                  |
| `src/features/` | One directory per capability; the bulk of the code                             |
| `src/server/`   | API middleware and the service layer that does I/O                             |
| `src/app/`      | Next.js App Router — dashboard pages and REST routes                           |
| `src/cli/`      | The `autodev` command                                                          |
| `tests/`        | `unit/`, `integration/`, `e2e/`                                                |

## Code style

Enforced by ESLint and Prettier; run `pnpm lint:fix` and `pnpm format`.

Beyond the automated rules:

- **Strict TypeScript.** `any` is an ESLint error. Use `unknown` and narrow it.
- **Comments explain _why_.** The code already says what it does. A comment
  earns its place by capturing a decision, a constraint, or a non-obvious
  consequence — the thing a reader would otherwise have to rediscover.
- **Errors are typed.** Throw an `AppError` subclass so the HTTP layer, the logs
  and the CLI all get a stable code and status.
- **Never log a credential.** The logger redacts by key name, but do not rely on
  it as the only line of defence.
- **User-facing text names things the way a user does.** "Notifications", not
  "webhook config".

## Commits and pull requests

We use [Conventional Commits](https://www.conventionalcommits.org/) — AutoDev CI
generates its own changelog from them.

```
feat(analysis): detect unbounded pagination in ORM queries
fix(github): count diff position past "no newline" markers
docs(readme): clarify GitHub App permissions
```

Breaking changes take a `!` (`feat(api)!: ...`) or a `BREAKING CHANGE:` footer.

A good pull request here:

- does one thing, and says in the description what that thing is;
- includes tests for the behaviour it changes;
- passes `pnpm verify`;
- explains any trade-off you made, so a reviewer does not have to infer it.

If you are unsure whether an idea fits, open an issue first — it is cheaper than
finding out after you have written it.

## Reporting bugs

Open an issue with the version, what you expected, what happened, and a minimal
reproduction. For an analyzer producing a wrong result, the most useful thing
you can include is the few lines of diff that triggered it.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](./SECURITY.md).

## Code of Conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
