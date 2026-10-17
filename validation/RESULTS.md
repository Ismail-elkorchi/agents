# Evaluator review and qualification — 2026-10-17

This records **local machinery qualification**, not live-model evaluation,
completed before the subsequent request to commit and push. No paid evaluation,
credential configuration or package publication was performed. During that
review both working diffs were preserved; TypeScript 6.0.3, manifests, lockfiles
and TypeScript sources were unchanged. The later Git-publication follow-up
updates only the Core source-revision pin, not dependency versions.

Runtime sources:

- Core `1a708405a00f32e060ec3e5ea73ae89f6379e1a9`
- Agents `0d0605921fe4671753185f3cda61bf2835f2a555`, plus the uncommitted evaluator

The first export audit rejected **stale installed Core runtime bytes despite
the matching Git pin**: `Installed @agent-core/runtime differs from the declared
Core build; rebuild and reinstall dependencies.` Core was rebuilt, then Agents
dependencies refreshed with `npm ci --offline`, and Agents rebuilt. Export
compares installed Core distribution bytes and package metadata with that
compiled checkout. The evaluator launches fresh CLI processes; rebuilding did
**not** update the already-running review agent.

## Final-diff verification

Linux, Node v24.14.0, working bubblewrap. Evidence root (relative to Agents):
`coding-agent/evals/results/completion-review/`.

| Exact command (repository) | Observed result | Log in evidence root |
| --- | --- | --- |
| `npm run verify:release` (Core) | Exit 0; 1,538 ordinary + 241 focused tests; build, lint, packed consumer and both declaration strictness checks passed | `core-release.log` |
| `npm ci --offline` then `npm run build` (Agents) | Both exit 0; refreshed copied Core without version/lock changes | `agents-install.log`, `agents-build.log` |
| `npm run verify:release` (Agents) | Exit 0; 393 tests, 392 passed, 1 existing platform-conditional skip; build, lint and packed consumers passed | `agents-verified.log` |
| `npm run package` (Core) | Exit 0; packed runtime and exactOptionalPropertyTypes=true/false declarations passed | `core-packed.log` |
| `npm run package` (Agents) | Exit 0; packed agent consumers passed | `agents-packed.log` |
| `node --test tests/evaluation-accounting-contract.test.js` (Core) | Exit 0; 1 passed | `core-accounting.log` |
| `git diff --check` (both repositories) | Exit 0 | `audit.log` |
| `node --check` on every `validation/*.mjs` (Agents) | Exit 0 | `audit.log` |

The existing skip is “workspace file authority fails closed where secure root
adoption is unavailable”; its unsupported-platform branch does not run on Linux.
No tests were skipped for bubblewrap or to accommodate a defect. Remote CI and
other operating systems were not run. `verified-source-inputs.json` records the
tested changed JavaScript sources and unchanged package/lock hashes.
`final-audit.json` confirms those sources still match after all gates and the
exported application distribution is byte-identical to the current built one.

The affected suite was also run separately from Agents, exit 0, **50 passed**,
0 skipped/failed (`focused-verified.log`):

```sh
node --test coding-agent/test/evaluation-contract.test.js \
  coding-agent/test/evaluation-rpc.test.js \
  coding-agent/test/evaluation-metrics.test.js \
  coding-agent/test/continuation-comparison.test.js \
  coding-agent/test/continuation-comparison-host.test.js
```

## Paired CLI qualification

Exact command from Agents, exit 0:

```sh
node validation/qualify-evaluation.mjs \
  "$PWD/coding-agent/evals/results/completion-review/paired-delivery"
```

Four attempts succeeded, in A/B then B/A order. Both labels deliberately used
the same build, pinned to the runtime revisions above:
`9429cf22376720375ad93f88224bb7107e0bd78a58a995b5fa9b4317b7da4410`.
The retained bundle includes inputs, build/evaluator inventories, traces, normal
application state, artifacts and all attempts.

Settings: local scripted Ollama `v0-scripted`, provider-default reasoning,
temperature 0, output cap 4096, normal tools, full-host permissions **inside**
the namespace. Each attempt had three runs, two follow-ups, five generation
requests, one discovery request and no measurement errors. Scripted input/output
usage was 50/16 per attempt; cost remains `null`. These are not live model token
measurements. Zero renewals means no renewal-quality claim; forced renewal is
covered separately in the host tests. There is no superiority claim from
identical-build scripted latency differences.

## Historical oracle checks

Exact commands, from Agents:

```sh
node validation/prepare-evaluation.mjs tasks \
  "$PWD/coding-agent/evals/results/completion-review/tasks-delivery"
node validation/qualify-project-tasks.mjs \
  "$PWD/coding-agent/evals/results/completion-review/tasks-delivery" \
  "$PWD/coding-agent/evals/results/completion-review/oracles-delivery"
```

Both exited 0. All six historical checks compiled using the frozen offline
dependency overlay and produced explicit verifier receipts:

| Development task | Starting revision | Fixing revision |
| --- | --- | --- |
| persistence-lock-ownership | 1 passed / 5 assertion failures; exit 1 | 6 passed; exit 0 |
| provider-usage-completeness | 12 passed / 31 assertion failures; exit 1 | 43 passed; exit 0 |
| resource-coverage-correction | 5 passed / 6 assertion failures; exit 1 | 11 passed; exit 0 |

These establish oracle discrimination, **not that an agent solved the tasks**.
The reserved draft task was not run. Two task-owned no-throw/no-reject assertions
are documented in task provenance and README; all original assertions remain.
The resource correction now explicitly declares the `resource.loaded.result`
contract that its tests require, rather than hiding an API requirement.

## Review findings and reproducible evidence

- **Exit-code-only grading was unsound.** Uncaught errors, syntax errors and
  missing imports also exit 1. A structured receipt and matching exit are now
  required. The generic regression verifier rejects non-assertion crashes,
  skipped/incomplete tests and early exits without declared tests.
- **Oracle qualification ignored cwd.** The old generated verifier masked this
  by setting cwd internally. The first stricter run produced six errors,
  retained in `oracles/`; `oracle-diagnostic.log` shows the same fixing source
  passing with the correct cwd. Candidate attempts and oracle qualification now
  use one acceptance launcher.
- **Two original oracles conflated candidate exceptions with verifier crashes.**
  `oracles-final/` retains six provider contract exceptions and six resource
  `findIndex` TypeErrors. The task-owned assertions now state which operations
  must not throw; no error-name allowlist or generic crash-as-failure fallback
  was added. To reproduce rejection of the retained *old* oracles, use:

  ```sh
  node validation/qualify-project-tasks.mjs \
    "$PWD/coding-agent/evals/results/completion-review/tasks-final" \
    /absolute/new-rejected-old-oracles
  ```

  Expected exit 1, with provider/resource starting checks classified as errors,
  not qualifying failures. The final `tasks-delivery` command above passes.
- **Partial output could masquerade as success.** A completed execution ending
  at its output limit now remains `incomplete`, even if acceptance passes or a
  later follow-up completes. Missing usage/fields, unfinished attempts and
  pending human review cannot produce favorable paired comparisons.
- **Cancellation could race asynchronous provider setup.** Admission now closes
  before new application/check/provider work; teardown errors preserve results
  and stop subsequent attempts. Recovery preserves cancellation and unstarted
  attempts. Checks have independent copies; chained symlink escapes are rejected.
- **The old interruption expected-failure test was obsolete.** Both `read_files`
  and `exec_command` interruption regressions now require an aborted run followed
  by successful continuation in the same session, original tool results in the
  next model request, exactly one execution call and one non-idempotent append.
  No retry, idempotent substitute or weakened expected failure remains.

Reproduce the corrected critical regressions:

```sh
node --test \
  --test-name-pattern='observable interruption|partial model output|evaluator crashes|cancellation during provider setup|acceptance checks|symlink containment' \
  coding-agent/test/continuation-comparison-host.test.js
node --test coding-agent/test/evaluation-contract.test.js \
  coding-agent/test/evaluation-rpc.test.js
```

Earlier reports and failed/interrupted review logs remain intact. In particular,
`focused-first.log` includes a test-field typo (`name` instead of `toolName`)
which was corrected, and `agents-delivery-release.log` is a deliberately stopped
intermediate gate, **not** final verification. Only the final logs named above
qualify the final implementation.

## Limits and unrun evaluation

Historical answers are **not hidden** by removing Git history: the candidate can
read newer compiled Core under `/build/node_modules/@agent-core/*/dist`. A host
regression proves that access. These tasks are contaminated development
diagnostics, not a blind holdout, including the reserved task.

Paid transport and a hard spending boundary remain unimplemented; paid
configuration is rejected. Exact historical A/B/C builds, remote CI, other OSes,
a genuinely blind independently curated holdout and natural long-session/live
quality evaluation remain unrun. There is no cgroup CPU/memory/disk quota or
frozen OS image; verifier receipts are not a proof against malicious test evasion.

See [README.md](README.md) for build/task preparation, launch and recovery.
[PILOT.md](PILOT.md) remains a proposal only: tasks, model settings, repetitions
and spending limit require approval before any live pilot.

## Git-publication follow-up

At the user's subsequent request, the Core documentation/accounting changes were
committed as `1bfb36ee3ab430462eee9414f29dc52f025286e9`. Agents now pins that Core
revision. Core runtime packages, dependency versions, lockfiles and TypeScript
are unchanged.

After updating the pin, Agents `npm run verify:release` exited 0 again: 393 tests,
392 passed, the same one platform-conditional skip, and packed consumers passed.
The log is `coding-agent/evals/results/publication-20261017/agents-release.log`.
Remote CI must be associated with the exact pushed commits. The review bundles
above retain their original revisions and digests; they have not been relabelled
as post-publication evaluations.
