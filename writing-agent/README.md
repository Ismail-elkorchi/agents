# Writing Agent

Writing Agent is a project-oriented writing application composed from Agent Core. It keeps briefs, structured intents, proposals, evidence, editorial decisions, authorship provenance, context receipts, transaction settlements, and content-addressed project revisions in one append-only private project log.

Private state defaults to the platform user-state directory (`$XDG_STATE_HOME/writing-agent` or `~/.local/state/writing-agent`) and must remain outside the writing project. Use `--state-root` for an explicit external location. `.writing-agent` and `.git` are denied inside the rooted project authority and are never authoritative state.

The model receives bounded project text, sources, excerpts, and tool output as untrusted data. Application-owned target descriptors are separate trusted control: each descriptor binds an admitted resource ID to its rooted relative path, base hash, media type, and stable document, paragraph, and protected-range anchors. A direct user request is adopted as an immutable structured operation before model execution.

In the default `suggest` mode, the model can read only exact admitted managed resources and `propose_revision` is its only write capability. Its schema is compiled for the admitted operation: text intents expose only their exact intent IDs, resource IDs, anchor IDs, and replacement prose, while structural alternatives appear only for corresponding structural intents. The model does not submit paths, hashes, ranges, source preimages, verification verdicts, criterion coverage, or mutation authority. The operation service injects and validates control values and candidate material before appending one durable proposal; it cannot mutate user files. Deterministic quality checks, semantic preservation, and editorial findings are produced afterward inside Agent Core's required verification boundary and persisted in a proposal-quality evaluation receipt.

Applying an accepted proposal is a separate application action using Agent Core's recoverable text transaction. Apply-mode direct-user authority is captured in the admitted operation, not retained as transient caller state. Initial execution, approval and decision continuation, recovery, and abort all pass through the same idempotent operation finalizer. A terminal Agent Core run that outlives its caller is reconciled from the durable run event, and an interrupted apply is recovered from its exact transaction receipt before one terminal operation lifecycle is appended. Required failed, unknown, stale, partially covered, or unevaluated verification blocks acceptance. Human acceptance criteria require explicit criterion-level decisions, which are retained in the editorial decision rather than inferred from a generic approval.

The CLI requires one `--human-criterion <criterion-id>` option for each human criterion the user explicitly passes when applying a proposal. It does not infer those decisions from the `apply` command itself.

One-shot writing remains available only through the explicit transient composition:

```bash
writing-agent write "Draft a concise product announcement."
```

Project commands include `init`, `status`, `brief show`, `brief amend`, `plan`, `draft`, `revise`, `review`, `diff`, `apply`, `reject`, `undo`, `suspension`, `resume`, `decide`, `approval`, `abort`, `source add`, and `source list`. Provider selection is application configuration, not a package assumption:

```bash
writing-agent init --root ./manuscript "Write a sourced technical essay."
writing-agent status --root ./manuscript
writing-agent revise <resource-id> --root ./manuscript --provider openai-codex --model <model> --reasoning-effort medium --min-words 1200 --max-words 1500 --preserve-existing-numbers --forbid-new-citations "Tighten the opening without changing claims."
```

Exactly four provider compositions are supported: `ollama`, `openrouter`, `openai`, and `openai-codex`. The library APIs remain provider-neutral and accept an Agent Core `ModelProvider` directly.

`--reasoning-effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; `WRITING_AGENT_REASONING_EFFORT` is the environment equivalent. Operation-level exact constraints are available through repeatable `--allow-number` and `--allow-entity` flags, `--preserve-existing-numbers`, and `--forbid-new-citations`. Project and intent length constraints are intersected only when they govern the same exact resource set. Constraints for different intents retain their own targets, so a multi-resource operation cannot accidentally evaluate one intent against another resource's text.

Required exact constraints have deterministic closed-world checks for numbers, citations, and named entities. Every machine check identifies the acceptance criteria it covers. Evaluation criterion coverage is therefore derived only from explicit bindings to deterministic checks or admitted editorial findings; a narrow checker cannot imply coverage it did not declare. Source identity, excerpt hashes, claim/evidence graph integrity, semantic evidence verdicts, semantic-preservation findings, and direct human decisions remain distinct records, and unknown evidence is never converted to support.

Secure local revision currently relies on Agent Core's Linux rooted-file authority, descriptor-relative path checks, link checks, and recoverable patch journal. The package does not claim secure revision support on unsupported platforms.

There is no autonomous mode. There is also no multi-agent orchestration, swarm API, specialist-agent configuration, inter-agent queue, or mutable role binding. Planning, drafting, review, evidence checking, and editorial work remain explicit bounded passes in one application. A specialist agent is deferred until evaluations demonstrate a benefit that separate passes cannot achieve and authority, shared-state conflict, attribution, suspension, and recovery contracts are defined.

The terminal command surface is intentionally non-interactive. A TUI can be added after the project, revision, recovery, and evaluation contracts stabilize; no TUI state or generic resume abstraction is part of the current domain model.

The committed evaluation corpus contains distinct development, regression, holdout, adversarial, and human-audit sets. Generated campaign answers, judge output, and aggregate reports are not committed. The regression set has a separately reviewed digest and runs as a required verification gate.

A subscription-backed long-form campaign is deliberately separate from deterministic CI. Run it locally with existing provider authentication:

```bash
WRITING_EVAL_PROVIDER=openai-codex \
WRITING_EVAL_MODEL=gpt-5.6-luna \
WRITING_EVAL_REASONING_EFFORT=medium \
npm run eval:writing:live
```

The ignored `writing-evaluation-artifacts/` output contains generated documents, exact commit and runtime bindings, a working-tree digest when a local checkout is dirty, operation/context/proposal identities, hashes, checks, criterion coverage, token budgets, and metadata for every provider request. It excludes credentials and hidden reasoning text. Live subscription-backed evaluation is local-only and is not part of GitHub Actions, ordinary CI, or release workflows.

This contract is intentionally breaking. Current code does not parse or translate the former model-authored proposal hashes, copied preimage text/ranges, v1 intents, or old file-change field names.
