<div align="center">

# AutoDev CI

**Code review that shows its work.**

Automated pull request review, changelog generation, documentation drift detection
and repository health scoring for GitHub.

[![CI](https://github.com/itsshreyasbhardwaj-design/autodev-ci/actions/workflows/ci.yml/badge.svg)](https://github.com/itsshreyasbhardwaj-design/autodev-ci/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg)](./tsconfig.json)

</div>

---

## What this is

AutoDev CI reviews pull requests the way a careful colleague would: it reads the
diff, points at specific lines, explains why something matters, and says when the
work is good.

The thing that makes it different from most AI review tools is **where the
findings come from**. Every finding is produced by a deterministic analyzer you
can read, reproduce and unit-test. A language model, when you configure one, adds
narrative explanation on top — it never decides the verdict, never sets a
severity, and can never fail your build.

That ordering has three consequences that matter in practice:

- **It works with no API key and costs nothing to run.** The deterministic engine
  is the product; the LLM is an upgrade.
- **CI stays green when your model provider has an outage.** Enrichment is
  best-effort and degrades to the deterministic summary.
- **A quality gate is trustworthy.** Model output is derived from
  attacker-controlled text (PR titles, diffs, comments), so it is structurally
  prevented from blocking a merge.

## Screenshots

> Replace these placeholders with your own captures after deploying.

| Landing page                               | Dashboard overview                        |
| ------------------------------------------ | ----------------------------------------- |
| ![Landing page](./docs/images/landing.png) | ![Dashboard](./docs/images/dashboard.png) |

| Findings                                | Repository health                   |
| --------------------------------------- | ----------------------------------- |
| ![Findings](./docs/images/findings.png) | ![Health](./docs/images/health.png) |

---

## Features

### AI pull request review

Ten analyzers run over every changed line and emit findings in a single shared
shape, which is what lets gates, scoring, the API and the dashboard treat all of
them uniformly.

| Analyzer           | Catches                                                                                                                               | Max severity |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `secrets`          | AWS, GitHub, Stripe, Slack, OpenAI, Anthropic and Google keys; private keys; credentialed database URLs                               | critical     |
| `security`         | Injection (code, command, SQL), XSS, SSRF, path traversal, weak crypto, disabled TLS verification, unsafe deserialisation, JWT bypass | critical     |
| `prompt-injection` | Untrusted input reaching a prompt, model output used as code or SQL, unrestricted tool calling                                        | critical     |
| `error-handling`   | Swallowed exceptions, floating promises, unguarded `JSON.parse`, missing cleanup, non-null assertions                                 | high         |
| `performance`      | N+1 queries, sequential awaits in loops, O(n²) reduces, unbounded queries, synchronous I/O                                            | high         |
| `complexity`       | Cyclomatic complexity, long functions, deep nesting, long parameter lists                                                             | high         |
| `duplication`      | Copy-pasted blocks, detected via normalised rolling-window hashing so renames still match                                             | medium       |
| `dependencies`     | Unpinned ranges, git and plain-HTTP dependencies, install scripts, lockfile drift, abandoned packages                                 | critical     |
| `testing`          | Focused (`.only`) and skipped tests, empty test bodies, untested new exports, source changed without tests                            | high         |
| `documentation`    | New environment variables, changed CLI flags, removed exports, new routes not reflected in the docs                                   | medium       |

Output includes inline comments with correct diff positions, a summary comment
that updates in place rather than accumulating, and — deliberately —
recognition of what was done well. Reviews that only criticise get muted.

### Quality gates

Findings become a merge decision through configurable gates: severity
thresholds, security scan, change size, test coverage, documentation, code
duplication and complexity. Only high-confidence deterministic findings can
block; everything else reports.

### Changelog and release management

Conventional Commits become a changelog, and a release becomes five documents:
release notes, an upgrade guide, a breaking-change summary, a migration guide,
and a deployment checklist that adapts to what actually changed — migrations
present means a migration step appears.

### Documentation drift

Detects the code changes that _imply_ a documentation update and checks whether
one happened. Suggestions are proposed as a pull request, never committed
directly: generated prose needs a human before it becomes your official docs.

### Repository health

Seven weighted dimensions — documentation, testing, security, code quality, CI
stability, dependency freshness, maintenance activity — produce a 0–100 score
tracked over time, with recommendations ranked by the points a fix is actually
worth rather than by raw score.

---

## Installation

### Option 1 — GitHub Action (fastest)

Create `.github/workflows/autodev.yml`:

```yaml
name: AutoDev CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: itsshreyasbhardwaj-design/autodev-ci@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          fail-on: critical
```

That is the whole setup. It runs on the built-in `GITHUB_TOKEN` — no account, no
API key, nothing to configure.

To add LLM explanations:

```yaml
- uses: itsshreyasbhardwaj-design/autodev-ci@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-provider: openrouter
    openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

#### Action inputs

| Input                | Default               | Description                                            |
| -------------------- | --------------------- | ------------------------------------------------------ |
| `command`            | `review`              | `review`, `changelog`, `release`, `health`, or `docs`  |
| `github-token`       | `${{ github.token }}` | Needs `pull-requests: write` to comment                |
| `fail-on`            | `critical`            | Severity that fails the job, or `never` to report only |
| `pull-request`       | from event            | Explicit PR number                                     |
| `post-comment`       | `true`                | Post the review to the pull request                    |
| `ai-provider`        | `deterministic`       | `deterministic` or `openrouter`                        |
| `openrouter-api-key` | —                     | Required when `ai-provider: openrouter`                |
| `min-health-score`   | `0`                   | Fail the `health` command below this score             |

#### Action outputs

`score`, `verdict`, `findings`, `critical`, `high`, `grade`, `version`.

### Option 2 — CLI

```bash
npm install -g autodev-ci
export GITHUB_TOKEN=$(gh auth token)

autodev review --repo owner/name --pr 42
autodev health --repo owner/name
autodev changelog --repo owner/name --write CHANGELOG.md
autodev release --repo owner/name --version 2.0.0
autodev docs --repo owner/name --pr 42
```

Run `autodev help` for the full flag reference.

### Option 3 — Self-hosted dashboard

```bash
git clone https://github.com/itsshreyasbhardwaj-design/autodev-ci.git
cd autodev-ci
pnpm install
pnpm dev
```

Open <http://localhost:3000>. It boots with **zero configuration**: in-memory
storage, the deterministic engine, and a development identity. Add credentials
to `.env.local` to progressively unlock features — see
[`.env.example`](./.env.example) for every variable.

Deploy to Vercel:

```bash
pnpm dlx vercel deploy --prod
```

---

## GitHub App setup

A GitHub App is the right choice for production: tokens are scoped per
installation, expire hourly, and are refreshed automatically.

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set **Webhook URL** to `https://your-deployment/api/webhooks/github`.
3. Generate a **Webhook secret** and keep it.
4. Grant these **repository permissions**:
   - Contents: **Read-only**
   - Pull requests: **Read & write**
   - Issues: **Read & write** (summary comments are issue comments)
   - Metadata: **Read-only**
   - Checks: **Read & write** (optional, for check runs)
5. Subscribe to events: **Pull request**, **Push**, **Release**.
6. Generate a **private key** and download the `.pem`.
7. Install the App on the repositories you want reviewed.
8. Set the environment variables:

```bash
GITHUB_APP_ID="123456"
GITHUB_APP_CLIENT_ID="Iv1.abc123"
GITHUB_APP_CLIENT_SECRET="..."
GITHUB_APP_PRIVATE_KEY="$(cat private-key.pem)"   # or base64 -i private-key.pem
GITHUB_WEBHOOK_SECRET="..."
```

> **Least privilege.** AutoDev CI never requests write access to repository
> contents for reviews. The only write path is opening a documentation pull
> request, which uses the `contents: write` permission you grant explicitly.

---

## Configuration

Drop a `.autodev.yml` at the repository root. Every key is optional; unknown
keys are rejected so a typo fails loudly instead of being silently ignored.

```yaml
version: 1

review:
  enabled: true
  categories: [security, correctness, performance, maintainability, testing]
  minSeverity: low # drop findings below this
  inlineComments: true
  maxInlineComments: 20
  commendations: true
  ignore:
    - '**/dist/**'
    - '**/*.generated.ts'
  disabledRules:
    - readability/long-lines # a single rule
    - style # or a whole namespace
  blockingConfidence: 0.7 # below this, report but never block
  requestChangesOnFailure: false

qualityGates:
  enabled: true
  failOnSeverity: critical
  warnOnSeverity: high
  maxUntestedLines: 400
  maxChangedFiles: 75
  requireTests: false
  requireDocs: false
  maxDuplicateBlocks: 5
  maxFunctionComplexity: 15

security:
  secretScanning: true
  dependencyAudit: true
  promptInjection: true
  allowlist:
    - 'EXAMPLE_[A-Z_]+' # regexes treated as false positives

changelog:
  path: CHANGELOG.md
  includeTypes: [feat, fix, perf, refactor, docs]
  groupByScope: false
  includeContributors: true

docs:
  watch: ['README.md', 'docs/**/*.md']
  openPullRequest: true

notifications:
  githubComment: true
  slack: false
  teams: false
  minSeverity: high
```

Configuration is read from the **head** commit of a pull request, so a PR that
tightens the rules is reviewed under the new rules.

---

## REST API

Every endpoint returns a stable error envelope and `x-request-id` /
`RateLimit-*` headers. Set `AUTODEV_API_KEYS` to require
`Authorization: Bearer <key>`.

| Method                 | Endpoint                | Description                                    |
| ---------------------- | ----------------------- | ---------------------------------------------- |
| `GET`                  | `/api/health`           | Liveness, storage adapter, active capabilities |
| `POST`                 | `/api/reviews`          | Analyse a pull request                         |
| `GET`                  | `/api/reviews`          | Review history                                 |
| `GET`                  | `/api/repositories`     | Connected repositories                         |
| `POST`                 | `/api/repositories`     | Connect a repository                           |
| `GET`/`PATCH`/`DELETE` | `/api/repositories/:id` | Read, update or disconnect                     |
| `GET`                  | `/api/findings`         | Query findings by severity, category, repo     |
| `POST`                 | `/api/findings`         | Dismiss a finding with a reason                |
| `GET`                  | `/api/health-score`     | Compute repository health with trend           |
| `POST`                 | `/api/changelog`        | Generate a changelog                           |
| `POST`                 | `/api/release`          | Build the full release package                 |
| `POST`                 | `/api/docs`             | Detect documentation drift                     |
| `POST`                 | `/api/ai/explain`       | Stream an explanation (SSE)                    |
| `POST`                 | `/api/webhooks/github`  | GitHub webhook receiver                        |

### Example

```bash
curl -X POST https://your-deployment/api/reviews \
  -H 'Authorization: Bearer $AUTODEV_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"owner":"acme","repo":"widgets","pullNumber":42,"dryRun":true}'
```

```jsonc
{
  "review": {
    "summary": { "verdict": "request-changes", "score": 61, "headline": "…" },
    "findings": [
      { "rule": "security/hardcoded-secret.aws-access-key", "severity": "critical", "…": "…" },
    ],
    "gates": [{ "id": "security", "status": "failed", "blocking": true, "…": "…" }],
    "engine": "deterministic",
  },
  "blocked": true,
}
```

A blocked review returns **202**, not an error: the request succeeded, the gates
just say do not merge.

---

## Architecture

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   GitHub    │   │  Dashboard  │   │     CLI     │
│  Webhooks   │   │  (Next.js)  │   │   / Action  │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                 │
       └────────┬────────┴────────┬────────┘
                ▼                 ▼
       ┌──────────────────────────────────┐
       │        Service layer             │  GitHub I/O, config,
       │  review · health · release       │  persistence, publishing
       └────────────────┬─────────────────┘
                        ▼
       ┌──────────────────────────────────┐
       │      Analysis engine (pure)      │  no network, no clock,
       │  10 analyzers → Finding[]        │  no shared state
       └────────────────┬─────────────────┘
                        ▼
       ┌────────────┬───────────┬─────────┐
       │  Gates     │  Scoring  │ Narrator│  deterministic, or
       └────────────┴───────────┴────┬────┘  AI-enriched
                                     ▼
       ┌──────────────────────────────────┐
       │   DataStore (memory │ postgres)  │
       └──────────────────────────────────┘
```

Directory layout:

```
src/
├── core/          env, logger, errors, crypto, cache, rate limiting, types
├── db/            Drizzle schema + DataStore port with two adapters
├── features/
│   ├── github/    App auth, webhooks, diff parser, publishing
│   ├── ai/        provider abstraction, OpenRouter, prompts, narrators
│   ├── analysis/  the ten analyzers and the orchestrator
│   ├── config/    .autodev.yml schema and loader
│   ├── changelog/ Conventional Commits, semver, changelog rendering
│   ├── release/   release planning
│   ├── health/    seven-dimension scoring
│   ├── quality-gates/
│   └── notifications/
├── server/        API middleware and service layer
├── app/           Next.js App Router (dashboard + REST API)
├── components/    UI primitives
└── cli/           the `autodev` command
```

Three design decisions worth knowing about:

1. **Analyzers are pure functions.** No I/O, no clock, no shared state. That is
   what makes runs reproducible and what makes it safe to let one block a merge.
2. **Storage is a port with two adapters.** The in-memory one is a first-class
   adapter, not a test double — it is what runs when there is no `DATABASE_URL`,
   and it implements the full contract including pagination and ordering.
3. **Prompt injection is handled structurally.** Untrusted content is fenced with
   per-process random delimiters and sanitised, but the real defence is that the
   model cannot affect a verdict.

---

## Development

```bash
pnpm install
pnpm dev              # dashboard at :3000
pnpm test             # unit + integration (208 tests)
pnpm test:e2e         # Playwright against a production build
pnpm typecheck        # strict TypeScript, no errors
pnpm lint             # ESLint
pnpm verify           # all of the above
pnpm build            # production build
pnpm build:cli        # bundle the CLI for the Action
```

Requires Node ≥ 20.11 and pnpm 11.

---

## Roadmap

- [ ] OSV / GitHub Advisory lookups for dependency vulnerabilities (currently
      pattern-based only, since a proper implementation belongs in a background job)
- [ ] Check Runs API integration so gates appear as native status checks
- [ ] Incremental review: analyse only what changed since the last review
- [ ] Tree-sitter parsing to replace the heuristic function extractor
- [ ] Per-organisation rule packs shared across repositories
- [ ] GitLab and Bitbucket adapters behind the existing port
- [ ] Trigger.dev-backed background jobs for large monorepos
- [ ] Historical trend analytics and team dashboards

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) —
it covers the development setup, how to add an analyzer (about 40 lines and a
test), and what a good pull request looks like here.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, please follow [SECURITY.md](./SECURITY.md) rather
than opening a public issue.

## License

[MIT](./LICENSE) © AutoDev CI contributors
