import { Activity } from 'lucide-react';
import type { Metadata } from 'next';
import { getStore } from '@/db';
import { healthTrend } from '@/features/health';
import { Card, CardHeader, EmptyState, ScoreRing } from '@/components/ui/primitives';
import { gradeColor } from '@/lib/utils';

export const metadata: Metadata = { title: 'Health' };
export const dynamic = 'force-dynamic';

/**
 * Repository health.
 *
 * Shows the score, the dimension breakdown that produced it, and the trend
 * sparkline. The breakdown is not optional detail — a score nobody can explain
 * is a score nobody acts on.
 */
export default async function HealthPage() {
  const store = getStore();
  const repositories = await store.listRepositories({ limit: 50 });

  const reports = (
    await Promise.all(
      repositories.items.map(async (repository) => {
        const [latest, history] = await Promise.all([
          store.latestHealthSnapshot(repository.id),
          store.listHealthSnapshots(repository.id, 30),
        ]);
        return latest ? { repository, latest, history } : null;
      }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Health</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Repository health</h1>
        <p className="mt-2 max-w-2xl text-pretty text-[color:var(--color-fg-muted)]">
          Seven weighted dimensions — documentation, testing, security, code quality, CI stability,
          dependency freshness and maintenance activity — scored 0–100.
        </p>
      </header>

      {reports.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Activity className="size-8" aria-hidden />}
            title="No health scores yet"
            description="Run GET /api/health-score?owner=…&repo=… or the `autodev health` command to compute the first score for a repository."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {reports.map(({ repository, latest, history }) => {
            const previous = history[history.length - 2]?.score;
            const trend = healthTrend(latest.score, previous);

            return (
              <Card key={repository.id}>
                <div className="flex flex-wrap items-start gap-6">
                  <div className="flex items-center gap-5">
                    <ScoreRing
                      score={latest.score}
                      size={96}
                      label={latest.grade}
                      color={gradeColor(latest.grade)}
                    />
                    <div>
                      <h2 className="font-display text-[16px] font-semibold">
                        {repository.fullName}
                      </h2>
                      <p className="mt-1 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                        grade {latest.grade} · {latest.computedAt.toISOString().slice(0, 10)}
                      </p>
                      {trend.direction !== 'flat' ? (
                        <p
                          className="mt-1.5 font-mono text-[11px]"
                          style={{
                            color:
                              trend.direction === 'up'
                                ? 'var(--color-add)'
                                : 'var(--color-sev-high)',
                          }}
                        >
                          {trend.direction === 'up' ? '▲' : '▼'} {Math.abs(trend.delta)} points
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* Dimension bars */}
                  <div className="min-w-[260px] flex-1 space-y-2">
                    {latest.dimensions.map((dimension) => (
                      <div key={dimension.id}>
                        <div className="mb-1 flex items-baseline justify-between gap-3">
                          <span className="text-[12.5px] text-[color:var(--color-fg-muted)]">
                            {dimension.label}
                          </span>
                          <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-fg-subtle)]">
                            {dimension.score}
                            <span className="ml-1.5 opacity-60">
                              ×{dimension.weight.toFixed(2)}
                            </span>
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-[color:var(--color-ink-700)]">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{
                              width: `${dimension.score}%`,
                              background:
                                dimension.score >= 80
                                  ? 'var(--color-add)'
                                  : dimension.score >= 55
                                    ? 'var(--color-sev-medium)'
                                    : 'var(--color-sev-critical)',
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {latest.recommendations.length > 0 ? (
                  <div className="mt-5 border-t border-[color:var(--color-line)] pt-4">
                    <CardHeader eyebrow="Highest leverage next" title="Recommendations" />
                    <ol className="space-y-2">
                      {latest.recommendations.map((recommendation, index) => (
                        <li
                          key={index}
                          className="flex gap-3 text-[13px] leading-relaxed text-[color:var(--color-fg-muted)]"
                        >
                          <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <span className="text-pretty">{recommendation}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
