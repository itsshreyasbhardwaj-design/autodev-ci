import {
  ArrowRight,
  BookOpen,
  FileCode2,
  GitPullRequest,
  Package,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { GitHubMark } from '@/components/ui/github-mark';
import Link from 'next/link';
import { ButtonLink, GateBadge, SeverityBadge } from '@/components/ui/primitives';

/**
 * Landing page.
 *
 * The hero shows the product's actual output — a rendered review comment —
 * rather than an abstract illustration. For a tool whose entire value is "the
 * verdict is worth reading", showing the verdict is the strongest argument
 * available.
 */

const ANALYZERS = [
  {
    id: 'secrets',
    label: 'Hardcoded secrets',
    severity: 'critical',
    detail: '11 provider key formats, entropy-filtered',
  },
  {
    id: 'security',
    label: 'Vulnerability patterns',
    severity: 'critical',
    detail: 'Injection, SSRF, weak crypto, TLS bypass',
  },
  {
    id: 'prompt-injection',
    label: 'LLM safety',
    severity: 'high',
    detail: 'Prompt injection, unsafe tool calling',
  },
  {
    id: 'error-handling',
    label: 'Error handling',
    severity: 'high',
    detail: 'Swallowed errors, floating promises',
  },
  {
    id: 'performance',
    label: 'Performance',
    severity: 'medium',
    detail: 'N+1 queries, sequential awaits, O(n²) reduces',
  },
  {
    id: 'complexity',
    label: 'Complexity',
    severity: 'medium',
    detail: 'Cyclomatic complexity, nesting, long functions',
  },
  {
    id: 'duplication',
    label: 'Duplication',
    severity: 'low',
    detail: 'Normalised rolling-window hashing',
  },
  {
    id: 'dependencies',
    label: 'Supply chain',
    severity: 'high',
    detail: 'Unpinned ranges, git deps, install scripts',
  },
  {
    id: 'testing',
    label: 'Test coverage',
    severity: 'low',
    detail: 'Untested exports, focused and skipped tests',
  },
  {
    id: 'docs',
    label: 'Documentation drift',
    severity: 'low',
    detail: 'Env vars, CLI flags, routes, public API',
  },
] as const;

const CAPABILITIES = [
  {
    icon: GitPullRequest,
    title: 'Pull request review',
    body: 'Ten analyzers run on every push, producing inline comments with correct diff positions and a summary that leads with what actually matters.',
  },
  {
    icon: ShieldCheck,
    title: 'Quality gates',
    body: 'Configurable thresholds turn findings into a merge decision. Only high-confidence deterministic findings can block, so the gate stays trustworthy.',
  },
  {
    icon: Package,
    title: 'Changelog and releases',
    body: 'Conventional Commits become release notes, an upgrade guide, a migration guide and a deployment checklist derived from what actually changed.',
  },
  {
    icon: BookOpen,
    title: 'Documentation drift',
    body: 'Detects when code changes leave the docs behind — new env vars, changed CLI flags, removed exports — and opens a pull request rather than editing in place.',
  },
  {
    icon: FileCode2,
    title: 'Repository health',
    body: 'Seven weighted dimensions produce an explainable score, tracked over time, with recommendations ranked by the points a fix is actually worth.',
  },
  {
    icon: Terminal,
    title: 'Runs anywhere',
    body: 'GitHub Action, REST API, or CLI. The same engine backs all three, so a local run and a CI run give byte-identical results.',
  },
];

export default function HomePage() {
  return (
    <main id="main">
      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                              */}
      {/* ---------------------------------------------------------------- */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 grid-lines opacity-[0.5]"
          aria-hidden
        />

        <nav className="relative mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[color:var(--color-signal)]/15 ring-1 ring-[color:var(--color-signal)]/30">
              <span className="font-mono text-sm font-medium text-[color:var(--color-signal-bright)]">
                A
              </span>
            </div>
            <span className="font-display text-[15px] font-semibold tracking-tight">
              AutoDev CI
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Link
              href="/dashboard"
              className="rounded-lg px-3 py-2 text-sm text-[color:var(--color-fg-muted)] transition-colors hover:text-[color:var(--color-fg)]"
            >
              Dashboard
            </Link>
            <a
              href="https://github.com/itsshreyasbhardwaj-design/autodev-ci"
              className="inline-flex items-center gap-2 rounded-lg border border-[color:var(--color-line)] px-3 py-2 text-sm text-[color:var(--color-fg-muted)] transition-colors hover:border-[color:var(--color-line-bright)] hover:text-[color:var(--color-fg)]"
            >
              <GitHubMark className="size-4" aria-hidden />
              <span className="hidden sm:inline">Source</span>
            </a>
          </div>
        </nav>

        <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-6 pb-24 pt-12 lg:grid-cols-[1fr_1.05fr] lg:pt-20">
          {/* Thesis */}
          <div>
            <p className="label rise mb-5" style={{ ['--delay' as string]: '0ms' }}>
              Open source · MIT · Self-hostable
            </p>

            <h1
              className="rise text-balance font-display text-[clamp(2.5rem,6vw,4.25rem)]"
              style={{ ['--delay' as string]: '70ms' }}
            >
              Code review that
              <br />
              <span className="text-[color:var(--color-signal-bright)]">shows its work.</span>
            </h1>

            <p
              className="rise mt-6 max-w-lg text-pretty text-[17px] leading-relaxed text-[color:var(--color-fg-muted)]"
              style={{ ['--delay' as string]: '140ms' }}
            >
              AutoDev CI reviews pull requests, writes changelogs, catches documentation drift and
              scores repository health. Every finding comes from deterministic analysis you can read
              and reproduce — the language model adds explanation, never the verdict.
            </p>

            <div
              className="rise mt-8 flex flex-wrap items-center gap-3"
              style={{ ['--delay' as string]: '210ms' }}
            >
              <ButtonLink href="/dashboard" size="lg">
                Open the dashboard
                <ArrowRight className="size-4" aria-hidden />
              </ButtonLink>
              <a
                href="https://github.com/itsshreyasbhardwaj-design/autodev-ci#installation"
                className="inline-flex h-12 items-center gap-2 rounded-lg border border-[color:var(--color-line)] px-6 text-[15px] font-medium text-[color:var(--color-fg)] transition-colors hover:border-[color:var(--color-line-bright)] hover:bg-[color:var(--color-ink-800)]"
              >
                Installation guide
              </a>
            </div>

            <div
              className="rise mt-9 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[12px] text-[color:var(--color-fg-subtle)]"
              style={{ ['--delay' as string]: '280ms' }}
            >
              <span>No API key required</span>
              <span aria-hidden>·</span>
              <span>No database required</span>
              <span aria-hidden>·</span>
              <span>Runs in GitHub Actions</span>
            </div>
          </div>

          {/* The artifact: what AutoDev CI actually posts */}
          <div className="rise" style={{ ['--delay' as string]: '340ms' }}>
            <ReviewArtifact />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* What it checks — reads like a check-run list, because it is one   */}
      {/* ---------------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-6 py-20">
        <div className="mb-10 max-w-2xl">
          <p className="label mb-3">The analyzers</p>
          <h2 className="text-balance text-[clamp(1.75rem,3.5vw,2.5rem)]">
            Ten passes over every changed line
          </h2>
          <p className="mt-4 text-pretty leading-relaxed text-[color:var(--color-fg-muted)]">
            Each analyzer is a pure function of the diff — no network, no clock, no shared state.
            That is what makes a run reproducible, and what makes it safe to let one of them block a
            merge.
          </p>
        </div>

        <div className="glass overflow-hidden p-0">
          <ul>
            {ANALYZERS.map((analyzer, index) => (
              <li
                key={analyzer.id}
                className={
                  index === 0
                    ? 'flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 transition-colors hover:bg-white/[0.02]'
                    : 'hairline flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 transition-colors hover:bg-white/[0.02]'
                }
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: `var(--color-sev-${analyzer.severity})` }}
                  aria-hidden
                />
                <span className="w-48 shrink-0 text-sm font-medium">{analyzer.label}</span>
                <span className="flex-1 text-[13px] text-[color:var(--color-fg-muted)]">
                  {analyzer.detail}
                </span>
                <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                  max {analyzer.severity}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Capabilities                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-6 pb-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((capability) => (
            <div
              key={capability.title}
              className="glass group p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-[color:var(--color-line-bright)]"
            >
              <capability.icon
                className="mb-4 size-5 text-[color:var(--color-signal-bright)]"
                aria-hidden
              />
              <h3 className="text-[15px] font-semibold">{capability.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-[color:var(--color-fg-muted)]">
                {capability.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Install                                                           */}
      {/* ---------------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-6 pb-24">
        <div className="glass overflow-hidden p-0">
          <div className="grid lg:grid-cols-2">
            <div className="p-8 lg:p-10">
              <p className="label mb-3">Get started</p>
              <h2 className="text-[clamp(1.5rem,3vw,2rem)]">Two minutes to your first review</h2>
              <p className="mt-4 text-pretty leading-relaxed text-[color:var(--color-fg-muted)]">
                Drop the workflow into{' '}
                <code className="font-mono text-[13px]">.github/workflows</code> and open a pull
                request. It runs on the built-in{' '}
                <code className="font-mono text-[13px]">GITHUB_TOKEN</code> — no account, no API
                key, nothing to configure.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <ButtonLink
                  href="https://github.com/itsshreyasbhardwaj-design/autodev-ci#github-app-setup"
                  variant="secondary"
                >
                  GitHub App setup
                </ButtonLink>
                <ButtonLink href="/dashboard" variant="ghost">
                  Explore the dashboard
                  <ArrowRight className="size-4" aria-hidden />
                </ButtonLink>
              </div>
            </div>

            <div className="border-t border-[color:var(--color-line)] bg-[color:var(--color-ink-950)]/60 p-8 lg:border-l lg:border-t-0 lg:p-10">
              <div className="mb-3 flex items-center gap-2">
                <span
                  className="size-2.5 rounded-full bg-[color:var(--color-sev-critical)]/60"
                  aria-hidden
                />
                <span
                  className="size-2.5 rounded-full bg-[color:var(--color-sev-medium)]/60"
                  aria-hidden
                />
                <span
                  className="size-2.5 rounded-full bg-[color:var(--color-add)]/60"
                  aria-hidden
                />
                <span className="label ml-2">.github/workflows/autodev.yml</span>
              </div>
              <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed text-[color:var(--color-fg-muted)]">
                <code>{`name: AutoDev CI
on:
  pull_request:
    types: [opened, synchronize, reopened]

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
          github-token: \${{ secrets.GITHUB_TOKEN }}
          fail-on: critical`}</code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      <footer className="hairline">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8">
          <p className="text-[13px] text-[color:var(--color-fg-subtle)]">
            AutoDev CI · MIT licensed · Built for teams who read their tooling&apos;s output
          </p>
          <div className="flex gap-5 text-[13px] text-[color:var(--color-fg-subtle)]">
            <a
              className="transition-colors hover:text-[color:var(--color-fg)]"
              href="https://github.com/itsshreyasbhardwaj-design/autodev-ci"
            >
              GitHub
            </a>
            <a
              className="transition-colors hover:text-[color:var(--color-fg)]"
              href="https://github.com/itsshreyasbhardwaj-design/autodev-ci/blob/main/CONTRIBUTING.md"
            >
              Contributing
            </a>
            <a
              className="transition-colors hover:text-[color:var(--color-fg)]"
              href="https://github.com/itsshreyasbhardwaj-design/autodev-ci/blob/main/SECURITY.md"
            >
              Security
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

/**
 * A faithful render of what AutoDev CI posts on a pull request — same
 * structure, same severity spine, same gate table as the real Markdown output.
 */
function ReviewArtifact() {
  return (
    <div className="glass overflow-hidden p-0">
      <div className="flex items-center gap-3 border-b border-[color:var(--color-line)] px-5 py-3.5">
        <div className="flex size-6 items-center justify-center rounded-md bg-[color:var(--color-signal)]/15">
          <span className="font-mono text-[10px] text-[color:var(--color-signal-bright)]">A</span>
        </div>
        <span className="text-[13px] font-medium">autodev-ci</span>
        <span className="rounded border border-[color:var(--color-line)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
          bot
        </span>
        <span className="ml-auto font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
          #482
        </span>
      </div>

      <div className="px-5 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-display text-lg">Request changes</h3>
          <span className="font-mono text-[13px] text-[color:var(--color-fg-subtle)]">
            score <span className="text-[color:var(--color-sev-high)]">61</span>/100
          </span>
        </div>

        <p className="mt-3 text-[13.5px] leading-relaxed text-[color:var(--color-fg-muted)]">
          This is a moderate change (7 files, +284/−41). Analysis found 1 critical issue that should
          be resolved before merging, alongside 4 lower-severity notes.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <SeverityBadge severity="critical" count={1} />
          <SeverityBadge severity="high" count={1} />
          <SeverityBadge severity="medium" count={2} />
          <SeverityBadge severity="low" count={2} />
        </div>

        {/* Gates */}
        <div className="mt-5 space-y-1.5">
          {[
            { name: 'Security scan', status: 'failed' as const, detail: '1 critical finding' },
            {
              name: 'Finding severity',
              status: 'failed' as const,
              detail: '1 at or above critical',
            },
            { name: 'Test coverage', status: 'passed' as const, detail: '3 test files changed' },
            { name: 'Complexity', status: 'warning' as const, detail: '1 function over budget' },
          ].map((gate) => (
            <div key={gate.name} className="flex items-center gap-3 text-[13px]">
              <GateBadge status={gate.status} />
              <span className="font-medium">{gate.name}</span>
              <span className="ml-auto text-[color:var(--color-fg-subtle)]">{gate.detail}</span>
            </div>
          ))}
        </div>

        {/* A finding, with the signature severity spine */}
        <div
          className="spine mt-5 rounded-r-lg bg-[color:var(--color-sev-critical)]/[0.06] py-3 pr-4"
          style={{ ['--spine-color' as string]: 'var(--color-sev-critical)' }}
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13.5px] font-semibold">
              AWS access key ID committed to source
            </span>
            <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
              src/lib/s3.ts:14
            </span>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--color-fg-muted)]">
            Anything committed to git is permanently in the repository history, even after a
            follow-up commit removes it. Rotate this credential, then move it to an environment
            variable.
          </p>
          <p className="mt-2 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
            security/hardcoded-secret.aws-access-key · confidence 97%
          </p>
        </div>

        <div
          className="spine mt-2.5 rounded-r-lg py-3 pr-4"
          style={{ ['--spine-color' as string]: 'var(--color-sev-high)' }}
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13.5px] font-semibold">Possible N+1 query pattern</span>
            <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
              src/api/orders.ts:63
            </span>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--color-fg-muted)]">
            A data-access call appears inside a loop, so total latency scales with collection size.
            Fetch all records in one batched query before the loop.
          </p>
        </div>

        <p className="mt-5 border-t border-[color:var(--color-line)] pt-3 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
          engine: deterministic · 10 analyzers · 1.4s
        </p>
      </div>
    </div>
  );
}
