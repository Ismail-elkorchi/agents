# Redesign validation, 2026-09-08

The application workloads use the real `gpt-5.6-sol` subscription endpoint through the governed runtime. They are development tools, not application dependencies. JSON reports include source-content fingerprints, provider/profile identity, admitted budgets, and actual outcomes. The deployment alias has no disclosed immutable model revision, and subscription dollar costs are unknown.

`harness-redesign-live-2026-09-08.json` records a successful Coding review across eight user contributions: the PostgreSQL correction and original `total(values)` interface survived intervening prompts, the final answer identified the source defect, and files remained unchanged. Its Writing workload stopped during fixture creation because two resources were assigned to the same document node. This was a benchmark fixture error, not a measured model failure.

`writing-redesign-live-2026-09-08.json` retains that diagnosed fixture failure. After assigning the readable reference its own resource, `writing-redesign-live-v2-2026-09-08.json` records successful proposal correction across two runs in one Writing operation. The selected successor used the requested numbered list, read/edit grants remained distinct, and neither file was applied. Both recorded verifications required no semantic invocation. Per-attempt token accounting was not captured by this version of the Writing benchmark; the runner now includes it in subsequent reports.

These are single application trials, not comparative quality evidence. Core's separate reports under `docs/validation/redesign-*.json` compare replay, retrieval and notes with matched memory workloads; all comparative quality gates remain inconclusive. No result selects a universal memory policy.

`harness-redesign-final-2026-09-08.json` repeats both application workloads after the full local release gate passed against Core `af50d0041ebbd068a68e3ec13be6d042333f1dca`. Both trials passed: Coding retained the corrected database and original API requirement across eight runs, and Writing selected a valid numbered-list successor within one operation. Files remained unchanged. This report includes per-attempt token accounting for both applications and elapsed time for each workload (about 74 and 75 seconds). Its application commit identifies the pre-commit base; the source-content fingerprint identifies the tested implementation. The comparative quality gate remains inconclusive.

Deterministic tests separately cover exact observation retrieval, protected artifacts, conflicting note revisions, steering/source identity, uncertain effects, resource leases, stale publication, legitimate verifier changes, verifier weakening, shared budgets, cancellation and recovery. Live mutation/publication, concurrent steering and process-loss measurements remain unmeasured here. The local host cannot establish the required Linux Sandbox namespace backend; platform CI exercises the supported cases.

Run `npm run verify:release` for source, domain tests, conformance and packed consumers. Run an explicitly bounded live application workload with:

```sh
node scripts/evaluate-harness-redesign.mjs --mode live --provider codex \
  --model gpt-5.6-sol --endpoint https://chatgpt.com/backend-api/codex \
  --codex-auth-file /absolute/path/to/auth.json --trials 1 \
  --workloads coding-review,writing-correction --delay 4 \
  --max-invocations 24 --max-prompt-tokens 200000 \
  --max-completion-tokens 8000 --timeout-ms 180000 --output /new/report.json
```

Authentication is read only and is never copied into reports. Use a new output path to preserve prior measurements. Default dry mode performs no model generation.
