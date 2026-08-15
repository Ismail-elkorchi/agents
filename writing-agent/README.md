# Writing Agent

Narrow drafting and durable document-revision workflows composed from Agent Core. Drafting is tool-free; document revision uses an explicitly selected local file capability set. The package exists to exercise the general runtime with a non-coding product, not to define a complete writing application.

```bash
writing-agent "Draft a concise product announcement for a technical audience."
printf '%s\n' "Rewrite this paragraph for clarity: ..." | writing-agent
writing-agent --show-reasoning "Draft a structured essay outline."
writing-agent --document draft.md --root . "Tighten the opening and preserve the voice."
```

Document revision is durable. It records sessions and runs under `.writing-agent` by default, authorizes only the selected document, and exposes only `read_files` and `apply_patch`. Pass the printed session ID through `--session` to continue the same revision history.

The current executable uses OpenAI Codex subscription authentication and defaults to `gpt-5.6-luna`. Authenticate through the shared OpenAI Codex credential store before running it.
