'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * Root error boundary.
 *
 * States what happened and what to do about it. The digest is shown because it
 * is the one thing that lets someone correlate this screen with a server log
 * line — the message itself is deliberately withheld by Next.js in production.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled application error', error);
  }, [error]);

  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center"
    >
      <p className="label text-[color:var(--color-sev-high)]">Error</p>
      <h1 className="font-display text-[clamp(1.75rem,4vw,2.5rem)]">This page failed to load</h1>
      <p className="max-w-md text-pretty text-[color:var(--color-fg-muted)]">
        Something went wrong while rendering. Retrying often resolves it; if it does not, the digest
        below identifies this failure in the server logs.
      </p>
      {error.digest ? (
        <code className="rounded-md border border-[color:var(--color-line)] px-3 py-1.5 font-mono text-[12px] text-[color:var(--color-fg-subtle)]">
          {error.digest}
        </code>
      ) : null}
      <Button onClick={reset} className="mt-2">
        Try again
      </Button>
    </main>
  );
}
