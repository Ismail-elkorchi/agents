# Terminal application measurements

This directory retains the reproducible terminal measurements referenced by `terminal-ui-consumer-findings.md`.

- `tui-baseline.mjs` records the pre-redesign Coding Agent TUI surface.
- `tui-performance.mjs` measures input, rendering, and JSONL history-page latency for Coding Agent and Writing Agent.
- `terminal-measurement-repro.mjs` isolates repeated terminal-ui measurement of unchanged content.
- `terminal-session.mjs` runs a scripted application through the Node terminal host for emulator review.

The adjacent JSON files are recorded results from those programs. Memory-terminal frames contribute to measured heap use, and host load affects latency; treat the reports as bounded observations rather than product guarantees.

Run the source and package gate with `npm run verify:release`.

`coding-agent-reliability.mjs` is an opt-in live evaluation of reading, a 1,000-word expansion, critique, and a follow-up revision in one session, followed by a separate command-execution scenario. It uses fresh temporary workspaces and records actual file counts, revision digests, model settings, tool failures, and durable record locations. It checks objective outcomes; it does not grade prose quality or guarantee future model behavior. Results and session data stay outside committed source.

```sh
node validation/coding-agent-reliability.mjs --live --model gpt-5.6-luna --reasoning low --output coding-agent/evals/results/reliability.json
```

The default is two trials with identical settings; `--commands-only` runs the shell scenario separately. The output file must be new. Provider credentials use the application's normal credential store. `coding-agent/test/process-control.test.js` exercises input, stopping, and workspace access after process settlement; `coding-agent/test/interrupted-response.test.js` injects a broken response after an applied patch and verifies reopen, reconciliation, stopping, and a subsequent prompt.
