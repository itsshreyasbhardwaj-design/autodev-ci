import type { Finding } from '@/core/types';
import { addedLines, type FileDiff } from '@/features/github/diff';
import { type AnalysisContext, type Analyzer, createFinding, lineLocation } from '../types';

/**
 * Dependency analysis.
 *
 * Runs without a network call, so it cannot query an advisory database. What
 * it does instead is catch the dependency mistakes that are visible in the
 * diff itself: known-abandoned or known-malicious packages, version ranges
 * that silently accept anything, protocol-level supply-chain risks (git and
 * http URLs), and manifest changes with no matching lockfile update.
 *
 * The advisory feed is a deliberate follow-up rather than a gap: doing it
 * properly means an authenticated OSV/GitHub Advisory query, which belongs in
 * a background job, not in the synchronous review path.
 */

const MANIFEST_FILES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
]);

const LOCKFILES: Record<string, readonly string[]> = {
  'package.json': ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'],
  'requirements.txt': ['requirements.lock', 'requirements-lock.txt'],
  'pyproject.toml': ['poetry.lock', 'uv.lock', 'pdm.lock'],
  Gemfile: ['Gemfile.lock'],
  'go.mod': ['go.sum'],
  'Cargo.toml': ['Cargo.lock'],
  'composer.json': ['composer.lock'],
};

/**
 * Packages that are deprecated, unmaintained, or have a documented history of
 * compromise. Kept short and high-confidence on purpose.
 */
const FLAGGED_PACKAGES: Record<
  string,
  { severity: Finding['severity']; reason: string; alternative: string }
> = {
  request: {
    severity: 'medium',
    reason: 'Deprecated since 2020 and no longer receiving security fixes.',
    alternative: 'the built-in `fetch`, `undici`, or `axios`',
  },
  'event-stream': {
    severity: 'high',
    reason: 'Was compromised in a supply-chain attack (2018) and remains unmaintained.',
    alternative: 'native streams',
  },
  'node-uuid': {
    severity: 'medium',
    reason: 'Deprecated in favour of the `uuid` package.',
    alternative: '`uuid` or `crypto.randomUUID()`',
  },
  'left-pad': {
    severity: 'low',
    reason: 'Trivial functionality available natively.',
    alternative: '`String.prototype.padStart`',
  },
  moment: {
    severity: 'low',
    reason: 'In maintenance mode; large bundle and mutable API.',
    alternative: '`date-fns`, `dayjs`, or `Temporal`',
  },
  'crypto-js': {
    severity: 'medium',
    reason: 'Historically slow to patch cryptographic issues.',
    alternative: 'the platform `crypto` / WebCrypto APIs',
  },
  colors: {
    severity: 'high',
    reason: 'Was sabotaged by its maintainer in 2022 (infinite-loop payload).',
    alternative: '`picocolors` or `chalk`',
  },
  faker: {
    severity: 'medium',
    reason: 'The original package was withdrawn by its maintainer.',
    alternative: '`@faker-js/faker`',
  },
};

function parseJsonDependencies(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return {
      ...parsed.dependencies,
      ...parsed.devDependencies,
      ...parsed.peerDependencies,
    };
  } catch {
    return {};
  }
}

/** Extracts `"name": "range"` pairs from added lines of a package.json diff. */
function addedNpmDependencies(
  file: FileDiff,
): Array<{ name: string; range: string; line: number }> {
  const results: Array<{ name: string; range: string; line: number }> = [];
  const pattern = /^\s*"([@\w][\w./-]*)"\s*:\s*"([^"]+)"/;

  for (const line of addedLines(file)) {
    const match = pattern.exec(line.content);
    if (!match?.[1] || !match[2]) continue;
    // Skip top-level manifest fields that share the shape.
    if (['name', 'version', 'description', 'license', 'main', 'types'].includes(match[1])) continue;
    results.push({ name: match[1], range: match[2], line: line.newLine ?? 0 });
  }

  return results;
}

export const dependenciesAnalyzer: Analyzer = {
  id: 'dependencies',
  description: 'Reviews dependency additions for supply-chain and maintenance risk',
  categories: ['dependencies', 'security'],

  analyze(context: AnalysisContext): Finding[] {
    if (!context.config.security.dependencyAudit) return [];

    const findings: Finding[] = [];
    const changedPaths = new Set(context.allFiles.map((file) => file.path));

    for (const file of context.allFiles) {
      const basename = file.path.split('/').pop() ?? '';
      if (!MANIFEST_FILES.has(basename)) continue;

      // --- Lockfile drift ---------------------------------------------------

      const expectedLocks = LOCKFILES[basename];
      if (expectedLocks && file.additions + file.deletions > 0) {
        const lockUpdated = expectedLocks.some((lock) =>
          [...changedPaths].some((path) => path.endsWith(lock)),
        );

        if (!lockUpdated) {
          findings.push(
            createFinding({
              rule: 'dependencies/lockfile-not-updated',
              category: 'dependencies',
              severity: 'medium',
              title: `\`${basename}\` changed but no lockfile was updated`,
              description: [
                `Dependencies were modified in \`${file.path}\` without a corresponding change to ${expectedLocks
                  .map((lock) => `\`${lock}\``)
                  .join(' or ')}.`,
                '',
                'This means CI and every developer machine can resolve different versions than the author tested against — the "works on my machine" class of bug, but for the whole dependency tree.',
              ].join('\n'),
              location: { path: file.path },
              suggestion: {
                description: 'Run the package manager install command and commit the lockfile.',
              },
              confidence: 0.85,
            }),
          );
        }
      }

      if (basename !== 'package.json') continue;

      // --- Per-dependency checks -------------------------------------------

      for (const dependency of addedNpmDependencies(file)) {
        const flagged = FLAGGED_PACKAGES[dependency.name];

        if (flagged) {
          findings.push(
            createFinding({
              rule: 'dependencies/discouraged-package',
              category: 'dependencies',
              severity: flagged.severity,
              title: `\`${dependency.name}\` is not recommended`,
              description: `${flagged.reason}\n\nConsider ${flagged.alternative} instead.`,
              location: { path: file.path, line: dependency.line },
              confidence: 0.9,
            }),
          );
        }

        if (/^(?:\*|latest|x)$/.test(dependency.range)) {
          findings.push(
            createFinding({
              rule: 'dependencies/unpinned-version',
              category: 'security',
              severity: 'high',
              title: `\`${dependency.name}\` accepts any version`,
              description: [
                `The range \`${dependency.range}\` will install whatever the latest published version happens to be, including a future major release or a compromised one.`,
                '',
                'This turns every install into an unreviewed change to your dependency tree.',
              ].join('\n'),
              location: { path: file.path, line: dependency.line },
              suggestion: {
                description: 'Pin to a caret range against a known version, e.g. `^1.2.3`.',
              },
              confidence: 0.95,
              references: ['https://cwe.mitre.org/data/definitions/1357.html'],
            }),
          );
        }

        if (/^(?:git\+|github:|git:)/.test(dependency.range)) {
          const pinned = /#[0-9a-f]{7,40}$/.test(dependency.range);
          findings.push(
            createFinding({
              rule: 'dependencies/git-dependency',
              category: 'security',
              severity: pinned ? 'low' : 'high',
              title: `\`${dependency.name}\` is installed from a git URL`,
              description: pinned
                ? 'Git dependencies bypass registry provenance and immutability guarantees. This one is pinned to a commit, which mitigates the worst of it.'
                : 'A git dependency without a commit pin resolves to whatever the branch points at when install runs. Anyone with write access to that repository can change your build output.',
              location: { path: file.path, line: dependency.line },
              suggestion: {
                description: pinned
                  ? 'Prefer a published registry version where one exists.'
                  : 'Pin to a specific commit SHA (`#a1b2c3d`), or publish the package.',
              },
              confidence: 0.9,
            }),
          );
        }

        if (dependency.range.startsWith('http://')) {
          findings.push(
            createFinding({
              rule: 'dependencies/insecure-protocol',
              category: 'security',
              severity: 'critical',
              title: `\`${dependency.name}\` is fetched over plain HTTP`,
              description:
                'An unencrypted dependency download can be modified in transit, letting an attacker on the network path substitute arbitrary code that then executes during install.',
              location: { path: file.path, line: dependency.line },
              suggestion: { description: 'Use HTTPS, or install from the registry.' },
              confidence: 0.98,
              references: ['https://cwe.mitre.org/data/definitions/319.html'],
            }),
          );
        }
      }

      // --- Install scripts ---------------------------------------------------

      const content = context.fileContents?.get(file.path);
      if (content) {
        const dependencies = parseJsonDependencies(content);
        const count = Object.keys(dependencies).length;
        if (count > 150) {
          findings.push(
            createFinding({
              rule: 'dependencies/large-tree',
              category: 'dependencies',
              severity: 'low',
              title: `Project declares ${count} direct dependencies`,
              description:
                'A large direct dependency count increases install time, bundle size and the attack surface exposed to supply-chain compromise. Worth periodically auditing for packages that are no longer used.',
              location: { path: file.path },
              confidence: 0.8,
            }),
          );
        }
      }

      for (const line of addedLines(file)) {
        if (/"(?:preinstall|install|postinstall)"\s*:/.test(line.content)) {
          findings.push(
            createFinding({
              rule: 'dependencies/install-script',
              category: 'security',
              severity: 'medium',
              title: 'Install lifecycle script added',
              description:
                'Install scripts execute automatically on every `install`, including in CI and on developer machines. They are the primary mechanism used by malicious packages, so a new one deserves an explicit look.',
              location: lineLocation(file, line),
              confidence: 0.75,
            }),
          );
        }
      }
    }

    return findings;
  },
};
