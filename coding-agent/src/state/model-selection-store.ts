import { parseJsonObject } from '@agent-core/json';
import { isCodingAgentProviderId, type CodingAgentProviderId } from '../configuration.js';
import { PrivateStateDirectory } from './private-state.js';

export interface CodingAgentModelSelection {
  readonly provider: CodingAgentProviderId;
  readonly model?: string;
}

export class ModelSelectionStore {
  readonly #state: PrivateStateDirectory;

  constructor(state: PrivateStateDirectory) {
    this.#state = state;
  }

  async read(): Promise<CodingAgentModelSelection | undefined> {
    const encoded = await this.#state.read('settings/model-selection.json');
    if (encoded === undefined) return undefined;
    const value = parseJsonObject(JSON.parse(encoded), {
      maxDepth: 4,
      maxCollectionEntries: 16,
      maxStringBytes: 8_192,
      maxTotalBytes: 16_384
    });
    const keys = Object.keys(value);
    if (value.version !== 1 || keys.some((key) => key !== 'version' && key !== 'provider' && key !== 'model')) {
      throw new Error('Stored model selection is invalid.');
    }
    if (!isCodingAgentProviderId(value.provider)) throw new Error('Stored model selection has an invalid provider.');
    if (value.model !== undefined && (typeof value.model !== 'string' || value.model.trim().length === 0)) {
      throw new Error('Stored model selection has an invalid model.');
    }
    return Object.freeze({
      provider: value.provider,
      ...(typeof value.model === 'string' ? { model: value.model } : {})
    });
  }

  write(selection: CodingAgentModelSelection): Promise<void> {
    const model = selection.model?.trim();
    return this.#state.write('settings/model-selection.json', `${JSON.stringify({
      version: 1,
      provider: selection.provider,
      ...(model === undefined || model.length === 0 ? {} : { model })
    })}\n`);
  }
}
