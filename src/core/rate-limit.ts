/**
 * Rate limiting.
 *
 * Uses a sliding-window counter: each key holds the timestamps of recent hits
 * and anything older than the window is dropped on read. Compared to a fixed
 * window this avoids the burst-at-the-boundary problem where a client can send
 * 2x the limit across a window edge.
 *
 * The default store is in-process, which is correct for a single instance and
 * for the CLI. Serverless deployments running multiple instances should supply
 * a shared store (Redis, Upstash) via {@link createRateLimiter}; the interface
 * is deliberately small so an adapter is a few lines.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Unix ms at which the oldest hit in the window expires. */
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Records a hit and returns all hit timestamps still inside the window. */
  hit(key: string, windowMs: number, now: number): Promise<number[]> | number[];
  /** Drops a key's history entirely. */
  reset(key: string): Promise<void> | void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  hit(key: string, windowMs: number, now: number): number[] {
    this.sweep(now, windowMs);
    const cutoff = now - windowMs;
    const existing = this.hits.get(key) ?? [];
    const recent = existing.filter((timestamp) => timestamp > cutoff);
    recent.push(now);
    this.hits.set(key, recent);
    return recent;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /**
   * Periodically evicts keys with no recent activity. Without this a long-lived
   * process accumulates one Map entry per unique IP forever.
   */
  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    const cutoff = now - windowMs;
    for (const [key, timestamps] of this.hits) {
      const last = timestamps[timestamps.length - 1];
      if (last === undefined || last <= cutoff) this.hits.delete(key);
    }
  }

  /** Test helper. */
  clear(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs?: number;
  readonly store?: RateLimitStore;
  /** When true every request is allowed; used for tests and local dev. */
  readonly disabled?: boolean;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const limit = Math.max(1, options.limit);
  const windowMs = options.windowMs ?? 60_000;
  const store = options.store ?? new MemoryRateLimitStore();
  const disabled = options.disabled ?? false;

  return {
    async check(key: string): Promise<RateLimitResult> {
      const now = Date.now();

      if (disabled) {
        return {
          allowed: true,
          limit,
          remaining: limit,
          resetAt: now + windowMs,
          retryAfterSeconds: 0,
        };
      }

      const timestamps = await store.hit(key, windowMs, now);
      const count = timestamps.length;
      const oldest = timestamps[0] ?? now;
      const resetAt = oldest + windowMs;

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    },

    async reset(key: string): Promise<void> {
      await store.reset(key);
    },
  };
}

/** Standard `RateLimit-*` response headers for a result. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.allowed ? {} : { 'Retry-After': String(result.retryAfterSeconds) }),
  };
}
