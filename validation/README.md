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

## Terminal applications

`tui-baseline.json` records the inspected coding TUI before this implementation. `node --expose-gc validation/tui-performance.mjs` measures input/rendering latency and actual JSONL history reads for both consumers. The memory host records frames for inspection, so its heap measurements explicitly include retained test frames and must not be presented as live-terminal steady-state memory.

`validation/terminal-session.mjs coding|writing /tmp/evidence-prefix` runs an isolated scripted application through the real Node terminal host and records plain frames, exit state and diagnostics. The fixture creates temporary product data and removes it on exit; it performs no live model evaluation. Run it inside a terminal emulator; the automated memory-host suites provide complementary deterministic interaction and domain checks. `terminal-ui-consumer-findings.md` records confirmed public API limitations without modifying that dependency.

`tui-terminal-2026-09-09.json` records the xterm walkthroughs at 48 and 120 columns, including writing acceptance/application/undo, source selection, clipboard round trips, Unicode paste, resize, external editing and exit. Optional enhanced keyboard and grapheme protocols were unavailable. Exact copying of tabs, CRLF and other source changed by terminal-ui's display sanitizer remains blocked and is reported visibly by both consumers; the plan's unrestricted copy criterion is not complete.

`tui-performance-2026-09-09.json` records the final measured workload. Warm history reads are bounded and do not rebuild the index; cold index construction is reported separately. The 700-entry interaction tests separately exercise complete history traversal, unloaded search, bounded page caches and draft/anchor restoration. Functional test deadlines are not latency measurements.

The final recorded latency gate passed: input P95 is 13–29 ms, rendering P95 is 14–30 ms, and warm JSONL page P95 is 16 ms, within the 50/50/100 ms targets. `tui-performance-before-profiling-2026-09-09.json` and `tui-performance-measured-viewport-2026-09-09.json` preserve earlier failures. Load and sampled clock speeds differed substantially; those earlier reports sampled only CPU 0 before and after execution, while the final report records all CPUs. These results do not establish a speed improvement over the baseline or a guarantee under arbitrary host load. `terminal-measurement-repro.mjs` and its recorded result isolate repeated library measurement on unchanged content (TU04), which remains an opportunity for improvement.

The local release gate passed with `taskset -c 0-2 npm run verify:release`, bounding Node's test concurrency on the shared host: 200 tests passed, six namespace-dependent tests were skipped, and independent packed consumers passed. Test workloads and deadlines were unchanged; CI retains its normal runner configuration.
