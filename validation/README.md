# Reproducible application evaluations

See [RESULTS.md](RESULTS.md) for observed qualification results and known defects.

`coding-agent-evaluation.mjs` is the evaluator. It launches the supported Coding
Agent `rpc` CLI, not an alternate agent loop. `evaluation-rpc.mjs` is the small
application-interface boundary. A future application should implement that
boundary and keep the task/result contracts; there is no plugin loader.

## Qualify without paid calls

Requirements: Linux with working unprivileged user/PID/network namespaces,
`bwrap`, Git, tar, Node matching the repositories, and already-installed
dependencies or an npm cache containing the locked packages. There is **no
unsandboxed evaluation fallback**. Trusted build preparation can explicitly
retrieve locked dependencies; candidate execution and task checks remain offline.

```sh
cd ../agent-core && npm run verify:release
cd ../agents && npm ci --offline && npm run verify:release
node --test coding-agent/test/evaluation-contract.test.js \
  coding-agent/test/evaluation-rpc.test.js \
  coding-agent/test/evaluation-metrics.test.js \
  coding-agent/test/continuation-comparison.test.js \
  coding-agent/test/continuation-comparison-host.test.js
node validation/qualify-evaluation.mjs /absolute/new-qualification
node validation/prepare-evaluation.mjs tasks /absolute/new-tasks
node validation/qualify-project-tasks.mjs /absolute/new-tasks /absolute/new-oracle-results
```

The paired qualification uses identical actual application builds, two
repetitions and local scripted Ollama responses. A→B/B→A ordering, source edits,
independent checks, corrections and all four attempts are retained. This
qualifies machinery, **not live model quality**. The frozen baseline corpus,
independent citation oracles and Core mechanical regression commands in
`continuation-comparison.mjs` remain in use. Its old declaration-only scheduler
and the old in-process/full-host evaluator were removed.

The oracle command runs the development checks on each actual starting revision
and recorded fixing revision, outside any agent. The former must report a named
criterion failure and the latter completed passing tests. Both require a
structured verifier receipt with the matching exit status. Candidate TypeScript
diagnostic failures are failed compilation criteria in the qualified environment.
Compiler launch/signal failures, test-loader crashes, uncaught exceptions,
incomplete/skipped tests and timeouts remain verification errors. It does not
compare candidate patches to reference patches.
Two explicit, recorded oracle adaptations make task requirements assertions:
provider completion must not reject when usage is incomplete, and resource
completion must accept the coverage-bearing `result` contract declared in the
correction prompt. All original response/usage/rendering/selection assertions
remain. Candidate exceptions in these specific operations fail named criteria;
the generic verifier still rejects arbitrary exceptions as verifier errors.

The offline install refreshes copied Core dependencies after rebuilding; it does
not change the dependency versions. A successful source build alone does not
update the installed Core packages or an already-running agent. These commands
launch fresh CLI processes. They do not restart the agent running this review.

## Prepare tasks and builds

`project-tasks.mjs` pins real project changes and their parents. Development:
`persistence-lock-ownership` (focused defect), `provider-usage-completeness`
(cross-package change), `resource-coverage-correction` (staged, superseded
requirement). These tasks are implementation-visible. The correction is an
authored evaluation request, not a fabricated historical conversation.

`draft-shutdown-settlement` is separately reserved, not run or used for tuning.
It is **not claimed unseen to the task author**. Freeze it with
`prepare-evaluation.mjs tasks NEW_DIRECTORY --include-held-out`; do not use its
results to tune the development set. A genuinely blind held-out set still needs
an independent curator. Historical Core tasks have **known build exposure**:
`/build/node_modules/@agent-core/*/dist` is readable executable JavaScript (and
may include source maps) containing newer implementations. The host regression
explicitly proves candidate shell access to installed Core bytes. Hiding Git
history and checks does not hide those answers; neither the reserved task nor
development tasks are a blind holdout. These are contaminated diagnostics, not
clean estimates of unseen project performance. Blind evaluation needs tasks
outside this dependency history plus independent exposure review, or a
separately qualified process/remote execution boundary that hides the runtime.

Preparation creates hash-pinned source archives, dependency overlays, task JSON
and separate verifier archives. Git history, later solution commits, hidden
checks and references are not in the task workspace. Multiple repository
snapshots are supported by `repositories`; the supplied tasks need only Core.
The initial implementation rejects Git submodules and symlinks in source
archives rather than guessing how to flatten them. Offline setup can create
workspace-internal package links.

Prepare each exact Agents/Core pair from source:

```sh
node validation/prepare-evaluation.mjs build /absolute/agents-A /absolute/core-A /absolute/build-A
# Explicitly permit retrieving locked dependencies during trusted preparation:
node validation/prepare-evaluation.mjs build /absolute/agents-A /absolute/core-A /absolute/build-A --allow-downloads
```

Preparation captures exact source inputs, runs Core npm ci and build, then Agents
npm ci and build in a new temporary sibling layout. It packs the newly built
packages through the same archive helper as the packed-consumer release check.
Existing checkout dist and node_modules are never used as executable inputs,
and preparation does not rebuild or reinstall in the original repositories.
Temporary genuine detached Git metadata preserves the normal Core source-pin
checker, including for older exact revisions. It is excluded from retained source
archives and the runtime export. The Core source pin and both lockfiles are checked. The npm/Node implementation,
installed compiler bytes, complete input inventories and output inventories are
part of the build identity. A failed preparation emits no qualified build.json.
This is source-build provenance, not a claim that release gates passed.

Normal preparation requires clean tracked and nonignored untracked source and
uses committed bytes. Machinery qualification captures complete dirty snapshots,
including relevant added files, deleted files, binary inputs and executable bits.
Generated output, dependencies and ignored private files do not enter sources;
source symlinks and submodules are rejected. Qualification is explicitly labelled
and cannot masquerade as a clean revision comparison.

Keep BUILD.preparation alongside BUILD: it retains exact source archives,
preparation implementation, input manifests, command logs and the success/failure
receipt. Only BUILD is mounted in the candidate sandbox, so these source archives
and preparation logs are not exposed there. Receipt timestamps and storage paths
are separate from the canonical build identity. verifyBuild checks the frozen
artifact's integrity; verifyBuildPreparation separately checks the retained
source archives, packing archives, preparer code and successful receipt against
the pinned provenance. Comparison bundles retain this evidence outside the
candidate mount. Hashing an arbitrary existing dist is not source-build proof. Older build formats are rejected; old result bundles should stay intact.
Default dependency retrieval is offline with a shared temporary npm cache; set
npm_config_cache for a retained cache, or EVALUATION_DEPENDENCY_RETRIEVAL=online
for programmatic qualification preparation. This changes no dependency versions.


Exact continuation pairs are in `continuationBuilds` in `project-tasks.mjs`:
A is prior behavior, B selective continuation with the original state schema,
C narrative blocks. Run **A/B and B/C separately**. Historical builds must
support the RPC contract; incompatible builds fail, with no compatibility shim.
Their release gates have not been run by the local machinery qualification.

## Comparison manifest and launch

Schemas are strict, versioned JavaScript contracts in `evaluation-contract.mjs`.
Use absolute paths. A task identifies repository revision/tree/archive hashes,
agent instructions, environment, independent acceptance, allowed file changes,
human review criteria and finite limits. Its evaluator-only fields never enter
the prompt. The application receives an ordinary config copy; editing it is a
constraint violation and cannot rewrite the external task contract.

Example manifest (replace build digests and use an already-installed **unpaid
local** model with a pinned model identifier):

```json
{
  "format": "agents.comparison/1",
  "purpose": "local-model-diagnostic",
  "builds": [
    {"label":"A","directory":"/absolute/build-A","sha256":"64-hex-build-digest"},
    {"label":"B","directory":"/absolute/build-B","sha256":"64-hex-build-digest"}
  ],
  "tasks": ["/absolute/tasks/persistence-lock-ownership/task.json"],
  "repetitions": 2,
  "concurrency": 1,
  "settings": {
    "provider":"ollama","model":"EXACT_LOCAL_MODEL_IDENTIFIER",
    "reasoning":"provider-default","maxOutputTokens":4096,"temperature":0,
    "permissions":"full_host",
    "tools":["list_directory","find_files","read_files","search_text","view_image",
      "read_artifact","apply_patch","exec_command","write_stdin","stop_process"]
  },
  "spending":{"mode":"no-paid-calls"}
}
```

After approval of the local model/workload:

```sh
node validation/coding-agent-evaluation.mjs --manifest /absolute/comparison.json \
  --output /absolute/new-comparison --endpoint http://127.0.0.1:11434
```

Only credential-free loopback Ollama transport is implemented. Do not point it
at a paid proxy. Paid providers, arbitrary URLs and credentials are deliberately
not configuration options. [PILOT.md](PILOT.md) describes a proposed paid pilot
and its missing prerequisites; it is not currently launchable by this command.

## Isolation, limits and outcomes

Each attempt has fresh source, state, HOME, temporary files, network and PID
namespaces. Only the task and normal application state are writable. The build
is read-only; the running evaluator and hidden checks are not mounted. The
network namespace has only a narrow provider socket (exact model, show/chat
routes, output cap, bounded request count). Internet access is denied, including
retrieval of later fixes. Host environment variables and credentials are not
inherited. PID namespace teardown also kills detached grandchildren.

After namespace teardown, each immutable verifier runs against a separate
artifact copy, without provider access. Original regression sources replace
candidate tests. File constraints are checked independently. Human criteria
remain pending; no model judge is installed.

Core owns run token/tool/turn budgets. Scripted additional runs receive
disjoint portions of the task allowance, not fresh full allowances. The
external wall deadline terminates the application and preserves partial
evidence. Acceptance has its own explicit timeout. Total elapsed time includes
setup, execution and acceptance. Pair concurrency is bounded and order within
each pair is preserved. SIGINT/SIGTERM cancels active work and prevents admission
of the next build. Cleanup failures are retained in the report and stop admission
of further attempts; already-active peers still finalize their evidence.

Limits are not prepaid billing guarantees. An in-flight request can overshoot
reported token limits; output reservations and a transport request bound limit
exposure but do not make unknown pricing known. Missing usage closes further
provider admission, including when the missing receipt is the final response:
an otherwise accepted artifact remains `incomplete`, not `success`. Provider
failure, interrupted requests and exhausted request limits remain distinct.
A completed execution with partial/unknown model output (for example, an output
limit), or delivery diagnostics, is also incomplete; a later successful follow-up
does not erase it.
Direct provider access from a tool is still possible within
that narrow capability; transport receipts count it, and disagreement with Core
events must not be treated as complete runtime accounting. There is no cgroup
CPU/memory/disk quota, no frozen OS image, and no remote-host support. Use a
dedicated host for hostile/untrusted tasks and record the host environment.

One pure projection interprets the preserved attempt facts after application
shutdown and outer provider teardown. A shutdown RPC acknowledgement does not
establish a clean process exit. Results distinguish `success`, `incorrect_solution`, `agent_failure`,
`timeout`, `budget_exhaustion`, `infrastructure_failure`, `evaluator_failure`,
`cancelled`, `incomplete`, `not_run` and `pending_review`. A failed earlier run
cannot be hidden by a later successful claim. Expected scripted aborts are
recorded separately. Outcome and comparison qualification are independent: a
demonstrably incorrect solution remains incorrect when a missed correction,
failed cleanup or incomplete evidence makes its comparison unqualified. Live
finalization, report recovery and paired reporting use the same projection.
A verifier must end stdout with JSON of the form
`{"format":"agents.acceptance/1","status":"passed","evidence":"named criterion observations"}`
and exit 0; `status:"failed"` requires exit 1 and evidence of failed criteria.
An exit code alone is never sufficient. Missing/mismatched receipts, other
exits/signals/timeouts mean evaluator failure. `evaluation-acceptance.mjs` is
copied into immutable check archives; its Node test runner distinguishes named
assertion failures from verifier crashes. Treat arbitrary adversarial submitted code as untrusted even
inside a checker: process exit alone is not a proof against malicious test
evasion.

## Read and recover reports

`report.json` includes exact inputs/build inventories, scheduled order and every
attempt. Task, attempt and comparison-result formats are `/2`; old inputs and reports are
rejected rather than reinterpreted. `inputs/` retains frozen task/check/build bytes. Each attempt has a
durable `result.json`, external RPC trace, normal application state and final
or partial artifact. These are private local artifacts; do not commit them.
Final artifacts are hashed file inventories, not reference-patch similarities.

```sh
node validation/coding-agent-evaluation.mjs --recover /absolute/comparison
```

Recovery only rebuilds a report; it never resumes possibly executed work.
Running records remain incomplete and unstarted attempts stay in denominators.
Attempt directories must be new; existing evidence is never overwritten.
Relative symlinks are preserved in artifact and verifier copies.
Dangling/cyclic or escaping symlinks, including escapes through intermediate
links, are rejected. Each check's mutations are isolated from later checks and
from the retained candidate artifact.
Provider receipts count retries and context-management calls. Reported usage,
admission estimates, unknown usage and unknown cost are separate. No price or
receipt means `null`, not zero dollars. Compare paired improvements/regressions
before aggregates; inspect errors and constraint violations individually.
Pending human review makes a pair incomplete, not an improvement or regression.
So do unfinished attempts, missing usage and measurement attribution errors,
even when the other attempt succeeded or the artifact failed a criterion.
Missing or ineffective interventions, abnormal application shutdown and failed
cleanup disqualify either direction of a paired comparison.
There is no statistical superiority claim from a tiny pilot.

`constraints.stages` freezes initial no-edit run requirements. At each required
completed-run boundary the evaluator retains before/after inventories and the
host tool-effect/observation evidence. Applied mutations violate the stage even
if a later edit restores the bytes. Opaque shell execution, rolled-back writes,
missing observations or other insufficient evidence remain unproven; final
snapshot equality cannot turn them into success. Rejected mutation attempts
remain distinct from mutations and follow the task's explicit attempt policy.
These behavioral stages retain normal capabilities; they do not silently switch
the application to read-only mode or rebuild its runtime between prompts.

Checkpoints trigger on observed tool completion, context transition or run
completion, with occurrence and optional tool name, never sleeps. Corrections
use normal steering/follow-up; interruptions use normal abort followed by a
new prompt in the same session. Follow-ups at the same boundary are queued in
manifest order rather than replacing one another. Missing checkpoints and
abort requests that did not actually interrupt a run are incomplete, not passes.
Fresh/append/unchanged transitions and retained window identities are recorded.
Repeated input hashes, failed repeated work, retrieval and repeated effect
inputs are diagnostics: repeated arguments do not prove duplicated side
effects or lost understanding. Acceptance and human review establish those.
Natural runs and labelled context stress must not be pooled. The qualification
forces renewal explicitly; it does not establish reduced-window or natural
long-session quality. Successful one-window tasks establish no renewal quality.

## Existing terminal measurements

`tui-baseline.mjs`, `tui-performance.mjs`, `terminal-measurement-repro.mjs` and
`terminal-session.mjs` retain their separate terminal measurements and dated
JSON results. `terminal-session.mjs` takes `coding|writing` and an absolute
evidence prefix. Host load affects latency; historical results describe their
recorded dependency revisions, not current product guarantees.
