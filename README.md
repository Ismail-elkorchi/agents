# Agents

Concrete products composed from Agent Core:

- `@ismail-elkorchi/coding-agent`: interactive coding product with local tools, approvals, recovery, and a TUI.
- `@ismail-elkorchi/writing-agent`: narrow drafting and durable document-revision workflows used to keep the shared Core composition-neutral.

Runnable applications composed from [Agent Core](https://github.com/Ismail-elkorchi/agent-core).

Agent Core owns persistent conversation, scoped history and model notes, context
transitions, provider request accounting, inference invocation, tool/effect truth,
persistence, and recovery. Coding Agent owns target-scoped
repository guidance, isolated working copies, revision-bound acceptance checks,
review handoffs, and publication; Writing Agent owns operations, context selection,
claim evidence, proposals, production verification, exact apply authorization, and revision application. Offline
product/model measurement infrastructure is intentionally outside this
production workspace.

Completing a user request does not discard its conversation. Model notes help
retain decisions and retrieve earlier work; they do not change repository
permissions, editorial requirements, or verification results. Both products use
Core's shared continuity services while retaining their own acceptance contracts.
Coding keeps the original work objective and its corrections (or an explicit whole replacement) in context;
other relevant requirements and history use explicit model context selection.
Original user contributions remain retrievable, and selecting or omitting a source
never changes its authority.

| Package | Status |
| --- | --- |
| `@ismail-elkorchi/coding-agent` | Interactive coding agent with local tools and a terminal UI. |
| `@ismail-elkorchi/writing-agent` | Narrow drafting and durable document-revision workflows. |

Development currently requires `agents` and `agent-core` as adjacent checkouts. The required Agent Core commit is recorded in the root `package.json`. Build Agent Core first, then run `npm ci` and `npm run verify:release` here. Coding-agent usage is documented once in [`coding-agent/README.md`](coding-agent/README.md).
