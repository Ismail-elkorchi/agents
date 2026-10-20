# Coding Agent

Coding Agent is a conversational coding application composed from Agent Core. It keeps durable conversation history and exposes the same application service through its CLI, TUI, package API, and JSON-RPC adapter. Its contracts are pre-alpha and may change without compatibility layers.

## Start the application

```bash
# Interactive TUI
coding-agent
coding-agent "inspect the failing checks"

# One noninteractive request
coding-agent exec "summarize the workspace"
printf '%s\n' 'summarize the workspace' | coding-agent exec -

# Continue recorded work
coding-agent --resume
coding-agent --session SESSION_ID
coding-agent exec --resume
```

Interactive startup shows the missing workspace-trust and model decisions as controls. Trust and execution permissions are separate choices. `/model` opens provider and model pickers, authentication, supported reasoning settings, and temperature. Selection is applied together and saved for future submissions; an active run retains its admitted configuration. Other open clients reconcile the complete saved provider, model, and endpoint before accepting their next input. If the selected connection cannot be prepared, the input remains unsubmitted and the client remains usable. Cancel keeps the previous selection and unsent draft.

Type `/` for command suggestions or press Ctrl+P for the searchable command menu. Enter sends; Shift+Enter or Alt+Enter inserts a newline. Ctrl+O toggles tool details; Ctrl+T toggles provider-exposed reasoning. Ctrl+F searches recorded history; F3/Shift+F3 move between search matches; Alt+PageUp/PageDown move between messages. Ctrl+PageUp/PageDown load history, and Ctrl+End returns to live output. F1 shows the actual current bindings, including saved overrides.

Escape closes the top interaction. Ctrl+C copies an active selection, otherwise closes a popup before requesting interruption of active work. Ctrl+P toggles commands. Ctrl+D exits from an empty composer; `/exit` also preserves an unsent draft. `/stop` requests interruption without erasing it.

`/settings` and `/statusline` offer theme, reasoning visibility, tool disclosure, optional notifications, shortcut controls, and an ordered status-field selection with preview. Save applies presentation preferences without changing model inference or workspace authority. `/status` exposes full details and identifies unavailable accounting.

`/attach` adds, inspects, or removes authorized file and passage context and supported native images. `@` completes workspace references. `/drafts` recalls earlier or recovered prompts without sending them. Drafts retain text, caret, selection, and attachments across session switches and controlled restart. `/editor` or Ctrl+G uses `VISUAL` or `EDITOR`, suspends terminal ownership, and preserves the draft on failure.

`/sessions`, `/new`, `/name`, `/queue`, and `/branches` manage conversation navigation. Queue controls distinguish editing/canceling accepted pending input from composing a new request; steering is an explicit action. Branching history does not revert files. `/source` inspects messages, code, and tool results; `/export` writes the loaded history coverage locally. `/context` distinguishes available resources and the unsent draft from the latest admitted request and shows the current generated session state. `/processes` inspects session-owned commands and authority-wide recovery blockers. Input and termination require the current session owner; recovery decisions bind the current evidence revision. `/changes` shows recorded patches; `/recovery` handles pending approvals and uncertain outcomes.

Use `coding-agent --accessible` for semantic terminal scrollback instead of visual screen painting. Keyboard and paste input use the same application controls; Ctrl+L repeats the current accessible context. The package runner accepts `outputMode: 'accessible'`. This is an explicit output choice, not a claim of complete screen-reader qualification. The flag is interactive-only and does not change exec or RPC output.

Clipboard transport preserves selected source text, including tabs and line endings. Terminal capabilities are negotiated by terminal-ui; unsupported operations are reported explicitly.

## Review and continue work

`/help` is the terminal-independent fallback when the terminal intercepts F1. Help
search covers commands and current shortcut bindings. The command menu identifies
Compose, Review, Continue and Configure actions. Reading surfaces use the available
terminal space; compact selection dialogs remain small. Switching sessions closes
the previous session's inspectors and completion candidates while retaining its
draft and history bookmark.

Routine completed read and search calls can appear in a display-only group.
Expand the group to see its calls, then a call to inspect its original details.
Counts describe calls, not inferred files or successful effects. Active, failed
and uncertain calls remain separate; expanding all tools disables grouping.
Presentation never rewrites saved events or model-facing observations.

`/changes` navigates recorded files and patch hunks. **Original / select** exposes
exact text for selection and copying. **Ask about change**, **Ask about hunk** and
**Ask about selection** attach captured evidence to the existing draft without
submitting it. The attachment identifies the recorded run and content digest;
later filesystem edits do not replace its content. These are recorded mutation
patches, potentially containing multiple files, not a current working-tree diff
or a complete inventory of shell-created changes. Missing patches remain explicit.

Branch navigation leads with admitted task text when available and identifies
unloaded prompts honestly. It creates a conversation branch in the same workspace,
not an isolated Git worktree or a filesystem rollback. Contextual controls lead to
recorded changes, pending decisions and settled process output. Context-pressure
indicators describe an estimated admitted request, not live filesystem state.
Approval and recovery controls bind to the request or suspension they display;
old controls cannot decide a replacement request.

## Workspace authority

A new workspace starts untrusted. Record a decision from the TUI or CLI:

```bash
coding-agent trust status --root .
coding-agent trust trusted --root .
coding-agent trust revoke --root .
```

Repository content cannot grant trust or change the selected permission mode. Trust admits workspace content for model and tool use; permissions decide what tools can do. Project configuration can narrow the available tools.

Permission modes are:

| Mode | Workspace capability |
| --- | --- |
| `read_only` (default) | Read the selected host project; no edits or commands |
| `full_host` | Edit the host project and run commands under the host account, with access to the rest of the system and network |

Both modes use the selected host project directly. Run change reports fold recorded patch receipts into net file states, retaining explicit initial/final absence, presence, or uncertainty. Add-then-delete and restored contents have no net change; their receipts remain in history. Committed move provenance follows edits and chained moves without treating reused paths as the same original file. These reports are not a complete inventory of command-created changes.

Runs, sessions, artifacts, journals, trust decisions, and user model settings live in the platform user-state directory. `--state-root` selects another dedicated state directory outside the workspace. Coding Agent does not create private state inside the project.

## Command execution

Read-only mode starts no command executor. Full Host mode uses Agent Core's supervised local command executor with the host account's environment and network access. Commands are supervised for their admitted lifetime. Observation waits yield on output, completion, their bounded wait deadline, or steering; running results retain session-owned process handles and resource authority. `write_stdin` and `stop_process` operate across model runs. Closing the application stops session jobs and records their original-owner terminal results.

Captured output buffers have bounded retention. Terminal identity, ownership, status, and artifact references remain queryable after buffer expiration and application restart. Stopping an already completed owned process returns its original terminal outcome. Output availability and execution uncertainty remain separate facts; accepting uncertainty never certifies success or replays a command.

Coding Agent's host-root authority currently requires Linux `/proc`. Host workspace access is unavailable on macOS and Windows.

## Repository guidance

Coding Agent refreshes root/configured guidance and discovers ancestor `AGENTS.md` files for concrete file and process effects without scanning unrelated repository trees. Content revisions, configured precedence, and absent/deleted paths determine applicability. A collection callback does not establish delivery: only the exact source IDs in an admitted request do. The runtime rechecks guidance under the effect's resource lease before execution, including after approval. Changed guidance releases the earlier binding and supplies the new material for a new model decision. Symbolic-link guidance is not followed; unsafe or oversized applicable sources remain explicit and block the affected mutation.

## Explicit checks

Task budgets are optional. Project configuration can set explicit turn, tool, time, token, or cost limits; ordinary sessions have no preset task budget. Runtime capacity and compiled-request limits still apply.

Project configuration may name required and advisory commands. `run_check` binds the complete definition and the selected command executor before authorization, using the same file/process leases as shared tools. It is unavailable in read-only mode. Its historical observation records the command, effective timeout (60 seconds by default), configuration and definition identities, requirement classification, declared coverage, invocation/process identities, and before/after tested state. History adds the committed event receipt. Changing or deleting today's configuration cannot relabel that observation.

Outcomes are `passed`, `failed`, `timed_out`, `cancelled`, `execution_failed`, `not_started`, or `unknown`. Proven dispatch refusals are `not_started`; they do not require an execution-outcome recovery decision. A known nonzero exit is failed even with incomplete logs; a zero exit remains an observed pass. Output completeness and applicability are separate. Relevant observed changes make applicability `stale`; otherwise opaque command dependencies and possible external mutations leave it `unknown`. Matching before/after contents do not prove that inputs stayed unchanged during execution. Check-written changes cannot certify the resulting workspace.

Optional `testedPaths` declares up to 256 explicit rooted files, including dirty/untracked or currently absent paths. It does not recursively select directories or assert a complete shell dependency graph. Capture limits are 1 MiB per file, 4 MiB total and 1,024 rooted observation operations at each boundary. Missing scope, unsafe paths, oversized files or exhausted capture bounds produce incomplete/unknown applicability without preventing an authorized command. No check becomes mandatory for unrelated requests, and a check pass does not establish overall task success.

Application state, RPC session/history views, CLI and TUI expose the recorded definition, outcome, current applicability, and output completeness. Verification history uses bounded indexed pages (256 scanned events / 8 MiB per refresh), retaining at most 256 observations per cached run and 32 cached runs. `verification.history` reports completeness, omitted earlier checks and the last scanned sequence; subsequent reads advance the bounded page. A whole verification refresh shares one 256-file / 4 MiB / 1,024-operation current-state capture budget, reusing identical scopes and reporting unknown applicability when it is exhausted. A complete view may show `not_run` for an exact configured definition with no recorded observation; partial history never fabricates that claim. Original events remain available through history access.


```json
{
  "version": 1,
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "instructions": [],
  "tools": { "enabled": ["read_files", "search_text", "apply_patch", "exec_command"] },
  "verification": {
    "required": [
      { "id": "test", "command": "npm test", "coverage": "full", "timeoutMs": 120000, "testedPaths": ["package.json", "package-lock.json"] }
    ],
    "advisory": []
  }
}
```

The optional `limits` object accepts Agent Core's current run limits. Project configuration can narrow the selected tools. It cannot activate itself in an untrusted workspace.

## Durable conversation and recovery

Informational questions and editing tasks use the same Agent Core session contract. A user prompt does not create a separate revision workflow. Original contributions, corrections, tool observations, provider state, context selections, session state, branches, queued input, approvals, and uncertain effects remain durable.

Core saves narrative items independently from the exact revisions selected for model context. State is fallible interpretation, not verification or authority. Bounded history and item retrieval preserve originals; renewal preserves session identity, permissions, effects and accounting. See Core's [context guide](https://github.com/Ismail-elkorchi/agent-core/blob/main/docs/CONTEXT.md) for save, selection, atomic save-and-activate and recovery APIs. This build uses strict `agent-core.session/8` records and request presentations that bind exact selected material, skill revisions and authority dependencies. Older session and request-presentation records are incompatible and are rejected; their original bytes remain intact. There is no migration or legacy reader. Use the matching earlier build to access older records.

An approval binds the exact tool input, effects, implementation, policy, and execution target. Changed facts invalidate it. Effects with an unknown outcome are not replayed automatically. `--resume` without a task drives only an unfinished accepted run.

Conversation storage is authoritative. Live TUI delivery is a projection: a delivery gap or listener failure triggers a fresh state/history read, and stale asynchronous pages cannot replace newer conversation state. Browsing older history keeps live updates and Ctrl+End returns to the current tail.

## Package and RPC use

The package root exports `openCodingApplication`, `createCodingSession`, workspace and permission APIs, structured mutation reports, and configuration parsing without loading terminal presentation. Import `@ismail-elkorchi/coding-agent/tui` or `/rpc` for those adapters.

```bash
coding-agent rpc --root /path/to/workspace --session latest
```

The stdio adapter uses UTF-8 JSONL with JSON-RPC 2.0. `input.submit` accepts the Core session submission fields (`task`, `instructions`, `contextItems`, `images`, and `relationship`) and returns durable submission identities; notifications carry progress and terminal results. `session.read`, history, context, approvals, and change methods read the same recorded state. On `delivery.gap`, refresh the authoritative session. EOF and `application.shutdown` close application resources.

`workspace.files` returns `entries` with `complete` or `partial` coverage. The same bounded listing drives composer suggestions, which identify incomplete searches even when no matching file was returned.

## Development

The repository pins exact Agent Core, terminal-ui, and markspan revisions. Run the complete gate with:

```bash
npm run verify:release
```




Generation allowance is an application decision. The default reserves up to 16,384
output tokens, bounded by advertised output capacity and half the context window;
`--max-output-tokens` overrides it. Context inspection reports the effective
reservation and whether the endpoint enforces a cap. A reservation-only endpoint
can exceed that amount; actual usage still counts against the continuing session
budget. This default has structural coverage, not live-model quality validation.

Model, reasoning, and account commands open their respective controls directly. The status line prioritizes authority and activity at narrow widths; active work shows elapsed display time and an Escape stop hint above the composer. Tool details preserve inputs and observed outcomes, with highlighted patches and original-source inspection in `/changes`.

## Opening saved conversations

Saved conversations open automatically. Longer waits show “Opening conversation…”.
Closing the application or choosing another conversation cancels the pending opening.
If a conversation cannot be opened, the application explains the problem and keeps
its saved messages intact; other conversations remain usable.

### Resource policy

The CLI (including `rpc`) accepts `--inference-budget JSON`, `--context-policy JSON`,
`--context-control-policy JSON`, and `--output-reservation-policy JSON`. The same
fields are application options and optional fields in the existing project
configuration. Project policy is applied only after workspace trust permits it;
explicit host options take precedence.

- `inferenceBudget`: `maxInvocations`, `maxPromptTokens`, `maxCompletionTokens`,
  and `maxKnownCost: { amount, currency }`. These are continuing session-owner
  limits, separate from per-run `limits` and per-request `--max-output-tokens`.
  New runs, model changes, and context renewal do not reset consumed allowance.
  Once admitted, the owner's budget policy is immutable; changing a configuration
  does not replenish it. Known cost excludes unpriced usage.
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

`context.read` in RPC, or `inspectContext()` on the application, reports effective
context byte policy and operational allowance with settled usage, outstanding
exposure, and remaining allowance. `configuration.set` selects a model; it does
not grant a new owner budget.

Recovered command context is a bounded read-only pending-handoff projection. `resource_reports_read` paginates pending reports or reads committed releases by original run ID from the canonical event ledger. Reads remain session/branch-scoped, including inherited branch cutoffs, and exclude protected output references. A successful acknowledgement removes the pending view while the committed release remains retrievable.

## Optional tool capabilities

The CLI, RPC application and TUI share the same session tool configuration:

- `--programmatic-tools '{}'` enables the isolated portable JavaScript runner. The JSON object overrides validated compute, memory, output and call limits. Programs call qualified tools through the ordinary authorization and effect executor; they receive durable structured receipts. Interrupted code is not automatically replayed.
- `--native-tools '{"programmatic":true,"discovery":true}'` selects provider-native tool exposure explicitly. The actual endpoint/model must support the requested features. Native and portable programmatic execution cannot both be selected.
- `--web-tools '{"policy":{"id":"public-research-v1"}}'` enables bounded public-HTTPS source retrieval. Add `search:{"provider":"brave","credentialEnvironmentVariable":"BRAVE_SEARCH_API_KEY"}` for search. Credentials are read by the host, never supplied as tool arguments. Returned redirects require a separately authorized fetch.
- `--mcp-tools '{"servers":[]}'` configures optional MCP sources. Each server requires its host-assigned identity, endpoint, account and policy revision, and explicit per-tool effects. See `@agent-core/tools-mcp` for the bounded configuration contract. Discovery does not grant execution authority.

The corresponding application options are `programmaticTools`, `nativeToolExposure`, `webTools` and `mcpTools`. With none supplied, existing local-only tool behavior is preserved. Workspace edit/review permissions remain independent of optional network configuration. Source captures retain original bytes and identify any derived text separately.

Read-only mode still forbids workspace mutations and command execution. Explicit web/MCP configuration grants only those bounded tool connections; inspection reports `network: configured_tools`. Without that configuration it reports `network: denied`. This never grants a shell or ambient host network access.

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

Every admitted Coding root owns a handle to the workspace process supervisor for orphan
recovery, including read-only roots. Read-only mode still exposes no command tools or command
execution service. Compatible read-only and full-host application handles in one process
reuse that manager and scheduler; closing one handle leaves the others available. A competing
manager in another process is rejected before process recovery can disturb a live owner.
Separate state roots and external editors still require exact-base validation. Rooted workspace
authority retains its Linux-only platform admission; Writing uses a shared file coordinator
without a shell manager.

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
