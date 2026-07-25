/**
 * Typed error hierarchy.
 *
 * Every error thrown deliberately by AutoDev CI extends {@link AppError}, which
 * carries the three things an HTTP layer, a log line and a CLI all need:
 * a stable machine-readable `code`, an HTTP `status`, and a flag for whether
 * the message is safe to show a user. Anything else that escapes is treated as
 * an unexpected internal error and its message is never surfaced.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'GITHUB_ERROR'
  | 'AI_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  readonly code?: ErrorCode;
  readonly status?: number;
  readonly cause?: unknown;
  readonly details?: Record<string, unknown>;
  /** When true the message may be returned to API clients verbatim. */
  readonly expose?: boolean;
  /** Hint for callers that a retry with backoff may succeed. */
  readonly retryable?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly expose: boolean;
  readonly retryable: boolean;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.status = options.status ?? 500;
    this.details = options.details ?? {};
    this.expose = options.expose ?? this.status < 500;
    this.retryable = options.retryable ?? this.status >= 500;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Shape returned to API clients. Never includes internal messages. */
  toJSON(): {
    error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
  } {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'An unexpected internal error occurred.',
        ...(Object.keys(this.details).length > 0 && this.expose ? { details: this.details } : {}),
      },
    };
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: Record<string, unknown>) {
    super(message, { code: 'BAD_REQUEST', status: 400, details, expose: true });
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: Record<string, unknown>) {
    super(message, { code: 'VALIDATION_FAILED', status: 422, details, expose: true });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { code: 'UNAUTHORIZED', status: 401, expose: true });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, { code: 'FORBIDDEN', status: 403, expose: true });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, { code: 'NOT_FOUND', status: 404, expose: true });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, { code: 'CONFLICT', status: 409, expose: true });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Rate limit exceeded') {
    super(message, {
      code: 'RATE_LIMITED',
      status: 429,
      expose: true,
      retryable: true,
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'CONFIGURATION_ERROR', status: 503, details, expose: true });
  }
}

export class GitHubError extends AppError {
  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    const status = options.status ?? 502;
    super(message, {
      code: 'GITHUB_ERROR',
      // Client errors from GitHub are usually our fault (bad request, missing
      // permission) and are safe to surface; 5xx is upstream and retryable.
      status: status >= 400 && status < 500 ? status : 502,
      cause: options.cause,
      expose: true,
      retryable: status >= 500 || status === 429,
      details: { upstreamStatus: status },
    });
  }
}

export class AIError extends AppError {
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, {
      code: 'AI_ERROR',
      status: 502,
      cause: options.cause,
      expose: true,
      retryable: options.retryable ?? true,
    });
  }
}

export class TimeoutError extends AppError {
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`, {
      code: 'TIMEOUT',
      status: 504,
      expose: true,
      retryable: true,
      details: { operation, timeoutMs: ms },
    });
  }
}

/** Narrows unknown catch-bindings without losing information. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError(error.message, { cause: error, expose: false });
  }
  return new AppError(String(error), { expose: false });
}

/** Extracts a loggable message from any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
