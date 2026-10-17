// Real changes, not invented historical defects. Instructions are authored
// evaluation requests; the staged correction is not claimed to be a past user.
export const projectTasks = [
  {
    id: 'persistence-lock-ownership', split: 'development',
    fix: 'a022634d06d03b641fc0922e288d036b3471f403',
    start: '2ec82c15b03862b8d8a53106846b688e9d3cb2a9',
    instructions: 'In core, fix filesystem persistence lock ownership. Same-process writers must queue without spending the external acquisition timeout; failed operations must release locks without poisoning later writers. A displaced owner must report lost ownership without removing a replacement lock. Surface release failures even when the operation also fails; never label a committed conditional append as not committed because release failed. Preserve reentrancy and recovery of abandoned locks. Change only persistence implementation files; do not change public contracts, tests or dependencies.',
    writable: ['core/packages/persistence/src/'],
    tests: ['tests/persistence-lock.test.js'],
    checkpoints: []
  },
  {
    id: 'provider-usage-completeness', split: 'development',
    fix: '3717830fc92be03c464b35ec767f23edddee8ded',
    start: '0b1c5405672af9fa9c9faf3c9739846b67146b8f',
    instructions: 'In core, preserve uncertainty when providers omit token usage. Audit Ollama, OpenAI, OpenAI Responses, Codex and OpenRouter adapters. Missing or invalid required counts must not become fabricated zero usage; complete valid usage must preserve zero values and optional cache/reasoning counts. Keep provider behavior and shared contracts consistent. Do not change tests, dependencies or unrelated packages.',
    writable: ['ollama', 'openai', 'openai-responses', 'openai-codex', 'openrouter'].map(name => `core/packages/providers/${name}/src/`),
    tests: ['tests/provider-usage-completeness.test.js'],
    oracleNote: 'The upstream respond helper explicitly asserts that provider response does not reject; all original response/usage assertions remain.',
    checkpoints: []
  },
  {
    id: 'resource-coverage-correction', split: 'development',
    stages: [
      { id: 'inspect-without-editing', completedRun: 1, rule: 'no-edit', mutationAttempts: 'record-only' },
      { id: 'review-without-editing', completedRun: 2, rule: 'no-edit', mutationAttempts: 'record-only' }
    ],
    fix: 'a022634d06d03b641fc0922e288d036b3471f403',
    start: '2ec82c15b03862b8d8a53106846b688e9d3cb2a9',
    instructions: 'In core, inspect resource completion and describe how an empty search is displayed. Do not edit yet. Record the relevant source locations for later work. Preserve resource quoting, replacement ranges and selection behavior throughout this task.',
    writable: ['core/packages/tui/src/'],
    tests: ['packages/tui/test/resource-completion.test.js'],
    oracleNote: 'Calls to updateResourceCompletion explicitly assert that the declared result contract does not throw; all original rendering, quoting and selection assertions remain.',
    checkpoints: [
      { id: 'broader-review', after: { type: 'run.completed', occurrence: 1 }, action: 'follow',
        instruction: 'Still do not edit. Review the surrounding composer, resource loading, and existing completion regressions. Explain how search coverage is propagated, retaining the earlier constraint about quoting and selection. Initially propose treating empty lists as no matching resources.' },
      { id: 'supersede-empty-assumption', after: { type: 'run.completed', occurrence: 2 }, action: 'follow',
        instruction: 'Correction: an empty partial search must NOT claim there are no matching resources. Implement explicit partial-results disclosure for both nonempty and empty partial searches; reserve the definitive no-match message for complete empty searches. ResourceSearch.search must return { coverage: "complete" | "partial", items: ResourceSuggestion[] }; resource.loaded must carry this value as result rather than a bare items array. Propagate that contract through loading, state and rendering. Export the view as resourceSuggestions for consumers. Supersede the earlier assumption; preserve quoting, replacement ranges and selection behavior. Only change TUI implementation files, not tests or dependencies.' }
    ]
  },
  {
    id: 'draft-shutdown-settlement', split: 'held-out',
    fix: 'b8e1f2a558bbce609b209de9ba3c5db941ffe6e5',
    start: '959959a45c9cbcbacf76d740dde515b5f548d05d',
    instructions: 'In core, make TUI draft shutdown attempt every pending session draft save before reporting save failures. One failed save must not prevent the remaining drafts from being saved. Expose saveDrafts for consumers, preserve per-session draft values, and aggregate failures after all saves settle. Change only TUI implementation files, not tests or dependencies.',
    writable: ['core/packages/tui/src/'],
    tests: ['packages/tui/test/drafts-queue.test.js'],
    checkpoints: []
  }
];

export const continuationBuilds = {
  A: { agents: '040f5c496dfa87ad2ebb556c5d75c0b9451d43ff', core: '60b9929793725f46522a79f78f64e04d73030bc0', behavior: 'prior reset-on-state-update' },
  B: { agents: 'b92973b83b6e74d6892312ae6d31e41e0054040a', core: 'a9e65e23b413dbf17b0d161a0b02c01261944d8d', behavior: 'selective continuation, original state schema' },
  C: { agents: '6e79e1914b5e40456cc364ee41f55ad2f4279d83', core: 'd745f1b72996390f8dd1a52143c5838ef1e93692', behavior: 'selective continuation, narrative blocks' }
};
