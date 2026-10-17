import { createHash } from 'node:crypto';

const canonical = value => JSON.stringify(value, (_key, entry) => entry &&
  typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

/** Measurements distinguish received calls, invocation attempts, effects, and domain facts. */
export class EvaluationMetrics {
  generationRequests = 0;
  estimatedGenerationPromptTokens = 0;
  estimatedGenerationToolSchemaTokens = 0;
  contextRenewals = 0;
  contextAppends = 0;
  contextUnchanged = 0;
  contextTransitions = [];
  modelInterruptions = 0;
  #calls = new Map();

  record(event) {
    if (event.type === 'model.requested') {
      this.generationRequests++;
      this.estimatedGenerationPromptTokens += event.estimate.totalPromptTokens;
      this.estimatedGenerationToolSchemaTokens += event.estimate.toolSchemaTokens;
    } else if (event.type === 'context.transitioned') {
      if (event.transition.strategy === 'fresh') this.contextRenewals++;
      else if (event.transition.strategy === 'append') this.contextAppends++;
      this.contextTransitions.push({
        strategy: event.transition.strategy,
        cause: event.transition.cause,
        requestedRenewal: event.transition.requestedRenewal === true,
        ...(event.window ? { window: event.window } : {})
      });
    } else if (event.type === 'context.transition.unchanged') this.contextUnchanged++;
    else if (event.type === 'assistant.interrupted') this.modelInterruptions++;
    else if (['tool.call.received', 'tool.started', 'tool.ended'].includes(event.type)) {
      const identity = {
        turnId: event.turnId, requestAttempt: event.requestAttempt,
        toolBatchId: event.toolBatchId, callIndex: event.callIndex
      };
      const key = JSON.stringify(identity);
      let call = this.#calls.get(key);
      if (!call) {
        const callId = event.callId ?? event.toolCall?.id ?? event.input?.id;
        call = { identity, toolName: event.toolCall?.name ?? event.toolName,
          ...(callId === undefined ? {} : { callId }), received: false, attempts: new Map() };
        this.#calls.set(key, call);
      }
      if (event.type === 'tool.call.received') {
        call.received = true;
        const input = event.toolCall?.arguments ?? event.toolCall?.input;
        if (input !== undefined)
          call.inputSha256 = createHash('sha256').update(canonical(input)).digest('hex');
      }
      else {
        let attempt = call.attempts.get(event.toolAttempt);
        if (!attempt) {
          attempt = { toolAttempt: event.toolAttempt, invoked: false };
          call.attempts.set(event.toolAttempt, attempt);
        }
        if (event.type === 'tool.started') {
          attempt.invoked = true;
          call.callId = event.input.id;
        } else {
          const { kind, execution, scope, output } = event.observation;
          attempt.observationKind = kind;
          attempt.executionState = execution?.state;
          attempt.observationCoverage = scope.coverage;
          if (kind === 'failure') attempt.failureReason = output.reason;
          // These are returned domain facts, not a universal success classification.
          const result = kind === 'result' ? output : output.details?.process;
          if (result && typeof result === 'object')
            for (const field of ['status', 'applicationStatus', 'rootState', 'exitCode', 'signal',
              'coverage', 'resultCoverage', 'countCoverage', 'diagnostic'])
              if (field in result) (attempt.domain ??= {})[field] = result[field];
        }
      }
    }
  }

  toJSON() {
    const toolCalls = [...this.#calls.values()].map(call => ({
      ...call, attempts: [...call.attempts.values()]
    }));
    const attempts = toolCalls.flatMap(call => call.attempts);
    const repeated = new Map();
    let repeatedInputs = 0, repeatedFailedInputs = 0, repeatedEffectInputs = 0;
    for (const call of toolCalls) {
      if (!call.inputSha256) continue;
      const key = `${call.toolName}:${call.inputSha256}`;
      const previous = repeated.get(key);
      if (previous) {
        repeatedInputs++;
        if (previous.attempts.some(attempt => attempt.observationKind === 'failure' || attempt.domain?.exitCode > 0))
          repeatedFailedInputs++;
        if (['exec_command', 'apply_patch', 'write_stdin'].includes(call.toolName)) repeatedEffectInputs++;
      }
      repeated.set(key, call);
    }
    return {
      generationRequests: this.generationRequests,
      estimatedGenerationPromptTokens: this.estimatedGenerationPromptTokens,
      estimatedGenerationToolSchemaTokens: this.estimatedGenerationToolSchemaTokens,
      contextRenewals: this.contextRenewals, contextAppends: this.contextAppends,
      contextUnchanged: this.contextUnchanged, contextTransitions: [...this.contextTransitions],
      modelInterruptions: this.modelInterruptions,
      repeatedInputs, repeatedFailedInputs, repeatedEffectInputs,
      evidenceRetrievalCalls: toolCalls.filter(call => ['history_read', 'history_search', 'history_latest'].includes(call.toolName)).length,
      toolCallCount: toolCalls.length,
      invocationAttemptCount: attempts.length,
      invokedAttemptCount: attempts.filter(attempt => attempt.invoked).length,
      rejectedBeforeInvocationCount: attempts.filter(attempt =>
        !attempt.invoked && attempt.executionState === 'not_started').length,
      failureObservationCount: attempts.filter(attempt => attempt.observationKind === 'failure').length,
      toolCalls
    };
  }
}
