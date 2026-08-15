# Agents

Concrete products composed from Agent Core:

- `@ismail-elkorchi/coding-agent`: interactive coding product with local tools, approvals, recovery, and a TUI.
- `@ismail-elkorchi/writing-agent`: narrow drafting and durable document-revision workflows used to keep the shared Core composition-neutral.
- `@ismail-elkorchi/research-agent`: reserved scaffold; no workflow has been invented before a concrete product need exists.

Runnable applications composed from [Agent Core](https://github.com/Ismail-elkorchi/agent-core).

| Package | Status |
| --- | --- |
| `@ismail-elkorchi/coding-agent` | Interactive coding agent with local tools and a terminal UI. |
| `@ismail-elkorchi/writing-agent` | Narrow drafting and durable document-revision workflows. |
| `@ismail-elkorchi/research-agent` | Reserved; not implemented. |

Development currently requires `agents` and `agent-core` as adjacent checkouts. The required Agent Core commit is recorded in the root `package.json`. Build Agent Core first, then run `npm ci` and `npm run verify:release` here. Coding-agent usage is documented once in [`coding-agent/README.md`](coding-agent/README.md).
