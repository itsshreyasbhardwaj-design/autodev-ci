import { defineConfig } from 'tsup';

/**
 * Bundles the `autodev` CLI into a single self-contained ESM file so the
 * GitHub Action can run it without a `pnpm install` step in the consumer repo.
 */
export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  minify: false,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
