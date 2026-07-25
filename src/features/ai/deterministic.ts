import { sleep } from '@/core/async';
import type { AIProvider, CompletionRequest, CompletionResponse } from './provider';

/**
 * A local, offline {@link AIProvider}.
 *
 * This is not a mock in the testing sense — it is the provider that runs when
 * no API key is configured, and it powers the dashboard's streaming
 * "explain this" panel without any spend. It answers from the structured
 * context it is given rather than pretending to be a language model, so its
 * output is short, honest, and reproducible.
 */
export class DeterministicProvider implements AIProvider {
  readonly name = 'deterministic';
  readonly remote = false;

  /** Delay between streamed chunks, so the UI's streaming path is exercised. */
  constructor(private readonly chunkDelayMs = 12) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const content = this.render(request);
    return {
      content,
      model: 'autodev/deterministic',
      usage: {
        promptTokens: Math.ceil(request.messages.reduce((sum, m) => sum + m.content.length, 0) / 4),
        completionTokens: Math.ceil(content.length / 4),
        totalTokens: 0,
      },
      finishReason: 'stop',
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const content = this.render(request);
    // Chunk on word boundaries so partial renders never split a word.
    const chunks = content.match(/\S+\s*/g) ?? [content];

    for (const chunk of chunks) {
      if (request.signal?.aborted) return;
      yield chunk;
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs);
    }
  }

  /**
   * Produces a response from the request. JSON-mode requests get a valid empty
   * result object rather than prose, so callers expecting JSON always parse
   * successfully and simply receive no AI contributions.
   */
  private render(request: CompletionRequest): string {
    if (request.json) {
      return JSON.stringify({
        headline: '',
        highlights: [],
        concerns: [],
        findings: [],
        commendations: [],
        suggestions: [],
      });
    }

    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const topic = lastUser?.content.split('\n').find((line) => line.trim().length > 0) ?? '';

    return [
      'AutoDev CI is running with the deterministic analysis engine (no language model configured).',
      '',
      'The findings, severities, quality gates and scores you see are produced by static analysis',
      'and are complete on their own. Configuring `OPENROUTER_API_KEY` and setting',
      '`AUTODEV_AI_PROVIDER=openrouter` adds narrative explanations and additional non-blocking',
      'observations on top of these results.',
      ...(topic ? ['', `Context: ${topic.slice(0, 200)}`] : []),
    ].join('\n');
  }
}
