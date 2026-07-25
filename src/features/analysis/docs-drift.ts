import type { Finding } from '@/core/types';
import { addedLines, removedLines, type FileDiff, isDocFile } from '@/features/github/diff';
import { createFinding } from './types';

/**
 * Documentation drift detection.
 *
 * Documentation goes stale silently — nothing fails when a README describes a
 * flag that no longer exists. This looks for the specific code changes that
 * *imply* a documentation change and checks whether one happened:
 *
 *   - environment variables added or removed
 *   - CLI flags and commands changed
 *   - exported API surface changed
 *   - HTTP routes added or removed
 *   - install/build scripts changed
 *   - configuration schema changed
 *
 * Each signal names the file it thinks should be updated, so the suggestion is
 * actionable rather than a generic "consider updating the docs".
 */

export interface DriftSignal {
  readonly kind: string;
  readonly detail: string;
  /** Documentation paths most likely to need the update. */
  readonly suggestedDocs: readonly string[];
  readonly items: readonly string[];
}

const ENV_VAR =
  /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{2,})\b|\bos\.environ(?:\.get)?\[?['"]([A-Z][A-Z0-9_]{2,})['"]/g;
const CLI_FLAG = /['"`](--[a-z][a-z0-9-]{2,})['"`]/g;
const EXPORTED_SYMBOL =
  /^\s*export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/;
const HTTP_ROUTE =
  /\b(?:app|router|server)\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const NEXT_ROUTE = /^(?:src\/)?app\/(.+)\/route\.[cm]?tsx?$/;

function collectMatches(files: readonly FileDiff[], pattern: RegExp, added: boolean): Set<string> {
  const results = new Set<string>();

  for (const file of files) {
    if (isDocFile(file.path)) continue;
    const lines = added ? addedLines(file) : removedLines(file);

    for (const line of lines) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line.content)) !== null) {
        const value = match[1] ?? match[2];
        if (value) results.add(value);
      }
    }
  }

  return results;
}

function collectLineMatches(
  files: readonly FileDiff[],
  pattern: RegExp,
  added: boolean,
): Set<string> {
  const results = new Set<string>();

  for (const file of files) {
    if (isDocFile(file.path)) continue;
    const lines = added ? addedLines(file) : removedLines(file);
    for (const line of lines) {
      const match = pattern.exec(line.content);
      if (match?.[1]) results.add(match[1]);
    }
  }

  return results;
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((item) => !b.has(item));
}

/** Returns the drift signals present in a change set. */
export function detectDriftSignals(files: readonly FileDiff[]): DriftSignal[] {
  const signals: DriftSignal[] = [];

  // --- Environment variables ---------------------------------------------

  const envAdded = difference(
    collectMatches(files, ENV_VAR, true),
    collectMatches(files, ENV_VAR, false),
  );

  if (envAdded.length > 0) {
    signals.push({
      kind: 'environment-variables',
      detail: `${envAdded.length} new environment variable(s) are read by the code`,
      suggestedDocs: ['.env.example', 'README.md', 'docs/configuration.md'],
      items: envAdded,
    });
  }

  // --- CLI flags ----------------------------------------------------------

  const flagsAdded = difference(
    collectMatches(files, CLI_FLAG, true),
    collectMatches(files, CLI_FLAG, false),
  );

  if (flagsAdded.length > 0) {
    signals.push({
      kind: 'cli-flags',
      detail: `${flagsAdded.length} new CLI flag(s) were added`,
      suggestedDocs: ['README.md', 'docs/cli.md', 'docs/usage.md'],
      items: flagsAdded,
    });
  }

  // --- Public API ---------------------------------------------------------

  const exportsAdded = collectLineMatches(files, EXPORTED_SYMBOL, true);
  const exportsRemoved = collectLineMatches(files, EXPORTED_SYMBOL, false);
  const removedApi = difference(exportsRemoved, exportsAdded);

  if (removedApi.length > 0) {
    signals.push({
      kind: 'removed-api',
      detail: `${removedApi.length} export(s) were removed — this is a breaking change for consumers`,
      suggestedDocs: ['README.md', 'docs/api.md', 'CHANGELOG.md', 'MIGRATION.md'],
      items: removedApi,
    });
  }

  const addedApi = difference(exportsAdded, exportsRemoved);
  if (addedApi.length >= 3) {
    signals.push({
      kind: 'new-api',
      detail: `${addedApi.length} new export(s) were added to the public surface`,
      suggestedDocs: ['README.md', 'docs/api.md'],
      items: addedApi.slice(0, 15),
    });
  }

  // --- HTTP routes --------------------------------------------------------

  const routes = new Set<string>();
  for (const file of files) {
    const nextRoute = NEXT_ROUTE.exec(file.path);
    if (nextRoute?.[1] && file.status === 'added') routes.add(`/${nextRoute[1]}`);
  }
  for (const route of collectMatches(files, HTTP_ROUTE, true)) routes.add(route);

  if (routes.size > 0) {
    signals.push({
      kind: 'http-routes',
      detail: `${routes.size} HTTP route(s) were added or changed`,
      suggestedDocs: ['README.md', 'docs/api.md', 'openapi.yaml'],
      items: [...routes],
    });
  }

  // --- Build and install scripts -----------------------------------------

  const scriptFiles = files.filter((file) =>
    /(?:^|\/)(?:package\.json|Makefile|Dockerfile|docker-compose\.ya?ml|pyproject\.toml)$/.test(
      file.path,
    ),
  );

  const scriptChanged = scriptFiles.some((file) =>
    addedLines(file).some((line) =>
      /"scripts"|"(?:build|start|dev|test|install)"\s*:|^RUN |^CMD /.test(line.content),
    ),
  );

  if (scriptChanged) {
    signals.push({
      kind: 'build-scripts',
      detail: 'Build, install or run scripts changed',
      suggestedDocs: ['README.md', 'CONTRIBUTING.md', 'docs/setup.md'],
      items: scriptFiles.map((file) => file.path),
    });
  }

  return signals;
}

export interface DocDriftInput {
  readonly files: readonly FileDiff[];
  /** Documentation files that exist in the repository, with their contents. */
  readonly documents?: ReadonlyArray<{ path: string; content: string }>;
}

/**
 * Converts drift signals into findings.
 *
 * A signal only becomes a finding when the relevant documentation was *not*
 * updated in the same change, and — when document contents are available —
 * when the specific item is genuinely absent from them. That second check is
 * what stops this from nagging about a variable the README already documents.
 */
export function detectDocumentationDrift(input: DocDriftInput): Finding[] {
  const signals = detectDriftSignals(input.files);
  if (signals.length === 0) return [];

  const changedDocs = new Set(
    input.files.filter((file) => isDocFile(file.path)).map((file) => file.path),
  );

  const documentText = (input.documents ?? [])
    .map((doc) => doc.content)
    .join('\n')
    .toLowerCase();
  const haveDocuments = (input.documents?.length ?? 0) > 0;

  const findings: Finding[] = [];

  for (const signal of signals) {
    // Undocumented items only; if the docs already mention it, there is no drift.
    const missing = haveDocuments
      ? signal.items.filter((item) => !documentText.includes(item.toLowerCase()))
      : signal.items;

    if (missing.length === 0) continue;

    // If a suggested doc was edited in this same change, assume it was handled.
    const docUpdated = signal.suggestedDocs.some((doc) => changedDocs.has(doc));
    if (docUpdated && missing.length <= 2) continue;

    const isBreaking = signal.kind === 'removed-api';

    findings.push(
      createFinding({
        rule: `documentation/${signal.kind}`,
        category: 'documentation',
        severity: isBreaking ? 'medium' : 'low',
        title: `Documentation may be out of date: ${signal.detail}`,
        description: [
          signal.detail + '.',
          '',
          '**Not found in the documentation:**',
          ...missing.slice(0, 12).map((item) => `- \`${item}\``),
          ...(missing.length > 12 ? [`- …and ${missing.length - 12} more`] : []),
          '',
          `**Likely needs updating:** ${signal.suggestedDocs.map((doc) => `\`${doc}\``).join(', ')}`,
          ...(isBreaking
            ? [
                '',
                'Removed exports are a breaking change. Consumers upgrading need a migration note explaining what replaces them.',
              ]
            : []),
        ].join('\n'),
        location: { path: signal.suggestedDocs[0] ?? 'README.md' },
        suggestion: {
          description: isBreaking
            ? 'Document the removal and the replacement in the changelog and migration guide.'
            : `Document these in ${signal.suggestedDocs[0] ?? 'README.md'}.`,
        },
        confidence: haveDocuments ? 0.8 : 0.55,
      }),
    );
  }

  return findings;
}
