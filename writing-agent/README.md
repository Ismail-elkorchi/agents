# Writing Agent

A workspace assistant for writing, revising, researching from local sources, and discussing text. Requests run in a persistent conversation. Editing writes directly to files; review mode exposes read-only workspace tools. There is no required brief schema, document registration, proposal approval sequence, or automatic editorial judge.

Build from the repository root with `npm run build`, then launch:

```sh
node writing-agent/dist/cli.js tui --root /path/to/workspace
node writing-agent/dist/cli.js review --root /path/to/workspace --provider openai-codex --model MODEL 'Review the introduction in article.txt.'
node writing-agent/dist/cli.js write --root /path/to/workspace --provider openai-codex --model MODEL 'Revise the introduction in article.txt.'
```

With an installed executable, use `writing-agent` in place of `node writing-agent/dist/cli.js`. No arguments opens the TUI in an interactive terminal. `WRITING_AGENT_PROVIDER` and `WRITING_AGENT_MODEL` supply defaults. Providers are `ollama`, `openai`, `openai-codex`, and `openrouter`; `--endpoint` selects an endpoint and `--reasoning` requests a reasoning effort.

The TUI opens the conversation at full width. Missing provider/model settings open a guided picker; authentication and supported reasoning settings are reachable from `/model` or `/provider`. Save persists the complete default selection; cancel preserves the draft and previous configuration. Other open clients reconcile the saved provider, model, and endpoint before accepting their next input. An unavailable connection leaves the input unsubmitted and the client usable. `/mode` changes the edit/review default independently.

Type `/` for command suggestions or Ctrl+P for the searchable menu. Enter sends; Shift+Enter or Alt+Enter inserts a newline. Ctrl+O expands tool output; Ctrl+T shows provider-exposed reasoning. Ctrl+F searches recorded history and F3/Shift+F3 navigate matches. Alt+PageUp/PageDown move between messages. Escape closes the top interaction; Ctrl+C copies a selection, otherwise dismisses a popup before interrupting active work. Ctrl+P toggles commands. Ctrl+D exits from an empty composer; `/exit` preserves an unsent draft. F1 shows the current shortcuts.

`/files` opens documents on request; `/document`, `/conversation`, `/split`, `/outline`, and `/passage` navigate source and selected passages. The split view has a draggable, keyboard-resizable divider. `/conversation` hides the document. Narrow terminals show one view. Refresh loads a new document snapshot; Changes compares it with the previous observed revision. Streaming text, reasoning, tool inputs, progress, observations, and recorded changes share Core's presentation components. `/source` inspects earlier messages and individual code blocks without copying screen borders.

`/attach` manages authorized text/passage references and native images supported by the selected provider. `@` completes workspace resources. `/drafts` recalls prior or recovered requests without sending. Drafts and attachments survive session switching and controlled restart. `/editor` or Ctrl+G uses `VISUAL` or `EDITOR` and restores terminal ownership after success or failure. `/sessions`, `/new`, `/name`, `/queue`, `/recovery`, `/context`, and `/export` expose recorded history, pending input, decisions, authorized context, and a local export whose coverage is explicit.

`/settings` and `/statusline` offer themes, reasoning visibility, tool disclosure, ordered status fields, optional notifications, and shortcut overrides. Presentation changes do not grant permission or alter model context. Clipboard transport preserves selected source text, including tabs and line endings. Terminal capabilities are negotiated by terminal-ui.

Choose review mode for suggestions before editing. Ask a later edit-mode request to apply chosen suggestions or undo a change; original requests, patches, and observations remain available through history. Source and rendered views are presentation choices, not a mandated output format. The agent does not assume a language, word-count convention, entity catalog, or preservation criterion. State those requirements in the conversation when relevant.

`/context` shows the selected state revisions alongside selected originals.

Tools read, list, search, and patch workspace files. Model-managed history, session state, and context selection support continuing work. Documents are retrieved when needed instead of filling a fixed-size excerpt template. Session state cannot grant permission or establish that a claim is verified. Model judgments and review responses are not independent verification certificates.

Core saves narrative items independently from the exact revisions selected for model context. State is fallible interpretation, not verification or authority. Bounded history and item retrieval preserve originals; renewal preserves session identity, permissions, effects and accounting. See Core's [context guide](https://github.com/Ismail-elkorchi/agent-core/blob/main/docs/CONTEXT.md) for save, selection, atomic save-and-activate and recovery APIs. This build uses strict `agent-core.session/8` records and request presentations that bind exact selected material, skill revisions and authority dependencies. Older session and request-presentation records are incompatible and are rejected; their original bytes remain intact. There is no migration or legacy reader. Use the matching earlier build to access older records.

Optional `read_document_section`, `read_document_passage`, and `compare_document_revisions` tools provide exact original text, revision hashes, and source ranges. Markdown headings and offsets come from markspan; plain text needs no structure. Section reads accept a heading or its `headingStart` and page with a section-relative `offset`. Duplicate headings or quotations produce explicit conflicts; passages can instead select an exact half-open UTF-16 range or quotation occurrence. Reads validate at most 2 MiB of original UTF-8 source before parsing; excerpt pages contain at most 65,536 UTF-16 code units. Offsets cannot split a Unicode scalar or CRLF pair. Returned `range`, `expectedText`, and `expectedSha256` compose directly with `edit_text`, which uses one-based Unicode-scalar line/column positions. Edit mode enables both `edit_text` and `apply_patch` through the same patch journal; review mode exposes neither writer. Stale full-file hashes reject edits, including unrelated concurrent changes, without rebasing them.

`document.read` retains the exact opened snapshot for passage selection. Model section reads retain original revisions only with `retain: true`. The returned `revision` includes `path`, `expectedSha256`, and, when retained, `artifactId`. Comparisons require both revisions to be currently readable at their expected hash or explicitly retained. Missing historical bytes are unavailable; a hash cannot recover them. Comparison returns the exact region between the common prefix and suffix, including any intervening changes, and independently paged before/after excerpts (`beforeOffset` and `afterOffset`). It is a textual comparison, not a factual or editorial verdict.

The TUI's selected passage goes through `readPassageContext()` on the application service. Its attachment identifies the canonical rooted source URI, SHA-256 revision, and exact UTF-8 byte range. Identical selections coalesce; identical text from different documents remains distinct. Retained and current reads of the same original produce the same attachment identity. The quotation does not claim the current file is unchanged. External edits do not silently change that quotation. RPC exposes `document.section`, `document.passage`, `document.compare`, and `document.passage_context`; the latter returns a context item for ordinary `input.submit`/`input.follow` requests. CLI `write` and `review` accept repeated `--passage` JSON values using the same service request, for example `--passage '{"revision":{"path":"article.md","expectedSha256":"<hash from a read>"},"selector":{"quote":"Exact quotation"}}'`. Include the retained `artifactId` to quote an earlier revision. Explicit source retention across context transitions is a separate user context-selection action; ordinary passage attachment does not protect every completed-turn instruction forever.

The application API and state layout are breaking replacements; existing project-state directories are not migrated.

Private state defaults to `$XDG_STATE_HOME/writing-agent` or `~/.local/state/writing-agent`; `--state-root` must point outside the workspace. File access uses Agent Core's rooted authority, which currently requires Linux. Symlinks, reserved state directories, and `.git` are excluded. The default tool catalog contains no shell or network execution capability; bounded web retrieval and MCP sources require explicit host configuration. Requests to a configured model provider still use its connection. Pending runs retain their admitted file permission mode across restart. Unknown provider or tool outcomes require reconciliation or stopping through the recovery controls.

Headless applications import `openWritingApplication` from `@ismail-elkorchi/writing-agent`, call `start()`, submit an instruction string, await the returned completion, and close the application. An explicit configuration can set run limits or a session inference budget; ordinary work has no preset task budget. Runtime capacity and compiled-request limits still apply.

`writing-agent rpc` serves JSON-RPC 2.0 on standard input/output. Methods cover instruction submission, edit/review selection, documents, sessions, history, context, and recovery. Terminal rendering is exposed separately through `@ismail-elkorchi/writing-agent/tui`; neither adapter owns editing or session policy.




Generation allowance is an application decision. The default reserves up to 16,384
output tokens, bounded by advertised output capacity and half the context window;
`--max-output-tokens` overrides it. Context inspection reports the effective
reservation and whether the endpoint enforces a cap. A reservation-only endpoint
can exceed that amount; actual usage still counts against the continuing session
budget. This default has structural coverage, not live-model quality validation.

Model, reasoning, and account commands open directly. Escape closes the active popup or interrupts active work; it preserves the draft. Submission failures remain visible above the composer until dismissed.

## Opening saved conversations

Saved conversations open automatically. Longer waits show “Opening conversation…”.
Closing the application or choosing another conversation cancels the pending opening.
If a conversation cannot be opened, the application explains the problem and keeps
its saved messages intact; other conversations remain usable.

### Resource policy

The CLI (including `rpc`) accepts `--inference-budget JSON`, `--context-policy JSON`,
`--context-control-policy JSON`, and `--output-reservation-policy JSON`. These are
also application options and `WritingConfiguration` fields. Explicit application
options take precedence over the supplied configuration.

- `inferenceBudget`: `maxInvocations`, `maxPromptTokens`, `maxCompletionTokens`,
  and `maxKnownCost: { amount, currency }`. These continuing session-owner limits
  are separate from per-run `limits` and per-request `--max-output-tokens`.
  Runs, model changes, and context renewal do not reset consumption. Once admitted,
  the owner policy is immutable; changing configuration does not replenish it.
  Known cost excludes unpriced usage.
- `contextPolicy`: positive integer byte limits `maxSourceBytes`,
  `committedRetainedStateBytes`, `sessionStateMutationBytes`, and
  `sessionStateReadBytes`. Retained state counts committed revisions, including
  history and forks; it is not physical artifact disk usage.
- `contextControlPolicy`: finite context-control presentation and attempt bounds,
  including `requestsPerBoundary`, `outputTokens`, and `reserveMode` (`required`
  or `advisory`). Omitted fields use Core's explicit defaults.
- `outputReservationPolicy`: `{ minimum, maximum }` authorizes model-selected
  output reservations within these positive bounds. Its maximum cannot exceed the
  configured generation allowance. Without it, that allowance is fixed.

RPC `context.read`, or application `inspectContext()`, reports effective byte
policy and operational allowance with settled usage, outstanding exposure, and
remaining allowance. RPC `configuration.set` selects a model without granting a
new owner budget.

## Optional tool capabilities

The CLI, RPC application and TUI share the same session tool configuration:

- `--programmatic-tools '{}'` enables the isolated portable JavaScript runner. The JSON object overrides validated compute, memory, output and call limits. Programs call qualified tools through the ordinary authorization and effect executor; they receive durable structured receipts. Interrupted code is not automatically replayed.
- `--native-tools '{"programmatic":true,"discovery":true}'` selects provider-native tool exposure explicitly. The actual endpoint/model must support the requested features. Native and portable programmatic execution cannot both be selected.
- `--web-tools '{"policy":{"id":"public-research-v1"}}'` enables bounded public-HTTPS source retrieval. Add `search:{"provider":"brave","credentialEnvironmentVariable":"BRAVE_SEARCH_API_KEY"}` for search. Credentials are read by the host, never supplied as tool arguments. Returned redirects require a separately authorized fetch.
- `--mcp-tools '{"servers":[]}'` configures optional MCP sources. Each server requires its host-assigned identity, endpoint, account and policy revision, and explicit per-tool effects. See `@agent-core/tools-mcp` for the bounded configuration contract. Discovery does not grant execution authority.

The corresponding application options are `programmaticTools`, `nativeToolExposure`, `webTools` and `mcpTools`. With none supplied, existing local-only tool behavior is preserved. Workspace edit/review permissions remain independent of optional network configuration. Source captures retain original bytes and identify any derived text separately.

## Collaboration

Bounded collaboration is available through ordinary model tools by default. Participants
run as separate durable sessions under the same host resource coordination and continuing
budget owner. Resource leases coordinate one supervised collaboration family in its admitted
workspace. Independent application hosts and external editors do not share those leases;
exact-base validation still protects edits against changed files. Worktrees are not an
isolation boundary. The host supplies narrowed profiles; a participant cannot grant itself more
authority. Read-only and review modes remain read-only.

`collaboration_inspect` is available immediately. The model discovers other collaboration
operations through `tool_catalog_discover` and selects only the needed exact tool references
with `tool_catalog_select`. Discovery and selection do not expand the session's grants.

`--collaboration JSON` overrides `maxParticipants`, `maxConcurrentRuns`, `maxWaitMs`,
`maxPendingOperations`, and `participantBudget`; `--collaboration false` disables collaboration. The corresponding
application/configuration field is `collaboration`. Defaults permit four participants and
two concurrent participant runs. Participant allowances accumulate across continuations;
they do not replace or replenish the host's `inferenceBudget`.

The optional `/collaboration` inspector lists bounded pages of participants, their
session/run identities, current assignments and recorded result references. Select a
participant to send user steering, continue settled work, interrupt, cancel, or wait.
Steering is recorded as user input; peer contributions retain model-authored sender attribution.
Refresh and delivery-gap recovery read the canonical recorded state rather than reconstructing
execution from display events.

RPC provides `collaboration.read` (`offset`, `limit`, maximum 64),
`collaboration.participant`, `collaboration.send`, `collaboration.continue`,
`collaboration.interrupt`, `collaboration.cancel`, and `collaboration.wait`.
Mutating controls require the inspected participant/session/run identity and current epoch;
stale targets fail rather than controlling another run. Continuation retains the participant's
existing grants. Starting participants remains an ordinary governed model-tool operation.


## Host-configured retained material and skills

Embedding hosts can pass `materials` and `skills` through the application options. `materials` uses the shared Core `ContextServiceOptions['materials']` contract: an explicit material repository, artifact repository, current grant provider, optional erasure capability, and retention/read bounds. The host owns those scopes and storage locations independently of workspace paths. Opaque subject references do not decide ownership or audience. `skills` is an explicit `SkillCatalog` from `@agent-core/skills`; portable sources require no shell or workspace. The optional filesystem source in `@agent-core/skills/node` currently requires Linux rooted-file capabilities. The host owns source lifetimes and must await filesystem-source closure when acknowledging withdrawal.

These capabilities are embedding-host inputs, not project configuration or authority extracted from remembered text. Session and collaboration setup never infer a scope from a person's name. Participants do not inherit the supervisor's material or skill sources; selected peer contributions still use the existing explicit peer grants.

`/memory` includes current-session material and opens the ordinary retained-material panel. It lists bounded granted scopes and exact revisions, reads original bodies, submits user corrections, revokes future use, and requests physical erasure where the host supports it. RPC exposes the same service through `material.owner`, `material.scopes`, `material.list`, `material.read`, `material.correct`, `material.revoke`, and `material.erase`. Correction requests include the current `sessionId` and exact inspected reference. They reject an already stale head and return `correction_submitted`; this is durable user input, not a claim that the retained revision has already changed. When work is running, the correction steers that exact run; a run change during inspection rejects the action. Idle corrections start ordinary input. The eventual update must pass conditional revision checks.

Revocation blocks future use and does not erase historical records. The panel explicitly confirms revocation followed by an erasure request and reports any partial outcome. Physical erasure is a separate optional capability: unsupported hosts reject it, and supported hosts return per-target coverage for bodies, previews, indexes and caches, including retained shared bytes. Original history and request snapshots remain separately governed; prior provider delivery is not erased. `/context` shows exact selected material and skill revisions and reports an unavailable selection when current access no longer permits it. Saving or discovering does not silently activate content, and a skill's requested-tools metadata cannot grant execution authority.

## Privileged future-work admission

An embedding host can connect Core `HostWakeService` to `application.hostWakeSession(sessionId)` through its `resolveSession` callback. Restore or select that exact application session first; a stale facade fails closed. The host supplies durable intentions, clock/event observation, current authorization and its admission fence, and drives startup recovery and later event delivery. The application does not install a scheduler or infer future authorization from conversation text.

This ingress is absent from user RPC and model tool catalogs. Ordinary input rejects a forged `host_wake` origin. Accepted wakes use the existing session run lifecycle, budgets, cancellation, history and notifications; repeated trigger delivery returns the original admission receipt. RPC history and the TUI preserve typed host-wake provenance rather than presenting it as a direct user instruction.

Before a triggered submission is admitted, Writing Agent durably prepares the current edit/review permission for its exact deterministic run identity. Preparation is idempotent, rejects a changed grant, and is reused after restart; remembered text never reconstructs file authority.
