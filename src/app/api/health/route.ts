import { env } from '@/core/env';
import { getStore } from '@/db';
import { handler, ok } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness and readiness probe.
 *
 * Deliberately unauthenticated so load balancers and uptime monitors can reach
 * it, and deliberately explicit about which capabilities are active — an
 * operator seeing `apiAuth: false` in production has found a real problem.
 */
export const GET = handler(
  async () => {
    const store = getStore();
    const e = env();

    let storeHealthy = false;
    let storeError: string | undefined;

    try {
      storeHealthy = await store.ping();
    } catch (error) {
      storeError = error instanceof Error ? error.message : String(error);
    }

    const warnings: string[] = [];
    if (e.isProduction && !e.capabilities.persistentStorage) {
      warnings.push('Running in production with in-memory storage — data is lost on restart.');
    }
    if (e.isProduction && !e.capabilities.webhookVerification) {
      warnings.push('GITHUB_WEBHOOK_SECRET is not set — webhook signatures are not verified.');
    }
    if (e.isProduction && !e.capabilities.apiAuth) {
      warnings.push('AUTODEV_API_KEYS is not set — the REST API is publicly writable.');
    }
    if (e.isProduction && !e.capabilities.managedAuth) {
      warnings.push('No authentication provider configured — the dashboard is unprotected.');
    }

    return ok(
      {
        status: storeHealthy ? 'ok' : 'degraded',
        version: process.env.npm_package_version ?? '0.1.0',
        timestamp: new Date().toISOString(),
        storage: {
          adapter: store.kind,
          healthy: storeHealthy,
          ...(storeError ? { error: storeError } : {}),
        },
        capabilities: e.capabilities,
        engine: e.capabilities.aiEnrichment ? 'hybrid' : 'deterministic',
        warnings,
      },
      { status: storeHealthy ? 200 : 503 },
    );
  },
  { auth: false, rateLimit: 120 },
);
