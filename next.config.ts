import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * The CSP is intentionally strict. `'unsafe-inline'` is required for styles
 * because Next.js injects critical CSS inline during streaming SSR; scripts are
 * restricted to same-origin plus the nonce-less inline bootstrap Next emits,
 * which is why `'self'` + `'unsafe-eval'` is limited to development only.
 */
const isProd = process.env.NODE_ENV === 'production';

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com https://github.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.github.com https://openrouter.ai",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {},
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },
  typedRoutes: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
