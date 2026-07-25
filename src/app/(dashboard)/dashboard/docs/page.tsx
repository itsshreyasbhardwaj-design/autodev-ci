import { BookOpen } from 'lucide-react';
import type { Metadata } from 'next';
import { getStore } from '@/db';
import { Card, CardHeader, EmptyState } from '@/components/ui/primitives';
import { relativeTime, spineStyle } from '@/lib/utils';

export const metadata: Metadata = { title: 'Documentation' };
export const dynamic = 'force-dynamic';

/**
 * Documentation status.
 *
 * Documentation findings get their own page because they behave differently
 * from code findings: they are never blocking, they accumulate quietly, and
 * they are best acted on in a batch rather than one pull request at a time.
 */
export default async function DocsPage() {
  const store = getStore();

  const findings = await store.listFindings({ category: 'documentation', limit: 100 });

  const bySignal = new Map<string, Array<(typeof findings.items)[number]>>();
  for (const finding of findings.items) {
    const bucket = bySignal.get(finding.rule) ?? [];
    bucket.push(finding);
    bySignal.set(finding.rule, bucket);
  }

  const RULE_LABEL: Record<string, string> = {
    'documentation/environment-variables': 'Undocumented environment variables',
    'documentation/cli-flags': 'Undocumented CLI flags',
    'documentation/removed-api': 'Removed exports without a migration note',
    'documentation/new-api': 'New public API not documented',
    'documentation/http-routes': 'Undocumented HTTP routes',
    'documentation/build-scripts': 'Build or setup instructions may be stale',
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Documentation</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Documentation drift</h1>
        <p className="mt-2 max-w-2xl text-pretty text-[color:var(--color-fg-muted)]">
          Code changes that imply a documentation update — new environment variables, changed CLI
          flags, removed exports, new routes — where the docs did not follow. Suggestions are
          proposed as pull requests, never committed directly.
        </p>
      </header>

      {findings.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BookOpen className="size-8" aria-hidden />}
            title="Documentation is in sync"
            description="No drift detected in recent reviews. This page fills in when code changes leave the docs behind."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader eyebrow="Summary" title={`${findings.total} drift signal(s) detected`} />
            <div className="grid gap-2 sm:grid-cols-2">
              {[...bySignal.entries()].map(([rule, items]) => (
                <div key={rule} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="text-[color:var(--color-fg-muted)]">
                    {RULE_LABEL[rule] ?? rule}
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-[color:var(--color-fg-subtle)]">
                    {items.length}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <div className="space-y-2.5">
            {findings.items.map((finding) => (
              <Card key={finding.id} className="spine" style={spineStyle(finding.severity)}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[14px] font-semibold">{finding.title}</h2>
                    <p className="mt-2 whitespace-pre-line text-pretty text-[13px] leading-relaxed text-[color:var(--color-fg-muted)]">
                      {finding.description.slice(0, 600)}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                    {relativeTime(finding.createdAt)}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
