# Coding-agent implementation architecture

Normative architecture and execution rules. Status and progress live in `manifest.json` and the generated root summary.

## Objective

Build a serious repository coding agent which can safely inspect, change, verify, explain, and resume work. Preserve these authorities:

- `agent-core` owns domain-neutral durable agent execution, evidence, authorization contracts, candidates, verification state, and finalization.
- `agents/coding-agent` owns coding workflow, workspace trust, repository policy, Git use, instructions, verification policy, product prompts, permission modes, and UI composition.
- `agent-core/tools-local` owns reusable host-local file and process capabilities without coding or VCS policy.
- `sandbox` owns isolated execution, enforcement, process lifecycle, cleanup, and execution receipts.
- `terminal-ui` owns general terminal application contracts. Coding-agent must not reproduce or bypass them.

Success is not merely a polished chat interface. One accepted operation must have one durable next action after every proven failure boundary; no stale driver may start new work; no completed effect may repeat; unknown unsafe effects must remain explicit; file and command authority must be confined independently; verification must not certify itself invisibly; and user-facing change claims must be derived from machine evidence.

## Ledger path and persistence policy

- Current authoritative path: `/home/ismail-el-korchi/Documents/Projects/agents/.coding-agent-implementation-plan.md`.
- Authoritative repository and branch: `agents`, `main`.
- Before implementation, commit this file to `agents/main`; an untracked local file is not a durable coordination record.
- No copy of this ledger belongs in `agent-core`; its `AGENTS.md` explicitly excludes repository ledgers.
- `L0` must split growing execution evidence without changing architectural meaning:

```text
agents/.coding-agent-implementation-plan.md   generated summary and entrypoint
agents/.coding-agent-plan/architecture.md     normative invariants and ownership
agents/.coding-agent-plan/manifest.json       node, dependency, status, owner, source-SHA manifest
agents/.coding-agent-plan/nodes/<ID>.md       one bounded node specification
agents/.coding-agent-plan/decisions/<ID>.md   accepted/rejected decision records
agents/.coding-agent-plan/evidence/<ID>.md    one append-only evidence record per node
```

- Only the coordinator mutates global status, dependencies, source heads, or the generated root summary. Parallel implementers own disjoint node/evidence files or return evidence to the coordinator.
- Evidence is Git-tracked. Temporary logs, credentials, provider content, and raw command output are not copied into the ledger; evidence records contain bounded summaries, commands, result identities, and artifact references.
- Every node starts only from global invariants, its node file, dependency decisions/evidence, current repository heads, and applicable repository instructions. It must not require replaying an indefinitely growing chat or command history.

## Mandatory execution rules

1. No backward-compatibility readers, aliases, deprecated fields, migrations, parallel obsolete paths, or fallback contracts. This is a current-only schema-v1 correction; migrate all in-scope consumers and delete the replaced path.
2. Correct authority and ownership defects at their source. Do not conceal them with retries, casts, timing delays, duplicate state, permissive defaults, or application workarounds.
3. Delete dead code, tests, flags, documentation, types, and configuration in the same node that supersedes them.
4. Validate each public/dynamic boundary exactly once. Internal functions consume adopted domain values. Every type predicate proves its exact declared type.
5. Do not weaken types or use assertion-based escape hatches to hide unresolved dynamic state.
6. The append-only run ledger remains the sole durable operation authority. A rebuildable index may point to it; no independent mutable state copy may become a second truth.
7. Before any repeat-sensitive external effect, durably commit its exact intent and authority. After completion, durably settle it before projecting later source-order consequences.
8. Unsafe, irreversible, expired, or unknown effects are never replayed automatically. A side-effect-free action is not automatically deterministic or semantically replayable.
9. Tool effect completion remains distinct from source-order conversation projection.
10. Re-enter the existing finalizer. Do not replace it.
11. Workspace content, project configuration, instructions, tool output, and source files never grant authority. Sandbox availability never implies authorization.
12. Command isolation and host file confinement are independent. Never treat the command sandbox as protection for host-process file tools.
13. Never fall back from required sandbox guarantees to ambient execution. An unavailable guarantee is a blocked action, not a mode change.
14. Terminal UI changes require a minimal framework-level reproduction and a general terminal-application contract. Fix and verify Terminal UI first, push `main`, then update coding-agent to the exact pushed commit. No local path override or coding-specific Terminal UI API.
15. No distributed server, remote worker, plugin kernel, multi-agent orchestration, provider expansion, writing-agent expansion, or research-agent implementation is authorized by this graph.
16. Do not claim a durability or containment tier that the implementation and tests do not prove.
17. At most one coordinator-owned node status is `current` for each implementation owner. A node is `done` only after every acceptance criterion and evidence requirement passes.

## Status vocabulary

```text
not_started  no implementation has begun
current      one named owner is implementing the node
blocked      an exact external prerequisite prevents progress
done         implementation and all acceptance evidence are complete
rejected     investigated and deliberately excluded; rationale is durable
deferred     valid future work outside the first resilient release graph
```

## Normative architecture

### One authoritative transition log

One run stream contains audit events and operation transitions. Only an `operation.transition` record advances durable control. Each transition contains the complete bounded state needed to select exactly one next procedure, with references to immutable conversation/evidence/artifact records rather than copies of their payloads.

```text
conditional append(expected tail + driver generation)
    -> one authoritative transition record
    -> file sync acknowledges durability
    -> rebuildable index publication
    -> caller acknowledgement
```

If index publication fails after the ledger record commits, retry finds the idempotency key and rebuilds the index. No independent state is repaired into the ledger. Cold index rebuild streams records with bounded memory. Full-chain verification is a separate audit operation, not the normal resume cost.

Operation state must identify:

```text
operation and captured configuration
driver generation and control status
phase and next procedure
turn/request identity
provider attempt state
tool batch and each call state
approval state
verification state
candidate disposition state
finalization state
budget reservations, settled usage, and unknown exposure
```

Conversation/session projection remains a separate domain authority, as it is today. An operation transition records exact projection receipts/identities so incomplete projection is idempotently reconciled; it does not duplicate conversation truth.

### Driver and effect authority

- `attach` conditionally increments the monotonic driver generation. Every planning/control append requires the current generation and expected tail.
- A stale driver cannot append transitions, request a new effect ticket, or start an unconsumed ticket.
- Before calling an external system, the effect gateway rechecks and atomically consumes the ticket. This prevents a driver paused before start from invoking after takeover.
- A process already inside an external effect cannot be magically revoked. A replacement driver must treat the committed intent as potentially invoked, query/reconcile it when supported, or keep it unknown. It must not start a concurrent replacement.
- An exact-effect settlement capability is narrower than driver ownership. A late old owner or execution service may settle only the still-outstanding effect identity with a validated result. It cannot plan another effect or advance unrelated control. The current driver consumes that settlement to advance state.
- If the replacement has already durably closed the effect as unknown/aborted, a late settlement cannot rewrite history; it is retained as a bounded late-result diagnostic when safe.
- Cancellation durably wins before it can prevent new effects. It does not erase already-started external uncertainty.

### Recovery capabilities

Do not expose a generic transaction framework. Capture only these behaviors when a concrete effect supports them:

| Capability | Required captured facts | Recovery |
|---|---|---|
| side-effect-free re-execution | exact input plus resource/version preconditions | rerun only if every precondition still holds |
| queryable/reconcilable | external execution ID, parameter digest, query authority, retention/expiry | query first; never start concurrently |
| idempotency-keyed | service namespace, key, parameter digest, documented binding and retention/expiry | repeat only inside the proven retention window |
| buffered mutation | prepared/journal identity, before-state identities, commit/receipt query | reconcile journal/receipt; never infer from intent alone |
| unknown/irreversible | intent and maximum reserved exposure | no automatic replay; require explicit disposition |

“Pure” is not enough: a file read after a change returns a different fact. “Idempotent” is not enough without parameter binding and retention. Compensation is always an explicit new effect and is outside the first release unless a concrete tool requires it.

Reserve conservative tokens/cost/time before provider effects. If a process dies after possible external consumption and exact usage is unavailable, retain the reservation or record an explicit bounded unknown exposure; do not refund it optimistically.

### Durability tiers

| Failure | First-release claim after R0/S0/F0 | Non-claim |
|---|---|---|
| application process termination | accepted operations restore to one explicit next action; completed settlements do not repeat | no promise for effects lacking intent or settlement in pre-R0 data |
| sandbox/helper termination | reconcile by execution identity/receipt, or remain explicit unknown | no inference from PID absence alone |
| operating-system restart | JSONL/index/state survive when acknowledged file and directory sync contracts succeed; sandbox receipts follow their own contract | no survival of process-local-only handles |
| power loss | crash-consistent only on tested local filesystems that honor the documented sync contract | no guarantee against lying hardware, remote filesystems, or disabled barriers |
| storage corruption | detect, locate, quarantine, and refuse effects; repair only an uncommitted torn final record or rebuild a derived index | no automatic repair of a checksum-valid semantic conflict, middle corruption, or lost committed data |

Tests may prove implementation behavior under injected faults and supported filesystem assumptions; documentation must preserve these qualifications.

### Workspace trust and provenance

Trust state is application policy owned by the user or organization and stored outside the repository against a canonical adopted workspace identity. Repository files cannot grant or upgrade it.

| State | Allowed behavior |
|---|---|
| `untrusted` | local metadata and explicitly selected content inspection for the human; no provider egress, repository policy activation, mutation, command, plugin, network, or watcher activation |
| `restricted` | bounded root-capability reads may enter provider context under egress policy; structured mutations and exact sandbox runs require per-effect approval; repository instructions are attributed untrusted guidance, not authority; repository commands/configuration are proposals only |
| `trusted` | scoped repository instructions and approved project configuration may become active within user/organization ceilings; sandboxing, file confinement, egress rules, and effect authorization still apply |

Canonical identity must bind the physical root and repository identity strongly enough that replacing or retargeting the root invalidates trust. Moving, multi-root, worktree, bare, junction, and remote-origin behavior must be explicit. Trusting a parent directory implicitly is not a default.

Every prompt/context item records source kind, source URI/path, scope, trust state, content hash, and truncation. Repository instructions, source, tool output, generated logs, and web content remain untrusted content even in a trusted workspace; trust changes which policy may activate, not whether content is factual.

Provider egress uses a manifest and deny-by-default sensitive-path/content policy. Credentials, environment files, key material, private application state, `.git` authority data, and paths outside the root do not leave the host without an explicit higher authority. Redaction also applies to events, checkpoints, receipts, transcripts, errors, and model/tool summaries. Private state directories are `0700` and files are `0600` where the platform supports POSIX modes; equivalent ACL checks apply elsewhere. Retention and deletion are explicit.

Hidden Unicode, bidi controls, invalid text, and terminal controls are detected and represented safely. Terminal UI owns safe terminal rendering; coding-agent owns provenance labels, prompt boundaries, warnings, and the choice not to interpret repository content as authority.

### Root-bound file authority

All host file operations consume an adopted root capability, never an ambient absolute path or a bare `workspaceRoot` string. One capability governs read, discover, write, structured edit, create, replace, delete, image/artifact read, and release.

The implementation must distinguish lexical containment from physical handle containment; reject unsupported aliases and special files; prevent symlink, junction, reparse-point, mount/magic-link, and path-swap escape; and state its exact platform guarantee. Linux `openat2`/directory-FD style resolution and Windows handle/reparse semantics are reference mechanisms, not mandatory API names. If the necessary guarantee cannot be established, the action is unavailable.

Mutations use captured before identity (device/file identity where meaningful, type, link count, mode, size, hash), same-root/same-filesystem staging, private journals, atomic publication where supported, directory sync, and exact receipts. Existing-content replacement must not mutate a multiply linked inode in place. Parent chains are revalidated through held authority. Temporary files are created with private modes, bounded names, and deterministic cleanup.

Generic tools cannot mutate `.git` or application state. Coding-agent owns a separate, sanitized VCS inspection boundary that disables hooks, external diff helpers, text conversion, credential prompts, and repository-controlled configuration when those features are not explicitly required. Denial, abort, supersession, and tool completion release every handle, journal lease, and resource lease.

### Verification truth

Before edits, capture a verification-oracle manifest: check ID and implementation ID, source/authority, exact structured command, environment, working directory, sandbox/enforcement digest, timeout/output limits, referenced script/config hashes when knowable, dependency/lockfile identity, baseline result or explicit reason omitted, and coverage limitations.

Each verification result binds to an exact candidate snapshot and records whether tests, package scripts, compiler/build configuration, CI workflows, dependencies, lockfiles, or other oracle inputs changed. Legitimate changes are allowed but visible. A changed verifier cannot silently be the sole independent proof of its own candidate.

Use these result distinctions:

```text
pre_existing_required_checks_passed
agent_added_or_modified_checks_passed
verifier_definition_changed
targeted_checks_only
full_checks_passed
checks_unavailable_or_blocked
candidate_independently_verified
```

Verification runs in an isolated materialization of the exact candidate, or with the candidate mounted read-only plus explicit ephemeral writable outputs. A verifier may not silently mutate the authoritative workspace.

## Explicit exclusions and deferred work

- No coding prompts, Git, repositories, `AGENTS.md`, sandbox dependency, or coding UI in Agent Core.
- No second session/history API; use and evolve existing session/replay contracts.
- No independent mutable operation snapshot.
- No automatic replay of unknown or expired effects.
- No generic checkpointing of raw reasoning and no one-record-per-token persistence.
- No generic compensation/saga system.
- No exact rollback claim for arbitrary commands; C4 is deferred.
- No ambient coding-agent command fallback.
- No sandbox redesign without failing S0 tests; the currently confirmed cross-process lookup gap is in scope for S0.
- No portable path-confinement claim built only from preflight `realpath`/`lstat` checks.
- No repository configuration or trust state that widens user/organization authority.
- No automatic activation of package scripts, tests, compiler plugins, hooks, external diff/textconv, or watchers because a project names them.
- No model-generated final change/check facts when machine receipts exist.
- No Terminal UI APIs named for repositories, models, tools, approvals, or coding agents.
- No local-path Terminal UI dependency.
- No writing/research product expansion or speculative generic application-value store.
- No Pi-style server/worker/lane/plugin topology, remote execution service, subagents, or new providers.

## Unresolved node-local decisions before implementation

These do not reopen ownership or the dependency graph. The named node must resolve and record them before source edits:

1. `R0`: exact cross-platform locking/fencing primitive and the local-filesystem sync assumptions that can be tested. No implementation may start from the current stale-directory lock as if it already met the contract.
2. `C0`: whether each platform can meet hostile path-swap containment through existing runtime primitives or needs a package-owned native helper. If neither is accepted, affected operations remain unavailable on that platform.
3. `SEC0`: canonical identity behavior for moved roots, Git worktrees, multi-root workspaces, and changed remotes. The user/organization remains the only trust owner regardless of representation.
4. `S0`: sandbox execution-receipt location, query retention, cursor retention, and behavior after expiry. Current public source does not define cross-process one-shot reattachment.
5. `D1`: exact capabilities of each current provider adapter. Absence of primary provider guarantees means `unknown`, not a guessed idempotency window.
6. `A4`: how much verifier dependency closure can be captured per ecosystem. Uncaptured closure must lower coverage; it cannot be silently called independent verification.

## Per-node operating procedure

1. Refresh head/branch/worktree and applicable instructions; compare against the manifest SHA.
2. Reproduce cited current-source evidence. If it changed, update the decision/evidence before editing.
3. Coordinator assigns non-overlapping paths and marks exactly one owner/current record.
4. Write the boundary/conformance failure first where practical.
5. Correct the owning contract, migrate all consumers directly, and delete the superseded path.
6. Run focused tests, type checks, architecture checks, and the full repository gate appropriate to the node.
7. Record bounded commands/results, commit SHAs, durability/platform claims, and residual limitations in the node evidence.
8. Coordinator validates the DAG/source freshness and alone marks `done`.
9. Any Terminal UI issue follows the T1 reproduction/correction loop immediately; no consumer workaround is retained.

## Final completion gate

- Every active node `L0` through `Q1` is `done`; only explicitly deferred `D1P` and `C4` remain outside the first release.
- `V0` has a recorded `go` decision and no unresolved duplicate authority or special-case recovery.
- Agent Core, Sandbox if changed, Terminal UI, and agents full gates pass at exact recorded commits.
- R0 store conformance, C0 hostile-path matrix, SEC0 trust/egress tests, S0 execution query/receipt tests, and F0 live stale-owner/process-kill tests pass at the claimed platform tiers.
- Accepted operations restore to one next action; stale drivers cannot start new effects; settled effects never repeat; unsafe unknown effects never auto-replay; finalization uses the existing finalizer.
- Verification binds the exact candidate and reports oracle changes/coverage. Final change/check summaries are machine-derived and preserve user changes.
- Existing writing-agent workflows compile/pass against Core without coding-domain APIs.
- Coding-agent consumes the exact final pushed Terminal UI commit with a normal manifest/lock resolution and no private imports/workarounds.
- Q0 security violation rates are zero. Q1 records repeated stochastic outcomes and does not masquerade as deterministic CI.
- No compatibility aliases/readers, obsolete execution paths, repository-local private state, ambient sandbox fallback, or dead code remain.
- All final heads, release gates, durability/containment limitations, and remote branch equality are recorded in generated ledger evidence.
