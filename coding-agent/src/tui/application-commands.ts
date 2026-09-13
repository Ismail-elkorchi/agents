import type { CodingSubmissionResult } from '../application/contracts.js';
import type { CodingApplication } from '../application/service.js';
import { parseCodingPermissionMode } from '../security/permission-mode.js';
import { parseInteractiveCommandLine, type InteractiveCommandResult } from './interactive-commands.js';

export async function executeCodingCommand(
  application: CodingApplication,
  line: string
): Promise<InteractiveCommandResult> {
  const parsed = parseInteractiveCommandLine(line);
  if (parsed.kind === 'interface') return { message: '', action: parsed.message };
  const { command, value } = parsed;
  switch (command) {
    case '/permissions': {
      const state = await application.selectPermissionMode(
        parseCodingPermissionMode(value, '/permissions')
      );
      return { message: `Permission mode: ${state.runtimeDetails.permissions?.mode ?? 'pending setup'}` };
    }
    case '/trust':
      if (value !== 'restricted' && value !== 'trusted') throw new Error('Choose restricted or trusted.');
      await application.selectWorkspaceTrust(value);
      return { message: `Workspace trust: ${value}` };
    case '/temperature': {
      const current = application.modelSelection();
      if (current === undefined) return { message: '', action: { type: 'configuration.open' } };
      const selection = { ...current, temperature: Number(value) };
      const adapter = application.connectProvider(selection.provider, selection.endpoint);
      await application.configureModel(selection, adapter);
      return { message: 'Model configuration saved.' };
    }
    case '/steer':
      return submissionPresentation(await application.steer({ task: value }), value);
    case '/follow':
      return submissionPresentation(await application.follow({ task: value }), value);
    case '/stop':
      if (!(await application.abort(value || undefined))) throw new Error('No active run to abort.');
      return { message: 'Abort requested.' };
    case '/status':
      return {
        message: '',
        action: {
          type: 'panel.source-loaded',
          title: 'Application status',
          content: JSON.stringify(application.state(), null, 2)
        }
      };
    case '/debug':
      return { message: '', action: { type: 'overlay.open', overlay: 'debug' } };
  }
}

export function submissionPresentation(
  result: CodingSubmissionResult,
  text: string
): InteractiveCommandResult {
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
