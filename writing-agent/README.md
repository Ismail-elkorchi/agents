# Writing Agent

Writing Agent is a project-oriented writing application composed from Agent Core. It keeps briefs, structured intents, proposals, evidence, editorial decisions, authorship provenance, context receipts, transaction settlements, and content-addressed project revisions in one append-only private project log.

Private state defaults to the platform user-state directory (`$XDG_STATE_HOME/writing-agent` or `~/.local/state/writing-agent`) and must remain outside the writing project. Use `--state-root` for an explicit external location. `.writing-agent` and `.git` are denied inside the rooted project authority and are never authoritative state.

The model receives bounded project context as untrusted data. A direct user request is adopted as an immutable structured operation before model execution. In the default `suggest` mode, the model can read only exact admitted managed resources and `propose_revision` is its only write capability; it appends one validated private proposal and cannot mutate user files. Applying an accepted proposal is a separate application action using Agent Core's recoverable text transaction. Required failed, unknown, stale, or partially covered semantic-preservation findings block acceptance.

One-shot writing remains available only through the explicit transient composition:

```bash
writing-agent write "Draft a concise product announcement."
```

Project commands include `init`, `status`, `brief show`, `brief amend`, `plan`, `draft`, `revise`, `review`, `diff`, `apply`, `reject`, `undo`, `suspension`, `resume`, `decide`, `approval`, `abort`, `source add`, and `source list`. Provider selection is application configuration, not a package assumption:

```bash
writing-agent init --root ./manuscript "Write a sourced technical essay."
writing-agent status --root ./manuscript
writing-agent revise <resource-id> --root ./manuscript --provider openai --model <model> "Tighten the opening without changing claims."
```

Exactly four provider compositions are supported: `ollama`, `openrouter`, `openai`, and `openai-codex`. The library APIs remain provider-neutral and accept an Agent Core `ModelProvider` directly.

Secure local revision currently relies on Agent Core's Linux rooted-file authority, descriptor-relative path checks, link checks, and recoverable patch journal. The package does not claim secure revision support on unsupported platforms.

There is no autonomous mode. There is also no multi-agent orchestration, swarm API, specialist-agent configuration, inter-agent queue, or mutable role binding. Planning, drafting, review, evidence checking, and editorial work remain explicit bounded passes in one application. A specialist agent is deferred until evaluations demonstrate a benefit that separate passes cannot achieve and authority, shared-state conflict, attribution, suspension, and recovery contracts are defined.

The terminal command surface is intentionally non-interactive. A TUI can be added after the project, revision, recovery, and evaluation contracts stabilize; no TUI state or generic resume abstraction is part of the current domain model.

The committed evaluation corpus contains distinct development, regression, holdout, adversarial, and human-audit sets. Generated campaign answers, judge output, and aggregate reports are not committed. The regression set has a separately reviewed digest and runs as a required verification gate.
