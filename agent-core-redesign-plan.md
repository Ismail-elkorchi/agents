# Agent Core redesign for persistent sessions

Date: 2026-09-07; implementation validated 2026-09-08. Status: breaking implementation complete across Agent Core and Agents; live model-policy defaults remain unmeasured. Release evidence is recorded separately from the design requirements below.

This plan replaces the future context and inference proposals in `recommendation.md` and the earlier implementation plans wherever they conflict. Their descriptions of completed migrations remain historical evidence. The implementation must retire the superseded contracts and code in the same release, without compatibility aliases or a second legacy context engine.

Inspected source: Agent Core `aaa3f2ceb3acc050eac36e6db28c8a4381114916`; Agents `42e0fe28c037d835dff8671e2165540b935c50c8`. The Agents source dependency points to that Core revision. Findings below distinguish source behavior, controlled probes, vendor documentation, and architectural choices. Vendor capability claims are not cross-model performance measurements.

The design is a durable execution kernel with model-directed attention and application-owned meaning. Models can maintain notes, inspect history, request context changes, discover tools, and choose strategies. Core preserves original inputs, causal delivery, authority, protocol validity, resource admission, and recoverable execution. Applications decide what the agent is trying to accomplish and what constitutes an acceptable result.

## 1. What changes when the harness starts from today's models

The useful question is which assumptions constrain capable models. Increasing a context limit or installing a better summarizer leaves those assumptions intact.

| Earlier assumption | Replacement decision |
| --- | --- |
| Every completed prompt should become a short task/result digest. | A completed run changes execution status. It does not by itself evict conversation content. Keep original contributions in the active context until an explicit selection or transition changes it. |
| A model needs a prescribed plan, reflection, verification, and summary cycle. | Applications can configure those workflows. The general runtime does not impose that cognitive sequence or require a natural-language final answer. |
| Context is an editable array of text messages. | Context includes ordered content, protocol items, media, configuration changes, and sometimes provider-bound reasoning state. Each kind has explicit replay and transformation rules. |
| A bigger context window makes compression unnecessary, or a small window makes aggressive compression inevitable. | Choose attention policy against measured task quality, latency, cost, available retrieval, and provider constraints. Capacity and useful attention are different quantities. |
| Reasoning is display text that can be discarded or concatenated into an assistant answer. | Preserve provider-required reasoning state separately from display summaries and ordinary notes. Its compatibility and replay requirements are adapter contracts. |
| Tools run in one blocking batch between model calls. | Track tool work independently. Support synchronous groups and asynchronous results where the provider permits them. |
| A new user prompt always starts a new objective. | Scheduling and semantic relationship are separate. A contribution can continue work, correct it, ask a side question, or explicitly replace it. |
| A universal relevance scorer can select the right context for every agent. | Models and applications choose useful material. Core enforces declared selection, scope, mandatory input, and budgets. |
| Every integration should fit the oldest shared chat API. | Preserve common semantics and expose validated provider capabilities. Unsupported features are explicit; they are not silently flattened away. |
| A smaller next prompt proves an improvement. | Measure total task outcomes, repeated work, recovery effort, cost, and time across the whole session. |

Current documentation makes these requirements concrete:

| Model or API family | Verified observation | Architectural implication |
| --- | --- | --- |
| GPT-6 Astra | The current guide documents async tools, steering during a response, and appended configuration updates. [OpenAI model guide](https://developers.openai.com/api/docs/guides/latest-model) | A response, a user submission, and a tool job cannot share one lifecycle identity. Configuration changes need a causal position. |
| Qwen 3.8 | Alibaba's API requires historical reasoning in its own field when preserved thinking is enabled; this is the default for Qwen3.8 Max/Flash. [API contract](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions) | An OpenAI-compatible endpoint still has model-specific replay semantics. Text-only normalization can degrade the request. |
| Kimi K3 | Moonshot documents native vision and a one-million-token window. [K3 technical blog](https://www.kimi.com/en/blog/kimi-k3) | Keep multimodal references and allow larger retained histories. Do not infer provider protocol or deployment limits from the model family name. |
| GLM-5.3 | ZCode describes long-context, multi-turn tool work as a target capability. Separately, Z.AI's preserved-thinking API requires unchanged reasoning in its original sequence. [GLM-5.3 product documentation](https://zcode.z.ai/en/docs/agents), [thinking contract](https://docs.z.ai/guides/capabilities/thinking-mode) | Test the exact endpoint and model combination. A product claim is not sufficient evidence for every adapter capability. |
| Claude Fable/Mythos | The current Fable/Mythos 5.1 documentation describes invalidation of reasoning when earlier conversation changes, model compatibility restrictions, and rejection of forced tool choice. [Model contract](https://platform.claude.com/docs/en/models/fable-5-1/overview) | Arbitrary prompt rebuilding, generic reasoning transfer, and mandatory forced-tool strategies cannot be runtime invariants. |

Future models may have cheaper long context, more persistent internal state, stronger retrieval, or different execution interfaces. This plan predicts none of those as a requirement. It allows provider-declared capabilities to evolve without changing history ownership, note authority, or application semantics. Smaller models remain supported through explicit policies; their workarounds do not define the kernel.

## 2. Reassessment of recommendation.md

| Recommendation | Decision and reason |
| --- | --- |
| One history read model over existing records | Keep. Duplicating a second authoritative memory transcript would create reconciliation problems. |
| Explicit coverage for summaries and complete subsequent history | Keep, and strengthen: coverage records structural inclusion, not a claim that a summary preserved every meaning. |
| One accounting contract at request admission and invocation | Keep. Count the provider-bound representation, including tool inputs and replayed state. |
| Govern auxiliary inference | Keep the lifecycle guarantees. Extract a reusable invocation service instead of wrapping every summarizer or verifier in a complete conversational run. |
| Versioned, application-owned JSON working state | Narrow. Structured domain state is useful, but model notes must also support ordinary text. Requiring a universal structured handoff would constrain writing, planning, exploration, and future agents. |
| Settle the current tool group before every transition | Make provider-dependent. Resolve synchronous obligations; retain and route valid asynchronous work without waiting for every external job. |
| One immutable request snapshot | Keep request identity, but distinguish logical input, compiled provider input, and provider continuation state. One hash cannot prove all three. |
| A model-facing history capability selected by Coding | Generalize. Core supplies optional domain-neutral history/notes tools; every application can compose them. Coding has no privileged ownership. |
| Preserve the corrected stateless OpenAI and exact-prefix Codex behavior | Agree, and extend the abstraction with explicit provider context state and compatibility checks. Opaque state can have semantic replay requirements; it is not the source of user intent or effect authority. |
| Summaries are optional; summary-free rollover is not proven universally better | Agree. Compare retained history, notes with retrieval, and supported provider compaction through one context mechanism. This is already a qualification in the recommendation, not a disagreement with it. |
| A global provenance graph, arbitrary context rewrite hooks, or another scheduler | Do not add. Use bounded source references, declared contributions, and the existing coordinator/effect machinery. |

The source glossary prohibits ambiguous exported names such as `projection`, `candidate`, and `prepared`. New contracts below use history views, selections, compiled requests, and context windows. The redesign is substantive; it does not rename the existing ContextManager lineage and leave its behavior intact.

## 3. Problems this release must eliminate

1. **Completed conversation disappears after compaction.** `runtime/src/orchestration/session-replay.ts` selects the semantic summary instead of later completed history and then skips those completed runs. The preceding analysis reproduced missing input in the next request with both in-memory and JSONL repositories.
2. **Ordinary run boundaries discard detail.** The same file clips tasks and steering at 800 characters and results at 1,200; it keeps eight recent records plus a bounded older tail. This loss can happen without context pressure. A controlled probe showed a later constraint disappearing on the next request while remaining stored.
3. **Request accounting omits tool-call arguments.** `model/src/index.ts:SimpleTokenEstimator.estimateMessages()` counts text, images, and overhead. A probe in this workspace returned four tokens for both a one-character input and a 100,000-character input in an otherwise empty assistant tool-call message. Reasoning and new content kinds need accounting too.
4. **Continuity has several unrelated renderers.** Completed-run digests, deterministic `ModelWindow.installCheckpoint()`, and semantic `AgentSession.compact()` do not share source boundaries or a recovery contract.
5. **Compaction is a special callback outside normal durable invocation.** It holds session serialization across a network call, lacks an explicit cancellation signal in its callback contract, and relies on Coding's standalone summarizer.
6. **Declared instruction roles do not survive assembly.** `ModelMessage` has no developer variant; `compilePromptMaterial()` folds non-user guidance into a system message and injects a universal persona/workflow.
7. **The protocol representation is narrower than current model APIs.** `reasoning?: string`, text-plus-images messages, fixed per-run tool lists, and a provider/tools phase sequence do not represent all of the capabilities described above.
8. **Stored records lack a coherent model-facing retrieval path.** Reading a known artifact is useful, but it does not locate an old correction, decision, conversation item, or observation.

These are replacement targets. They do not justify deleting effect authorization, driver fencing, crash reconciliation, scoped file authority, corruption checks, or immutable application verification.

Primary local evidence: [session reconstruction](../agent-core/packages/runtime/src/orchestration/session-replay.ts), [model contracts and estimator](../agent-core/packages/model/src/index.ts), [session compaction lifecycle](../agent-core/packages/runtime/src/session/agent-session.ts), and [prompt assembly](../agent-core/packages/runtime/src/inference/model-request-assembler.ts).

## 4. Package and ownership boundaries

Start with modules and explicit package subpaths in the existing graph. Do not create a new package for every noun in this document. Extract a package only when dependency direction or independent consumption requires it.

| Owner | Responsibilities after the change | Responsibilities excluded |
| --- | --- | --- |
| `@agent-core/model` | Typed model input/output items, authority roles, capability contracts, compiled-request and accounting contracts, provider context-state references | Session relevance, persona, note schemas, application completion policy |
| `@agent-core/persistence` | Immutable artifacts, integrity, conditional writes, event streams, rebuildable index primitives | Deciding relevance or interpreting a note as true |
| `@agent-core/runtime` | Sessions, input delivery, history views, note revision semantics, context selection/transition, governed invocation, tools/effect scheduling, optional acceptance capabilities | Coding plans, editorial briefs, research workflows, mandatory reflection or autonomous continuation |
| `@agent-core/tools` | Validated tool definitions, capability requirements, advertised catalog identities, effect contracts | Broad access to arbitrary session IDs or internal files |
| Provider adapters | Protocol lowering, counting/estimation, native context operations, reasoning compatibility, endpoint/model capability catalogs | Durable user authority or permission to execute application tools |
| Applications | Instructions, persistent domain requirements, domain state and validation, completion policy, tool grants, interface and continuation policy | Reimplementing transcript clipping, note persistence, history joins, or a separate inference lifecycle |

Pathless contracts and in-memory implementations remain available from normal exports. Filesystem repositories stay behind explicit Node exports. General history and note tools depend on repository capabilities, not on shell access or Coding's workspace root.

The existing check/disposition mechanisms remain optional domain-neutral capabilities. Remove universal prompt behavior and implicit activation of that workflow. A plain assistant or background classifier can finish without checks, a working copy, or publication. Coding and Writing continue to select their existing acceptance mechanisms explicitly. Split the current large runtime implementation along these ownership boundaries without rebuilding the effect state machine as an arbitrary plugin framework.

## 5. One history view with explicit source positions

Introduce `HistoryReader`, `HistoryPosition`, `HistoryItem`, and `HistorySelection` in Runtime.

`HistoryPosition` identifies the selected session branch head and the committed event heads read from participating run ledgers. Use existing IDs, sequence numbers, and hashes. Do not pretend independent ledgers have one reliable wall-clock order. Session acceptance and delivery establish order for conversation contributions; event order establishes causality within a run.

`HistoryItem` references the original record and any immutable content artifact. The reader joins session routing/branch records with run-owned assistant/tool records and deduplicates mirrored entries by source identity. It includes committed records from unfinished runs; indexing must not wait for run finalization. Display transcripts, inference reconstruction, search, and inspection consume this reader.

Committed partial output remains marked partial. Display deltas are not automatically complete protocol items, and a tool call is dispatchable only after its arguments are complete and validated. Interrupted generation must remain distinguishable from a delivered answer or settled tool observation.

Persist new source references at the existing recording boundaries so a mirrored session entry does not become a competing source of truth. A missing source is explicit corruption, unavailable material, or not-yet-visible material according to its recorded status; it is never silently replaced by an invented summary.

Replace special semantic-compaction replay with one selection rule:

```text
selected original entries and identified derived artifacts
+ every newly delivered contribution after the selection boundary
+ all provider-required protocol dependencies
+ current admitted application/control contributions
```

Overlapping selections deduplicate by source identity. A summary records the source set it was generated from; it does not own or delete that set. Advancing the boundary requires a new committed selection/transition. Completing a run alone cannot advance it.

Selections record retained sources, derived representations, and omitted ranges with reasons and retrieval references. Record compact ranges/cursors instead of listing every excluded entry on every request. Retrieval is subject to declared retention and authorization: an expired or redacted source must report its status rather than imply it remains recoverable forever.

Branch views include only ancestors and subsequent records admitted on that branch. A fork has a stable source cut. Other branches or sessions become visible only through explicit application grants; a model-supplied identifier is never authorization.

## 6. Separate user contributions, application state, notes, and provider state

These four forms of continuity have different owners and must not be merged into one memory blob.

**User contributions and requirements.** Keep original user text and attachments. Separate delivery scheduling (`steer`, `follow_up`, immediate admission) from intent relationship (continue, correct, side question, replace). An input does not erase prior work merely because it is newer. Applications define their normal routing policy; Core persists the selected relationship and references. Explicit replacement or cancellation has an auditable source.

Applications may bind continuing requirements to exact user source spans with scope and supersession references. Models can propose such bindings; they cannot promote their own paraphrases into authoritative user requirements. Direct, unambiguous user instructions can be admitted through application policy without a new confirmation ritual. Ambiguous interpretations remain attributed model proposals or ordinary conversation until resolved.

Mandatory context includes currently admitted requirements, undelivered accepted input, the active work identity, and the operational state needed for the next step. It does not include every historical prompt forever. Unselected earlier user content remains retrievable. If mandatory material cannot fit, return a specific context-admission failure; do not drop requirements, loop on compaction, or ask a model to remember an unprovided condition.

**Application state.** Applications expose immutable revisions of their state through typed contributions. Coding owns workspace and revision facts; Writing owns briefs and editorial contracts; other applications choose different representations. Core neither prescribes their fields nor ranks them a second time.

**Model notes.** Introduce `NoteRepository` and `NoteRevision`. A note has an opaque ID, title, media type, content artifact, parent revision, author identity, originating invocation, and optional source references. Text/Markdown is supported directly; schema-bound JSON is optional. Source references are encouraged for factual claims, not required for every plan or hypothesis. Notes are generated material, not instructions or verification.

**Provider context state.** Introduce an adapter-owned `ProviderContextState` reference with format/version, endpoint/model compatibility, originating request/input boundary, payload artifact or resumable handle, and replay/invalidation rules. Preserve exact returned blocks when required. A display reasoning summary is not a replacement for a signed or opaque block. Core must not decode hidden reasoning, invent missing state, insert it into user-visible history tools, or transport it to an incompatible model. The ordinary history view exposes safe status metadata and public content; protocol state remains a separately authorized resource.

## 7. Model-managed notes and history: the first useful tool surface

Expose optional tool factories backed by scoped Runtime services. Applications select presentation/namespaces suited to the provider, but the semantics remain identical. No private Codex endpoints are required.

| Capability | Minimum contract |
| --- | --- |
| `history.search` | Literal search plus structured source/role/run/tool/resource filters; bounded results, stable cursor, captured source position and index watermark |
| `history.read` | Exact source references, bounded text ranges or media/artifact references, neighboring items when requested, explicit unavailable/truncated status |
| `notes.list` / `notes.search` | Bounded metadata or matching text; exact scope and revision identity |
| `notes.read` | A specific revision or current branch-visible revision; bounded text or an artifact reference |
| `notes.write` | Create/update using an expected revision and invocation idempotency key; return committed revision or conflict |
| `notes.remove` | A branch-visible tombstone with expected revision; does not purge referenced artifacts or other branches |
| `context.inspect` | Current window, selected references, remaining budget with estimate quality, pending work, and legal transition options |
| `context.transition` | A proposed retained selection and note/summary references; schedules a host-validated transition instead of clearing state inside the handler |

Note writes use compare-and-swap. A repeated call with the same identity and content returns the original revision; a conflicting concurrent write is reported, not merged by last-writer-wins. A model can reread and reconcile. Exact reads see a committed write immediately. The initial local search implementation uses a rebuildable lexical index with a bounded scan fallback; a stale index must expose incomplete coverage. Do not require a vector database or silently claim semantic search. An optional semantic index must return the same source references and coverage metadata.

Notes follow the session branch by default. Forking pins inherited note revisions at the fork boundary; later parent/child writes diverge. Cross-session reuse and shared notes require explicit scope grants. A session note is not automatically a permanent user preference. Storage quotas cover note count, individual/total bytes, versions, query work, and artifacts; application retention may eventually purge unreferenced content. No automatic deletion is part of this migration.

Do not inject every note into every request. Bootstrap can include selected note references and a bounded note index, and the model retrieves what it needs. Models can maintain a concise entry note, several topic notes, or no notes if retained history is sufficient. The host does not demand a JSON handoff or force a tool call on models that reject forced tool choice.

## 8. Context windows and transitions

Introduce `ContextWindowRecord` and `ContextTransitionRecord`. They identify context history and selection boundaries, not a second execution state machine. A window has its parent, history position, admitted selection, provider state reference if any, and transition reason. Note revisions and application-state revisions are referenced, not copied into another mutable store.

An active context can span many completed user runs. Ordinary turns append newly delivered inputs, outputs, tool events, and supported control updates. The application chooses when to change retained attention; Core validates what that change means for the provider. Context controls remain usable even when no conversational run is active.

Transition lifecycle:

1. Admit the request with its expected branch/window revision and source position. Reserve any required invocation and storage budget.
2. At a provider-legal boundary, capture current input delivery, note references, application contributions, pending effects, and protocol obligations. Synchronous groups must be valid; unrelated asynchronous jobs need not have finished.
3. Optionally generate a note/summary through the governed invocation service. Ordinary transitions must also work without another model call.
4. Construct and compile the proposed next context. Check mandatory material, tool dependencies, provider state validity, and complete request fit.
5. Persist referenced artifacts and conditionally commit one transition record. If accepted input or relevant state changed, rebase/revalidate before commit. Do not hold the session command queue while awaiting inference.
6. Activate the new window and continue. On failure retain the previous committed window; if it cannot produce a valid next request, suspend with the exact reason. Do not rerun already settled effects.

Crash recovery observes either the old committed window or the new one. An orphaned staged artifact is not an active transition. Idempotency prevents a second transition commit. Large source scans and generated summaries need only be repeated when their captured dependencies actually changed.

Late results preserve their original effect, invocation, and tool-call IDs. If the provider can accept them across the boundary, carry the required dependency items and deliver them on those IDs. If not, delay the transition or explicitly finish/cancel the protocol operation while retaining the external job and eventual observation. Never manufacture a successful result or feed an unmatched tool result to a new provider conversation.

Support three policies through this same mechanism: retaining a recent original transcript with optional summaries; notes plus selective retrieval; and documented provider-native compaction. Start production with original-history retention, bounded retrieval, optional notes, and a valid conservative overflow path. Fresh-window retrieval becomes a normal automatic choice only after its bootstrap and semantic evaluations pass. Provider-native transforms record the boundary and returned state; hidden server behavior must not silently control local user-intent history.

A policy relying on recovery of omitted material is admissible only when the new window actually exposes authorized, bounded reads of that material. References to unavailable tools are not a retrieval path. An application can instead declare a self-contained state contract sufficient for its operation; that is an explicit domain guarantee, not something Core infers from a short note. Check retention, scope, available tools, and bootstrap fit before eviction.

## 9. A protocol contract that preserves modern capabilities

Replace text-only `ModelMessage` assumptions with ordered, typed `ModelInputItem` / `ModelOutputItem` contracts. Common variants cover authority-bearing messages, text/media content, tool invocation/result items, and control updates. Validated provider extensions carry unsupported native item kinds without turning the whole request into arbitrary JSON. Unknown required kinds are rejected explicitly.

The adapter publishes a versioned `ModelCapabilities` contract for roles, input/output kinds, reasoning state, continuation, context transforms, asynchronous tools, control updates, tool choice, counting, and limits. Capture the resolved endpoint/model capability revision at invocation admission. Families and marketing names are not capability predicates. Model-specific tables and exceptions belong in versioned adapters, with conformance tests and explicit overrides where documentation is insufficient.

Preserve real system/developer/user authority to lowering. Providers with different instruction channels declare their mapping and unsupported distinctions. Core cannot silently promote retrieved text or user notes into system guidance. Delete the universal Agent Core persona and final-answer contract; applications supply purpose, tone, workflow, and expected output.

Replace the fixed provider-then-tool-batch assumption with independent pending-call records and a provider-declared legal next-input boundary. Keep existing effect admission, locks, settlement, and driver fencing. This is an evolution of the current coordinator, not a second executor. A provider response ending, an assistant message being delivered, an external job ending, and application work completing are distinct events.

Native steering must record submitted, acknowledged, applied, failed, and uncertain delivery states. The same accepted user input must not be injected both natively and through a local follow-up. After disconnect, resolve delivery from available provider evidence; do not assume connection-local queued steering survived. Providers without native steering retain deterministic next-boundary delivery. [OpenAI steering contract](https://developers.openai.com/api/docs/guides/steering)

Advertised tools form an immutable `ToolCatalogSnapshot` for each request. Calls bind to the advertised definition revision; current revocations still apply before execution. Discovery adds authorized definitions to a subsequent request or supported native catalog update. Programmatic tool execution, where enabled, must delegate each real effect to the same admission/settlement path; it cannot bypass it. Capability combinations require validation, not independent boolean toggles: for example, Astra's documented async tools are direct function/custom calls, with additional restrictions on programmatic and multi-agent combinations. [Async tools](https://developers.openai.com/api/docs/guides/async-tool-calling)

Keep conservative exact-prefix reuse in existing Codex WebSocket transport. Make reuse/invalidation reasons observable. A changed branch, catalog, context selection, or instruction state must use a supported append/update operation, validated full replay, or an explicit reset. Do not send invalid reasoning blocks on fallback. When opaque state cannot transfer, preserve public history/notes, record the lost provider-state continuity, and rebuild through an admitted transition. [Claude reasoning contract](https://platform.claude.com/docs/en/build-with-claude/thinking)

## 10. One governed invocation service and one accounting path

Extract `InferenceService` from the lifecycle currently embedded in `AgentRuntime`; retain `InferenceGateway` as its provider boundary or absorb it if it becomes a trivial wrapper. The final implementation must have one real invocation path, not two equivalent abstractions.

An `InferenceInvocation` has a purpose, owner/run or parent invocation, captured model/capability configuration, logical input identity, compiled request identity, cancellation, budget reservation, result artifact, usage, and settlement state. Summary generation, semantic verification, classification, and normal agent steps use this service. They do not require a full interactive session or domain acceptance loop. Pure local reads and note CAS operations do not become artificial model runs.

Admit under the existing coordinator, release serialization while performing network work, and serialize settlement. Cancellation remains responsive. Unknown provider outcome and known partial output remain distinguishable. Hosted tools that can cause effects require explicit application grants and adapter outcome semantics; record unavailable evidence instead of inventing local tool receipts.

The request path becomes:

```text
history selection + mandatory/application contributions + catalog + provider state
→ logical input
→ adapter compilation
→ complete accounting and admission
→ governed invocation of that compiled input
→ durable output, usage, and provider-state settlement
```

`CompiledModelRequest` contains an immutable payload plan and immutable referenced media/state, excluding secrets and transport credentials. Count the same compiled input that is sent. No late hook can mutate it after fingerprinting. Count all text, actual tool inputs/results, schemas, framing, media, and provider-replayed state. Transport byte limits and model token limits are separate. Encrypted payload byte size is not its logical token count.

`RequestAccounting` reports counted/estimated/unknown components, method/version, calibrated uncertainty, context/input/output limits, and pricing semantics. Prefer provider counting or a matching tokenizer; use an explicit complete estimator with headroom where exact counting is unavailable. A heuristic is never labeled an exact guarantee. Unknown opaque cost requires provider accounting or a declared admission policy, never a zero estimate. Counting endpoints that consume resources also have bounded, cancellable accounting and shared quota; do not add recursive model calls just to count a request.

Model capacity, requested generation budget, total task spend, and context-transition allowance are separate. Default output reservation comes from an application/model policy, not the model's maximum output capacity. Reasoning inclusion and cached-token pricing follow provider semantics; cached tokens still occupy context. Calibration cannot be blindly reused after a model/format change. All child invocations, note generation, retrieval results, and native continuation share the owning work's resource policy so auxiliary work cannot escape limits.

## 11. Application migrations

**Coding Agent.** Extract a reusable coding-session composition service from `coding-agent/src/index.ts`. CLI and TUI call it. Delete its standalone summarizer and transcript renderer. Compose Core history/notes/context tools; use the same transition service for the user command and automatic pressure handling. Replace `/compact` with a clearly defined context command and matching events, without an alias preserving the old summary callback.

Supply current repository guidance and a revision-bound view of handoffs, actual changed resources, checks, unknown effects, and publication state. Model notes can explain decisions, rejected approaches, and next actions; they cannot fabricate check results or permission grants. Bind continuing user requirements to their source. Preserve isolated working copies, sandbox execution, check plans, scoped guidance, and publication control. State changes during a persistent session must update admitted context at the next valid boundary instead of keeping startup orientation indefinitely.

**Writing Agent.** Preserve the brief, structured intents, protected ranges, source support, production verification, and exact proposal/application bindings. Add optional model notes for editorial rationale and bounded history retrieval. Do not make Writing adopt Coding's handoff schema or force a general chat workflow onto a revision operation.

Extend `WritingContextSelection` to record newly retrieved history/notes as immutable supplements tied to the operation's base project revision and exact note/source revisions. The next invocation and semantic verifier identify the delivered selection revision. Required proposal anchor/control changes are explicit operation revisions or new operations, never silent mutations to an admitted proposal contract. A later edit can promote a direct user preference into a brief/editorial-decision revision through Writing's existing domain operations. A generated note alone cannot perform that promotion.

**Other agents.** Keep Research's reserved scaffold as a scaffold. Prove neutrality with small test compositions: a plain conversational assistant, a structured classifier, and a read-only monitoring agent awaiting external input. They require no repository, document tree, natural-language final response, forced planner, or universal verification pass. Applications may arrange multiple sessions with scoped sharing; swarm scheduling and a generalized workflow language are outside this release.

## 12. Deletion and replacement inventory

Paths beginning `packages/` are in Agent Core. Entries below are active replacements unless explicitly identified as dead helpers.

| Existing surface | Final disposition |
| --- | --- |
| `packages/runtime/src/orchestration/session-replay.ts` completed-run and compaction renderers | Replace with `HistoryReader` and one source-position-based context selection. Remove 800/1,200-character continuity clipping and the eight-run digest rule. Keep valid event decoding and interrupted-run recovery through the new reader. |
| `packages/runtime/src/inference/model-window.ts` mutable private history, `installCheckpoint()`, `checkpointHistorySummary()`, continuity text machinery | Replace with explicit context selections and committed windows backed by source references. Preserve useful tool presentation, media accounting, and protocol-validation behavior in the new owners. |
| `ModelWindow.recordToolCall()` | Delete. Repository search finds only its delegating definition. |
| `packages/runtime/src/session/agent-session.ts` compaction callback, `compacting` state, `compact()` | Delete after governed invocation/transition cutover. Keep session delivery, queueing, branching, and durable recovery. |
| `SessionCompactionEntry`, `AgentSessionCompactionRequest`, `appendCompaction`, privileged replay base | Remove from public contracts, event codecs, in-memory and Node repositories, exports, and tests. Use derived artifacts and window transitions. |
| `PromptMaterial.notes`, `.continuity`, always-injected observed-fact digests | Replace duplicated continuity channels with attributed selected items. Retain observed-fact records and optional domain-neutral query/filter support. |
| `compilePromptMaterial()` universal persona, role flattening, duplicate full tool prose, default final-text contract | Delete; replace with typed authority-preserving assembly and application-selected guidance/output policy. |
| `SimpleTokenEstimator` as the production admission mechanism; separate scaffold/request-fit/budget formulas | Replace with complete compiled-request accounting. Remove old production callers and redundant formula helpers, including `estimatePromptScaffoldTokens` if superseded. A diagnostic heuristic must use the new component contract. |
| `ModelMessage` text-centric union, flat reasoning replay, partial-content rebuilding through generic `raw` | Replace public model contracts and every adapter/validator. Preserve safe display summaries as display data. Store required protocol artifacts explicitly. |
| `normalizeStreamedFinalResponse()` in `orchestration/model-request.ts` | Delete. Repository search finds no callers; gateway already owns the relevant normalization. |
| Separate durable provider lifecycle code embedded in `AgentRuntime` after extraction | Delete duplicated lifecycle implementation; all first-party inference uses `InferenceService`. |
| Fixed per-run tool catalog and implicit all-tools-before-next-response condition | Replace with immutable per-request catalog binding and explicit provider protocol obligations. Preserve effect locks and uncertain-outcome handling. |
| `coding-agent/src/index.ts:summarizeConversation`, `renderConversationItem`, `maxChars` clipping | Delete with the callback API. Extract composition; retain only CLI wiring in the entry point. |
| Old compaction-only Coding command, message, status, and TUI event plumbing | Replace through one context/invocation presentation path in `index.ts`, `tui/runtime.ts`, `tui/messages.ts`, and affected reducers/tests. |
| Writing's independent verifier invocation path | Route through the same governed invocation service; retain editorial prompt construction and interpretation. |
| Provider name-prefix checks used to infer shared runtime capability | Remove from Core and application logic. Replace adapter exceptions with versioned tested endpoint/model capability records, not broader regex guesses. |
| Earlier context redesign proposals and generated declarations for removed exports | Consolidate active decisions into the final glossary/docs, retire conflicting future-plan sections, clean builds and packed artifacts. Historical reports may remain clearly dated. |

Do not delete HTTP full replay, conservative continuation fallback, effect reconciliation, corruption detection, stored observations, artifact reading, or image handling merely because they look like fallback code. They have current consumers and correctness purposes.

Persisted pre-alpha formats change in place with an explicit format identity. Old state is rejected with an actionable incompatibility error; it is not silently interpreted, migrated, or deleted. Starting a new session is separate from discarding existing user data. No old-format readers, compatibility aliases, fallback shape detection, or automatic directory cleanup belong in this release.

## 13. Implementation sequence and exit gates

Implement as a coordinated Core/Agents development series and release once. Intermediate commits may introduce replacement internals, but a capability is not complete while its old production path still runs. Do not ship a flag maintaining two continuity systems. Each milestone removes its predecessor before its exit gate.

| Milestone | Concrete delivery and removals | Required evidence |
| --- | --- | --- |
| M0 — Contract and regression fixtures | Capture original input after run completion, post-summary tail, large tool arguments, role lowering, reasoning artifacts, note/branch scope, and cancellation cases. Agree new source/format identities in the glossary. | Behavioral fixtures distinguish current failures from desired semantics. Existing recovery/acceptance tests remain authoritative. |
| M1 — Typed provider input and accounting | Introduce content/protocol items, capability revisions, compiled input, and common accounting. Migrate current provider serializers/validators and the gateway. Remove text-only assumptions, role flattening, and duplicated production estimates. | Every sent content kind is accounted; declared roles survive allowed lowering; unsupported combinations fail explicitly; existing providers build and pass conformance. |
| M2 — History and continuous windows | Add shared branch-aware history views, source cuts, and committed selection/window records. Make run completion preserve active conversation. Replace completed-run digests and summary-special replay, including privileged compaction repository events. Add exact history read/search and its scope checks. | Corrections survive many completed runs; reconstruction from successive committed selections preserves all later contributions; index rebuild and branch reads agree; no full-ledger rescan for every next request. |
| M3 — Governed invocation | Extract invocation lifecycle, common budget ownership and cancellation. Migrate Writing verification and the summary-generation capability into the service. Remove the `summarizeConversation` callback, compaction lock path, and their callers together; M4 connects optional summary assistance to the new transition API. | Cancellation/steering remain responsive during auxiliary inference; restart settles or reports uncertainty without duplicated spend/effects; no direct first-party provider invocation remains outside the service/adapters. |
| M4 — Notes and context transitions | Implement note text/JSON revisions, CAS, branch inheritance, tools, bootstrap validation, and the model/host transition lifecycle on M2's records. Replace deterministic checkpoint collapse; connect context controls and pressure handling to this single path. | Working model can write a note, transition, recover old history, and continue; concurrent note edits, stale transitions, oversized bootstrap, and crash cuts behave as specified. |
| M5 — Modern provider execution | Integrate async pending work, catalog refresh, native steering delivery, reasoning-preserving continuation, and supported native context transforms with the existing coordinator. Remove fixed-batch assumptions. | Native and non-native adapters pass the same delivery/effect invariants; exact protocol compatibility, cancellation, late results and disconnect tests pass. |
| M6 — Applications and neutrality | Finish Coding session service/TUI migration and Writing admitted selection supplements. Add the three minimal neutral compositions. Consolidate active architectural documentation. | Coding and Writing preserve domain acceptance contracts; generic compositions have no coding/writing dependencies or forced workflow. |
| M7 — Evaluation, deletion, release | Run policy comparisons, select defaults by model/endpoint and workload, remove dead/superseded source and generated outputs, update dependency pins and publishable package graph together. | Core and Agents release gates and packed consumers pass; removed APIs absent; documented compatibility matrix and measured policy defaults available. |

The dependency-critical first implementation slice is M0–M2: original conversation retention plus bounded history access on a typed, completely accounted request. This gives model-managed recall a real foundation before introducing note-assisted rollover. M3–M4 make notes and transitions usable; M5 is required before claiming modern async/native protocol support. Shipping M2 as a completed redesign would leave the requested work unfinished.

For provider coverage, exercise three distinct protocol families: OpenAI Responses (including the Codex transport where compatible), reasoning-preserving Chat Completions endpoints used by Qwen/Kimi/GLM, and a native Claude Messages adapter with signed/preserved state. Add the latter as a reference adapter in M5 rather than pretending OpenAI compatibility proves Claude support. Advertise each exact model/endpoint feature only after conformance. Deterministic protocol fixtures do not require credentials; live evaluations use available authorized accounts and record unavailable models, especially access-limited ones.

## 14. Tests that determine whether the redesign worked

Mechanical correctness gates are absolute; model behavior measurements are statistical and reported separately.

| Area | Required scenarios and assertions |
| --- | --- |
| Many prompts | Sessions of 1, 10, 100, and 1,000 completed inputs; a requirement after character 800; a correction after several transitions; side questions and explicit task replacement. Original accepted content is stored and reachable, and newly delivered inputs cannot be skipped. |
| Selection boundaries | Summary plus retained source overlap; post-summary tail; repeated summaries from original sources; out-of-order tool completion; resumed unfinished runs; branches before/after a window boundary. No duplication, missing tail, or cross-branch leakage. |
| Notes | Read after write, idempotent retry, conflicting writes, tombstones, inherited revisions, explicit shared grants, quota exhaustion, missing artifact, and stale search index. A generated note never changes authorization or actual verification. |
| Protocol | Native authority mapping, reasoning blocks passed unchanged, incompatible model switches, appended control updates, catalog changes, delayed async results, synchronous result dependencies, refusal/partial output, and unsupported content combinations. Never silently stringify an unsupported native item. |
| Accounting | Large tool inputs with empty message text, retained outputs, schemas, multilingual text, images/media, opaque state with known/unknown cost, output/thinking reservation, cache tiers, and changing model limits. Same compiled input is admitted and sent. |
| Crash and cancellation | Crash before/after note commit, transition commit, invocation start/settlement, steering acknowledgment, and result delivery. Every accepted input remains traceable; known effects are not repeated; uncertain outcomes stay explicit. |
| Application validity | Historical test results remain bound to their code revision. Writing context supplements do not change admitted anchors. Plain conversation/classification/monitoring run without domain acceptance machinery. |
| Long-session scaling | Bound search work, result bytes, note/index memory and per-request processing. Use incremental source cuts and pagination. Store growth follows declared retention; prompt size alone is not the resource metric. |

Evaluate at least retained transcript with optional summary, notes plus retrieval, and supported provider-native compaction on matched workloads. Include tasks where earlier choices become relevant much later and tasks where they are explicitly superseded. Compare prompt-only memory to original-history retrieval and notes separately so the contribution of each is visible.

Report task success, continuing-constraint adherence, use of the latest correction, stale-fact errors, repeated work, note/retrieval usage, retrieval failures, provider-state invalidations, total tokens/cost, latency, and user interventions. Pin model/endpoint/version and budget, repeat stochastic trials, and publish sample sizes and uncertainty. A tool capability profile is a protocol fact; a successful memory policy is an empirical result. Do not promote a default based on one demonstration or the smallest resulting prompt.

The release requires zero deterministic input-loss, unauthorized scope expansion, orphan tool-result, and duplicate-settlement failures in the regression/fault suite. Quality defaults require no material regression against a declared baseline within agreed uncertainty; numerical quality/cost thresholds are set before live evaluation, not invented after seeing results. Lower context usage alone cannot pass the gate.

Run `npm run verify:release` in Core and Agents after implementation, including clean builds, lint, unit/fault tests, provider conformance, dependency verification, and packed consumers. Check both source and packed declarations for removed names and imports. Update the source dependency commit pin only to the actual verified Core commit. Do not mark migration complete while old runtime paths or first-party bypasses remain.

## 15. Implementation evidence: 2026-09-08

M0–M6 are implemented across Core and Agents. The cutover includes typed protocol
and media input, complete compiled-request accounting, original branch-aware
history, scoped revisioned notes, durable context transitions, governed primary
and auxiliary inference, the Claude Messages reference adapter, and independent
provider/tool execution. Coding uses the shared session composition; Writing
keeps admitted anchors immutable while selecting separately bound supplements.
The retired compaction, transcript-digest and exclusive batch paths are removed.

The native runtime fixtures exercise a delayed asynchronous result across three
responses, a changed tool catalog, exact original call bindings, a shared budget
that rejects a successor before transmission, disconnect/restart without effect
repetition, and steering plus a required result sharing one admitted generation.
Usage accounting covers both provider-reported usage and complete-request
estimates after a native input extension. Approval fixtures enforce canonical
revision binding after preceding effects, including effects that settle during
planning. Session completion waits for application handoff observers.

M7 includes the policy runner and its recorded
[simulation and live-availability evidence](https://github.com/Ismail-elkorchi/agent-core/blob/main/docs/CONTEXT.md#recorded-release-measurements-2026-09-08).
The four-policy comparison completed 16 trials and 424 settled invocations, with
32 successful recall checkpoints and zero observed mechanical failures. These
are deterministic integration measurements, not evidence of model quality.
The configured subscription alias has no pinned deployment version; no live
quality generations ran and no model-specific policy default is promoted.
Empirical quality/cost gates remain in force for future default changes.

Both repositories passed `npm run verify:release`, including clean builds, lint
and packed consumers. Core passed 511 unit/fault tests and 179 focused tests.
Agents passed its five conformance-metric tests and 146 application tests; five
sandbox-dependent tests were unavailable in this environment and one non-Linux
test was inapplicable. These skips are explicit limitations of the validation.

The Agents source dependency pins verified Core commit
`cd2485ab81151adf5a849371da023be839548df8`; source dependency verification also
passed after updating that pin. The five excluded architecture/comparison and
application planning documents remain outside the commits and unchanged.
