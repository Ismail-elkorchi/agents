# Terminal application measurements

This directory retains reproducible terminal measurements. Dated results describe their recorded dependency revisions; rerun the scripts to measure the current applications.

- `tui-baseline.mjs` records the pre-redesign Coding Agent TUI surface.
- `tui-performance.mjs` measures input, rendering, and JSONL history-page latency for Coding Agent and Writing Agent.
- `terminal-measurement-repro.mjs` isolates repeated terminal-ui measurement of unchanged content.
- `terminal-session.mjs` runs a scripted application through the Node terminal host for emulator review.

The adjacent JSON files are recorded results from those programs. The September 13 workload uses 3,000 persisted entries and interleaves streamed output with typing, pickers, message navigation, and resizes at 48, 80, and 120 columns. `terminal-session.mjs` takes `coding|writing` and an absolute evidence prefix; it isolates application data and records frames, focus, input bytes, capabilities, and outcomes for emulator checks. Memory-terminal frames contribute to measured heap use, and host load affects latency; treat the reports as bounded observations rather than product guarantees.

Run the source and package gate with `npm run verify:release`.

`coding-agent-evaluation.mjs` is an opt-in live evaluation with independent fixtures for code repair, changing JSON requirements across prompts, read-only inspection of mixed files, and a command request. Checks execute the repaired module or inspect final files; tool choices are recorded, not prescribed by a task-specific verification tool. The review scenario checks that files remain unchanged; it does not grade the explanation. The command scenario checks its saved result; process control is covered by the structural tests below. These fixtures are evaluation inputs, never product instructions or tools.

```sh
node validation/coding-agent-evaluation.mjs --live --provider PROVIDER --model MODEL --reasoning EFFORT --output /absolute/new-report.json
```

Provider and model are required. Reasoning is optional and otherwise uses provider defaults. `--trials N` repeats each scenario; `--scenario ID` selects one. Each trial uses a new workspace and session. The report records model settings, execution outcomes, responses, checks, per-step latency, received calls and invocation attempts, pre-invocation rejections, observation kinds, execution states, and domain outcomes (including conflicts and process exit codes), interruptions, fresh context renewals, append publications, unchanged updates, requested renewal and actual strategy/cause, and estimated schema/prompt tokens for ordinary generation requests. Auxiliary session-state renewal calls are included in the authoritative run budget's inference usage and cost accounting, not in those generation estimates. Component estimates describe admission and overhead; they are not billed token totals. Each trial keeps one trace per run, including runs that fail before completing a step. Tool traces are keyed by call and attempt identities from received, started, and ended events rather than a bounded history page; delivery gaps or failures mark the measurements as incomplete. A zero fresh-renewal count does not rule out append or unchanged transitions. Protocol continuity, provider-reported cache usage, and retained information are distinct measurements. The output file must be new; partial results survive a failed trial. Credentials use the application's normal store. Keep reports and session data outside committed source.

The live evaluator does not exercise the TUI or establish writing quality. `coding-agent/test/process-control.test.js` covers process input, stopping, and workspace access after settlement. `coding-agent/test/interrupted-response.test.js` covers a broken response after an applied patch, reconciliation, and a subsequent prompt. Both agents also have memory-terminal interaction and retained-history tests.

## Isolated continuation comparison preparation

`continuation-comparison.mjs` supplies executable scenarios for the existing `coding-agent-evaluation.mjs`; it adds no execution engine or production strategy switch. Select one explicitly with `--scenario ID`:

- `project-task-continuity`: the actual baseline regression workspace and prompts, inspecting a sum defect, changing the settings goal, and preserving the math source. Checks inspect actual workspace bytes and parsed settings. The existing `module-repair` scenario separately executes repaired code.
- `late-corrected-requirement`, `rejected-approach`, `changed-goal`: sequential user prompts audit pinned project sources, checking corrected answers, exact evidence and source preservation.
- `deep-tool-evidence`: a long diagnostic file places the real source appendix after 4,096 inert lines; ordinary file tools retrieve it. The final question also requires abstention about an unmeasured production failure rate.
- `changed-external-resource`: the existing runner's per-step hook replaces a local resource between prompts; the model must reread it. This controlled local replacement does not exercise an external service.

The five source-audit probes are narrower than actual project work. Exact answer/evidence checks are deterministic, while explanation quality and whether a model found the best evidence still require semantic review. Citation order, expanded exact quotes and extra valid evidence are accepted. These evaluation fixtures never become product instructions or tools. The default live workload is unchanged.

All sources come from the shipped data-only `fixtures/continuation-baseline.json`: four exact regression files from Agents baseline `040f5c496dfa87ad2ebb556c5d75c0b9451d43ff`. The 21 KB corpus preserves original line offsets and context, with path/revision provenance plus verified corpus/per-file SHA-256 hashes. Historical test text is never executed. Preparation needs no Git history, credentials or network, including in shallow CI checkouts.

Run the deterministic preparation and actual existing-evaluator integration checks with:

```sh
node --test coding-agent/test/continuation-comparison.test.js
```

These tests run the evaluator against the existing loopback scripted Ollama server, including real file reads, an actual settings patch, and resource replacement. They make no paid provider calls. The evaluator accepts `--max-output-tokens N` to keep generation reservations explicit and matched across builds; the scripted 32K fixture uses 4096.

`prepareComparison` takes `[primaryTaskScenario(), ...comparisonFixtures()]`, separately qualified A/B/C build declarations, explicit model/tool settings, per-trial and total charge caps, token/preparation/time budgets, and repetitions. It returns counterbalanced A→B and B→C ordinary-workload trials. A is the original Core/Agents pair; B must be the qualified original-schema continuation commit, C the later narrative-block commit. B/C are required inputs. The declaration does not verify qualification claims or enforce live budgets: exact clean heads, dependency pins, qualification receipts and hard budget enforcement must be checked before paid execution.

Pressure, repeated state growth and interrupted committed effects use existing deterministic regression commands listed in `mechanicsCases`, bound to each declared revision by `prepareComparison`:

- Core `tests/context-recovery-accounting.test.js` on A/B/C
- Core's `repeated appended state notices` test in `tests/native-context-renewal.test.js` on B/C, where append exists
- Agents `coding-agent/test/interrupted-response.test.js` on A/B/C

Run those commands in each separate pinned repository build after its normal build qualification. They exercise actual recovery, repeated notices and injected stream failure; they are mechanical checks, not matched live-quality trials. No fake intervention DSL or forced narrative-state generator remains. Live pressure/repeated-state/provider-interruption comparisons remain unimplemented and must not be reported as supported.

E1 still requires explicit model/workload/repetition/spending approval. Use existing `EvaluationMetrics` and authoritative run budgets, preserve failed/incomplete trials and actual receipts, and mark unavailable charges or token fields unknown rather than zero. No model-quality or cost improvement is established by these deterministic checks.
