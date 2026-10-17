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

export function pairedReport(attempts, builds) {
  const pairs = [];
  const groups = Map.groupBy(attempts, attempt => `${attempt.task}:${attempt.repetition}`);
  for (const [id, values] of groups) {
    const a = values.find(value => value.build === builds[0].label);
    const b = values.find(value => value.build === builds[1].label);
    const incomplete = !a || !b || [a, b].some(value =>
      value.status !== 'finished' || value.measurementErrors?.length ||
      value.measurements?.usageSource !== 'provider' ||
      ['not_run', 'incomplete', 'pending_review', 'cancelled', 'infrastructure_failure', 'evaluator_failure'].includes(value.outcome));
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
