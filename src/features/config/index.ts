import { minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';
import { ValidationError } from '@/core/errors';
import { logger } from '@/core/logger';
import { type AutodevConfig, autodevConfigSchema, defaultConfig } from './schema';

export * from './schema';

/** Filenames checked, in order, when discovering repository configuration. */
export const CONFIG_FILENAMES = [
  '.autodev.yml',
  '.autodev.yaml',
  '.github/autodev.yml',
  '.github/autodev.yaml',
  '.autodev.json',
] as const;

/**
 * Parses repository configuration from YAML or JSON.
 *
 * A malformed config is a hard error rather than a silent fallback to
 * defaults: silently ignoring a typo'd `failOnSeverity` would leave a team
 * believing they have a gate that isn't running.
 */
export function parseConfig(source: string, filename = '.autodev.yml'): AutodevConfig {
  if (source.trim().length === 0) return defaultConfig();

  let raw: unknown;
  try {
    raw = filename.endsWith('.json') ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new ValidationError(`Failed to parse ${filename}`, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (raw === null || raw === undefined) return defaultConfig();

  const result = autodevConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`Invalid configuration in ${filename}`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return result.data;
}

/**
 * Loads configuration using a caller-supplied file reader.
 *
 * Taking a reader rather than an Octokit client keeps this usable from the
 * CLI (local filesystem), the webhook handler (GitHub API) and tests (a plain
 * object) without three implementations.
 */
export async function loadConfig(
  read: (path: string) => Promise<string | null>,
): Promise<{ config: AutodevConfig; source: string | null }> {
  for (const filename of CONFIG_FILENAMES) {
    let content: string | null;
    try {
      content = await read(filename);
    } catch (error) {
      logger().debug('Config lookup failed', { filename, error });
      continue;
    }

    if (content !== null) {
      return { config: parseConfig(content, filename), source: filename };
    }
  }

  return { config: defaultConfig(), source: null };
}

/**
 * Deep-merges an override object over a base config and re-validates.
 * Used to layer per-repository dashboard settings over `.autodev.yml`.
 */
export function mergeConfig(base: AutodevConfig, override: Record<string, unknown>): AutodevConfig {
  const merged = deepMerge(base as unknown as Record<string, unknown>, override);
  const result = autodevConfigSchema.safeParse(merged);
  if (!result.success) {
    logger().warn('Config override was invalid and has been discarded', {
      issues: result.error.issues.map((issue) => issue.path.join('.')),
    });
    return base;
  }
  return result.data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = output[key];
    // Arrays replace rather than concatenate — a maintainer setting
    // `categories: [security]` means "only security", not "security as well".
    output[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return output;
}

/** True when `path` matches any of the ignore globs. */
export function isIgnored(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

/** True when `path` matches any watch glob. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}
