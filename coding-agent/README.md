# Coding Agent

Coding Agent is a conversational coding application composed from Agent Core. It works in the selected workspace, keeps durable conversation history, and exposes the same application service through its CLI, TUI, package API, and JSON-RPC adapter. Its contracts are pre-alpha and may change without compatibility layers.

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

Clipboard fidelity and terminal-host limitations are documented in [terminal-ui consumer findings](../terminal-ui-consumer-findings.md). Unsupported exact copy is reported without altering source.

## Workspace authority

A new workspace starts untrusted. Record a decision from the TUI or CLI:

```bash
coding-agent trust status --root .
coding-agent trust restricted --root .
coding-agent trust trusted --root .
coding-agent trust revoke --root .
```

Repository content cannot grant trust, tools, provider egress, command execution, network access, or approval. Restricted workspaces require approval for mutations and commands. Trusted workspaces use the selected permission mode and any narrower project policy.

Permission modes are:

| Mode | Workspace capability |
| --- | --- |
| `review` | Root-bound reads |
| `edit` | Reads and structured patches |
| `develop` | Reads, structured patches, and sandboxed commands |

Authorized patches change the selected workspace directly and return their committed transaction receipt before the model observes success. Unrelated workspace changes are preserved. A later failure does not roll back an earlier successful edit. Run change reports are derived from authoritative `apply_patch` start and result records; command-created and external changes remain separate workspace facts.

Runs, sessions, artifacts, journals, trust decisions, and user model settings live in the platform user-state directory. `--state-root` selects another dedicated state directory outside the workspace. Coding Agent does not create private state inside the project.

## Command execution

Command execution initializes on first use. Coding Agent observes the active platform shell, search path, Node installation, and runtime roots. On Linux it first prepares Sandbox's isolated namespace layout, then prepares the stable host-layout confinement backend when the strict requirements are unavailable. macOS and Windows use their stable native host-layout backends. Selection completes before effect authorization and remains bound for dispatch and recovery.

Both layouts grant workspace writes, grant observed toolchain inputs read-only, pass an explicit environment, deny network access, and own process termination. The authorization report identifies the result as `isolated workspace` or `workspace confined`. If no backend satisfies the policy, command tools report the unmet Sandbox requirement; questions, reads, and structured patches remain available.

Sandbox currently exposes no PTY capability, so commands use pipes for stdin, stdout, and stderr. `write_stdin` and `stop_process` operate on recorded live processes.

## Repository guidance

Coding Agent loads the root `AGENTS.md` and configured instruction files when a run starts. It discovers nested `AGENTS.md` files from the root to a concrete tool target without recursively loading unrelated directories. Before the first mutation or command in a newly discovered scope, Core returns the applicable guidance with `effectStarted: false`; the model then chooses the next action with that guidance in context. Symbolic-link guidance is not followed, and unreadable or oversized applicable guidance blocks the affected mutation.

## Explicit checks

Task budgets are optional. Project configuration can set explicit turn, tool, time, token, or cost limits; ordinary sessions have no preset task budget. Runtime capacity and compiled-request limits still apply.

Project configuration may name required and advisory commands. Coding Agent exposes them through `run_check`; it does not infer commands or coverage from package manifests. Each result records the process outcome, retained output, output completeness, and passed, failed, or inconclusive status. A check not invoked remains `not_run` in the run's verification view.


```json
{
  "version": 1,
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "instructions": [],
  "tools": { "enabled": ["read_files", "search_text", "apply_patch", "exec_command"] },
  "permissions": {
    "maximumMode": "develop",
    "requireApprovalFor": ["write", "delete", "command"]
  },
  "verification": {
    "required": [
      { "id": "test", "command": "npm test", "coverage": "full", "timeoutMs": 120000 }
    ],
    "advisory": []
  }
}
```

The optional `limits` object accepts Agent Core's current run limits. Project configuration can narrow the selected tool and permission ceiling. It cannot activate itself in an untrusted workspace.

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
