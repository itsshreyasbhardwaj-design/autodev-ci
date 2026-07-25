import { ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { SEVERITIES, type Severity, countBySeverity } from '@/core/types';
import { getStore } from '@/db';
import { Card, EmptyState, SeverityBadge } from '@/components/ui/primitives';
import { relativeTime, spineStyle } from '@/lib/utils';

export const metadata: Metadata = { title: 'Findings' };
export const dynamic = 'force-dynamic';

/**
 * Findings list.
 *
 * The severity spine on each row is the signature element from the review
 * comment, carried into the dashboard so the same finding looks the same
 * wherever a reviewer meets it.
 */
export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ severity?: string }>;
}) {
  const params = await searchParams;
  const severityFilter = (SEVERITIES as readonly string[]).includes(params.severity ?? '')
    ? (params.severity as Severity)
    : undefined;

  const store = getStore();
  const [findings, all] = await Promise.all([
    store.listFindings({ limit: 100, ...(severityFilter ? { severity: severityFilter } : {}) }),
    store.listFindings({ limit: 100 }),
  ]);

  const counts = countBySeverity(all.items);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <p className="label mb-2">Findings</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Security and quality findings</h1>
        <p className="mt-2 text-[color:var(--color-fg-muted)]">
          {all.total} open finding{all.total === 1 ? '' : 's'} across all reviews.
        </p>
      </header>

      <nav aria-label="Filter by severity" className="mb-6 flex flex-wrap gap-2">
        <a
          href="/dashboard/findings"
          className={`rounded-md px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
            severityFilter === undefined
              ? 'bg-[color:var(--color-signal)]/15 text-[color:var(--color-signal-bright)]'
              : 'text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)]'
          }`}
        >
          all {all.total}
        </a>
        {SEVERITIES.map((severity) => (
          <a
            key={severity}
            href={`/dashboard/findings?severity=${severity}`}
            className="transition-opacity hover:opacity-100"
            style={{ opacity: severityFilter === severity ? 1 : 0.65 }}
          >
            <SeverityBadge severity={severity} count={counts[severity]} />
          </a>
        ))}
      </nav>

      {findings.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShieldCheck className="size-8" aria-hidden />}
            title={severityFilter ? `No ${severityFilter} findings` : 'No open findings'}
            description={
              severityFilter
                ? 'Nothing at this severity. Try another filter, or clear it to see everything.'
                : 'Every analyzed pull request came back clean. Findings appear here as reviews run.'
            }
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {findings.items.map((finding) => (
            <Card key={finding.id} className="spine" style={spineStyle(finding.severity)}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={finding.severity} />
                    <h2 className="text-[14px] font-semibold">{finding.title}</h2>
                  </div>

                  {finding.location ? (
                    <p className="mt-1.5 font-mono text-[11.5px] text-[color:var(--color-fg-subtle)]">
                      {finding.location.path}
                      {finding.location.line ? `:${finding.location.line}` : ''}
                    </p>
                  ) : null}

                  <p className="mt-2 line-clamp-3 text-pretty text-[13px] leading-relaxed text-[color:var(--color-fg-muted)]">
                    {finding.description.split('\n').filter(Boolean).slice(0, 2).join(' ')}
                  </p>

                  {finding.suggestion ? (
                    <p className="mt-2 text-[12.5px] text-[color:var(--color-fg-muted)]">
                      <span className="text-[color:var(--color-signal-bright)]">Fix:</span>{' '}
                      {finding.suggestion.description}
                    </p>
                  ) : null}
                </div>

                <div className="shrink-0 text-right font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                  <p>{finding.rule}</p>
                  <p className="mt-1">{Math.round(finding.confidence * 100)}% confidence</p>
                  <p className="mt-1">{relativeTime(finding.createdAt)}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
