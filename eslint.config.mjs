import js from '@eslint/js';
// eslint-config-next v16 ships a native flat config, so it is spread directly
// rather than wrapped in FlatCompat (which cannot serialise it).
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'dist/**',
      'action/dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'drizzle/**',
      'next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextCoreWebVitals,
  {
    /*
     * Typed linting for our own TypeScript.
     *
     * This block comes after the Next.js config on purpose: Next installs its
     * own parser globally, and rules like `consistent-type-imports` need type
     * information that parser does not forward. Re-declaring the parser here
     * for `src/` and `tests/` only keeps typed rules working without asking
     * the type checker to process config files.
     */
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../../*'],
              message: 'Use the "@/" path alias instead of deep relative imports.',
            },
          ],
        },
      ],
    },
  },
  {
    // The CLI is a terminal program: writing to stdout is its entire purpose.
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  prettier,
);
