export function acceptanceStatus(result) {
  if (result.stopped || result.signal || result.error) return 'error';
  // Exit 1 also means an uncaught exception, missing import or syntax error.
  // Require an explicit receipt from the trusted verifier, not just its exit.
  try {
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (receipt.format !== 'agents.acceptance/1' || typeof receipt.evidence !== 'string' || !receipt.evidence)
      return 'error';
    return receipt.status === 'passed' && result.code === 0 ? 'passed'
      : receipt.status === 'failed' && result.code === 1 ? 'failed' : 'error';
  } catch { return 'error'; }
}

export function providerMeasurements(receipts, metadataRequests = 0) {
  const known = value => Number.isSafeInteger(value) && value >= 0;
  const complete = receipts.every(item => item.status === 'returned' &&
    known(item.usage?.promptTokens) && known(item.usage?.completionTokens));
  const sum = field => receipts.reduce((total, item) => total + (known(item.usage?.[field]) ? item.usage[field] : 0), 0);
  return {
    requests: receipts.length,
    metadataRequests,
    allProviderRequests: receipts.length + metadataRequests,
    usageSource: complete && receipts.length ? 'provider' : 'unavailable-or-partial',
    reported: {
      promptTokens: complete && receipts.length ? sum('promptTokens') : null,
      completionTokens: complete && receipts.length ? sum('completionTokens') : null,
      observedPromptTokens: sum('promptTokens'), observedCompletionTokens: sum('completionTokens'),
      reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null
    },
    cost: { amount: null, currency: null, status: 'unavailable', reason: 'No provider charge receipt or pinned pricing.' },
    receipts
  };
}

// This projection is the sole interpretation of durable attempt facts. It is
// reapplied after outer provider cleanup and during recovery; prior projections
// are deliberately ignored. Solution evidence and experimental qualification
// are separate, so a broken experiment cannot erase a demonstrated wrong answer.
export function projectAttempt(facts) {
  if (facts.format !== 'agents.attempt/2') throw new Error('Incompatible evaluation attempt.');
  const reasons = [];
  const add = (condition, reason) => { if (condition) reasons.push(reason); };
  const checks = facts.acceptance ?? [];
  const wrong = facts.invalidArtifact || facts.phaseEvidence?.some(stage => stage.status === 'violated') || facts.constraintViolations?.length || checks.some(check => check.status === 'failed');
  const cancelled = facts.cancelled || facts.process?.stopped === 'cancelled';
  const timeout = facts.process?.stopped === 'timeout' || facts.environmentSetup?.stopped === 'timeout';
  const badProcess = facts.process && (facts.process.code !== 0 || facts.process.signal || facts.process.error || facts.process.stopped);
  const infrastructure = facts.failurePhase === 'infrastructure' ||
    (facts.failurePhase === 'artifact' && !facts.invalidArtifact) || facts.cleanupErrors?.length ||
    facts.providerAdmissionClosedReason === 'provider_failure';
  const evaluator = facts.failurePhase === 'evaluator' || checks.some(check => check.status === 'error');
  const incomplete = facts.missingCheckpoints?.length || facts.measurementErrors?.length ||
    facts.measurements?.usageSource !== 'provider' || facts.providerAdmissionClosedReason === 'usage_unavailable' ||
    facts.interventions?.some(item => item.receipt?.kind === 'rejected' || item.interrupted === false);
  add(facts.status !== 'finished', 'attempt_not_finished');
  add(cancelled, 'cancelled');
  add(facts.providerCleanup === 'pending', 'provider_cleanup_pending');
  add(infrastructure, 'infrastructure_failure');
  add(evaluator, 'evaluator_failure');
  add(facts.phaseEvidence?.some(stage => stage.status === 'unproven'), 'unproven_phase_constraint');
  add(facts.missingCheckpoints?.length, 'missing_checkpoints');
  add(facts.measurementErrors?.length || facts.measurements?.usageSource !== 'provider', 'incomplete_measurements');
  add(facts.interventions?.some(item => item.receipt?.kind === 'rejected' || item.interrupted === false), 'ineffective_intervention');
  add(facts.humanReview?.some(item => item.status !== 'passed'), 'pending_review');
  add(facts.execution === 'incomplete' || facts.providerAdmissionClosedReason === 'usage_unavailable', 'incomplete_execution');
  add(badProcess && !timeout && !cancelled, 'abnormal_application_exit');
  add(facts.status === 'finished' && !facts.execution && !timeout && !cancelled && !badProcess, 'missing_execution');
  add(facts.execution === 'completed' && !facts.process, 'missing_application_exit');
  let outcome;
  if (facts.status === 'not-started') outcome = 'not_run';
  else if (cancelled) outcome = 'cancelled';
  else if (timeout) outcome = 'timeout';
  else if (facts.execution === 'budget_exhaustion' || facts.providerAdmissionClosedReason === 'request_limit') outcome = 'budget_exhaustion';
  else if (wrong) outcome = 'incorrect_solution';
  else if (infrastructure) outcome = 'infrastructure_failure';
  else if (evaluator) outcome = 'evaluator_failure';
  else if (facts.status !== 'finished') outcome = 'incomplete';
  else if (facts.providerAdmissionClosedReason === 'usage_unavailable') outcome = 'incomplete';
  else if (facts.execution && facts.execution !== 'completed') outcome = facts.execution;
  else if (badProcess || facts.failurePhase === 'agent') outcome = 'agent_failure';
  else if (incomplete || facts.phaseEvidence?.some(stage => stage.status === 'unproven') || !facts.execution || !facts.process) outcome = 'incomplete';
  else if (facts.humanReview?.some(item => item.status !== 'passed')) outcome = 'pending_review';
  else outcome = 'success';
  add(outcome === 'incomplete', 'incomplete_attempt');
  return { ...facts, outcome, qualification: { qualified: reasons.length === 0, reasons } };
}

export function comparisonStatus(attempts, cancelled = false) {
  return cancelled || attempts.some(attempt => attempt.cancelled || attempt.process?.stopped === 'cancelled') ? 'cancelled'
    : attempts.every(attempt => attempt.status === 'finished' && !attempt.cleanupErrors?.length && attempt.providerCleanup !== 'pending') ? 'finished' : 'incomplete';
}

export function pairedReport(attempts, builds) {
  const pairs = [];
  const groups = Map.groupBy(attempts.map(projectAttempt), attempt => `${attempt.task}:${attempt.repetition}`);
  for (const [id, values] of groups) {
    const a = values.find(value => value.build === builds[0].label);
    const b = values.find(value => value.build === builds[1].label);
    const incomplete = !a || !b || !a.qualification.qualified || !b.qualification.qualified;
    const both = !incomplete && a.outcome === 'success' && b.outcome === 'success';
    const delta = field => both && a.measurements?.reported[field] != null && b.measurements?.reported[field] != null
      ? b.measurements.reported[field] - a.measurements.reported[field] : null;
    pairs.push({
      id, order: values.map(value => value.build),
      outcomes: [a?.outcome ?? 'not-run', b?.outcome ?? 'not-run'],
      change: incomplete ? 'incomplete' : a.outcome === 'success' && b.outcome !== 'success' ? 'regression'
        : a.outcome !== 'success' && b.outcome === 'success' ? 'improvement' : 'no-completion-change',
      elapsedDeltaMs: both ? b.elapsedMs - a.elapsedMs : null,
      promptTokenDelta: delta('promptTokens'), completionTokenDelta: delta('completionTokens'),
      costDelta: null,
      renewalEvidence: [a, b].map(value => (value?.metrics?.contextRenewals ?? 0) > 0)
    });
  }
  return {
    pairs,
    summary: Object.fromEntries(['improvement', 'regression', 'incomplete', 'no-completion-change']
      .map(kind => [kind, pairs.filter(pair => pair.change === kind).length])),
    interpretation: 'Diagnostic paired observations, not evidence of superiority. Repeated attempts are not independent tasks. No confidence claim from a small pilot; inspect every failure and pending review. No renewal-quality inference where renewalEvidence is false.'
  };
}
