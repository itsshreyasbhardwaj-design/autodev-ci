import { AlertTriangle } from 'lucide-react';
import type { Metadata } from 'next';
import { describeCapabilities, env } from '@/core/env';
import { getStore } from '@/db';
import { defaultConfig } from '@/features/config';
import { Card, CardHeader } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

/**
 * Settings.
 *
 * Read-only by design. Configuration lives in `.autodev.yml` in the repository
 * and in environment variables on the deployment — both under version control
 * and change review. A dashboard toggle that silently overrides a committed
 * file is how teams end up unable to explain why CI behaves differently from
 * what the repo says.
 */
export default async function SettingsPage() {
  const e = env();
  const store = getStore();
  const config = defaultConfig();

  const warnings: string[] = [];
  if (e.isProduction && !e.capabilities.persistentStorage) {
    warnings.push('Running in production without DATABASE_URL — all data is lost on restart.');
  }
  if (e.isProduction && !e.capabilities.webhookVerification) {
    warnings.push('GITHUB_WEBHOOK_SECRET is unset — webhook signatures are not being verified.');
  }
  if (e.isProduction && !e.capabilities.apiAuth) {
    warnings.push('AUTODEV_API_KEYS is unset — the REST API accepts unauthenticated writes.');
  }
  if (e.isProduction && !e.capabilities.managedAuth) {
    warnings.push('No authentication provider configured — the dashboard is publicly reachable.');
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-8">
        <p className="label mb-2">Settings</p>
        <h1 className="text-[clamp(1.75rem,3vw,2.25rem)]">Configuration</h1>
        <p className="mt-2 max-w-2xl text-pretty text-[color:var(--color-fg-muted)]">
          Per-repository behaviour is set in{' '}
          <code className="font-mono text-[13px]">.autodev.yml</code> and deployment behaviour in
          environment variables, so every change is reviewable in git.
        </p>
      </header>

      {warnings.length > 0 ? (
        <Card
          className="mb-4 spine"
          style={{ ['--spine-color' as string]: 'var(--color-sev-high)' }}
        >
          <div className="flex gap-3">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-[color:var(--color-sev-high)]"
              aria-hidden
            />
            <div>
              <h2 className="text-[14px] font-semibold">
                {warnings.length} configuration warning{warnings.length === 1 ? '' : 's'}
              </h2>
              <ul className="mt-2 space-y-1.5">
                {warnings.map((warning) => (
                  <li key={warning} className="text-[13px] text-[color:var(--color-fg-muted)]">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4">
        <Card>
          <CardHeader eyebrow="Deployment" title="Active capabilities" />
          <pre className="overflow-x-auto rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink-950)]/60 p-4 font-mono text-[12px] leading-relaxed text-[color:var(--color-fg-muted)]">
            <code>{describeCapabilities(e)}</code>
          </pre>
          <p className="mt-3 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
            storage adapter: {store.kind} · environment: {e.NODE_ENV} · rate limit:{' '}
            {e.RATE_LIMIT_PER_MINUTE}/min
          </p>
        </Card>

        <Card>
          <CardHeader
            eyebrow="Repository defaults"
            title="What .autodev.yml looks like with no overrides"
          />
          <pre className="max-h-96 overflow-auto rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink-950)]/60 p-4 font-mono text-[12px] leading-relaxed text-[color:var(--color-fg-muted)]">
            <code>{renderConfigYaml(config)}</code>
          </pre>
          <p className="mt-3 text-[13px] text-[color:var(--color-fg-muted)]">
            Commit any subset of these keys to a repository to override the defaults. Unknown keys
            are rejected so typos fail loudly rather than being ignored.
          </p>
        </Card>
      </div>
    </div>
  );
}

/** Renders the config object as readable YAML for display. */
function renderConfigYaml(config: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (Array.isArray(config)) {
    if (config.length === 0) return '[]';
    return `\n${config.map((item) => `${pad}  - ${String(item)}`).join('\n')}`;
  }

  if (typeof config === 'object' && config !== null) {
    return Object.entries(config)
      .map(([key, value]) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          return `${pad}${key}:\n${renderConfigYaml(value, indent + 1)}`;
        }
        return `${pad}${key}: ${renderConfigYaml(value, indent)}`;
      })
      .join('\n');
  }

  return String(config);
}
