import { Lock } from 'lucide-react';
import { GitHubMark } from '@/components/ui/github-mark';
import type { Metadata } from 'next';
import { getStore } from '@/db';
import { Card, EmptyState, ScoreRing } from '@/components/ui/primitives';
import { relativeTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Repositories' };
export const dynamic = 'force-dynamic';

export default async function RepositoriesPage() {
  const store = getStore();
  const repositories = await store.listRepositories({ limit: 100 });

  const withHealth = await Promise.all(
    repositories.items.map(async (repository) => ({
      repository,
      health: await store.latestHealthSnapshot(repository.id),
    })),
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Repositories</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Connected repositories</h1>
        <p className="mt-2 max-w-2xl text-pretty text-[color:var(--color-fg-muted)]">
          A repository is connected the first time AutoDev CI analyses one of its pull requests, or
          explicitly through <code className="font-mono text-[13px]">POST /api/repositories</code>.
        </p>
      </header>

      {withHealth.length === 0 ? (
        <Card>
          <EmptyState
            icon={<GitHubMark className="size-8" aria-hidden />}
            title="No repositories connected"
            description="Add the AutoDev CI GitHub Action to a repository's workflow, or POST to /api/repositories with an owner and repo name."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {withHealth.map(({ repository, health }) => (
            <Card key={repository.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-display text-[15px] font-semibold">
                    {repository.fullName}
                  </h2>
                  {repository.private ? (
                    <Lock
                      className="size-3.5 shrink-0 text-[color:var(--color-fg-subtle)]"
                      aria-label="Private"
                    />
                  ) : null}
                </div>

                <p className="mt-1 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                  default branch: {repository.defaultBranch}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[color:var(--color-fg-muted)]">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="size-1.5 rounded-full"
                      style={{
                        background: repository.active
                          ? 'var(--color-add)'
                          : 'var(--color-fg-subtle)',
                      }}
                      aria-hidden
                    />
                    {repository.active ? 'Active' : 'Paused'}
                  </span>
                  <span>
                    {repository.lastAnalyzedAt
                      ? `Analyzed ${relativeTime(repository.lastAnalyzedAt)}`
                      : 'Not yet analyzed'}
                  </span>
                </div>
              </div>

              {health ? (
                <ScoreRing score={health.score} size={62} label={health.grade} />
              ) : (
                <div className="shrink-0 text-right">
                  <p className="label">Health</p>
                  <p className="mt-1 font-mono text-[12px] text-[color:var(--color-fg-subtle)]">
                    not measured
                  </p>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
