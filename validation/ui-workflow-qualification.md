# Offline UI journey qualification

Build the workspace first using its normal build workflow, then run:

```sh
node --test coding-agent/test/ui-workflow-qualification.test.js
node validation/ui-native-workflow.mjs /absolute/path/to/evidence/native visual
```

The native runner must run inside a real terminal, not a pipe. It uses the same
public app entry point and terminal host as the interactive application. The
fixture has synthetic recorded changes, branch boundaries, and approvals. It
never calls a provider, executes a tool, mutates a workspace, or creates branches.
Attempting branch creation is deliberately rejected. The test is presentation
qualification, not proof of the production persistence or provider integration.

The output prefix receives capabilities, native input bytes, rendered frames,
focus snapshots, and a final result with draft, submissions, decisions, and
runtime diagnostics. Evidence can include typed text: only use synthetic input.

## Repeatable keyboard journey

1. Confirm initial Unicode draft `Review carefully: café 世界`.
2. Ctrl+P, type `help`, Enter. Filter `changes`; confirm F7 and /changes are found.
   Clear filter and use Tab/PgDn to inspect lower help content. Escape returns to
   the untouched draft. Some terminals reserve F1, so use the palette fallback.
3. F7, Enter. Inspect recorded-evidence warning, file/hunk navigation, original
   source and highlighted patch. Use Tab to reach controls; PgDn/PgUp/Home/End
   must move the patch rather than the conversation. Next hunk selects an exact
   excerpt; Ask about hunk returns to the composer with an attachment, preserving
   the draft. This is not an apply/revert/approval operation.
4. F5. Inspect semantic prompt previews, Escape. Do not create a fixture branch.
5. Resize the terminal narrower and shorter, then restore it. Check clipping,
   focus, draft, review selection, and footer stability.
6. Optional synthetic approval: replace draft with `approval`, Enter. Inspect
   pending approval and cancel with the explicit denial action. No command runs.
7. Ctrl+P, `exit`, Enter. Confirm normal terminal restoration and final JSON.
8. Repeat with `accessible` replacing `visual` to inspect accessible terminal
   output. This is not a substitute for testing with a real screen reader.

## Coverage boundaries

Memory integration tests cover exact attachment evidence and draft preservation
at 48/120 columns, including a resize during selected-hunk review. Native review
should record terminal/emulator, OS, dimensions, observed journeys, and failures.
Do not infer macOS, Windows, SSH/tmux, IME composition, clipboard interoperability,
contrast compliance, or screen-reader usability from Linux/Xfce visual checks.
