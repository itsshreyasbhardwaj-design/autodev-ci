/**
 * TTL cache with single-flight de-duplication.
 *
 * Analysis runs hammer the same GitHub endpoints (repo metadata, file
 * contents, commit lists) many times within a few seconds. This cache both
 * serves repeats from memory and, crucially, collapses *concurrent* misses for
 * the same key into one upstream call — without that, ten analyzers starting
 * at once produce ten identical API requests and burn the rate limit.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  private hits = 0;
  private misses = 0;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 500;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so `evict` approximates LRU rather than FIFO.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    this.evictIfNeeded();
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Returns the cached value, or computes it via `factory`. Concurrent calls
   * for the same key share a single `factory` invocation.
   */
  async getOrCompute(key: string, factory: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.hits += 1;
      return pending;
    }

    this.misses += 1;
    const promise = factory()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  get stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      hitRate: total === 0 ? 0 : Number((this.hits / total).toFixed(3)),
    };
  }

  private evictIfNeeded(): void {
    if (this.entries.size < this.maxEntries) return;

    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }

    // Still full after dropping expired entries: evict oldest-first.
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
