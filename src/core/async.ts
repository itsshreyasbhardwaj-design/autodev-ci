import { TimeoutError } from './errors';

/** Resolves after `ms`, honouring an optional abort signal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects with a {@link TimeoutError} if `promise` does not settle in time. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  operation = 'Operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(operation, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Return false to stop retrying a particular error. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Retries `fn` with exponential backoff and full jitter.
 *
 * Full jitter (a uniform random delay in `[0, backoff]`) rather than fixed
 * backoff matters here: when GitHub rate-limits us, every in-flight analyzer
 * fails at the same instant, and without jitter they would all retry in
 * lockstep and be limited again.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts;
      if (isLast || !shouldRetry(error, attempt)) break;

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * exponential);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

/**
 * Runs `tasks` with bounded concurrency, preserving input order in the output.
 *
 * `Promise.all` over 200 files would open 200 sockets at once and trip
 * secondary rate limits; this keeps a fixed number of workers pulling from a
 * shared cursor.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Like {@link mapWithConcurrency} but never rejects: failures are captured
 * per-item so one bad file cannot abort an entire analysis run.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<
  Array<{ item: T; index: number } & ({ ok: true; value: R } | { ok: false; error: Error })>
> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { item, index, ok: true as const, value: await mapper(item, index) };
    } catch (error) {
      return {
        item,
        index,
        ok: false as const,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  });
}
