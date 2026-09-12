# Writing Agent

A workspace assistant for writing, revising, researching from local sources, and discussing text. Requests run in a persistent conversation. Editing writes directly to files; review mode exposes read-only workspace tools. There is no required brief schema, document registration, proposal approval sequence, or automatic editorial judge.

Build from the repository root with `npm run build`, then launch:

```sh
node writing-agent/dist/cli.js tui --root /path/to/workspace --provider openai-codex --model MODEL
node writing-agent/dist/cli.js review --root /path/to/workspace --provider openai-codex --model MODEL 'Review the introduction in article.txt.'
node writing-agent/dist/cli.js write --root /path/to/workspace --provider openai-codex --model MODEL 'Revise the introduction in article.txt.'
```

With an installed executable, use `writing-agent` in place of `node writing-agent/dist/cli.js`. No arguments opens the TUI in an interactive terminal. `WRITING_AGENT_PROVIDER` and `WRITING_AGENT_MODEL` supply defaults. Providers are `ollama`, `openai`, `openai-codex`, and `openrouter`; `--endpoint` selects an endpoint and `--reasoning` requests a reasoning effort.

The TUI starts in the conversation, without requiring a selected document. Enter sends; Shift+Enter or Ctrl+O inserts a newline. F1 shows controls, F2 browses workspace files, F3 opens the displayed Markdown outline, F4 switches source/rendered views, F5 opens the conversation, F6 starts a new conversation, F7 switches edit/review mode, F8 quotes a selected passage into the visible composer, F10 configures the model, F11 selects a session, and F12 opens recovery. Ctrl+F searches recorded history, Alt+N opens model notes, and Ctrl+E opens an external instruction editor. Ctrl+C copies selected text or interrupts active work.

Choose review mode for suggestions before editing. Ask a later edit-mode request to apply chosen suggestions or undo a change; original requests, patches, and observations remain available through history. Source and rendered views are presentation choices, not a mandated output format. The agent does not assume a language, word-count convention, entity catalog, or preservation criterion. State those requirements in the conversation when relevant.

Tools read, list, search, and patch workspace files. Model-managed history, notes, and context selection support continuing work. Documents are retrieved when needed instead of filling a fixed-size excerpt template. Notes cannot grant permission or establish that a claim is verified. Model judgments and review responses are not independent verification certificates.

The application API and state layout are breaking replacements; existing project-state directories are not migrated.

Private state defaults to `$XDG_STATE_HOME/writing-agent` or `~/.local/state/writing-agent`; `--state-root` must point outside the workspace. File access uses Agent Core's rooted authority, which currently requires Linux. Symlinks, reserved state directories, and `.git` are excluded. The tool catalog contains no shell or network execution capability; requests to a configured model provider still use its connection. Pending runs retain their admitted file permission mode across restart. Unknown provider or tool outcomes require reconciliation or stopping through the recovery controls.

Headless applications import `openWritingApplication` from `@ismail-elkorchi/writing-agent`, call `start()`, submit an instruction string, await the returned completion, and close the application. An explicit configuration can set run limits or a session inference budget; ordinary work has no preset task budget. Runtime capacity and compiled-request limits still apply.

`writing-agent rpc` serves JSON-RPC 2.0 on standard input/output. Methods cover instruction submission, edit/review selection, documents, sessions, history, notes, and recovery. Terminal rendering is exposed separately through `@ismail-elkorchi/writing-agent/tui`; neither adapter owns editing or session policy.
