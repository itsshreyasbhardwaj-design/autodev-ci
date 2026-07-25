import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@/core/errors';
import {
  CONFIG_FILENAMES,
  defaultConfig,
  isIgnored,
  loadConfig,
  matchesAny,
  mergeConfig,
  parseConfig,
} from '@/features/config';

/**
 * Repository configuration.
 *
 * The behaviour that matters most here is that a malformed or typo'd config
 * is a hard error. Silently falling back to defaults would leave a team
 * believing they have a gate that is not running.
 */

describe('parseConfig', () => {
  it('returns defaults for an empty file', () => {
    expect(parseConfig('')).toEqual(defaultConfig());
    expect(parseConfig('   \n  ')).toEqual(defaultConfig());
  });

  it('returns defaults for a YAML document that is only comments', () => {
    expect(parseConfig('# nothing here\n')).toEqual(defaultConfig());
  });

  it('applies partial overrides on top of the defaults', () => {
    const config = parseConfig(
      ['version: 1', 'review:', '  minSeverity: high', '  maxInlineComments: 5'].join('\n'),
    );

    expect(config.review.minSeverity).toBe('high');
    expect(config.review.maxInlineComments).toBe(5);
    // Untouched keys keep their defaults.
    expect(config.review.inlineComments).toBe(true);
    expect(config.qualityGates.failOnSeverity).toBe('critical');
  });

  it('parses JSON when the filename says so', () => {
    const config = parseConfig('{"review":{"minSeverity":"medium"}}', '.autodev.json');
    expect(config.review.minSeverity).toBe('medium');
  });

  it('rejects an unknown key rather than ignoring a typo', () => {
    // `failOnSeverty` is a plausible typo that would otherwise silently
    // disable the gate the author thought they were configuring.
    expect(() => parseConfig('qualityGates:\n  failOnSeverty: high\n')).toThrow(ValidationError);
  });

  it('rejects an invalid enum value', () => {
    expect(() => parseConfig('review:\n  minSeverity: catastrophic\n')).toThrow(ValidationError);
  });

  it('rejects an out-of-range number', () => {
    expect(() => parseConfig('review:\n  blockingConfidence: 5\n')).toThrow(ValidationError);
  });

  it('reports the offending path in the error details', () => {
    try {
      parseConfig('review:\n  minSeverity: nope\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details as {
        issues: Array<{ path: string }>;
      };
      expect(details.issues[0]!.path).toContain('minSeverity');
    }
  });

  it('rejects malformed YAML with the filename in the message', () => {
    expect(() => parseConfig('review:\n  - [unclosed\n', '.autodev.yml')).toThrow(
      /Failed to parse \.autodev\.yml/,
    );
  });
});

describe('loadConfig', () => {
  it('checks the documented filenames in order and stops at the first hit', async () => {
    const seen: string[] = [];
    const read = vi.fn(async (path: string) => {
      seen.push(path);
      return path === '.github/autodev.yml' ? 'review:\n  minSeverity: high\n' : null;
    });

    const { config, source } = await loadConfig(read);

    expect(source).toBe('.github/autodev.yml');
    expect(config.review.minSeverity).toBe('high');
    expect(seen).toEqual(CONFIG_FILENAMES.slice(0, 3));
  });

  it('falls back to defaults when no config file exists', async () => {
    const { config, source } = await loadConfig(async () => null);
    expect(source).toBeNull();
    expect(config).toEqual(defaultConfig());
  });

  it('keeps looking when a lookup throws', async () => {
    // A transient 500 on one filename should not abort discovery.
    const read = vi.fn(async (path: string) => {
      if (path === '.autodev.yml') throw new Error('upstream blew up');
      if (path === '.autodev.yaml') return 'review:\n  commendations: false\n';
      return null;
    });

    const { config, source } = await loadConfig(read);
    expect(source).toBe('.autodev.yaml');
    expect(config.review.commendations).toBe(false);
  });

  it('propagates a validation error rather than silently using defaults', async () => {
    await expect(loadConfig(async () => 'review:\n  nope: true\n')).rejects.toThrow(
      ValidationError,
    );
  });
});

describe('mergeConfig', () => {
  it('deep-merges nested objects', () => {
    const merged = mergeConfig(defaultConfig(), {
      review: { minSeverity: 'high' },
      qualityGates: { requireTests: true },
    });

    expect(merged.review.minSeverity).toBe('high');
    expect(merged.review.maxInlineComments).toBe(20);
    expect(merged.qualityGates.requireTests).toBe(true);
  });

  it('replaces arrays instead of concatenating them', () => {
    // `categories: [security]` means "only security", not "security as well".
    const merged = mergeConfig(defaultConfig(), { review: { categories: ['security'] } });
    expect(merged.review.categories).toEqual(['security']);
  });

  it('discards an invalid override and keeps the base config', () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, { review: { minSeverity: 'not-a-severity' } });
    expect(merged).toEqual(base);
  });
});

describe('glob matching', () => {
  it('matches ignore patterns including dotfiles', () => {
    const patterns = ['**/dist/**', '**/*.min.js', '.github/**'];

    expect(isIgnored('packages/app/dist/index.js', patterns)).toBe(true);
    expect(isIgnored('public/bundle.min.js', patterns)).toBe(true);
    expect(isIgnored('.github/workflows/ci.yml', patterns)).toBe(true);
    expect(isIgnored('src/index.ts', patterns)).toBe(false);
  });

  it('matches watch patterns', () => {
    expect(matchesAny('docs/guide.md', ['docs/**/*.md'])).toBe(true);
    expect(matchesAny('README.md', ['README.md'])).toBe(true);
    expect(matchesAny('src/a.ts', ['docs/**/*.md'])).toBe(false);
  });

  it('matches nothing when there are no patterns', () => {
    expect(isIgnored('anything.ts', [])).toBe(false);
  });
});
