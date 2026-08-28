# Usage

Coding Agent is pre-alpha and intentionally uses breaking contracts. Import documented package exports only.

## Workspace trust and private state

A new workspace is inspection-only until the user records a trust decision:

```bash
coding-agent trust status --root .
coding-agent trust restricted --root .
coding-agent trust trusted --root .
coding-agent trust revoke --root .
```

Restricted workspaces may send bounded, screened context to the configured provider, but every mutation or command requires exact approval and repository execution policy remains inactive. Trusted workspaces may activate project proposals within the user-provided CLI authority. Repository files never grant trust or tool authority.

Runs, sessions, artifacts, journals, and trust records live under the platform user-state directory, keyed by the adopted physical workspace identity. `--state-root` selects another dedicated Coding Agent state root. A state root must be outside the workspace and is adopted only when empty or already marked as Coding Agent state. No `.coding-agent` directory is created or read as private state.

## CLI

```bash
# Interactive TUI, optionally with an initial task
coding-agent
coding-agent "inspect the failing checks"

# Noninteractive task or piped input
coding-agent exec "summarize the workspace"
printf '%s\n' 'summarize the workspace' | coding-agent exec -

# Resume the most recently active session or open an existing ID
coding-agent --resume
coding-agent --session SESSION_ID
```

Session selection is not part of project configuration. A resumed session restores its latest provider and model unless explicitly overridden. Resolution order is explicit CLI options, resumed-session settings, trusted project configuration, then environment values. There is no hidden provider or model fallback.

Select one permission ceiling with `--permissions`: `review` exposes root-bound reads, `edit` adds structured patch mutation, and `develop` adds sandboxed commands and verification. Project configuration can only narrow that ceiling and exact tool set. Coding Agent never falls back to ambient command execution; if Sandbox cannot establish the declared boundary, commands are unavailable.

A trusted project may propose a narrower boundary:

```json
{
  "version": 1,
  "provider": "openai",
  "model": "gpt-5.6-sol",
  "instructions": [],
  "tools": { "enabled": ["read_files", "search_text", "apply_patch"] },
  "permissions": { "maximumMode": "edit", "requireApprovalFor": ["write", "delete"] },
  "verification": {
    "required": [{ "id": "test", "command": "npm test", "coverage": "full" }],
    "advisory": []
  }
}
```

The repository cannot activate this policy or raise trust. Restricted workspaces treat configuration as attributed data and independently require approval for every mutation and command.

## Approvals

Input is parsed and canonicalized before authorization. When a call requires approval, `run()` returns a durable suspension:

```ts
const result = await runtime.run({ task: 'update the workspace' }).result;
if (result.state === 'suspended') {
  const approval = result.pendingApprovals[0];
  const resumedControl = await reopenedRuntime.resolveApproval({
    runId: result.runId,
    approvalId: approval.approvalId,
    fingerprint: approval.fingerprint,
    decision: 'allow'
  });
  const resumed = await resumedControl.result;
}
```

Changed input, effects, implementation, policy, or execution boundary invalidates the approval. Non-idempotent uncertain work is never retried automatically.

The CLI supports the same persisted operation after process restart:

```bash
coding-agent approval allow RUN_ID APPROVAL_ID FINGERPRINT --root . --config coding-agent.config.json --permissions develop
```

## Checks

```ts
const checks = [{
  id: 'mentions-risk',
  implementationId: 'my-application/mentions-risk@1',
  kind: 'deterministic' as const,
  requirement: 'required' as const,
  timeoutMs: 2_000,
  async run({ candidate, signal }) {
    signal.throwIfAborted();
    return candidate.message.includes('risk')
      ? { verdict: 'passed' as const, summary: 'Risk is covered.' }
      : { verdict: 'failed' as const, summary: 'Risk is missing.' };
  }
}];
```

Deterministic checks inspect only their admitted candidate and evidence. In `develop` mode, configured commands run through a durable no-network Sandbox execution against a private exact copy of the candidate, never the authoritative workspace. `coverage` is required and must be `targeted` or `full`; it describes what the command actually proves. Changes to tests, package scripts, compiler/build configuration, CI workflows, dependencies, or lockfiles make the configured check inconclusive instead of letting a modified verifier certify itself. A lower permission mode leaves command checks explicitly unavailable rather than running them on the host.

## Result semantics

- Normal stop with visible content: completed execution and complete candidate.
- Output limit or content filter with visible content: completed execution and partial candidate.
- Interrupted stream or abort after visible content: failed/aborted execution, partial candidate, verification not run.
- Failure before visible content: absent candidate.
- Missing or unknown required check: inconclusive verification.

For every ended run, Coding Agent compares the exact root-bound workspace state captured before runtime effects with the final state and reduces `apply_patch` ledger receipts into a bounded durable change report. The CLI prints changed paths and distinguishes structured mutations from external or concurrent changes. A path already reported by the initial Git observation remains marked as changed before the run; Coding Agent never assumes the workspace started clean. Binary, oversized, aliased, unreadable, or truncated evidence makes coverage explicitly partial. Model prose is candidate narrative, not authority for changed paths or verification status, and command effects are never described as undoable.

Run `npm run verify:release` for the full repository gate.
## Complete CLI option reference

Run `coding-agent [initial task] [options]` for the interactive TUI. Run `coding-agent exec <task|-> [options]` for one noninteractive task; `-` reads the task from standard input.

| Option | Parameter and behavior |
| --- | --- |
| `--root <dir>` | Workspace root. Defaults to the current directory. |
| `--state-root <dir>` | Dedicated private Coding Agent state root. Defaults to the platform user-state location. |
| `--config <path>` | Load a project configuration proposal. `coding-agent.config.json` is discovered when present. |
| `--provider <name>` | Select `ollama`, `openrouter`, `openai`, or `openai-codex`. |
| `--model <name>` | Select the provider model, such as `gpt-5.6-luna`. |
| `--provider-endpoint <url>` | Override the Ollama host or hosted-provider base URL. |
| `--codex-transport <http_sse\|websocket>` | Select OpenAI Codex HTTP full-replay streaming or live WebSocket continuation. Defaults to `http_sse`. |
| `--max-output-tokens <n>` | Set a positive per-request output-token limit. |
| `--temperature <n>` | Set a finite temperature when the selected provider/model supports it. OpenAI Codex subscription requests do not support temperature. |
| `--reasoning-effort <level>` | Select `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, subject to provider/model support. |
| `--show-reasoning` | Render reasoning text or summaries exposed by the provider. It does not expose private chain-of-thought. |
| `--permissions <review\|edit\|develop>` | Select the authority ceiling. Defaults to `review`; `edit` adds structured patches; `develop` adds sandboxed commands and command checks. |
| `--resume` | Resume the most recently active session for this workspace. |
| `--session <id>` | Open an existing session by exact ID. |
| `--branch <entry-id>` | Branch the selected existing session from an entry. Requires `--resume` or `--session`. |

Runtime-setting precedence is explicit CLI option, resumed-session setting, matching trusted project configuration, then environment. Provider-specific project settings are meaningful only for their configured provider. A provider and model must be selected explicitly through one of those sources.

Provider environment variables are `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_APP_URL`, and `OPENROUTER_APP_TITLE`. Runtime defaults can be supplied with `CODING_AGENT_PROVIDER`, `CODING_AGENT_MODEL`, `CODING_AGENT_PROVIDER_ENDPOINT`, and `CODING_AGENT_REASONING_EFFORT`.

Credential commands are:

```bash
coding-agent auth status openai
coding-agent auth status openai-codex
coding-agent auth login openai-codex
coding-agent auth logout openai-codex
```

OpenAI Platform authentication comes from `OPENAI_API_KEY`; ChatGPT subscription authentication is stored by `auth login openai-codex` outside the workspace.
