import { errorMessage } from './errors';

/**
 * Structured logger.
 *
 * Emits newline-delimited JSON in production (so Vercel/Datadog/CloudWatch can
 * index it) and a compact coloured format in development. Child loggers carry
 * bindings — request id, repository, PR number — so every line from a single
 * analysis run can be correlated without threading context manually.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a new logger that merges `bindings` into every emitted record. */
  child(bindings: LogFields): Logger;
  /** Times an async operation and logs its duration and outcome. */
  time<T>(operation: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
}

/**
 * Keys whose values are redacted before serialisation. Matching is
 * case-insensitive and substring-based so `githubAppPrivateKey`,
 * `GITHUB_TOKEN` and `authorization` are all caught.
 */
const SENSITIVE_KEY_PATTERNS = [
  'token',
  'secret',
  'password',
  'apikey',
  'api_key',
  'authorization',
  'privatekey',
  'private_key',
  'encryptionkey',
  'signature',
  'cookie',
  'credential',
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalised.includes(pattern.replace(/_/g, '')));
}

/**
 * Recursively redacts sensitive values and makes the payload JSON-safe.
 * Handles cycles, Errors, Maps/Sets and BigInt, all of which appear in real
 * log payloads and would otherwise throw or serialise to `{}`.
 */
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[max depth]';

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${(value as bigint).toString()}n`;
  if (type === 'function') return '[function]';
  if (type === 'symbol') return (value as symbol).toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause !== undefined ? { cause: sanitize(value.cause, depth + 1, seen) } : {}),
      stack: value.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.source;

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => sanitize(item, depth + 1, seen));
    }
    if (value instanceof Map) {
      return Object.fromEntries(
        [...value.entries()]
          .slice(0, 100)
          .map(([k, v]) => [
            String(k),
            isSensitiveKey(String(k)) ? REDACTED : sanitize(v, depth + 1, seen),
          ]),
      );
    }
    if (value instanceof Set) {
      return [...value].slice(0, 100).map((item) => sanitize(item, depth + 1, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? REDACTED : sanitize(item, depth + 1, seen);
    }
    return output;
  }

  return String(value);
}

export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly time: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

/** Where records go. Swapped out in tests to assert on emitted logs. */
export type LogSink = (record: LogRecord) => void;

const ANSI: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

/** Warnings and errors go to stderr so stdout stays parseable for the CLI. */
function write(level: Exclude<LogLevel, 'silent'>, line: string): void {
  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

function consoleSink(pretty: boolean): LogSink {
  return (record) => {
    if (pretty) {
      const colour = ANSI[record.level];
      const extras =
        Object.keys(record.fields).length > 0 ? ` ${JSON.stringify(record.fields)}` : '';
      const line = `${colour}${record.level.toUpperCase().padEnd(5)}${RESET} ${record.message}${extras}`;
      write(record.level, line);
      return;
    }
    const line = JSON.stringify({
      level: record.level,
      time: record.time,
      msg: record.message,
      ...record.fields,
    });
    write(record.level, line);
  };
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly pretty?: boolean;
  readonly sink?: LogSink;
  readonly bindings?: LogFields;
}

class StructuredLogger implements Logger {
  private readonly threshold: number;
  private readonly sink: LogSink;
  private readonly bindings: LogFields;
  private readonly options: Required<Pick<LoggerOptions, 'level' | 'pretty'>>;

  constructor(options: LoggerOptions = {}) {
    const level = options.level ?? 'info';
    const pretty = options.pretty ?? false;
    this.options = { level, pretty };
    this.threshold = LEVEL_WEIGHT[level];
    this.sink = options.sink ?? consoleSink(pretty);
    this.bindings = options.bindings ?? {};
  }

  private emit(level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const merged = { ...this.bindings, ...fields };
    this.sink({
      level,
      time: new Date().toISOString(),
      message,
      fields: sanitize(merged) as Record<string, unknown>,
    });
  }

  debug(message: string, fields?: LogFields): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger({
      ...this.options,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  async time<T>(operation: string, fn: () => Promise<T>, fields?: LogFields): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await fn();
      this.debug(`${operation} completed`, {
        ...fields,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      this.error(`${operation} failed`, {
        ...fields,
        durationMs: Math.round(performance.now() - startedAt),
        error: errorMessage(error),
      });
      throw error;
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

/**
 * A logger that discards everything. Used by tests and by the CLI when
 * `--quiet` is passed.
 */
export function createNullLogger(): Logger {
  return new StructuredLogger({ level: 'silent', sink: () => {} });
}

let rootLogger: Logger | undefined;

/** Process-wide logger, configured from the environment on first use. */
export function logger(): Logger {
  if (!rootLogger) {
    // Imported lazily to avoid a module cycle: env -> errors -> logger.
    const level = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    rootLogger = createLogger({
      level: nodeEnv === 'test' ? 'silent' : level,
      pretty: nodeEnv === 'development',
    });
  }
  return rootLogger;
}

/** Test helper: replaces the process-wide logger. */
export function setRootLogger(next: Logger | undefined): void {
  rootLogger = next;
}
