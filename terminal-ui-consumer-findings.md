# Terminal UI consumer findings

Dependency: `e9ec556d96814a8029936106e5a1a6ef70b5da3c`, resolved from upstream `main` on 2026-09-08. Applications consume this exact commit; this implementation authors no terminal-ui source changes.

The same revision remains upstream main on 2026-09-13, verified during this implementation.

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

## TU05 — Modal dismissal requires a focusable descendant

- Confirmed through the public runtime with raw Escape on 2026-09-12 at the dependency revision above. A modal `dialog` with explicit `focusPolicy`, `dismissOnEscape: true` and `onDismiss`, whose content is a viewport containing only text, does not dismiss. Advancing the memory host's Escape ambiguity deadline makes no difference. The same dialog containing a focusable button dismisses.
- Cause: the runtime invokes component key handlers through `renderNodeLayoutKeyChainForFocus`, which returns an empty chain without a valid focused target. Thus the modal's own Escape handler is unreachable in loading, empty or error states with no focusable content.
- Expected/proposal: route unconsumed input through the active modal scope even without a focused descendant, while preserving child consumption and preventing input from reaching obscured content. Verify text-only/loading/error dialogs, nested scopes, focus restoration, raw Escape and enhanced keyboard events.
- Consumer disposition: provide useful visible Close/Cancel actions and valid focus policies for application interactions. These affordances do not resolve the general defect. Do not add dummy focus targets, copy the input router or intercept Escape globally as a substitute. The general dismissal guarantee remains blocked upstream.

## TU06 — Legacy Alt input can be indistinguishable from Unicode text

- xterm 407's default eight-bit Meta profile emitted UTF-8 `c3 ae` (î) for Alt+N. With its Meta-as-Escape profile it emitted `1b 6e`; the latter opened notes, and Escape/Ctrl+C/repeating the opener closed the application panel and restored composer focus. Ctrl+P works in both profiles.
- This is an input ambiguity, not evidence that a Unicode î should be decoded as Alt+N. Consumers cannot distinguish identical byte sequences and must not guess or replace their input decoder.
- General improvement: expose supported Meta-as-Escape negotiation and input-profile diagnostics through terminal host ownership where the terminal supports them. Verify restoration and preserve literal Unicode under legacy profiles. Command menus remain the discoverable application path; no per-agent byte heuristic is installed.

## TU07 — tmux capability evidence disagrees with session setup

- Reproduced on 2026-09-13 with tmux 3.6a inside xterm 407, `TERM=tmux-256color`, at the pinned dependency. An unwrapped Node `createTerminalHost().getCapabilities()` reports alternate-screen support as `supported/available`; `runTui()` then rejects its required alternate-screen operation as `unknown/available`. Mouse and cursor operations also become unknown. The shell's `stty -g` state is restored after failure.
- A neutral `defineTui` application containing only a Close button reproduces the failure with the native host. It needs no Core or agent imports, custom stdin wrapper, filesystem authority, or provider. Thus the failure is upstream of application rendering; affected tmux startup remains blocked.
- Expected/proposal: host capability discovery and session protocol application must use consistent terminal evidence, while honoring actual multiplexer capabilities and rejected operations. Verify the neutral application under tmux and ordinary xterm, including raw mode, alternate screen, cursor, input ownership, and restoration.
- Consumer disposition: retain required terminal ownership and report failure. Do not override capability truth, weaken required operations, emit private protocol resets, or add a second rendering mode as a workaround.

## Current interaction evidence

- The 2026-09-13 xterm checks exercised command/empty-notes dismissal, focus return, exact drafts, writing patch results, tool disclosure, settings, resize, external-editor success/failure, and exit. A direct Node SIGTERM test preserved the unsent Unicode draft and restored the same terminal settings. Editor output retained Unicode and its trailing newline; failure retained the prior draft. The completed shell sessions had identical before/after `stty -g` values.
- `validation/tui-performance-2026-09-13.json` covers 3,000 stored entries, 48/80/120 columns, simultaneous streaming and typing, command pickers, message navigation, and resize. Typing p95 was 30.8–46.2 ms, streaming p95 33.3–45.9 ms, warm history-page p95 17.3 ms. Picker p95 was 60.6–90.4 ms; paired resize p95 was 315–379 ms. These are measured observations; only the existing input/render/history budgets are enforced. The memory host retains frames and contributes to heap use.
- Actual screen readers, Windows/macOS terminals, SSH, IME and AltGr were not exercised here. Memory-host tests and cross-platform CI do not establish those interactive guarantees. TU02's unrestricted exact clipboard guarantee and TU07's affected multiplexer startup remain unresolved.
