import {
  parseModelReasoningRequest,
  type ModelProvider,
  type ModelReasoningEffort,
  type ModelReasoningRequest
} from '@agent-core/model';
import { OllamaProvider } from '@agent-core/provider-ollama';
import { OpenAIProvider } from '@agent-core/provider-openai';
import { OpenAICodexProvider, type OpenAICodexTransport } from '@agent-core/provider-openai-codex';
import { OpenRouterProvider } from '@agent-core/provider-openrouter';

export const WRITING_PROVIDER_IDS = Object.freeze([
  'ollama',
  'openrouter',
  'openai',
  'openai-codex'
] as const);
export type WritingProviderId = (typeof WRITING_PROVIDER_IDS)[number];

export interface WritingProviderConfiguration {
  readonly provider: WritingProviderId;
  readonly model?: string;
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
  throw new Error(
    `Unsupported writing provider: ${value}. Supported providers: ${WRITING_PROVIDER_IDS.join(', ')}.`
  );
}

export function createWritingProvider(configuration: WritingProviderConfiguration): WritingProviderBinding {
  const providerId = parseWritingProviderId(configuration.provider);
  const model = configuration.model?.trim();
  if (model === '') throw new Error('Writing provider model must not be empty.');
  if (configuration.codexTransport !== undefined && providerId !== 'openai-codex')
    throw new Error('codexTransport is valid only for openai-codex.');
  const options = {
    ...(model === undefined ? {} : { model }),
    ...(configuration.endpoint === undefined ? {} : { baseUrl: configuration.endpoint })
  };
  let provider: ModelProvider;
  switch (providerId) {
    case 'ollama':
      provider = new OllamaProvider({
        ...(model === undefined ? {} : { model }),
        ...(configuration.endpoint === undefined ? {} : { host: configuration.endpoint })
      });
      break;
    case 'openrouter':
      provider = new OpenRouterProvider(options);
      break;
    case 'openai':
      provider = new OpenAIProvider(options);
      break;
    case 'openai-codex':
      provider = new OpenAICodexProvider({
        ...options,
        ...(configuration.codexTransport === undefined ? {} : { transport: configuration.codexTransport })
      });
      break;
  }
  return { providerId, model: model ?? provider.describe().defaultModel, provider };
}

export function createWritingReasoningRequest(
  effort: ModelReasoningEffort | undefined
): ModelReasoningRequest | undefined {
  if (effort === undefined) return undefined;
  return parseModelReasoningRequest(
    effort === 'none' ? { strategy: 'disabled' } : { strategy: 'effort', effort }
  );
}
