import type { ModelProvider, ModelReasoningEffort, ModelReasoningRequest } from '@agent-core/model';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider, type OpenAICodexTransport } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';

export const WRITING_PROVIDER_IDS = Object.freeze(['ollama', 'openrouter', 'openai', 'openai-codex'] as const);
export type WritingProviderId = typeof WRITING_PROVIDER_IDS[number];

export interface WritingProviderConfiguration {
  readonly provider: WritingProviderId;
  readonly model: string;
  readonly endpoint?: string;
  readonly codexTransport?: OpenAICodexTransport;
}

export interface WritingProviderBinding {
  readonly provider: ModelProvider;
  readonly providerId: WritingProviderId;
  readonly model: string;
}

export function isWritingProviderId(value: string): value is WritingProviderId {
  return WRITING_PROVIDER_IDS.some((candidate) => candidate === value);
}

export function parseWritingProviderId(value: string): WritingProviderId {
  if (isWritingProviderId(value)) return value;
  throw new Error(`Unsupported writing provider: ${value}. Supported providers: ${WRITING_PROVIDER_IDS.join(', ')}.`);
}

export function createWritingProvider(configuration: WritingProviderConfiguration): WritingProviderBinding {
  const providerId = parseWritingProviderId(configuration.provider);
  const model = configuration.model.trim();
  if (model.length === 0) throw new Error('Writing provider model must not be empty.');
  if (configuration.codexTransport !== undefined && providerId !== 'openai-codex') {
    throw new Error('codexTransport is valid only for openai-codex.');
  }
  switch (providerId) {
    case 'ollama': return Object.freeze({
      providerId,
      model,
      provider: new OllamaProvider({ model, ...(configuration.endpoint === undefined ? {} : { host: configuration.endpoint }) })
    });
    case 'openrouter': return Object.freeze({
      providerId,
      model,
      provider: new OpenRouterProvider({ model, ...(configuration.endpoint === undefined ? {} : { baseUrl: configuration.endpoint }) })
    });
    case 'openai': return Object.freeze({
      providerId,
      model,
      provider: new OpenAIProvider({ model, ...(configuration.endpoint === undefined ? {} : { baseUrl: configuration.endpoint }) })
    });
    case 'openai-codex': return Object.freeze({
      providerId,
      model,
      provider: new OpenAICodexProvider({
        model,
        ...(configuration.endpoint === undefined ? {} : { baseUrl: configuration.endpoint }),
        ...(configuration.codexTransport === undefined ? {} : { transport: configuration.codexTransport })
      })
    });
  }
}

export function createWritingReasoningRequest(effort: ModelReasoningEffort | undefined): ModelReasoningRequest | undefined {
  if (effort === undefined) return undefined;
  return effort === 'none' ? { strategy: 'disabled' } : { strategy: 'effort', effort, summary: 'auto' };
}
