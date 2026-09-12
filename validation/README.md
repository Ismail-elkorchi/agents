# Terminal application measurements

This directory retains the reproducible terminal measurements referenced by `terminal-ui-consumer-findings.md`.

- `tui-baseline.mjs` records the pre-redesign Coding Agent TUI surface.
- `tui-performance.mjs` measures input, rendering, and JSONL history-page latency for Coding Agent and Writing Agent.
- `terminal-measurement-repro.mjs` isolates repeated terminal-ui measurement of unchanged content.
- `terminal-session.mjs` runs a scripted application through the Node terminal host for emulator review.

The adjacent JSON files are recorded results from those programs. Memory-terminal frames contribute to measured heap use, and host load affects latency; treat the reports as bounded observations rather than product guarantees.

Run the source and package gate with `npm run verify:release`.

`coding-agent-evaluation.mjs` is an opt-in live evaluation with independent fixtures for code repair, changing JSON requirements across prompts, read-only inspection of mixed files, and a command request. Checks execute the repaired module or inspect final files; tool choices are recorded, not prescribed by a task-specific verification tool. The review scenario checks that files remain unchanged; it does not grade the explanation. The command scenario checks its saved result; process control is covered by the structural tests below. These fixtures are evaluation inputs, never product instructions or tools.

```sh
node validation/coding-agent-evaluation.mjs --live --provider PROVIDER --model MODEL --reasoning EFFORT --output /absolute/new-report.json
```

Provider and model are required. Reasoning is optional and otherwise uses provider defaults. `--trials N` repeats each scenario; `--scenario ID` selects one. Each trial uses a new workspace and session. The report records model settings, execution outcomes, responses, checks, and diagnostic tool traces. The output file must be new; partial results survive a failed trial. Credentials use the application's normal store. Keep reports and session data outside committed source.

The live evaluator does not exercise the TUI or establish writing quality. `coding-agent/test/process-control.test.js` covers process input, stopping, and workspace access after settlement. `coding-agent/test/interrupted-response.test.js` covers a broken response after an applied patch, reconciliation, and a subsequent prompt. Both agents also have memory-terminal interaction and retained-history tests.
