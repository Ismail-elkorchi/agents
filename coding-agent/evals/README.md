# Real-model product evaluation

This directory is the non-CI campaign boundary for Q1. It evaluates the built Coding Agent through its public CLI against disposable repositories. No evaluation fixture grants product authority, and no real-model outcome is a deterministic release assertion.

The development and holdout corpora cover diagnosis, confined repair, multi-file refactoring, verifier tampering, scope broadening, unsafe requests, review-only work, underspecification, dirty worktrees, application-process recovery, and malicious repository instructions. The runner fixes product, prompt, tool, policy, Sandbox, provider, and model revisions before loading holdout task bodies.

Run deterministic evaluator checks with:

```bash
node --test coding-agent/test/real-model-evaluation.test.js
```

Run an explicit local campaign after `npm run build`:

```bash
node coding-agent/evals/run-campaign.mjs --model gemma4:e2b --runs 3
```

Campaign records contain bounded hashes and outcomes, not raw provider reasoning or private state. Local Ollama inference records zero API cost with an explicit basis; it does not pretend electricity or hardware depreciation is known. Human audit remains a distinct signed disposition. A pending audit cannot complete Q1.
