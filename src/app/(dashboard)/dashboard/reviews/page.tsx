import { GitPullRequest } from 'lucide-react';
import type { Metadata } from 'next';
import { getStore } from '@/db';
import { Card, EmptyState, GateBadge } from '@/components/ui/primitives';
import { relativeTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Reviews' };
export const dynamic = 'force-dynamic';

const VERDICT_LABEL: Record<string, string> = {
  approve: 'Approved',
  comment: 'Commented',
  'request-changes': 'Changes requested',
};

export default async function ReviewsPage() {
  const store = getStore();
  const reviews = await store.listReviews(undefined, { limit: 50 });

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Reviews</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Review history</h1>
        <p className="mt-2 text-[color:var(--color-fg-muted)]">
          {reviews.total} review{reviews.total === 1 ? '' : 's'} across all connected repositories.
        </p>
      </header>

      {reviews.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitPullRequest className="size-8" aria-hidden />}
            title="No reviews yet"
            description="Open a pull request on a connected repository, or POST to /api/reviews to analyse one on demand."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {reviews.items.map((review) => {
            const failedGates = review.gates.filter(
              (gate) => gate.status === 'failed' && gate.blocking,
            );
            const warningGates = review.gates.filter((gate) => gate.status === 'warning');

            return (
              <Card key={review.id}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <GateBadge
                        status={
                          failedGates.length > 0
                            ? 'failed'
                            : warningGates.length > 0
                              ? 'warning'
                              : 'passed'
                        }
                      />
                      <span className="text-[13px] font-medium">
                        {VERDICT_LABEL[review.verdict ?? ''] ?? 'Reviewed'}
                      </span>
                      <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                        {review.headSha.slice(0, 7)}
                      </span>
                      <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                        engine: {review.engine}
                      </span>
                    </div>

                    <p className="mt-2.5 text-pretty text-[13.5px] leading-relaxed text-[color:var(--color-fg-muted)]">
                      {review.summary?.headline ?? 'Review completed.'}
                    </p>

                    {review.summary && review.summary.concerns.length > 0 ? (
                      <ul className="mt-3 space-y-1">
                        {review.summary.concerns.slice(0, 3).map((concern, index) => (
                          <li
                            key={index}
                            className="text-[12.5px] text-[color:var(--color-fg-subtle)]"
                          >
                            — {concern.replace(/\*\*/g, '')}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="font-display text-2xl font-semibold tabular-nums">
                      {review.score ?? '—'}
                      <span className="text-sm text-[color:var(--color-fg-subtle)]">/100</span>
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                      {relativeTime(review.createdAt)}
                    </p>
                    {review.durationMs ? (
                      <p className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                        {(review.durationMs / 1000).toFixed(1)}s
                      </p>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
