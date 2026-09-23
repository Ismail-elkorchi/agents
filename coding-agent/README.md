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

Interactive startup shows the missing workspace-trust and model decisions as controls. Trust and execution permissions are separate choices. `/model` opens provider and model pickers, authentication, supported reasoning settings, and temperature. Selection is applied together and saved for future submissions; an active run retains its admitted configuration. Cancel keeps the previous selection and unsent draft.

Type `/` for command suggestions or press Ctrl+P for the searchable command menu. Enter sends; Shift+Enter or Alt+Enter inserts a newline. Ctrl+O toggles tool details; Ctrl+T toggles provider-exposed reasoning. Ctrl+F searches recorded history; F3/Shift+F3 move between search matches; Alt+PageUp/PageDown move between messages. Ctrl+PageUp/PageDown load history, and Ctrl+End returns to live output. F1 shows the actual current bindings, including saved overrides.

Escape closes the top interaction. Ctrl+C copies an active selection, otherwise closes a popup before requesting interruption of active work. Ctrl+P and Alt+N toggle commands and notes. Ctrl+D exits from an empty composer; `/exit` also preserves an unsent draft. `/stop` requests interruption without erasing it.

`/settings` and `/statusline` offer theme, reasoning visibility, tool disclosure, optional notifications, shortcut controls, and an ordered status-field selection with preview. Save applies presentation preferences without changing model inference or workspace authority. `/status` exposes full details and identifies unavailable accounting.

`/attach` adds, inspects, or removes authorized file and passage context and supported native images. `@` completes workspace references. `/drafts` recalls earlier or recovered prompts without sending them. Drafts retain text, caret, selection, and attachments across session switches and controlled restart. `/editor` uses `VISUAL` or `EDITOR`, suspends terminal ownership, and preserves the draft on failure.

`/sessions`, `/new`, `/name`, `/notes`, `/queue`, and `/branches` manage conversation navigation. Queue controls distinguish editing/canceling accepted pending input from composing a new request; steering is an explicit action. Branching history does not revert files. `/source` inspects messages, code, and tool results; `/export` writes the loaded history coverage locally. `/context` distinguishes available resources and the unsent draft from the latest admitted request. `/processes` inspects owned commands and offers input/termination through their existing capabilities. `/changes` shows recorded patches; `/recovery` handles pending approvals and uncertain outcomes.

Clipboard transport preserves selected source text, including tabs and line endings. Terminal capabilities are negotiated by terminal-ui; unsupported operations are reported explicitly.

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
| `sandbox` | Read, edit, and run commands in an isolated Sandsurf guest without host credentials or network access |
| `full_host` | Edit the host project and run commands under the host account, with access to the rest of the system and network |

In `sandbox` mode, file tools, attachments, guidance, checks, and commands use the same guest `/workspace`. Patches commit in the guest. The host directory is imported when the guest is created; edits do not write through, and reopening reconnects the existing guest rather than importing again. Host publication and re-import are not exposed by this application yet. `read_only` and `full_host` use the selected host project directly. Run change reports describe recorded patches, not a complete inventory of command-created changes.

Runs, sessions, artifacts, journals, trust decisions, and user model settings live in the platform user-state directory. `--state-root` selects another dedicated state directory outside the workspace. Coding Agent does not create private state inside the project.

## Command execution

Sandbox mode creates or reconnects a persistent Sandsurf Linux environment. The verified image supplies the shell and tools; commands run as the guest `agent` user without inherited host credentials or network grants. Missing or incompatible guest state fails explicitly and is never replaced by replaying prior effects. Read-only mode starts no command executor. Full host mode uses Agent Core's supervised local command executor with the host account's environment and network access.

Sandbox commands support pipes and PTYs, and an explicitly selected `environment` lifetime can continue beyond a tool call or session connection. Full host commands use supervised local processes without PTY or environment lifetime. `write_stdin` and `stop_process` operate on session-owned processes across model runs. Closing the application detaches clients without destroying a Sandsurf guest; local processes follow their supervisor's shutdown behavior. Terminal input is acquired only when needed.

Original output is captured independently of bounded model/UI views. Known terminal outcomes remain authoritative after runtime evidence becomes unavailable. Missing logs, unavailable controls, and unknown execution outcomes remain distinct; accepting uncertainty never certifies success or replays a command.

Sandsurf requires a qualified virtualization host and sufficient persistent storage. Current Coding Agent startup still uses Core's Linux host-root authority for trust identity and project-configuration discovery; the application's macOS/Windows startup path is not yet qualified. Writing Agent has no Sandsurf or virtualization dependency.

## Repository guidance

Coding Agent refreshes root/configured guidance and discovers ancestor `AGENTS.md` files for concrete file and process effects without scanning unrelated repository trees. Content revisions, configured precedence, and absent/deleted paths determine applicability. A collection callback does not establish delivery: only the exact source IDs in an admitted request do. The runtime rechecks guidance under the effect's resource lease before execution, including after approval. Changed guidance releases the earlier binding and supplies the new material for a new model decision. Symbolic-link guidance is not followed; unsafe or oversized applicable sources remain explicit and block the affected mutation.

## Explicit checks

Task budgets are optional. Project configuration can set explicit turn, tool, time, token, or cost limits; ordinary sessions have no preset task budget. Runtime capacity and compiled-request limits still apply.

Project configuration may name required and advisory commands. `run_check` binds the complete definition and the selected command executor before authorization, using the same file/process leases as shared tools. It is unavailable in read-only mode. Its historical observation records the command, effective timeout (60 seconds by default), configuration and definition identities, requirement classification, declared coverage, invocation/process identities, and before/after tested state. History adds the committed event receipt. Changing or deleting today's configuration cannot relabel that observation.

Outcomes are `passed`, `failed`, `timed_out`, `cancelled`, `execution_failed`, or `unknown`. A known nonzero exit is failed even with incomplete logs; a zero exit remains an observed pass. Output completeness and applicability are separate. Relevant observed changes make applicability `stale`; otherwise opaque command dependencies and possible external mutations leave it `unknown`. Matching before/after contents do not prove that inputs stayed unchanged during execution. Check-written changes cannot certify the resulting workspace.

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

Informational questions and editing tasks use the same Agent Core session contract. A user prompt does not create a separate revision workflow. Original contributions, corrections, tool observations, provider state, context selections, notes, branches, queued input, approvals, and uncertain effects remain durable.

An approval binds the exact tool input, effects, implementation, policy, and execution target. Changed facts invalidate it. Effects with an unknown outcome are not replayed automatically. `--resume` without a task drives only an unfinished accepted run.

Conversation storage is authoritative. Live TUI delivery is a projection: a delivery gap or listener failure triggers a fresh state/history read, and stale asynchronous pages cannot replace newer conversation state. Browsing older history keeps live updates and Ctrl+End returns to the current tail.

## Package and RPC use

The package root exports `openCodingApplication`, `createCodingSession`, workspace and permission APIs, structured mutation reports, and configuration parsing without loading terminal presentation. Import `@ismail-elkorchi/coding-agent/tui` or `/rpc` for those adapters.

```bash
coding-agent rpc --root /path/to/workspace --session latest
```

The stdio adapter uses UTF-8 JSONL with JSON-RPC 2.0. `input.submit` accepts the Core session submission fields (`task`, `instructions`, `contextItems`, `images`, and `relationship`) and returns durable submission identities; notifications carry progress and terminal results. `session.read`, history, notes, approvals, and change methods read the same recorded state. On `delivery.gap`, refresh the authoritative session. EOF and `application.shutdown` close application resources.

## Development

The repository pins exact Agent Core, Sandbox, terminal-ui, and markspan revisions. Run the complete gate with:

```bash
npm run verify:release
```

On a Linux KVM host, exercise real guest import, file transactions, pipe/PTY commands, and reconnect with `SANDSURF_KVM_TEST=1 node --test coding-agent/test/coding-command-authority.test.js`. Test storage must fit the guest disk; select a disk-backed `TMPDIR` if the default temporary filesystem is too small.

When a model cannot use selected native state, the model selector offers **Continue fresh in this session** as an explicit second action. This preserves the session and original history, continuing from selected portable user contributions, answers, complete tool observations and selected notes. Pending or uncertain work must be resolved first; unsupported selected images remain a conflict. Continuing processes retain their original controls.

For a resumed CLI session, use `--fresh-continuation --session ID --provider PROVIDER --model MODEL` (or `--resume` in place of `--session ID`). RPC `configuration.set` accepts the usual flat model selection plus `"continuation": "fresh"`. The option applies to that command only. Ordinary compatible model changes do not require it.

RPC error `-32010` means the selected native context requires an explicit fresh-continuation choice. Image and unresolved-work conflicts remain separate errors.

Generation allowance is an application decision. The default reserves up to 16,384
output tokens, bounded by advertised output capacity and half the context window;
`--max-output-tokens` overrides it. Context inspection reports the effective
reservation and whether the endpoint enforces a cap. A reservation-only endpoint
can exceed that amount; actual usage still counts against the continuing session
budget. This default has structural coverage, not live-model quality validation.
