import type { Finding } from '@/core/types';
import { addedLines } from '@/features/github/diff';
import {
  type AnalysisContext,
  type Analyzer,
  addedCodeLines,
  createFinding,
  lineLocation,
  stripLiterals,
} from '../types';

/**
 * Prompt-injection and LLM-safety analysis.
 *
 * AI features have a vulnerability class that traditional scanners do not look
 * for: untrusted text reaching a model that can then take actions. The rules
 * here target the three shapes that cause real incidents —
 *
 *   1. user input concatenated straight into a prompt,
 *   2. model output used as code, a command, or a query,
 *   3. tool/function-calling wired up with no confirmation or allowlist.
 *
 * The analyzer only runs on files that actually look AI-related, so
 * non-AI repositories see no output from it at all.
 */

const AI_SIGNALS =
  /\b(?:openai|anthropic|claude|gpt-?[0-9]|langchain|llamaindex|openrouter|ollama|bedrock|vertexai|huggingface|completion|chat\.completions|generateText|streamText|invoke_model|messages\.create|systemPrompt|system_prompt)\b/i;

/** True when the file participates in an LLM code path. */
export function looksAiRelated(content: string, path: string): boolean {
  return AI_SIGNALS.test(content) || /(?:prompt|llm|agent|ai)[-_/.]/i.test(path);
}

interface Rule {
  readonly id: string;
  readonly title: string;
  readonly severity: Finding['severity'];
  readonly confidence: number;
  readonly pattern: RegExp;
  readonly unless?: RegExp;
  readonly description: string;
  readonly suggestion: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'user-input-in-prompt',
    title: 'User input interpolated directly into a prompt',
    severity: 'high',
    confidence: 0.6,
    pattern:
      /(?:prompt|system|instruction|messages?|content)\s*[:=][\s\S]{0,80}?\$\{\s*(?:req|request|input|user|body|query|params|message|userMessage|userInput)/i,
    unless: /sanitiz|escape|fence|delimit|<untrusted/i,
    description: [
      'Untrusted text is being placed into a prompt without delimiting or sanitising it. An attacker who controls that text can append their own instructions ("ignore the above and ...") and change what the model does.',
      '',
      'This matters most when the model can act — call tools, write to a database, or produce output another system trusts.',
    ].join('\n'),
    suggestion:
      'Wrap untrusted content in clearly labelled delimiters, state in the system prompt that its contents are data and must never be followed as instructions, and never let model output alone authorise a privileged action.',
  },
  {
    id: 'llm-output-to-eval',
    title: 'Model output executed as code',
    severity: 'critical',
    confidence: 0.85,
    pattern:
      /\b(?:eval|Function|exec|execSync|spawn|system|compile)\s*\([^)]*\b(?:completion|response|result|output|message|content|answer|generated|llmResponse)\b/i,
    description:
      'A language model response is being executed. Because model output is derived from untrusted input, this is equivalent to remote code execution with extra steps.',
    suggestion:
      'Never execute model output. Constrain the model to a fixed set of named operations and dispatch through a switch you control.',
  },
  {
    id: 'llm-output-to-sql',
    title: 'Model output used to build a query',
    severity: 'critical',
    confidence: 0.8,
    pattern:
      /(?:query|execute|raw|\$queryRaw)\s*\(\s*[`'"][^`'"]*\$\{\s*(?:completion|response|result|output|content|generated|sql)\b/i,
    description:
      "A query is being constructed from model output. An injection in the model's input becomes a SQL injection in your database.",
    suggestion:
      'Have the model choose from predefined query templates and supply only bound parameters, which you then validate.',
  },
  {
    id: 'unrestricted-tool-calling',
    title: 'Tool calling without confirmation or allowlist',
    severity: 'high',
    confidence: 0.5,
    pattern: /\b(?:tools|functions|tool_choice)\s*[:=]/,
    unless: /allowlist|allowList|confirm|approve|requireApproval|readOnly|permission|guard/i,
    description:
      'Tools are exposed to the model with no visible allowlist or confirmation step. If any tool has a side effect — sending mail, spending money, deleting data — a successful prompt injection inherits that capability.',
    suggestion:
      'Separate read-only tools from side-effecting ones, and require explicit human confirmation before any irreversible or outward-facing action.',
  },
  {
    id: 'system-prompt-from-input',
    title: 'System prompt built from external data',
    severity: 'critical',
    confidence: 0.75,
    pattern:
      /role\s*:\s*['"]system['"][\s\S]{0,120}?\$\{\s*(?:req|request|user|input|body|params|db|row)/i,
    description:
      "The system prompt — the part of the conversation the model trusts most — is being assembled from external data. This hands full control of the model's behaviour to whoever controls that data.",
    suggestion:
      'Keep the system prompt static. Pass variable content as a user message inside labelled delimiters.',
  },
  {
    id: 'no-output-validation',
    title: 'Model output parsed without validation',
    severity: 'medium',
    confidence: 0.55,
    pattern:
      /JSON\.parse\s*\(\s*(?:\w+\.)?(?:completion|response|content|message|output|generated|text)\b/i,
    unless: /safeParse|schema|zod|validate|try\s*\{/i,
    description:
      'Model output is parsed as JSON and used directly. Models return malformed or unexpectedly shaped JSON regularly, and here that becomes an exception or a bad value flowing into downstream logic.',
    suggestion:
      'Parse inside a try/catch and validate the result against a schema before using it.',
  },
  {
    id: 'unbounded-token-spend',
    title: 'Model call without a token or cost ceiling',
    severity: 'low',
    confidence: 0.45,
    pattern: /\b(?:chat\.completions\.create|messages\.create|generateText|streamText)\s*\(/,
    unless: /max_?[tT]okens|maxOutputTokens|max_completion_tokens/,
    description:
      'No output-token limit is set. A crafted input can push the model to generate its maximum context length, which is a latency and cost amplification vector.',
    suggestion: 'Set an explicit `max_tokens` appropriate to the task.',
  },
];

export const promptInjectionAnalyzer: Analyzer = {
  id: 'prompt-injection',
  description: 'Detects prompt-injection and unsafe LLM integration patterns',
  categories: ['security'],

  analyze(context: AnalysisContext): Finding[] {
    if (!context.config.security.enabled || !context.config.security.promptInjection) return [];

    const findings: Finding[] = [];
    const seen = new Set<string>();

    // Restrict to files that are plausibly part of an AI code path.
    const aiFiles = context.files.filter((file) => {
      const content = addedLines(file)
        .map((line) => line.content)
        .join('\n');
      return looksAiRelated(content, file.path);
    });

    if (aiFiles.length === 0) return [];

    for (const { file, line, code } of addedCodeLines(aiFiles)) {
      const stripped = stripLiterals(code);

      for (const rule of RULES) {
        // Interpolation rules need the template literal contents intact.
        const subject = rule.pattern.source.includes('\\$\\{') ? code : stripped;
        if (!rule.pattern.test(subject)) continue;
        if (rule.unless?.test(code)) continue;

        const key = `${file.path}:${line.newLine}:${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push(
          createFinding({
            rule: `security/prompt-injection.${rule.id}`,
            category: 'security',
            severity: rule.severity,
            title: rule.title,
            description: [
              rule.description,
              '',
              '```' + file.language,
              code.trim().slice(0, 280),
              '```',
            ].join('\n'),
            location: lineLocation(file, line),
            suggestion: { description: rule.suggestion },
            confidence: rule.confidence,
            references: [
              'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
            ],
          }),
        );
      }
    }

    return findings;
  },
};
