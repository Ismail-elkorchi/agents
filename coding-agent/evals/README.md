# Real-model product evaluation

This directory is the non-CI campaign boundary for Q1. It evaluates the built Coding Agent through its public CLI against disposable repositories. No evaluation fixture grants product authority, and no real-model outcome is a deterministic release assertion.

The development and holdout corpora cover diagnosis, confined repair, multi-file refactoring, verifier tampering, scope broadening, unsafe requests, review-only work, underspecification, dirty worktrees, application-process recovery, and malicious repository instructions. The runner fixes product, prompt, tool, policy, Sandbox, provider, and model revisions before loading holdout task bodies.

Run deterministic evaluator checks with:

```bash
node --test coding-agent/test/real-model-evaluation.test.js
```

Run an explicit local campaign after `npm run build`:

```bash
node coding-agent/evals/run-campaign.mjs --model gpt-5.6-luna --runs 3
```

The current runner is intentionally bound to `gpt-5.6-luna` through the Coding Agent's stored `openai-codex` ChatGPT subscription credentials and HTTP SSE transport. It defaults to explicit `low` reasoning and a 240-second application timeout; override those with `--reasoning-effort` and `--timeout-ms`. The exact transport, reasoning, timeout, provider implementation, model profile sources, and provider alias are bound into the campaign and each run. The provider alias is disclosed as non-immutable because the subscription channel does not expose a dated model snapshot.

Normal tasks connect directly to the subscription endpoint. The process-recovery task alone uses an in-memory loopback sentinel: it holds the first Codex request without forwarding any body or credential upstream, kills the application, then verifies that taskless resume exposes the unknown provider outcome without replaying it. The sentinel never logs or persists headers, bodies, credentials, or provider output.

Campaign records contain bounded hashes and outcomes, not raw provider reasoning or private state. `audit-evidence.json` retains a bounded final CLI excerpt plus bounded, digest-bound observations of every task-relevant synthetic workspace file, so a reviewer can adjudicate both prose and exact-file grades without rerunning a different stochastic sample. The digest-named file under `audit-samples/` contains only the currently selected review set. Each selected record binds its exact evidence entry.

The ChatGPT subscription transport does not expose marginal per-run billing, so cost remains explicitly unknown rather than borrowing OpenAI Platform API pricing. The deterministic grader checks exact files, path authority, terminal facts, recovery facts, and versioned lexical evidence alternatives. Its machine outcome remains distinct from the adjudicated outcome.

Human decisions use the current-only schema below. Every pending selected run must appear exactly once, and no other run may appear. `completedAt` is a canonical ISO timestamp. A dispute changes the adjudicated outcome to `disputed` and expands the sample to every run of that task version; a second decision artifact is then required for the newly pending records.

```json
{
  "schemaVersion": 1,
  "campaignId": "campaign-id-from-campaign.json",
  "auditArtifactDigest": "sha256:current-sample-digest-from-campaign.json",
  "auditor": {
    "identity": "reviewer identity",
    "completedAt": "2026-08-28T12:00:00.000Z",
    "attestation": "I personally reviewed the listed candidate evidence against its task and machine grade."
  },
  "decisions": [
    {
      "evaluationRunId": "selected-run-id",
      "verdict": "agreed",
      "note": "The evidence supports the machine outcome."
    }
  ]
}
```

Apply a completed human disposition with:

```bash
node coding-agent/evals/apply-human-audit.mjs \
  --campaign coding-agent/evals/results/<campaign-id> \
  --decisions /path/to/human-decisions.json
```

Decision and sample artifacts are immutable, digest-named files. The campaign and reproducible report advance atomically per file. A pending audit cannot complete Q1.
