import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { DrizzleStore } from './drizzle-store';
import { MemoryStore } from './memory-store';
import * as schema from './schema';
import type { DataStore } from './store';

/**
 * Store factory.
 *
 * Picks the Postgres adapter when `DATABASE_URL` is set and the in-memory one
 * otherwise, then memoises the result. Serverless functions re-run module code
 * per cold start but reuse the module scope across warm invocations, so the
 * connection pool is created once per instance rather than once per request —
 * which is what keeps Supabase's connection limit from being exhausted.
 */

let store: DataStore | undefined;
let sqlClient: ReturnType<typeof postgres> | undefined;

function createPostgresStore(url: string): DataStore {
  sqlClient = postgres(url, {
    max: env().DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // Supabase's pooled endpoint does not support prepared statements.
    prepare: false,
    ...(env().DATABASE_SSL === 'require' ? { ssl: 'require' as const } : {}),
    onnotice: () => {},
  });

  const db = drizzle(sqlClient, { schema });
  logger().info('Database connected', { adapter: 'postgres', poolMax: env().DATABASE_POOL_MAX });
  return new DrizzleStore(db);
}

export function getStore(): DataStore {
  if (store) return store;

  const url = env().DATABASE_URL;
  if (url) {
    store = createPostgresStore(url);
  } else {
    logger().warn(
      'No DATABASE_URL configured — using in-memory storage. Data will not survive a restart.',
    );
    store = new MemoryStore();
  }

  return store;
}

/** Test helper: injects a store (usually a fresh {@link MemoryStore}). */
export function setStore(next: DataStore | undefined): void {
  store = next;
}

/** Closes the pool. Called from CLI teardown; serverless hosts do not need it. */
export async function closeStore(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
  }
  store = undefined;
}

export { MemoryStore } from './memory-store';
export { DrizzleStore } from './drizzle-store';
export * from './store';
export * as schema from './schema';
