/**
 * AI provider abstraction.
 *
 * AutoDev CI treats the LLM as an *enrichment* layer, never as the source of
 * truth. The deterministic engine produces findings on its own; a provider,
 * when configured, adds prose quality and catches things pattern matching
 * cannot. This ordering is deliberate:
 *
 *   - the platform works, and is testable, with no API key and no spend;
 *   - LLM downtime degrades output quality instead of breaking CI;
 *   - findings that gate a merge always have a deterministic origin.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Ask the provider for a JSON object response where supported. */
  readonly json?: boolean;
  readonly signal?: AbortSignal;
}

export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CompletionResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: CompletionUsage;
  readonly finishReason?: string;
}

export interface AIProvider {
  readonly name: string;
  /** False when the provider is a local stand-in rather than a real model. */
  readonly remote: boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Yields incremental text chunks. */
  stream(request: CompletionRequest): AsyncIterable<string>;
}

/**
 * Extracts a JSON object from a model response.
 *
 * Models wrap JSON in prose or fences far more often than their docs suggest,
 * and a review that silently produces nothing because of a stray ``` is worse
 * than one that recovers. Returns null rather than throwing so callers can
 * fall back to deterministic output.
 */
export function extractJson<T = unknown>(content: string): T | null {
  const trimmed = content.trim();

  const attempts: string[] = [trimmed];

  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(trimmed);
  if (fenced?.[1]) attempts.push(fenced[1].trim());

  // Fall back to the outermost brace/bracket pair.
  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace !== -1) {
    const opening = trimmed[firstBrace];
    const closing = opening === '{' ? '}' : ']';
    const lastClose = trimmed.lastIndexOf(closing);
    if (lastClose > firstBrace) attempts.push(trimmed.slice(firstBrace, lastClose + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Rough token estimate (~4 characters per token for English + code).
 *
 * Used only for budgeting prompt size before a call. Exact accounting comes
 * from the provider's usage field on the response.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncates `text` to approximately `maxTokens`, keeping the head and tail.
 *
 * Diffs are the main thing that overflows a context window, and the
 * interesting parts are usually at the edges — the start of a function and the
 * change at the end — so cutting from the middle preserves more signal than a
 * plain head truncation.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars - 64;

  return [
    text.slice(0, headChars),
    `\n\n... [${text.length - headChars - tailChars} characters omitted] ...\n\n`,
    text.slice(-tailChars),
  ].join('');
}
