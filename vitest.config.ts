import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    // Vitest 4 removed `environmentMatchGlobs`; UI tests opt in per-file with
    // an `@vitest-environment jsdom` docblock.
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      /*
       * Coverage measures the layers this suite is responsible for: the pure
       * analysis engine, the core utilities, the storage contract and the API
       * middleware.
       *
       * Excluded below are the layers whose correctness is established
       * elsewhere, so that the threshold stays a real signal rather than an
       * average diluted by code Vitest was never going to execute:
       *
       *  - `src/app/**` and `src/components/**` — rendered and asserted by the
       *    Playwright suite against a production build.
       *  - `src/server/services/**` and the Octokit wrappers — live GitHub I/O,
       *    exercised end-to-end by the CLI against real repositories.
       *  - `src/db/drizzle-store.ts` — needs a Postgres instance; the in-memory
       *    adapter is tested against the same DataStore contract.
       *  - `src/cli/**` — the binary is smoke-tested in CI.
       */
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/app/**',
        'src/components/**',
        'src/cli/**',
        'src/server/services/**',
        'src/features/github/client.ts',
        'src/features/github/publish.ts',
        'src/db/drizzle-store.ts',
        'src/db/schema.ts',
        'src/db/index.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
