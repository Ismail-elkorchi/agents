import { parseJsonObject } from '@agent-core/json';
import { parseModelSelection, type ModelSelection } from '@agent-core/model';
import { isCodingAgentProviderId, type CodingAgentProviderId } from '../configuration.js';
import { PrivateStateDirectory } from './private-state.js';

export interface CodingAgentModelSelection extends ModelSelection {
  readonly provider: CodingAgentProviderId;
}

export class ModelSelectionStore {
  constructor(private readonly state: PrivateStateDirectory) {}

  async read(): Promise<CodingAgentModelSelection | undefined> {
    const encoded = await this.state.read('settings/model-selection.json');
    if (encoded === undefined) return undefined;
    const value = parseJsonObject(JSON.parse(encoded), { maxTotalBytes: 64 * 1024 });
    if (value.version !== 1) throw new Error('Stored model selection is invalid.');
    const fields = { ...value };
    delete fields.version;
    const selection = parseModelSelection(fields);
    if (!isCodingAgentProviderId(selection.provider))
      throw new Error('Stored model selection has an invalid provider.');
    return { ...selection, provider: selection.provider };
  }

  write(selection: CodingAgentModelSelection): Promise<void> {
    return this.state.write(
      'settings/model-selection.json',
      `${JSON.stringify({ version: 1, ...selection })}\n`
    );
  }
}
