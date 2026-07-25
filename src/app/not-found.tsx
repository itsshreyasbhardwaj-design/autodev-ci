import Link from 'next/link';
import { ButtonLink } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center"
    >
      <p className="label">404</p>
      <h1 className="font-display text-[clamp(2rem,5vw,3rem)]">This page does not exist</h1>
      <p className="max-w-md text-pretty text-[color:var(--color-fg-muted)]">
        The link may be out of date. The dashboard has everything AutoDev CI has analysed so far.
      </p>
      <div className="mt-2 flex gap-3">
        <ButtonLink href="/dashboard">Open the dashboard</ButtonLink>
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-lg border border-[color:var(--color-line)] px-4 text-sm transition-colors hover:border-[color:var(--color-line-bright)]"
        >
          Back home
        </Link>
      </div>
    </main>
  );
}
