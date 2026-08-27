# Adversarial review decision record

## Review baseline

Adversarial review completed on 2026-08-27 against these exact heads:

```text
agents/main:      d0a3e919efc68eb2ba9a2a77bc8e874933f11e29
agent-core/main:  94a94ce36b11b34d14a2ab807dabbe958933b3a0
terminal-ui/main: d83d01432056470d17f42793bb83f6d7c93e595d
sandbox/main:     d2b79bf82766bb5832ed20bd1c9bc653f90c30c2
```

The three local heads equal `origin/main`. The only dirty path is this untracked ledger in `agents`. Re-read applicable repository instructions and refresh every head before implementation. Source evidence below is valid only for these SHAs.

At review time `coding-agent/package.json` and the workspace lockfile resolve Terminal UI commit `5cfc52deed787e6d4cde2e209af33415a973e7fb`. `T0` must adopt the latest pushed Terminal UI `main`, not blindly adopt the review SHA.

## Confirmed current-source evidence

### Durable storage and execution

- `agent-core/packages/evidence/src/event-repository.ts`: `EventRepository.append()` has no expected tail, compare-and-commit, driver generation, tail read, or conditional batch primitive.
- `agent-core/packages/evidence/src/repositories.ts`: JSONL append serializes through a process/file lock, scans all retained records for an idempotency key, and retains every decoded envelope in an in-memory array. Cold recovery is linear in total history and memory.
- The JSONL repository hashes sequence/previous-hash chains, syncs appended file data, detects middle corruption, ignores one unterminated tail on reads, and truncates that tail before a later append. Preserve those useful properties.
- Header/root creation and lock files do not establish private `0700` directory and `0600` file contracts or directory-sync publication. Existing tests do not prove disk-full, permission loss, power-loss ordering, checksum failure during append, stale live writers, or bounded recovery.
- `packages/runtime/src/session/agent-session.ts:204-215` converts a restored `claimed` submission to failure. Queued and approval-suspended work restore; general active execution does not.
- `packages/runtime/src/agent-runtime.ts:279-328` has a special `resumeApproval()` reconstruction path rather than one general operation driver.
- `packages/runtime/src/orchestration/tool-execution.ts` waits for a scheduled `Promise.all()` wave before the caller persists observations. Sibling external completions can be lost before source-order projection.
- `packages/runtime/src/orchestration/finalization.ts` already reconciles `finalization.prepared`, session projection, and `run.ended`. Keep it.
- `packages/model/src/index.ts` exposes continuation state and request/response identities, but no provider query/resume/idempotency-retention capability. `retryDisposition()` only describes whether local continuation state is reusable after an error.
- `packages/tools/src/core/authorization.ts` classifies effects only as `pure`, `idempotent`, or `non_idempotent`. This is too broad for recovery: a read can observe changed state; an idempotency key can expire; and a non-idempotent effect may still be queryable.
- `AgentCheckDefinition` is an arbitrary unversioned executable callback. Check identity currently consists only of `id`, requirement, and optional timeout.

### Host file and process authority

- `packages/tools-local/src/core/filesystem.ts` rejects lexical escapes and many symlinks, and `read_files` checks an open file's identity for replacement/growth/truncation. Structured patching has before hashes, an atomic-ish journal, recovery diagnostics, and cross-process journal locking.
- The same file boundary still performs separate path resolution, `lstat`/`realpath`, `open`/`readFile`, and later use. A hostile concurrent path swap can race those checks. Ordinary Node path APIs do not provide a root directory capability.
- Discovery skips `.git`, but generic reads can address `.git` directly. No one adopted root authority controls all read/discover/write/edit/delete/image operations.
- `packages/tools-local/src/core/process-manager.ts:810` proves its service with `instanceof ProcessManager`; `exec-command` therefore depends on a concrete local class.
- Commands and verification are string shell programs. Project scripts, test discovery, compiler/build plugins, package lifecycle scripts, Git hooks/config, external diff drivers, text conversion drivers, and file watchers can execute repository-controlled code even when the requested action sounds observational.

### Coding-agent product

- Configuration is loaded only through explicit `--config`; `AGENTS.md` hierarchy is not discovered automatically.
- Workspace configuration currently supplies instructions, commands, tools, authorization narrowing, and limits without a prior workspace-trust state or provenance/egress model.
- Runtime state lives under the workspace `.coding-agent` directory rather than a private user-state location.
- The CLI composes `--apply`, `--allow-shell`, project risk lists, approval callbacks, and direct `ProcessManager` use instead of one explicit permission and execution-target model.
- Verification commands execute against the live workspace and have no captured oracle manifest, baseline identity, candidate snapshot, or verifier-mutation classification.
- The TUI has confirmed composition defects around reliable event delivery, swallowed dispatch failures, session hydration, command history, and an unconsumed command-effect protocol. Ownership must be reproduced before deciding whether each belongs to coding-agent or Terminal UI.
- Coding-agent pins an older Terminal UI commit while local/current `main` is newer.

### Sandbox

- Current sandbox preparation returns redacted summaries, enforcement facts, policy/execution digests, expiry, and a one-shot prepared capability; exact digests are presented for approval; execution fails closed; cleanup is explicit; no shell is inserted implicitly.
- The public lifecycle states that prepared objects live in their owning runtime. Current public documentation has no durable caller-supplied execution identity with cross-process query/reattach of a running or recently completed one-shot execution. That gap matters for takeover; `S0` must prove it with conformance before choosing the sandbox correction.

## Adversarial decision record

### Accepted

1. Add a storage prerequisite (`R0`) before durable runtime work. Current persistence does not supply conditional append or fencing.
2. Keep one append-only authority, but make each control-advancing transition record contain the complete bounded next operation state. Do not recover control by folding all semantic telemetry forever.
3. Persist only a rebuildable latest-transition index bound to exact ledger sequence/hash/offset. The index is not state authority.
4. Add explicit workspace trust/provenance (`SEC0`) and root-bound host file authority (`C0`). Command sandboxing does not cover host file tools.
5. Add capability-specific effect recovery and split planning/start authority from exact-effect settlement authority (`E0`). A driver fence alone cannot cancel an effect already inside an external system.
6. Split minimum per-call tool settlement (`D2`) from parallel completion/source-order projection (`D3`) so an end-to-end slice can validate the architecture early.
7. Add `V0` after the minimum safe foundations and require a stop/go architectural review before horizontal expansion.
8. Capture verification-oracle provenance and classify verifier changes (`A4`).
9. Split deterministic conformance (`Q0`) from repeated real-model product evaluation (`Q1`).
10. Make the ledger itself mechanically validated and coordinator-owned (`L0`).

### Narrowed or replaced

- **Full-history semantic reduction:** rejected as the normal recovery algorithm. It preserves auditability but makes latency/memory grow with total history and makes code evolution depend on every historical reducer. Historical verification remains available; current control comes from the latest complete transition record.
- **Independent current-state snapshot:** rejected. It creates two mutable truths. The only cache is a pointer/index whose sequence/hash must resolve to an authoritative record.
- **Generic durable partial model stream in P0:** deferred. Minimum resilience is durable intent, one final settlement, provider-specific reconciliation, correct usage/budget accounting, and no duplicate logical response. Raw private reasoning is never generically checkpointed.
- **One replay flag:** replaced by captured, capability-specific recovery facts with exact preconditions, parameter binding, expiry, and reconciliation behavior.
- **General compensation framework:** rejected for the first release. No current coding-agent tool requires a generic saga/transaction system. Explicit query, idempotency, buffered mutation, or unknown outcome is enough.
- **C3 removal:** rejected. Agent Core already owns candidate and verification state, and bounded accept/revise/fail disposition is neutral. C3 remains, but its decision must be deterministic and implementation-bound; any model or command evaluator is an explicit durable effect.
- **Exact user rollback as a first-release prerequisite:** deferred. Transaction rollback during a failed mutation remains required; accurate before/after accounting and conflict detection remain active. A later user-requested multi-file undo must be justified independently and cannot claim arbitrary command rollback.
- **Portable race-free containment using only Node `path`/`fs`:** rejected as an unsupported claim. C0 must use a handle/native mechanism, or declare a platform guarantee unavailable and fail closed. Detection after a path operation is not confinement.
- **Workspace trust as authority:** rejected. Trust only enables product policy to consider repository configuration; user/organization ceilings, root capabilities, and sandbox enforcement remain independent.
- **Pi topology or terminology:** rejected. The pinned canonical Pi design assumes one writer and explicitly does not persist partial provider streams. Its working total-state handoff is useful evidence, not a specification for these repositories.

## Source evidence invalidated or corrected by this review

- The prior ledger made `D0` depend on folding total state from all semantic events. Current JSONL loads all envelopes and retains them in memory; that design does not meet bounded recovery. It is replaced by authoritative complete transition records plus a pointer index.
- The prior ledger treated durable partial provider content/reasoning as P0. The stronger safe minimum does not require it, and generic raw reasoning retention is inappropriate. `D1P` is deferred.
- The prior ledger's `pure | idempotent | non_idempotent` recovery language mirrored current types but was not truthful enough for file reads, expiring external keys, queryable processes, or buffered mutation.
- The prior `C4`/undo dependency delayed a useful integrated slice without evidence that exact user rollback is required. Accurate change accounting remains in A5; C4 is deferred.
- The prior graph postponed end-to-end composition until A7. `V0` now gates advanced work.
- The prior A8 mixed deterministic system conformance with stochastic model quality. It is replaced by Q0/Q1.
- The previous pinned `earendil-works/pi/.../harness-v2-state-machine.md` URL does not exist at repository HEAD `4e494929998d6bc4fccf75e0a233f727db4b70ee`; it is removed as pinned evidence. Search-indexed working handoff text is not a stable primary reference.
- Existing line evidence for Agent Core/coding-agent and the Terminal UI dependency still matches the reviewed heads. Revalidate line numbers, not just statements, before each node.

## Pinned external evidence

External systems are comparison evidence, never templates.

- Sandbox source and docs at `d2b79bf82766bb5832ed20bd1c9bc653f90c30c2`: `https://github.com/Ismail-elkorchi/sandbox/tree/d2b79bf82766bb5832ed20bd1c9bc653f90c30c2`.
- Pi stable canonical durable-harness design at `2f31a6b5c5d77c6c49fe2fcec81d7c1d361f0ab5`: `https://github.com/ranxianglei/pi-stable/blob/2f31a6b5c5d77c6c49fe2fcec81d7c1d361f0ab5/packages/agent/docs/harness-v2.md`. It documents intent-before-effect, bounded open-operation recovery, a single writer, and deliberate omission of partial stream persistence.
- Aider source snapshot `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` plus its lint/test and Git workflow documentation, accessed 2026-08-27: `https://aider.chat/docs/usage/lint-test.html`, `https://aider.chat/docs/git.html`.
- SWE-agent source snapshot `3ea751c087f32b16e039a2233dd6eefecef325d5` and ACI paper `https://arxiv.org/abs/2405.15793`.
- VS Code Workspace Trust and agent trust/safety, accessed 2026-08-27: `https://code.visualstudio.com/docs/editing/workspaces/workspace-trust`, `https://code.visualstudio.com/docs/agents/concepts/trust-and-safety`. These support restricted activation of workspace-controlled execution, not this product's exact state names.
- Claude Code security, accessed 2026-08-27: `https://code.claude.com/docs/en/security`. This supports permission, root, sandbox, egress, and prompt-injection boundaries, not reuse of its product modes.
- Git primary docs, accessed 2026-08-27: `https://git-scm.com/docs/githooks`, `https://git-scm.com/docs/git-diff` (`--no-ext-diff`, `--no-textconv`).
- Node filesystem docs, accessed 2026-08-27: `https://nodejs.org/api/fs.html`; they explicitly warn that check-then-use filesystem calls introduce races.
- Linux `openat2(2)` and Microsoft `CreateFile` documentation, accessed 2026-08-27: `https://man7.org/linux/man-pages/man2/openat2.2.html`, `https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea`.
- GitHub Copilot sandbox/security and custom-instruction docs, accessed 2026-08-27: `https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes`, `https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot`.

For web documentation without immutable versions, the implementing node records access date and a content digest or replaces it with an immutable upstream source reference. A changed page triggers review; it does not silently change this architecture.
