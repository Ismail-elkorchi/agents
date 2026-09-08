# Usage

Coding Agent is pre-alpha and intentionally uses breaking contracts. Import documented package exports only.

## Workspace trust and private state

A new workspace is inspection-only until the user records a trust decision. The interactive TUI opens before that decision and offers `/trust restricted` and `/trust trusted`; the equivalent standalone commands are:

```bash
coding-agent trust status --root .
coding-agent trust restricted --root .
coding-agent trust trusted --root .
coding-agent trust revoke --root .
```

Restricted workspaces may send bounded, screened context to the configured provider, but every mutation or command requires exact approval and repository execution policy remains inactive. Trusted workspaces may activate project proposals within the user-provided CLI authority. Repository files never grant trust or tool authority.

Runs, sessions, artifacts, journals, trust records, and the user-selected provider/model live under the platform user-state directory. Workspace records are keyed by the adopted physical workspace identity; the provider/model selection is a user default for new interactive sessions. `--state-root` selects another dedicated Coding Agent state root. A state root must be outside the workspace and is adopted only when empty or already marked as Coding Agent state. No `.coding-agent` directory is created or read as private state.

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

# Noninteractive recovery drives the unfinished accepted run without queuing a new task
coding-agent exec --resume
coding-agent exec --session SESSION_ID
```

Interactive startup does not require provider, model, permission, or trust flags. It renders first, restores any available settings, and reports the exact missing setup. Use `/provider`, `/model`, `/permissions`, `/trust`, and `/login` inside the TUI. A message submitted before setup is complete is retained and starts automatically after setup. `coding-agent exec` remains noninteractive and fails immediately when trust or a complete model selection cannot be resolved.

Session selection is not part of project configuration. A resumed session restores its latest provider and model unless explicitly overridden. Interactive model resolution order is explicit CLI options, resumed-session settings, trusted project configuration, the stored user selection, then environment values. Noninteractive execution does not consume the interactive user default. There is no provider or model fallback chosen by the application.

Select one permission ceiling with `--permissions`: `review` exposes root-bound reads, `edit` adds structured patch mutation, and `develop` also exposes sandboxed commands to the model. Mutable `edit` and `develop` runs execute their admitted verification plan through a separate sandboxed verifier authority; granting verification never grants the model a shell. Project configuration can only narrow the ceiling and exact model-facing tool set. Coding Agent never falls back to ambient command execution; if Sandbox cannot establish the declared boundary, the affected model command or required check is explicitly unavailable.

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

## Repository guidance

Coding Agent loads the root `AGENTS.md` and explicitly configured guidance at run start. It does not recursively place unrelated descendant guidance in the initial model request. When a read enters a deeper target, Coding Agent walks that target's root-to-directory ancestry, securely loads any newly applicable `AGENTS.md`, persists the active set with the run, and includes it in the next model request. A command working directory is treated as a concrete target in the same way.

The first write, delete, or command entering a scope whose guidance has not yet been delivered is denied without starting the effect. The resulting observation names the newly active guidance; the model retries after that guidance is present. Hidden and ignored paths do not bypass ancestry lookup, symbolic-link guidance is never followed, and guidance content cannot grant filesystem, shell, network, credential, approval, or publication authority.

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

The CLI supports the same persisted run after process restart:

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
  async run({ modelOutput, signal }) {
    signal.throwIfAborted();
    return modelOutput.message.includes('risk')
      ? { verdict: 'passed' as const, summary: 'Risk is covered.' }
      : { verdict: 'failed' as const, summary: 'Risk is missing.' };
  }
}];
```

Application checks use `@agents/verification` and the shared Core effect executor. A coding work record owns references to original user contributions, the baseline, private working copy, admitted verifier contract, and budget/resource owner across attempts and model changes. Corrections preserve the source contribution and its other constraints; only an explicit whole-contribution replacement supersedes it. A side question submitted with `relationship: { kind: 'side_question' }` has read-only authority and leaves revision work available for continuation.

An independent verifier names its protected `verifierInputs` explicitly. These identify the admitted program, tests, fixtures and relevant dependency inputs; command text and a declared coverage label alone are observational. All selected inputs are bound by exact hashes. Test, dependency, build and CI files can change legitimately when the independent verifier covering those changes remains intact. Changing a protected verifier input requires a new admitted contract; filenames do not determine authority.

Commands run against isolated snapshots through no-network Sandbox execution. The system runtime is mutable and is described by an environment policy, not an invented content attestation. New attempts obtain fresh command observations; only an exact invocation may reconcile its recorded result. There is no separate baseline-result cache. Exact baseline output comparison is diagnostic: matching failures never pass a check, and incomplete output cannot establish coverage.

`IsolatedWorkingCopy` and `PreChangeSnapshot` belong to work. Publication requires passed required checks covering the exact private revision and unchanged source content since isolation. The application coordinator records verification, acceptance and publication independently of Core's immutable execution outcome. Unknown effects hold subsequent prompts durably until reconciliation. A later prompt can continue an unaccepted working copy; it does not implicitly reset its baseline or allowance.

## Result semantics

- Normal stop with visible content: completed execution and complete model output.
- Output limit or content filter with visible content: completed execution and partial model output.
- Interrupted stream or abort after visible content: failed/aborted execution, partial model output, verification not run.
- Failure before visible content: absent model output.
- Missing or unknown required check: inconclusive verification.

For settled revision work, Coding Agent emits one persisted `CodingHandoff` for both CLI and TUI. It binds the admitted task, model summary, exact reviewed working-copy digest, changed files, bounded change artifact, revision acceptance results, usage, publication status, unresolved facts, and unknown effects. The underlying change report compares the `PreChangeSnapshot` with the private working copy—even when publication is rejected—so a failed apply never erases the revision the user is reviewing. `apply_patch` ledger observations distinguish structured mutations from unaccounted working-copy changes. A path already reported by the initial Git observation remains marked as changed before the run; Coding Agent never assumes the workspace started clean. Binary, oversized, aliased, unreadable, or truncated observations make coverage explicitly partial. Model prose is not authority for changed paths, checks, publication, or usage.

The interactive TUI renders before runtime activation, then restores durable conversation, execution outcomes, application checks and Coding handoffs, queued work, driver control, approvals, and unknown-effect recovery. Its status line retains the active provider, model, trust, sandbox, and permission boundary. Provider, model, permission mode, and trust changes are admitted only while the session is idle with no queued submissions. Use Ctrl+P for commands. Use Up and Down at the first or last composer line to browse sent messages; the current draft is restored when history browsing ends.

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
| `--permissions <review\|edit\|develop>` | Select the model authority ceiling. Defaults to `review`; `edit` adds structured patches; `develop` adds sandboxed model commands. Mutable modes run the separately admitted verifier plan. |
| `--resume` | Select the most recently active session. In taskless `exec` mode, drive its unfinished accepted run without creating another submission. |
| `--session <id>` | Select an existing session by exact ID. In taskless `exec` mode, drive its unfinished accepted run without creating another submission. |
| `--branch <entry-id>` | Branch the selected existing session from an entry. Requires `--resume` or `--session`. |

For interactive sessions, model-selection precedence is explicit CLI option, resumed-session setting, matching trusted project configuration, stored user selection, then environment. For `exec`, precedence is explicit CLI option, resumed-session setting, matching trusted project configuration, then environment. Provider-specific project settings are meaningful only for their configured provider. A provider and model must be selected explicitly through one of those sources or through the interactive `/provider` and `/model` commands.

Provider environment variables are `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_APP_URL`, and `OPENROUTER_APP_TITLE`. Runtime defaults can be supplied with `CODING_AGENT_PROVIDER`, `CODING_AGENT_MODEL`, `CODING_AGENT_PROVIDER_ENDPOINT`, and `CODING_AGENT_REASONING_EFFORT`.

Credential commands are:

```bash
coding-agent auth status openai
coding-agent auth status openai-codex
coding-agent auth login openai-codex
coding-agent auth logout openai-codex
```

OpenAI Platform authentication comes from `OPENAI_API_KEY`; ChatGPT subscription authentication is stored by `auth login openai-codex` outside the workspace.

## Reusable persistent sessions

`createCodingSession` composes the same workspace authority, isolated working copy,
Sandbox tools, check plans, work settlement, and handoff service used by the CLI and TUI.
It accepts an already opened and admitted workspace, a `ModelProvider`, exact session
settings, and a permission mode. `closeCodingSession` settles application cleanup;
the caller closes its opened workspace after the session finishes.

```ts
import { createCodingSession, closeCodingSession } from '@ismail-elkorchi/coding-agent';

const coding = await createCodingSession({
  workspace,
  provider,
  settings: { provider: provider.id, model },
  permissionMode: 'review'
});
try {
  const submission = await coding.agent.submit({ task: 'Inspect this implementation.' });
  if (submission.kind === 'started') await submission.completion;
} finally {
  await closeCodingSession(coding);
}
```

The package exports `decodeCodingHandoff` for integrations reading persisted handoffs. Its `outcome` records application verification and acceptance; `changeReport` records workspace changes and coverage.

Original user contributions remain available across completed runs. The optional
attention tools are composed for every Coding session: `history_read`,
`history_search`, `notes_list`, `notes_search`, `notes_read`, `notes_write`,
`notes_remove`, `context_inspect`, and `context_transition`. They are confined to
the selected session branch. Notes are generated material and cannot authorize
workspace effects, change a check result, or publish a working copy. Review mode
can maintain private notes while workspace writes remain unavailable.

`/context` or `/context inspect` shows the committed window and pending work.
`/context retain` requests a validated window retaining original history after a
run has established the complete tool catalog. Model
context requests are scheduled for a legal runtime boundary. Both controls use
Core's context service and compiled bootstrap validation. A failed admission keeps
the previous committed window. A provider-native strategy requires an active run,
an explicit provider capability and a governed transform of completed history;
the current run's source and synchronous tool obligations remain original.
Primary generation and native transforms share `coding.inference`, durable
invocation records and one owning work budget. Hosts may set `inferenceBudget`.

Active repository guidance is reread at request and authorization boundaries. Each
request includes current source and working-copy revision identities, actual
changed resources, the admitted check plan, the latest observed check, and the
latest handoff's exact reviewed revision and publication status. A prior check is
labelled applicable only when its checked revision equals the current working
copy; model notes cannot change that binding.
