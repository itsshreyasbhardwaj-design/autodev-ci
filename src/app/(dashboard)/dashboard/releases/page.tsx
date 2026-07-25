import { Package } from 'lucide-react';
import type { Metadata } from 'next';
import { getStore } from '@/db';
import { Card, EmptyState } from '@/components/ui/primitives';
import { relativeTime } from '@/lib/utils';

export const metadata: Metadata = { title: 'Releases' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  changelog: 'Changelog',
  'release-notes': 'Release notes',
  'upgrade-guide': 'Upgrade guide',
  'migration-guide': 'Migration guide',
  'deployment-checklist': 'Deployment checklist',
  'docs-suggestion': 'Docs suggestion',
};

export default async function ReleasesPage() {
  const store = getStore();
  const repositories = await store.listRepositories({ limit: 50 });

  const artifacts = (
    await Promise.all(
      repositories.items.map(async (repository) => {
        const page = await store.listArtifacts(repository.id, undefined, { limit: 20 });
        return page.items.map((artifact) => ({ artifact, repository }));
      }),
    )
  )
    .flat()
    .sort((a, b) => b.artifact.createdAt.getTime() - a.artifact.createdAt.getTime());

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Releases</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Generated release artifacts</h1>
        <p className="mt-2 max-w-2xl text-pretty text-[color:var(--color-fg-muted)]">
          Changelogs, release notes, upgrade and migration guides, and deployment checklists —
          derived from Conventional Commits and the files that actually changed.
        </p>
      </header>

      {artifacts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Package className="size-8" aria-hidden />}
            title="No release artifacts yet"
            description="Run `autodev release --version 1.2.0` or POST to /api/release to generate the full release package for a repository."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {artifacts.map(({ artifact, repository }) => (
            <Card key={artifact.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="rounded-md bg-[color:var(--color-signal)]/12 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-signal-bright)]">
                      {KIND_LABEL[artifact.kind] ?? artifact.kind}
                    </span>
                    <h2 className="text-[14px] font-semibold">{artifact.title}</h2>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                    {repository.fullName}
                    {artifact.subject ? ` · ${artifact.subject}` : ''}
                  </p>
                </div>
                <span className="font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
                  {relativeTime(artifact.createdAt)}
                </span>
              </div>

              <pre className="mt-4 max-h-52 overflow-auto rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink-950)]/60 p-4 font-mono text-[12px] leading-relaxed text-[color:var(--color-fg-muted)]">
                <code>{artifact.content.slice(0, 1400)}</code>
              </pre>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
