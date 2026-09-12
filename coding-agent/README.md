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

Interactive startup renders before setup is complete. Use `/provider`, `/model`, `/permissions`, `/trust`, and `/login` to satisfy the displayed requirements. Run `coding-agent --help` for the complete CLI option reference.

The TUI submits with Enter, inserts a newline with Shift+Enter or Ctrl+O, steers active work with Alt+Enter, and queues a follow-up with Ctrl+Enter. Ctrl+C interrupts active work. Ctrl+P opens commands; F1 opens help; F2 selects sessions; F5 inspects branches; F6 manages queued input; F7 inspects recorded workspace changes; F8 opens original Markdown; Alt+N opens model-authored notes. Ctrl+PageUp/PageDown loads history and Ctrl+End follows current output.

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

Project configuration may name required and advisory commands. Coding Agent exposes them through `run_check`; it does not infer commands or coverage from package manifests. Each result records the process outcome, retained output, output completeness, and passed, failed, or inconclusive status. A check not invoked remains `not_run` in the run's verification view.

Explicit requirements also apply to documents and other deliverables, and remain relevant through follow-up revisions unless the user changes them. `count_markdown_words` measures a complete saved Markdown file without shell access or configured checks. It returns the count, the content SHA-256, and the shared Markspan counting convention: headings, prose, code, and image alternative text count; Markdown syntax, link destinations, HTML markup, definitions, and front matter do not. Measurements apply to the measured revision and must be repeated after relevant edits. The tool is available in all permission modes and can be selected through `tools.enabled`.

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

The stdio adapter uses UTF-8 JSONL with JSON-RPC 2.0. `input.submit` accepts the Core session submission fields (`task`, `instructions`, `contextItems`, and `relationship`) and returns durable submission identities; notifications carry progress and terminal results. `session.read`, history, notes, approvals, and change methods read the same recorded state. On `delivery.gap`, refresh the authoritative session. EOF and `application.shutdown` close application resources.

## Development

The repository pins exact Agent Core, Sandbox, terminal-ui, and markspan revisions. Run the complete gate with:

```bash
npm run verify:release
```
