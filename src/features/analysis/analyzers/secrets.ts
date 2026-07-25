import type { Finding } from '@/core/types';
import {
  type AnalysisContext,
  type Analyzer,
  addedCodeLines,
  createFinding,
  lineLocation,
} from '../types';

/**
 * Hardcoded secret detection.
 *
 * Precision matters far more than recall here. A secret scanner that cries
 * wolf gets disabled within a week, and then it catches nothing at all. Three
 * things keep the false-positive rate down:
 *
 *   - provider-specific patterns (a Stripe key has a known shape) are trusted
 *     at high confidence; generic `password = "..."` patterns are not;
 *   - obvious placeholders (`xxx`, `changeme`, `your-key-here`, env lookups,
 *     template interpolation) are excluded;
 *   - a Shannon-entropy floor filters out low-randomness strings that happen
 *     to sit next to the word "token".
 */

interface SecretRule {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
  readonly confidence: number;
  /** Require the matched value to look random. */
  readonly entropyCheck?: boolean;
  readonly reference?: string;
}

const PROVIDER_RULES: readonly SecretRule[] = [
  {
    id: 'aws-access-key',
    label: 'AWS access key ID',
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
    confidence: 0.97,
    reference: 'https://cwe.mitre.org/data/definitions/798.html',
  },
  {
    id: 'aws-secret-key',
    label: 'AWS secret access key',
    pattern: /\baws_secret_access_key\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    confidence: 0.95,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{22,255})\b/g,
    confidence: 0.98,
  },
  {
    id: 'openai-key',
    label: 'OpenAI API key',
    pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g,
    confidence: 0.95,
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic API key',
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
    confidence: 0.97,
  },
  {
    id: 'stripe-key',
    label: 'Stripe secret key',
    pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g,
    confidence: 0.97,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    confidence: 0.96,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    confidence: 0.95,
  },
  {
    id: 'private-key',
    label: 'Private key material',
    pattern: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE KEY-----/g,
    confidence: 0.99,
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    confidence: 0.8,
  },
  {
    id: 'postgres-url',
    label: 'Database URL with inline credentials',
    pattern:
      /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+)/gi,
    confidence: 0.9,
  },
];

const GENERIC_RULES: readonly SecretRule[] = [
  {
    id: 'generic-secret-assignment',
    label: 'Hardcoded credential',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[=:]\s*['"]([^'"\s]{12,})['"]/gi,
    confidence: 0.6,
    entropyCheck: true,
  },
];

/**
 * Strings that look like secrets but are documentation, tests or wiring.
 * Ordered roughly by how often each shows up in real repositories.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(x{3,}|\*{3,}|\.{3,}|-{3,}|0{6,})$/i,
  /\b(your|my|the)[-_]?(api)?[-_]?(key|token|secret|password)\b/i,
  /\b(example|sample|placeholder|dummy|fake|test|mock|demo|changeme|replaceme|todo|fixme|redacted|hidden)\b/i,
  /^(<|\{\{|\$\{|%\(|\[)/,
  /^(process\.env|import\.meta\.env|os\.environ|System\.getenv|ENV\[)/,
  /^(null|undefined|none|nil|true|false|empty)$/i,
  /^[a-f0-9]{32}$/i, // bare md5-looking hashes are usually checksums
  /\.(png|jpg|svg|css|js|json|md)$/i,
];

/** Files where credential-shaped strings are expected and harmless. */
const EXEMPT_PATH = /(^|\/)(\.env\.example|\.env\.sample|\.env\.template|.*\.example\.[a-z]+)$/i;

/**
 * Shannon entropy in bits per character. Real keys are near-random and score
 * above ~3.2; English words and identifiers score well below that.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

/** Shows the first and last few characters so a human can locate the value. */
function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

export const secretsAnalyzer: Analyzer = {
  id: 'secrets',
  description: 'Detects credentials and key material committed to the repository',
  categories: ['security'],

  analyze(context: AnalysisContext): Finding[] {
    if (!context.config.security.enabled || !context.config.security.secretScanning) return [];

    const findings: Finding[] = [];
    const allowlist = context.config.security.allowlist.map((pattern) => new RegExp(pattern, 'i'));
    const seen = new Set<string>();

    const rules = [...PROVIDER_RULES, ...GENERIC_RULES];

    for (const { file, line, code } of addedCodeLines(context.files)) {
      if (EXEMPT_PATH.test(file.path)) continue;

      for (const rule of rules) {
        // Regexes are module-level with /g, so lastIndex must be reset.
        rule.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = rule.pattern.exec(code)) !== null) {
          const value = match[1] ?? match[0];

          if (looksLikePlaceholder(value)) continue;
          if (allowlist.some((pattern) => pattern.test(value))) continue;
          if (rule.entropyCheck && shannonEntropy(value) < 3.2) continue;

          // Two occurrences of the same secret in one file is one problem.
          const key = `${file.path}:${rule.id}:${value.slice(0, 12)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push(
            createFinding({
              rule: `security/hardcoded-secret.${rule.id}`,
              category: 'security',
              severity: rule.confidence >= 0.9 ? 'critical' : 'high',
              title: `${rule.label} committed to source`,
              description: [
                `A value matching the shape of a ${rule.label.toLowerCase()} was found in \`${file.path}\`: \`${maskSecret(value)}\`.`,
                '',
                'Anything committed to git is permanently in the repository history, even after a follow-up commit removes it.',
                '',
                '**What to do:**',
                '1. Treat this credential as compromised and rotate it now.',
                '2. Move the value to an environment variable or a secrets manager.',
                '3. Purge it from history (`git filter-repo`) if the repository is public.',
              ].join('\n'),
              location: lineLocation(file, line),
              suggestion: {
                description: 'Read the value from the environment instead of hardcoding it',
              },
              confidence: rule.confidence,
              references: rule.reference
                ? [rule.reference]
                : ['https://cwe.mitre.org/data/definitions/798.html'],
            }),
          );
        }
      }
    }

    return findings;
  },
};
