import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Fonts are self-hosted by `next/font`, which matters here: the Content
 * Security Policy in `next.config.ts` blocks external font hosts, and
 * self-hosting also removes a render-blocking third-party request.
 */
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'AutoDev CI — AI pull request review that ships with its own evidence',
    template: '%s · AutoDev CI',
  },
  description:
    'Automated pull request review, changelog generation, documentation drift detection and repository health scoring for GitHub. Deterministic analysis first, AI second.',
  keywords: ['code review', 'github', 'ci/cd', 'static analysis', 'changelog', 'devops'],
  authors: [{ name: 'AutoDev CI' }],
  openGraph: {
    type: 'website',
    title: 'AutoDev CI',
    description:
      'Automated pull request review, changelog generation and repository health scoring for GitHub.',
    siteName: 'AutoDev CI',
  },
  twitter: { card: 'summary_large_image', title: 'AutoDev CI' },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#070a12',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${plexSans.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[color:var(--color-signal)] focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
