# Terminal UI consumer findings

Dependency: `e9ec556d96814a8029936106e5a1a6ef70b5da3c`, resolved from upstream `main` on 2026-09-08. Applications consume this exact commit; this implementation authors no terminal-ui source changes.

The public modal-dialog type permits an input that its runtime rejects (TU01). Other observations below distinguish application responsibilities from dependency limitations.

## Application responsibilities established at baseline

- The coding composer's fixed two-row height comes from the application's grid tracks, not a restriction of `textArea()`.
- Markdown parsing and source identity belong to markspan. Converting its nodes into terminal elements and presenting coding changes or writing revisions belong to the consumers.
- The current display eviction, repeated conversation measurement, and command choices are application policies. Their presence does not demonstrate a library defect.
- Both consumers now use `measuredViewport()` with retained entries, consistent word wrapping and an explicitly reserved scrollbar column. The public primitive exposed inconsistent consumer measurements; manual spacer columns were removed.

## Findings format

Each confirmed issue records an ID and status, affected public API and revision, reproduction environment and neutral input, expected and observed behavior, evidence, ownership, the workaround otherwise required, a general library proposal and validation condition, and the consumer disposition. Unconfirmed observations remain labeled as such. Proposed contracts must not contain agent-specific concepts.

## Environment and evidence

- Runtime: Node 24.14.0, npm 11.8.0, Linux. Reproducible baseline measurements are recorded under `validation/`.
- Real emulator checks used xterm 407 on an isolated Xvfb 21.1.22 display, at 48 and 120 columns, through the public Node terminal host. Keyboard review/application/undo, Unicode paste, resize, pointer selection, OSC 52 clipboard round trips, external editing and normal exit were exercised. `validation/tui-terminal-2026-09-09.json` records the results.
- xterm did not negotiate the optional enhanced keyboard or grapheme protocols. Ordinary keys and Ctrl+O multiline insertion remained usable. Clipboard round trips required the emulator's explicit clipboard permission.
- macOS and Windows terminal emulators, SSH, multiplexers, screen readers and physical-terminal steady-state memory remain unmeasured. Cross-platform package CI and memory-host tests do not establish those capabilities.

## TU01 — Modal focus invariant is missing from the public type

- Status: confirmed at the pinned revision; application uses an explicit focus policy. No terminal-ui changes authored.
- Reproduction: in TypeScript, construct `dialog({id: 'example', title: 'Example', modal: true, width: 40, height: 10, slots: {content: text({content: 'Loading'})}})`. This compiles, then throws “Modal dialog requires focusPolicy” during component creation. Reproduced with Node 24.14.0 and the memory terminal host while composing navigation dialogs.
- Impact: a consumer can ship a type-correct modal that fails when opened. A loading surface needs the same deliberate focus policy as an interactive surface.
- Ownership/proposal: terminal-ui should express modal/nonmodal options as a union requiring `focusPolicy` for modal dialogs. A compile-time consumer fixture should reject its absence, and an explicit-focus loading dialog should render and restore focus. This is general dialog behavior, with no application-domain terminology.
- Consumer disposition: supply stable initial and return-focus policies. This fulfills the runtime contract; no workaround or alternate dialog engine is needed.

## TU02 — Clipboard payloads undergo display normalization

- Status: confirmed at the pinned revision. Exact copying of text that changes under `sanitizeTerminalText` is blocked; applications report this explicitly and preserve original source. No alternate clipboard encoder or terminal-ui modification is introduced.
- Reproduction: `createClipboardWriteSequence('a\t文\r\nb', {allowed: true})` returns an OSC 52 sequence whose decoded UTF-8 payload differs from the supplied text. `TuiEffectContext.copySelectedText` also sanitizes its input before reaching this encoder. Reproduced on Node 24.14.0 through the installed public protocol and TUI APIs; the behavior is independent of the emulator.
- Expected: explicitly authorized clipboard text should survive transport encoding exactly, subject to an explicit byte limit. Escaped/base64 clipboard payloads are data, whereas cell-rendered text needs terminal display sanitization.
- Impact: source-code tabs, CRLF documents, and literal control-sequence examples cannot be copied exactly through the public clipboard API. A consumer otherwise must encode OSC 52 itself or use an external clipboard program, duplicating terminal ownership and protocol policy.
- General proposal: separate clipboard payload validation and byte accounting from display sanitization. Preserve exact Unicode source in the base64 payload; reject unsupported or oversized payloads explicitly. A round-trip test should decode the generated payload and compare exact source, including tabs, CRLF, combining characters, and literal escape sequences. Preserve terminal output ownership and suspension behavior.
- Consumer disposition: source readers retain original text; source-selection copy uses the public clipboard API only when it preserves the selected text. An explicit visible message identifies unavailable exact copy. This remains an upstream limitation against the plan's unrestricted copy-fidelity criterion.

## TU03 — Multiline editing lacks document-boundary keybindings

- Status: confirmed at the pinned revision in xterm 407 on the isolated Xvfb display. Read-only text areas accept Ctrl+A and Shift+arrow selection, but Ctrl+Home and Ctrl+Shift+End do not move/select to document boundaries. Input logs contain the correct CSI `1;5H` and `1;6F` sequences; the public text-area movement bindings omit these combinations.
- Impact: users accustomed to document editors cannot navigate or select long sources with those keys. Consumers would otherwise add their own document-start/end movement bindings.
- PageUp/PageDown also use a fixed ten-logical-line movement in the public document editor, independent of viewport height or wrapped rows. The writing help test confirms that repeated page keys reach the final controls; a page key does not currently mean one visible page.
- General proposal: add document-boundary movement operations and the conventional Ctrl+Home/End and Ctrl+Shift+Home/End bindings for multiline text, preserving line-boundary Home/End behavior. Verify wrapped text, selection direction, read-only documents, and scroll reveal.
- Page movement should use the active text layout and viewport geometry while preserving selection and preferred columns. Consumers should not need to replace the editor's movement engine to obtain viewport-sized paging.
- Consumer disposition: use existing Ctrl+A, Shift+arrows, page navigation, and pointer selection; no replacement editor or custom text-area key engine. This is an optional upstream usability improvement, not a loss of source access.

## TU04 — Unchanged measured content is measured again on sibling updates

- Status: confirmed repeated work at the pinned revision; this is a performance finding, not a correctness failure. `node validation/terminal-measurement-repro.mjs` reuses the same element, measured collection and window while changing only sibling text. Measurement calls increase from 2 at startup to 22 after ten updates; the result is in `validation/terminal-measurement-repro-2026-09-09.json`.
- Impact: retaining the collection and parser does not retain component measurement. A CPU profile of the application workload attributed about 9.3 seconds of 40.5 seconds of samples to terminal-ui grapheme functions, including `richText` measurement through `wrapRenderSpans`. This does not establish that all latency comes from the library.
- General proposal: provide bounded retention of measured component content with explicit invalidation for model revision, constraints, width profile, theme and other declared measurement inputs. Establish the row invariant when those inputs change and reuse the result for unrelated updates. Verify unchanged siblings, changed wrapping, resize, Unicode and stale measurements; preserve validation of mismatched row geometry.
- Consumer disposition: use the supported measured viewport and correct its inputs, without bypassing measurement validation or implementing a second layout engine. The final recorded workload meets its 50/50/100 ms input/rendering/history budgets. Earlier runs missed the input/rendering budgets and are preserved under `validation/`; their CPU 0 clock samples are not a continuous record of execution speed. Neither host conditions nor this hotspot alone establish the full cause of the variation. Retaining component measurement remains a general performance opportunity.
