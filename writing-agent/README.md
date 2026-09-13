# Writing Agent

A workspace assistant for writing, revising, researching from local sources, and discussing text. Requests run in a persistent conversation. Editing writes directly to files; review mode exposes read-only workspace tools. There is no required brief schema, document registration, proposal approval sequence, or automatic editorial judge.

Build from the repository root with `npm run build`, then launch:

```sh
node writing-agent/dist/cli.js tui --root /path/to/workspace
node writing-agent/dist/cli.js review --root /path/to/workspace --provider openai-codex --model MODEL 'Review the introduction in article.txt.'
node writing-agent/dist/cli.js write --root /path/to/workspace --provider openai-codex --model MODEL 'Revise the introduction in article.txt.'
```

With an installed executable, use `writing-agent` in place of `node writing-agent/dist/cli.js`. No arguments opens the TUI in an interactive terminal. `WRITING_AGENT_PROVIDER` and `WRITING_AGENT_MODEL` supply defaults. Providers are `ollama`, `openai`, `openai-codex`, and `openrouter`; `--endpoint` selects an endpoint and `--reasoning` requests a reasoning effort.

The TUI opens the conversation at full width. Missing provider/model settings open a guided picker; authentication and supported reasoning settings are reachable from `/model` or `/provider`. Save persists the complete default selection; cancel preserves the draft and previous configuration. `/mode` changes the edit/review default independently.

Type `/` for command suggestions or Ctrl+P for the searchable menu. Enter sends; Shift+Enter or Alt+Enter inserts a newline. Ctrl+O expands tool output; Ctrl+T shows provider-exposed reasoning. Ctrl+F searches recorded history and F3/Shift+F3 navigate matches. Alt+PageUp/PageDown move between messages. Escape closes the top interaction; Ctrl+C copies a selection, otherwise dismisses a popup before interrupting active work. Ctrl+P and Alt+N toggle commands and notes. Ctrl+D exits from an empty composer; `/exit` preserves an unsent draft. F1 shows the current shortcuts.

`/files` opens documents on request; `/document`, `/conversation`, `/outline`, and `/passage` navigate source and selected passages. Wide terminals can show a document beside the conversation; narrow terminals use one focused view. Streaming text, reasoning, tool inputs, progress, observations, and recorded changes share Core's presentation components. `/source` inspects earlier messages and individual code blocks without copying screen borders.

`/attach` manages authorized text/passage references and native images supported by the selected provider. `@` completes workspace resources. `/drafts` recalls prior or recovered requests without sending. Drafts and attachments survive session switching and controlled restart. `/editor` uses `VISUAL` or `EDITOR` and restores terminal ownership after success or failure. `/sessions`, `/new`, `/name`, `/notes`, `/queue`, `/recovery`, `/context`, and `/export` expose recorded history, pending input, decisions, authorized context, and a local export whose coverage is explicit.

`/settings` and `/statusline` offer themes, reasoning visibility, tool disclosure, ordered status fields, optional notifications, and shortcut overrides. Presentation changes do not grant permission or alter model context. [Known terminal-ui limitations](../terminal-ui-consumer-findings.md) remain explicit, including clipboard normalization and affected multiplexer startup.

Choose review mode for suggestions before editing. Ask a later edit-mode request to apply chosen suggestions or undo a change; original requests, patches, and observations remain available through history. Source and rendered views are presentation choices, not a mandated output format. The agent does not assume a language, word-count convention, entity catalog, or preservation criterion. State those requirements in the conversation when relevant.

Tools read, list, search, and patch workspace files. Model-managed history, notes, and context selection support continuing work. Documents are retrieved when needed instead of filling a fixed-size excerpt template. Notes cannot grant permission or establish that a claim is verified. Model judgments and review responses are not independent verification certificates.

The application API and state layout are breaking replacements; existing project-state directories are not migrated.

Private state defaults to `$XDG_STATE_HOME/writing-agent` or `~/.local/state/writing-agent`; `--state-root` must point outside the workspace. File access uses Agent Core's rooted authority, which currently requires Linux. Symlinks, reserved state directories, and `.git` are excluded. The tool catalog contains no shell or network execution capability; requests to a configured model provider still use its connection. Pending runs retain their admitted file permission mode across restart. Unknown provider or tool outcomes require reconciliation or stopping through the recovery controls.

Headless applications import `openWritingApplication` from `@ismail-elkorchi/writing-agent`, call `start()`, submit an instruction string, await the returned completion, and close the application. An explicit configuration can set run limits or a session inference budget; ordinary work has no preset task budget. Runtime capacity and compiled-request limits still apply.

`writing-agent rpc` serves JSON-RPC 2.0 on standard input/output. Methods cover instruction submission, edit/review selection, documents, sessions, history, notes, and recovery. Terminal rendering is exposed separately through `@ismail-elkorchi/writing-agent/tui`; neither adapter owns editing or session policy.
