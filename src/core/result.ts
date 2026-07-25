/**
 * A lightweight Result type.
 *
 * Used at boundaries where failure is an expected outcome rather than an
 * exception — a single analyzer failing should not abort a whole review, and a
 * notification channel being down should not fail the run that triggered it.
 * Exceptions remain the right tool for genuinely unexpected states.
 */

export type Result<T, E = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Runs `fn`, converting a thrown value into an `err`. */
export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Splits settled results into successes and failures. */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): {
  values: T[];
  errors: E[];
} {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return { values, errors };
}
