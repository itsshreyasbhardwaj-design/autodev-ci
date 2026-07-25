import { ArrowUpRight, GitPullRequest, ShieldAlert } from 'lucide-react';
import { GitHubMark } from '@/components/ui/github-mark';
import Link from 'next/link';
import type { Metadata } from 'next';
import { type Severity, countBySeverity } from '@/core/types';
import { getStore } from '@/db';
import {
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  GateBadge,
  ScoreRing,
  SeverityBadge,
  Stat,
} from '@/components/ui/primitives';
import { relativeTime, spineStyle } from '@/lib/utils';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

/**
 * Overview page.
 *
 * Answers the three questions a maintainer opens this for: what needs my
 * attention right now, is the trend going the right way, and what did the bot
 * just do. Everything else lives on a dedicated page.
 */
export default async function DashboardPage() {
  const store = getStore();

  const [repositories, reviews, findings, pullRequests] = await Promise.all([
    store.listRepositories({ limit: 100 }),
    store.listReviews(undefined, { limit: 8 }),
    store.listFindings({ limit: 100 }),
    store.listPullRequests(undefined, { limit: 6, state: 'open' }),
  ]);

  const counts = countBySeverity(findings.items);
  const blocking = counts.critical + counts.high;

  const averageScore =
    reviews.items.length > 0
      ? Math.round(
          reviews.items.reduce((sum, review) => sum + (review.score ?? 0), 0) /
            reviews.items.length,
        )
      : 0;

  const isEmpty = repositories.total === 0 && reviews.total === 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Overview</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">
          {blocking > 0
            ? `${blocking} finding${blocking === 1 ? '' : 's'} need attention`
            : 'Everything is clear'}
        </h1>
        <p className="mt-2 text-[color:var(--color-fg-muted)]">
          {isEmpty
            ? 'Connect a repository to start reviewing pull requests.'
            : `Across ${repositories.total} connected ${repositories.total === 1 ? 'repository' : 'repositories'}.`}
        </p>
      </header>

      {isEmpty ? (
        <Card>
          <EmptyState
            icon={<GitHubMark className="size-8" aria-hidden />}
            title="No repositories connected"
            description="Add the AutoDev CI GitHub Action to a repository, or connect one through the API, and reviews will appear here on the next pull request."
            action={<ButtonLink href="/dashboard/repositories">Connect a repository</ButtonLink>}
          />
        </Card>
      ) : (
        <>
          {/* Summary row */}
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <Stat label="Repositories" value={repositories.total} hint="connected" />
            </Card>
            <Card>
              <Stat
                label="Open findings"
                value={findings.total}
                hint={`${counts.critical} critical · ${counts.high} high`}
                accent={blocking > 0 ? 'var(--color-sev-high)' : 'var(--color-add)'}
              />
            </Card>
            <Card>
              <Stat label="Reviews" value={reviews.total} hint="completed" />
            </Card>
            <Card className="flex items-center justify-between">
              <div>
                <p className="label">Avg score</p>
                <p className="mt-1.5 text-[13px] text-[color:var(--color-fg-muted)]">
                  last {reviews.items.length} reviews
                </p>
              </div>
              <ScoreRing score={averageScore} size={68} />
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            {/* Recent reviews */}
            <Card>
              <CardHeader
                eyebrow="Activity"
                title="Recent reviews"
                action={
                  <Link
                    href="/dashboard/reviews"
                    className="inline-flex items-center gap-1 text-[13px] text-[color:var(--color-fg-muted)] transition-colors hover:text-[color:var(--color-fg)]"
                  >
                    All reviews
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </Link>
                }
              />

              {reviews.items.length === 0 ? (
                <EmptyState
                  title="No reviews yet"
                  description="Open a pull request on a connected repository and the first review will appear here."
                />
              ) : (
                <ul className="space-y-2.5">
                  {reviews.items.map((review) => {
                    const failed = review.gates.filter(
                      (gate) => gate.status === 'failed' && gate.blocking,
                    ).length;

                    return (
                      <li
                        key={review.id}
                        className="hairline flex flex-wrap items-center gap-x-3 gap-y-1 pt-2.5 first:border-t-0 first:pt-0"
                      >
                        <GateBadge status={failed > 0 ? 'failed' : 'passed'} />
                        <span className="min-w-0 flex-1 truncate text-[13.5px]">
                          {review.summary?.headline?.slice(0, 90) ?? 'Review completed'}
                        </span>
                        <span className="font-mono text-[12px] tabular-nums text-[color:var(--color-fg-subtle)]">
                          {review.score ?? '—'}/100
                        </span>
                        <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                          {relativeTime(review.createdAt)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {/* Severity breakdown */}
            <Card>
              <CardHeader eyebrow="Findings" title="By severity" />

              {findings.total === 0 ? (
                <EmptyState
                  icon={<ShieldAlert className="size-7" aria-hidden />}
                  title="No open findings"
                  description="Every analyzed pull request came back clean."
                />
              ) : (
                <div className="space-y-3">
                  {(['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((severity) => {
                    const count = counts[severity];
                    const share = findings.total > 0 ? (count / findings.total) * 100 : 0;

                    return (
                      <div key={severity}>
                        <div className="mb-1.5 flex items-center justify-between">
                          <SeverityBadge severity={severity} />
                          <span className="font-mono text-[12px] tabular-nums text-[color:var(--color-fg-muted)]">
                            {count}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[color:var(--color-ink-700)]">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{
                              width: `${share}%`,
                              background: `var(--color-sev-${severity})`,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* Open pull requests */}
          <Card className="mt-4">
            <CardHeader eyebrow="Queue" title="Open pull requests" />

            {pullRequests.items.length === 0 ? (
              <EmptyState
                icon={<GitPullRequest className="size-7" aria-hidden />}
                title="No open pull requests"
                description="Pull requests appear here as soon as AutoDev CI analyses them."
              />
            ) : (
              <ul className="space-y-2.5">
                {pullRequests.items.map((pullRequest) => (
                  <li
                    key={pullRequest.id}
                    className="spine hairline pt-2.5 first:border-t-0 first:pt-0"
                    style={spineStyle('info')}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-[12px] text-[color:var(--color-fg-subtle)]">
                        #{pullRequest.number}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                        {pullRequest.title}
                      </span>
                      <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                        {pullRequest.author}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-add)]">
                        +{pullRequest.additions}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-remove)]">
                        −{pullRequest.deletions}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
