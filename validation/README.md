# Terminal application measurements

This directory retains the reproducible terminal measurements referenced by `terminal-ui-consumer-findings.md`.

- `tui-baseline.mjs` records the pre-redesign Coding Agent TUI surface.
- `tui-performance.mjs` measures input, rendering, and JSONL history-page latency for Coding Agent and Writing Agent.
- `terminal-measurement-repro.mjs` isolates repeated terminal-ui measurement of unchanged content.
- `terminal-session.mjs` runs a scripted application through the Node terminal host for emulator review.

The adjacent JSON files are recorded results from those programs. Memory-terminal frames contribute to measured heap use, and host load affects latency; treat the reports as bounded observations rather than product guarantees.

Run the source and package gate with `npm run verify:release`.
