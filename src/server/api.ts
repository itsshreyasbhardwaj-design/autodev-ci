import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { generateId, fingerprint, safeEqual } from '@/core/crypto';
import { env } from '@/core/env';
import {
  type AppError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  toAppError,
} from '@/core/errors';
import { logger } from '@/core/logger';
import { createRateLimiter, rateLimitHeaders, type RateLimiter } from '@/core/rate-limit';

/**
 * REST API plumbing.
 *
 * Every route goes through {@link handler}, which owns the cross-cutting
 * concerns — request id, structured logging, authentication, rate limiting,
 * validation and error shaping. Keeping them here rather than in each route
 * means a new endpoint cannot accidentally ship without a rate limit, and the
 * error envelope is guaranteed identical everywhere.
 */

export interface ApiContext {
  readonly requestId: string;
  readonly request: Request;
  readonly params: Record<string, string>;
  /** Fingerprint of the presented API key, or `anonymous`. */
  readonly principal: string;
  readonly log: ReturnType<typeof logger>;
}

export interface HandlerOptions<TBody = unknown, TQuery = unknown> {
  /** Require a valid bearer token. Defaults to true when API keys are configured. */
  readonly auth?: boolean;
  readonly bodySchema?: z.ZodType<TBody>;
  readonly querySchema?: z.ZodType<TQuery>;
  /** Per-minute limit for this route. Defaults to `RATE_LIMIT_PER_MINUTE`. */
  readonly rateLimit?: number;
  readonly rateLimitKey?: (context: ApiContext) => string;
}

export interface HandlerInput<TBody, TQuery> extends ApiContext {
  readonly body: TBody;
  readonly query: TQuery;
}

let sharedLimiter: RateLimiter | undefined;

function limiter(): RateLimiter {
  sharedLimiter ??= createRateLimiter({
    limit: env().RATE_LIMIT_PER_MINUTE,
    disabled: env().AUTODEV_DISABLE_RATE_LIMIT || env().isTest,
  });
  return sharedLimiter;
}

/** Test helper: resets the shared limiter between cases. */
export function resetRateLimiter(): void {
  sharedLimiter = undefined;
}

/**
 * Extracts the client identity for rate limiting.
 *
 * Prefers the API key so one noisy key cannot exhaust the budget for a whole
 * NAT'd office. Falls back to the forwarded IP, taking the *first* entry
 * because that is the original client; later entries are proxies.
 */
function clientKey(request: Request, principal: string): string {
  if (principal !== 'anonymous') return `key:${principal}`;

  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
  return `ip:${ip}`;
}

/**
 * Authenticates a bearer token against the configured API keys.
 *
 * Comparison is constant-time. When no keys are configured the API is open,
 * which is correct for local evaluation and is surfaced as a warning on the
 * health endpoint so it cannot be missed in production.
 */
function authenticate(request: Request): string {
  const keys = env().apiKeys;
  if (keys.length === 0) return 'anonymous';

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Provide an API key as `Authorization: Bearer <key>`');
  }

  const presented = header.slice('Bearer '.length).trim();
  const matched = keys.some((key) => safeEqual(key, presented));

  if (!matched) throw new UnauthorizedError('Invalid API key');
  return fingerprint(presented);
}

function errorResponse(
  error: AppError,
  requestId: string,
  extraHeaders: HeadersInit = {},
): NextResponse {
  return NextResponse.json(
    { ...error.toJSON(), requestId },
    {
      status: error.status,
      headers: {
        'x-request-id': requestId,
        ...(error instanceof RateLimitError
          ? { 'Retry-After': String(error.retryAfterSeconds) }
          : {}),
        ...extraHeaders,
      },
    },
  );
}

export type RouteHandler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>;

/**
 * Wraps a route implementation with the standard middleware chain.
 *
 * @example
 * export const GET = handler(async ({ query }) => ok({ items: [] }), {
 *   querySchema: listQuerySchema,
 * });
 */
export function handler<TBody = undefined, TQuery = undefined>(
  fn: (input: HandlerInput<TBody, TQuery>) => Promise<NextResponse> | NextResponse,
  options: HandlerOptions<TBody, TQuery> = {},
): RouteHandler {
  return async (request, routeContext) => {
    const requestId = request.headers.get('x-request-id') ?? generateId();
    const startedAt = performance.now();
    const url = new URL(request.url);

    const log = logger().child({
      requestId,
      method: request.method,
      path: url.pathname,
    });

    try {
      const params = routeContext?.params ? await routeContext.params : {};

      // --- Authentication --------------------------------------------------
      const requiresAuth = options.auth ?? env().apiKeys.length > 0;
      const principal = requiresAuth ? authenticate(request) : 'anonymous';

      const context: ApiContext = { requestId, request, params, principal, log };

      // --- Rate limiting ---------------------------------------------------
      const key = options.rateLimitKey?.(context) ?? clientKey(request, principal);
      const routeLimiter = options.rateLimit
        ? createRateLimiter({
            limit: options.rateLimit,
            disabled: env().AUTODEV_DISABLE_RATE_LIMIT || env().isTest,
          })
        : limiter();

      const limit = await routeLimiter.check(`${url.pathname}:${key}`);
      if (!limit.allowed) {
        throw new RateLimitError(limit.retryAfterSeconds);
      }

      // --- Validation ------------------------------------------------------
      let body = undefined as TBody;
      if (options.bodySchema) {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          throw new ValidationError('Request body must be valid JSON');
        }

        const parsed = options.bodySchema.safeParse(raw);
        if (!parsed.success) {
          throw new ValidationError('Request body failed validation', {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }
        body = parsed.data;
      }

      let query = undefined as TQuery;
      if (options.querySchema) {
        const raw = Object.fromEntries(url.searchParams.entries());
        const parsed = options.querySchema.safeParse(raw);
        if (!parsed.success) {
          throw new ValidationError('Query parameters failed validation', {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }
        query = parsed.data;
      }

      // --- Handler ---------------------------------------------------------
      const response = await fn({ ...context, body, query });

      response.headers.set('x-request-id', requestId);
      for (const [header, value] of Object.entries(rateLimitHeaders(limit))) {
        response.headers.set(header, value);
      }

      log.info('Request completed', {
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return response;
    } catch (error) {
      const appError = toAppError(error);

      // 5xx is our bug and needs a stack; 4xx is the caller's and does not.
      if (appError.status >= 500) {
        log.error('Request failed', {
          error: appError,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } else {
        log.warn('Request rejected', {
          code: appError.code,
          status: appError.status,
          message: appError.message,
        });
      }

      return errorResponse(appError, requestId);
    }
  };
}

/** 200 response with a JSON body. */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { status: 200, ...init });
}

/** 201 response. */
export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

/** 202 for work that continues in the background. */
export function accepted<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 202 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * Streams text as Server-Sent Events.
 *
 * Used by the AI endpoints so the dashboard renders tokens as they arrive
 * rather than after a 30-second wait.
 */
export function streamResponse(
  source: AsyncIterable<string>,
  init: { requestId?: string } = {},
): NextResponse {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of source) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: chunk })}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables proxy buffering, without which nothing reaches the browser
      // until the whole stream completes.
      'X-Accel-Buffering': 'no',
      ...(init.requestId ? { 'x-request-id': init.requestId } : {}),
    },
  });
}
