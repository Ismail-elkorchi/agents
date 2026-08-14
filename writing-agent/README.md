# Writing Agent

A narrow, tool-free drafting workflow composed from Agent Core. It exists to exercise the general runtime with a non-coding product, not to define a complete writing application.

```bash
writing-agent "Draft a concise product announcement for a technical audience."
printf '%s\n' "Rewrite this paragraph for clarity: ..." | writing-agent
writing-agent --show-reasoning "Draft a structured essay outline."
```

The current executable uses OpenAI Codex subscription authentication and defaults to `gpt-5.6-luna`. Authenticate through the shared OpenAI Codex credential store before running it.
