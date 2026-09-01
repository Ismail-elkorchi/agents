# Writing Agent

Writing Agent is a project-oriented application composed from Agent Core. Its append-only private project log retains briefs, structured operations and intents, context selections, proposals, claim/source evidence, editorial decisions, authorship provenance, production verification, transaction settlements, and content-addressed project revisions.

Private state defaults to the platform user-state directory ($XDG_STATE_HOME/writing-agent or ~/.local/state/writing-agent) and must remain outside the writing project. Use --state-root for another external location. .writing-agent and .git are denied inside rooted project authority and are never authoritative state.

## Model and authority boundary

A direct user request is admitted as an immutable writing operation. WritingExecutionBinding freezes the operation, base project revision, context selection, and proposal vocabulary used by one run.

The producer receives the complete applicable WritingOperationContract: every intent instruction, dependency, target, preservation requirement, affected criterion, affected claim/evidence relation, prior decision, and exact machine constraint that may affect acceptance. Project text, sources, excerpts, and tool output remain data. Host-owned target descriptors bind admitted resource IDs to rooted paths, hashes, media types, and stable document/range anchors.

In suggest mode, the model can read only admitted target resources and affected local source resources. propose_revision is its only write-shaped capability. The model supplies admitted IDs and replacement prose; it cannot choose paths, hashes, preimages, verification verdicts, criterion coverage, or mutation authority. The host validates and stores one private proposal without modifying managed files.

All model calls, including semantic verification, pass through Agent Core's InferenceGateway. Writing performs one ordered WritingContextSelection; Core preserves that order in PromptMaterial and does not run another relevance selector.

## Verification and evidence

Evidence means material that supports or contradicts a claim. Tool outputs are observations, deterministic check details are observations, and model-returned prose is model output.

ProposalProductionVerification combines:

- deterministic structural, range, hash, provenance, length, citation, number, and named-entity checks;
- semantic-preservation and editorial findings against the exact proposed revision;
- exact claim/source evidence excerpts relevant to the admitted operation;
- criterion-level human decisions where machine verification is insufficient.

Unknown, stale, partially covered, or failed required verification blocks acceptance. Semantic findings cannot override deterministic failures. Findings bind the proposed revision, base revision, operation contract, verification-input hash, and exact host-issued proposed/base/source citations.

The CLI requires one --human-criterion option for every human criterion the user explicitly passes when applying a proposal. An apply command alone does not imply those decisions.

## Apply and recovery

Applying an accepted proposal is a separate application action. A pre-run delegated apply policy may ask the application to accept a future passing result, but it is not mutation authority. After verification and acceptance, the application persists a WritingApplyAuthorization bound to the exact proposal, project revision, resource preimages, production verification, human decisions, and recoverable transaction identity. The revision service rejects missing, altered, or stale authorization.

Initial execution, user decisions, recovery, and abort converge through the same idempotent finalization path. A run that outlives its caller is reconciled from durable run events. A committed text transaction is recovered before one terminal writing lifecycle is appended. Stale content is never force-overwritten, and rejection leaves managed files unchanged.

## Commands

One-shot transient writing remains explicit:

~~~bash
writing-agent write "Draft a concise product announcement."
~~~

Project commands include init, status, brief show, brief amend, plan, draft, revise, review, diff, apply, reject, undo, suspension, resume, decide, approval, abort, source add, and source list.

~~~bash
writing-agent init --root ./manuscript "Write a sourced technical essay."
writing-agent status --root ./manuscript
writing-agent revise <resource-id> --root ./manuscript --provider openai-codex --model <model> --reasoning-effort medium --min-words 1200 --max-words 1500 --preserve-existing-numbers --forbid-new-citations "Tighten the opening without changing claims."
~~~

Exactly four provider compositions are supported: ollama, openrouter, openai, and openai-codex. Library APIs remain provider-neutral and accept an Agent Core ModelProvider. Reasoning effort accepts none, minimal, low, medium, high, xhigh, or max; WRITING_AGENT_REASONING_EFFORT is the environment equivalent.

Secure local revision currently requires Agent Core's Linux rooted-file authority, descriptor-relative checks, link checks, and recoverable patch journal. Unsupported platforms fail closed.

There is no autonomous mode, multi-agent orchestration, live model mutation, model-owned publication, or offline measurement corpus/campaign subsystem. The terminal surface is intentionally non-interactive. This package is pre-alpha and intentionally does not translate retired unpublished state names.
