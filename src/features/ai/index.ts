import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { DeterministicProvider } from './deterministic';
import { AiNarrator, TemplateNarrator, type Narrator } from './narrator';
import { OpenRouterProvider } from './openrouter';
import type { AIProvider } from './provider';

export * from './provider';
export * from './narrator';
export * from './prompts';
export { DeterministicProvider } from './deterministic';
export { OpenRouterProvider } from './openrouter';

let provider: AIProvider | undefined;
let narrator: Narrator | undefined;

/**
 * Returns the configured provider.
 *
 * Falls back to the deterministic provider if OpenRouter is selected but
 * cannot be constructed — a missing key should degrade the product, not crash
 * a webhook handler mid-delivery.
 */
export function getAIProvider(): AIProvider {
  if (provider) return provider;

  const e = env();

  if (e.AUTODEV_AI_PROVIDER === 'openrouter') {
    try {
      provider = new OpenRouterProvider();
      logger().info('AI provider ready', { provider: 'openrouter', model: e.OPENROUTER_MODEL });
      return provider;
    } catch (error) {
      logger().warn('OpenRouter unavailable; using the deterministic engine', { error });
    }
  }

  provider = new DeterministicProvider();
  return provider;
}

/** Returns the narrator matching the configured provider. */
export function getNarrator(): Narrator {
  if (narrator) return narrator;

  narrator = env().capabilities.aiEnrichment
    ? new AiNarrator(getAIProvider())
    : new TemplateNarrator();

  return narrator;
}

/** Test helper: replaces the memoised provider and narrator. */
export function setAIProvider(next: AIProvider | undefined, nextNarrator?: Narrator): void {
  provider = next;
  narrator = nextNarrator;
}
