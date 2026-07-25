import {
  Activity,
  BookOpen,
  GitPullRequest,
  LayoutDashboard,
  Package,
  Settings,
  ShieldAlert,
} from 'lucide-react';
import { GitHubMark } from '@/components/ui/github-mark';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { env } from '@/core/env';
import { getStore } from '@/db';

/**
 * Dashboard shell.
 *
 * A fixed left rail on desktop and a horizontal scroller on mobile. The
 * capability strip at the bottom of the rail is deliberate: a self-hosted tool
 * running with in-memory storage or unverified webhooks should say so where an
 * operator will see it, not bury it in a health endpoint.
 */

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/repositories', label: 'Repositories', icon: GitHubMark },
  { href: '/dashboard/reviews', label: 'Reviews', icon: GitPullRequest },
  { href: '/dashboard/findings', label: 'Findings', icon: ShieldAlert },
  { href: '/dashboard/health', label: 'Health', icon: Activity },
  { href: '/dashboard/releases', label: 'Releases', icon: Package },
  { href: '/dashboard/docs', label: 'Documentation', icon: BookOpen },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const store = getStore();
  const capabilities = env().capabilities;

  const active: Array<[string, boolean]> = [
    ['Storage', capabilities.persistentStorage],
    ['GitHub', capabilities.github],
    ['AI', capabilities.aiEnrichment],
    ['Auth', capabilities.managedAuth],
  ];

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-[color:var(--color-line)] lg:w-60 lg:border-b-0 lg:border-r">
        <div className="sticky top-0 flex h-full flex-col">
          <Link href="/" className="flex items-center gap-2.5 px-5 py-5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-[color:var(--color-signal)]/15 ring-1 ring-[color:var(--color-signal)]/30">
              <span className="font-mono text-sm font-medium text-[color:var(--color-signal-bright)]">
                A
              </span>
            </div>
            <span className="font-display text-[15px] font-semibold tracking-tight">
              AutoDev CI
            </span>
          </Link>

          <nav
            aria-label="Dashboard"
            className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-0"
          >
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] text-[color:var(--color-fg-muted)] transition-colors hover:bg-[color:var(--color-ink-800)] hover:text-[color:var(--color-fg)]"
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="mt-auto hidden px-5 py-5 lg:block">
            <p className="label mb-2.5">Capabilities</p>
            <ul className="space-y-1.5">
              {active.map(([label, enabled]) => (
                <li key={label} className="flex items-center gap-2 font-mono text-[11px]">
                  <span
                    className="size-1.5 rounded-full"
                    style={{
                      background: enabled ? 'var(--color-add)' : 'var(--color-fg-subtle)',
                    }}
                    aria-hidden
                  />
                  <span
                    className={
                      enabled
                        ? 'text-[color:var(--color-fg-muted)]'
                        : 'text-[color:var(--color-fg-subtle)]'
                    }
                  >
                    {label}
                  </span>
                  <span className="ml-auto text-[color:var(--color-fg-subtle)]">
                    {enabled ? 'on' : 'off'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 font-mono text-[10px] leading-relaxed text-[color:var(--color-fg-subtle)]">
              storage: {store.kind}
              <br />
              engine: {capabilities.aiEnrichment ? 'hybrid' : 'deterministic'}
            </p>
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  );
}
