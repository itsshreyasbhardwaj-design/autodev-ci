import { withTimeout, retry } from '@/core/async';
import { env } from '@/core/env';
import { AIError, ConfigurationError } from '@/core/errors';
import { logger } from '@/core/logger';
import type { AIProvider, ChatMessage, CompletionRequest, CompletionResponse } from './provider';

/**
 * OpenRouter client.
 *
 * OpenRouter proxies many model providers behind one OpenAI-compatible API,
 * which is why it is the default remote backend: users pick whichever model
 * they already pay for without AutoDev CI shipping five SDKs.
 */

interface OpenRouterChoice {
  message?: { content?: string };
  delta?: { content?: string };
  finish_reason?: string;
}

interface OpenRouterResponse {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: number };
}

export interface OpenRouterOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
}

export class OpenRouterProvider implements AIProvider {
  readonly name = 'openrouter';
  readonly remote = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fallbackModel: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterOptions = {}) {
    const e = env();
    const apiKey = options.apiKey ?? e.OPENROUTER_API_KEY;

    if (!apiKey) {
      throw new ConfigurationError(
        'OPENROUTER_API_KEY is required when AUTODEV_AI_PROVIDER=openrouter. Set AUTODEV_AI_PROVIDER=deterministic to run without an LLM.',
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? e.OPENROUTER_BASE_URL;
    this.model = options.model ?? e.OPENROUTER_MODEL;
    this.fallbackModel = options.fallbackModel ?? e.OPENROUTER_FALLBACK_MODEL;
    this.timeoutMs = options.timeoutMs ?? e.AI_TIMEOUT_MS;
    this.maxTokens = options.maxTokens ?? e.AI_MAX_OUTPUT_TOKENS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter uses these for attribution and per-app rate limiting.
      'HTTP-Referer': env().NEXT_PUBLIC_APP_URL,
      'X-Title': 'AutoDev CI',
    };
  }

  private body(request: CompletionRequest, model: string, stream: boolean): string {
    return JSON.stringify({
      model,
      messages: request.messages.map((message: ChatMessage) => ({
        role: message.role,
        content: message.content,
      })),
      max_tokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature ?? 0.2,
      stream,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    });
  }

  private async call(request: CompletionRequest, model: string): Promise<CompletionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(request, model, false),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 429 and 5xx are transient; 4xx usually means a bad model id or key.
      throw new AIError(`OpenRouter returned ${response.status}: ${text.slice(0, 500)}`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const payload = (await response.json()) as OpenRouterResponse;

    if (payload.error) {
      throw new AIError(`OpenRouter error: ${payload.error.message ?? 'unknown'}`);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new AIError('OpenRouter returned an empty completion');
    }

    return {
      content,
      model: payload.model ?? model,
      ...(payload.usage
        ? {
            usage: {
              promptTokens: payload.usage.prompt_tokens ?? 0,
              completionTokens: payload.usage.completion_tokens ?? 0,
              totalTokens: payload.usage.total_tokens ?? 0,
            },
          }
        : {}),
      ...(payload.choices?.[0]?.finish_reason
        ? { finishReason: payload.choices[0].finish_reason }
        : {}),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const log = logger().child({ provider: 'openrouter', model: this.model });

    try {
      return await retry(
        () => withTimeout(this.call(request, this.model), this.timeoutMs, 'OpenRouter completion'),
        {
          attempts: 3,
          baseDelayMs: 500,
          shouldRetry: (error) => error instanceof AIError && error.retryable,
          onRetry: (_error, attempt, delayMs) =>
            log.warn('Retrying OpenRouter request', { attempt, delayMs }),
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
    } catch (primaryError) {
      if (this.fallbackModel === this.model) throw primaryError;

      // A single model being overloaded or deprecated should not fail the run
      // when the user configured a fallback.
      log.warn('Primary model failed; trying fallback', {
        fallbackModel: this.fallbackModel,
        error: primaryError,
      });

      return withTimeout(
        this.call(request, this.fallbackModel),
        this.timeoutMs,
        'OpenRouter fallback completion',
      );
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(request, this.model, true),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new AIError(`OpenRouter stream failed with ${response.status}: ${text.slice(0, 300)}`, {
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a chunk can split one in
        // half, so only complete frames are consumed and the remainder is kept.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            if (data.length === 0) continue;

            try {
              const parsed = JSON.parse(data) as OpenRouterResponse;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) yield delta;
            } catch {
              // OpenRouter interleaves ": OPENROUTER PROCESSING" keep-alives
              // that are not JSON. Skipping unparseable frames is correct.
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
