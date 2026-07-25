import type { Finding, Severity } from '@/core/types';
import {
  type AnalysisContext,
  type Analyzer,
  addedCodeLines,
  createFinding,
  isJsLike,
  lineLocation,
  stripLiterals,
} from '../types';

/**
 * Common vulnerability patterns.
 *
 * These are heuristics over single lines, not dataflow analysis, so each rule
 * is written to fire only on shapes that are wrong in essentially every
 * context. Where a pattern has legitimate uses (`dangerouslySetInnerHTML` with
 * sanitised input, `exec` with a constant command), the severity and
 * confidence are lowered rather than the rule dropped — a medium-severity
 * prompt to double-check is useful; a critical that is wrong half the time is
 * not.
 */

interface VulnRule {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly confidence: number;
  readonly pattern: RegExp;
  readonly languages?: readonly string[];
  readonly description: string;
  readonly suggestion: string;
  readonly references: readonly string[];
  /** Suppress the finding when this pattern also matches the line. */
  readonly unless?: RegExp;
  /**
   * Match against the raw line rather than the literal-stripped one. Required
   * for patterns that look *inside* string literals, e.g. `createHash('md5')`.
   */
  readonly raw?: boolean;
}

const RULES: readonly VulnRule[] = [
  {
    id: 'code-injection-eval',
    title: 'Dynamic code execution with eval()',
    severity: 'critical',
    confidence: 0.85,
    pattern: /\beval\s*\(/,
    languages: ['javascript', 'typescript', 'python', 'php', 'ruby'],
    description:
      '`eval` executes arbitrary code. If any part of the argument can be influenced by user input, this is remote code execution.',
    suggestion: 'Use JSON.parse for data, or a lookup table / explicit branch for behaviour.',
    references: ['https://cwe.mitre.org/data/definitions/95.html'],
  },
  {
    id: 'code-injection-function-constructor',
    title: 'Dynamic code execution via Function constructor',
    severity: 'high',
    confidence: 0.8,
    pattern: /new\s+Function\s*\(/,
    languages: ['javascript', 'typescript'],
    description:
      'The `Function` constructor compiles a string into executable code, with the same risk profile as `eval`.',
    suggestion: 'Replace with a statically defined function or a dispatch map.',
    references: ['https://cwe.mitre.org/data/definitions/95.html'],
  },
  {
    id: 'command-injection',
    raw: true,
    title: 'Shell command built from interpolated input',
    severity: 'critical',
    confidence: 0.8,
    pattern:
      /\b(?:exec|execSync|spawnSync|system|popen|shell_exec|os\.system|subprocess\.call)\s*\(\s*[`'"][^`'"]*\$\{|\b(?:exec|execSync)\s*\(\s*[^)]*\+/,
    description:
      'Interpolating values into a shell command allows an attacker to append their own commands with `;`, `&&` or backticks.',
    suggestion:
      'Use the argument-array form (`execFile`, `spawn` with an args array, `subprocess.run([...])`) so the shell never parses user input.',
    references: ['https://cwe.mitre.org/data/definitions/78.html'],
  },
  {
    id: 'sql-injection',
    raw: true,
    title: 'SQL query built by string concatenation',
    severity: 'critical',
    confidence: 0.75,
    pattern:
      /(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,120}?(?:\$\{|'\s*\+|"\s*\+|%s['"]?\s*%|\bf['"])/i,
    // Parameterised queries and tagged templates are the correct pattern.
    unless: /\b(?:sql|db)`|\?\s*,|\$\d+|:\w+\s*[,)]|\bprepare\b/i,
    description:
      'Building SQL by concatenating values allows an attacker to change the query structure.',
    suggestion:
      'Use parameterised queries (`?` / `$1` placeholders) or a query builder that binds parameters.',
    references: ['https://cwe.mitre.org/data/definitions/89.html'],
  },
  {
    id: 'xss-inner-html',
    title: 'Unsanitised HTML assignment',
    severity: 'high',
    confidence: 0.7,
    pattern: /\.innerHTML\s*=\s*(?!['"`]\s*['"`])|\.outerHTML\s*=/,
    languages: ['javascript', 'typescript', 'vue', 'svelte'],
    unless: /DOMPurify|sanitize|escapeHtml/i,
    description:
      'Assigning to `innerHTML` renders the value as markup. If it contains user-controlled data, script executes in your origin.',
    suggestion: 'Use `textContent`, or sanitise with DOMPurify before assigning.',
    references: ['https://cwe.mitre.org/data/definitions/79.html'],
  },
  {
    id: 'xss-dangerously-set-inner-html',
    title: 'dangerouslySetInnerHTML without sanitisation',
    severity: 'medium',
    confidence: 0.6,
    pattern: /dangerouslySetInnerHTML/,
    languages: ['javascript', 'typescript'],
    unless: /DOMPurify|sanitize/i,
    description:
      'React escapes content by default; this prop opts out. Any user-controlled value reaching it becomes an XSS vector.',
    suggestion: 'Sanitise with DOMPurify, or render the value as text.',
    references: ['https://cwe.mitre.org/data/definitions/79.html'],
  },
  {
    id: 'weak-hash',
    raw: true,
    title: 'Weak cryptographic hash',
    severity: 'high',
    confidence: 0.8,
    pattern: /\b(?:createHash|hashlib|MessageDigest\.getInstance)\s*\(\s*['"](?:md5|sha1)['"]/i,
    description:
      'MD5 and SHA-1 are broken against collision attacks and unsuitable for signatures, integrity checks or password storage.',
    suggestion:
      'Use SHA-256 or better for integrity. For passwords use bcrypt, scrypt or Argon2 — never a plain hash.',
    references: ['https://cwe.mitre.org/data/definitions/327.html'],
  },
  {
    id: 'insecure-random',
    title: 'Insecure randomness in a security context',
    severity: 'high',
    confidence: 0.65,
    pattern:
      /(?:token|secret|password|nonce|salt|otp|session[_-]?id|api[_-]?key)\s*[=:][^=]*Math\.random\s*\(/i,
    description:
      '`Math.random()` is not cryptographically secure and its output is predictable from previous values.',
    suggestion: 'Use `crypto.randomBytes()` / `crypto.getRandomValues()` / `crypto.randomUUID()`.',
    references: ['https://cwe.mitre.org/data/definitions/338.html'],
  },
  {
    id: 'tls-verification-disabled',
    title: 'TLS certificate verification disabled',
    severity: 'critical',
    confidence: 0.9,
    pattern:
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    description:
      'Disabling certificate verification removes all protection against man-in-the-middle attacks; the connection is encrypted but not authenticated.',
    suggestion:
      'Add the private CA to the trust store instead. If this is for local development, gate it behind an explicit non-production check.',
    references: ['https://cwe.mitre.org/data/definitions/295.html'],
  },
  {
    id: 'permissive-cors',
    raw: true,
    title: 'Wildcard CORS with credentials',
    severity: 'high',
    confidence: 0.85,
    pattern: /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*/,
    description:
      'A wildcard origin lets any site read the response. Combined with credentialed requests this exposes authenticated data cross-origin.',
    suggestion: 'Echo back an explicit allowlist of origins.',
    references: ['https://cwe.mitre.org/data/definitions/942.html'],
  },
  {
    id: 'path-traversal',
    title: 'File path built from unvalidated input',
    severity: 'high',
    confidence: 0.6,
    pattern:
      /\b(?:readFile|readFileSync|createReadStream|open|sendFile|unlink|writeFile)\s*\(\s*(?:[`'"][^`'"]*\$\{|[^),]*\+\s*(?:req|request|params|query|body|input|userInput))/,
    unless: /path\.(?:resolve|normalize|basename)|sanitizePath/,
    description:
      'Concatenating request data into a filesystem path allows `../` sequences to escape the intended directory.',
    suggestion:
      'Resolve the path and verify it still sits inside the allowed root, or map input through an allowlist of known filenames.',
    references: ['https://cwe.mitre.org/data/definitions/22.html'],
  },
  {
    id: 'ssrf',
    title: 'Outbound request to a user-controlled URL',
    severity: 'high',
    confidence: 0.55,
    pattern:
      /\b(?:fetch|axios(?:\.get|\.post)?|got|request|urllib\.request\.urlopen)\s*\(\s*(?:req|request)\.(?:body|query|params)/,
    description:
      'Fetching a URL supplied by a caller lets an attacker reach internal services, including cloud metadata endpoints.',
    suggestion:
      'Validate the URL against an allowlist of hosts and reject private/loopback address ranges before making the request.',
    references: ['https://cwe.mitre.org/data/definitions/918.html'],
  },
  {
    id: 'unsafe-deserialization',
    title: 'Unsafe deserialisation',
    severity: 'critical',
    confidence: 0.85,
    pattern:
      /\b(?:pickle\.loads|yaml\.load\s*\((?![^)]*Loader\s*=)|unserialize|Marshal\.load)\s*\(/,
    description:
      'These deserialisers can instantiate arbitrary types and execute code during parsing.',
    suggestion: 'Use a safe loader (`yaml.safe_load`, `json.loads`) or a schema-validating parser.',
    references: ['https://cwe.mitre.org/data/definitions/502.html'],
  },
  {
    id: 'jwt-none-algorithm',
    raw: true,
    title: 'JWT signature verification bypassed',
    severity: 'critical',
    confidence: 0.9,
    pattern:
      /algorithms?\s*:\s*\[?\s*['"]none['"]|verify\s*:\s*false|verify_signature\s*:\s*False/i,
    description:
      'Accepting the `none` algorithm or skipping verification means any attacker can forge a token with arbitrary claims.',
    suggestion: 'Pin an explicit algorithm list (e.g. `["RS256"]`) and always verify.',
    references: ['https://cwe.mitre.org/data/definitions/347.html'],
  },
  {
    id: 'debug-enabled',
    title: 'Debug mode enabled',
    severity: 'medium',
    confidence: 0.7,
    pattern: /\b(?:DEBUG|debug)\s*[=:]\s*True\b|app\.run\([^)]*debug\s*=\s*True/,
    description:
      'Debug mode exposes stack traces, configuration and — in some frameworks — an interactive console to anyone who can trigger an error.',
    suggestion: 'Drive this from an environment variable that defaults to off.',
    references: ['https://cwe.mitre.org/data/definitions/489.html'],
  },
];

export const securityAnalyzer: Analyzer = {
  id: 'security',
  description: 'Detects common vulnerability patterns in changed code',
  categories: ['security'],

  analyze(context: AnalysisContext): Finding[] {
    if (!context.config.security.enabled) return [];

    const findings: Finding[] = [];
    const allowlist = context.config.security.allowlist.map((pattern) => new RegExp(pattern, 'i'));
    const seen = new Set<string>();

    for (const { file, line, code } of addedCodeLines(context.files)) {
      // Comparing against the literal-stripped line prevents matches inside
      // strings and trailing comments.
      const stripped = stripLiterals(code);

      for (const rule of RULES) {
        if (rule.languages && !rule.languages.includes(file.language)) continue;
        if (
          rule.languages?.includes('javascript') &&
          !isJsLike(file) &&
          rule.languages.length <= 4
        ) {
          continue;
        }

        const subject = rule.raw ? code : stripped;

        if (!rule.pattern.test(subject)) continue;
        if (rule.unless?.test(code)) continue;
        if (allowlist.some((pattern) => pattern.test(code))) continue;

        const key = `${file.path}:${line.newLine}:${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push(
          createFinding({
            rule: `security/${rule.id}`,
            category: 'security',
            severity: rule.severity,
            title: rule.title,
            description: [
              rule.description,
              '',
              '```' + file.language,
              code.trim().slice(0, 300),
              '```',
            ].join('\n'),
            location: lineLocation(file, line),
            suggestion: { description: rule.suggestion },
            confidence: rule.confidence,
            references: rule.references,
          }),
        );
      }
    }

    return findings;
  },
};
