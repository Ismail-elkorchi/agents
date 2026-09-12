# Agents

Runnable applications composed from [Agent Core](https://github.com/Ismail-elkorchi/agent-core):

- `@ismail-elkorchi/coding-agent` is a conversational coding application with workspace tools, explicit permissions, Sandbox command execution, durable sessions, a TUI, and a JSON-RPC adapter.
- `@ismail-elkorchi/writing-agent` is a writing application with source evidence, document proposals, verification, explicit revision application, a TUI, and a JSON-RPC adapter.

Agent Core owns provider-neutral inference, conversation history, model-managed context and notes, durable effects, resource accounting, recovery, and session branches. Each application owns its domain tools, permission choices, verification meaning, and presentation.

The applications share delivery, RPC framing, terminal presentation, and deterministic verification utilities. Shared packages contain no coding or writing workflow policy.

Development uses adjacent `agents`, `agent-core`, and `sandbox` checkouts. Exact upstream commits are recorded in the root `package.json`. Build the upstream repositories, then run:

```bash
npm ci
npm run verify:release
```

See [Coding Agent](coding-agent/README.md) and [Writing Agent](writing-agent/README.md) for product usage.
