import type { CodingLoginResult, CodingSubmissionResult } from '../application/contracts.js';
import { parseReasoningEffort } from '../application/input.js';
import { parseProviderId, reasoningFromEffort } from '../application/runtime.js';
import type { CodingApplication } from '../application/service.js';
import { parseCodingPermissionMode } from '../security/permission-mode.js';
import { parseInteractiveCommandLine, type InteractiveCommandResult } from './interactive-commands.js';

export async function executeCodingCommand(
  application: CodingApplication,
  line: string
): Promise<InteractiveCommandResult> {
  if (!line.startsWith('/')) return submissionPresentation(await application.submit({ task: line }), line);
  const { command, value } = parseInteractiveCommandLine(line);
  switch (command) {
    case '/exit':
    case '/quit':
      return { message: 'Exit requested.' };
    case '/provider': {
      const provider = parseProviderId(value);
      await application.selectProvider(provider);
      return { message: `Provider: ${provider}. Select a model.` };
    }
    case '/model': {
      const state = await application.selectModel(value);
      return { message: `Model: ${state.runtimeDetails.providerId ?? 'select a provider'}/${value}` };
    }
    case '/permissions': {
      const state = await application.selectPermissionMode(parseCodingPermissionMode(value, '/permissions'));
      return { message: `Permission mode: ${state.runtimeDetails.permissions?.mode ?? 'pending setup'}` };
    }
    case '/trust':
      if (value !== 'restricted' && value !== 'trusted') throw new Error('Choose restricted or trusted.');
      await application.selectWorkspaceTrust(value);
      return { message: `Workspace trust: ${value}` };
    case '/temperature':
      await application.selectTemperature(Number(value));
      return { message: `Temperature: ${value}` };
    case '/reasoning-effort':
      await application.selectReasoning(
        reasoningFromEffort(parseReasoningEffort(value, '/reasoning-effort'))
      );
      return { message: `Reasoning effort: ${value}` };
    case '/login': {
      return loginPresentation(await application.login(value ? parseProviderId(value) : undefined));
    }
    case '/steer':
      return submissionPresentation(await application.steer({ task: value }), value);
    case '/follow':
      return submissionPresentation(await application.follow({ task: value }), value);
    case '/abort':
      if (!(await application.abort(value || undefined))) throw new Error('No active run to abort.');
      return { message: 'Abort requested.' };
    case '/resume': {
      const result = await application.resumeSuspension();
      return { message: result.state === 'suspended' ? 'The run is still paused. No recorded result is available yet.' : 'The run has finished.' };
    }
    case '/context':
      if (value === '' || value === 'inspect')
        return { message: JSON.stringify(await application.inspectContext(), null, 2) };
      if (value !== 'retain') throw new Error('/context accepts inspect or retain.');
      await application.retainHistory();
      return { message: 'Original selected history retained.' };
    case '/status': {
      const state = application.state();
      const phase = state.session?.phase ?? state.status;
      return {
        message:
          state.status === 'setup_required'
            ? `Complete setup: ${state.requirements.join(', ')}.`
            : `${phase.charAt(0).toUpperCase()}${phase.slice(1)} · ${state.runtimeDetails.providerId ?? 'provider'}/${state.runtimeDetails.modelId ?? 'model'}`
      };
    }
    case '/debug':
      return { message: JSON.stringify(application.state(), null, 2), view: 'debug' };
  }
}

function loginPresentation(result: CodingLoginResult): InteractiveCommandResult {
  switch (result.kind) {
    case 'not_required':
      return { message: 'Ollama does not require credentials.' };
    case 'authenticated':
      return { message: 'OpenAI Codex credentials stored.' };
    case 'api_key':
      return {
        message: result.available
          ? `${result.provider} API key is available.`
          : `Set ${result.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'} and restart.`
      };
  }
}

function submissionPresentation(result: CodingSubmissionResult, text: string): InteractiveCommandResult {
  if (result.kind === 'rejected') throw new Error(`Input rejected: ${result.reason}.`);
  // Execution failures are presented by the application's event stream.
  void result.completion.catch(() => undefined);
  switch (result.kind) {
    case 'started':
      return { message: 'Run started.', submission: { acceptance: result, text } };
    case 'steered':
      return { message: 'Steering accepted.', submission: { acceptance: result, text } };
    case 'queued':
      return { message: 'Follow-up queued.', submission: { acceptance: result, text } };
  }
}
