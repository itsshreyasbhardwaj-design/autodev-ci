import { afterEach, beforeEach, vi } from 'vitest';
import { resetEnvCache } from '@/core/env';
import { setRootLogger } from '@/core/logger';
import { setStore } from '@/db';
import { setAIProvider } from '@/features/ai';

/**
 * Global test setup.
 *
 * Every module-level singleton is reset between tests. Without this, a test
 * that configures a GitHub token or swaps the AI provider leaks that state
 * into the next file and produces failures that only appear in certain
 * orderings — the worst kind of flake to debug.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    AUTODEV_AI_PROVIDER: 'deterministic',
    AUTODEV_DISABLE_RATE_LIMIT: 'true',
    // Never inherit real credentials into a test run.
    GITHUB_TOKEN: '',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    OPENROUTER_API_KEY: '',
    DATABASE_URL: '',
  };

  resetEnvCache();
  setRootLogger(undefined);
  setStore(undefined);
  setAIProvider(undefined, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
  setStore(undefined);
  setAIProvider(undefined, undefined);
});
