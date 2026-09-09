# Design

## Objective

Shorten the evidence-driven Phase 2 iteration loop while preserving causal attribution, reproducibility, genericity, and human authority over expected outcomes.

## Non-Goals

- Production deployment or multi-user authentication
- A distributed queue or durable cloud worker fleet
- Autonomous pushes or merges to the planner repository
- Phase 3 plan generation
- Treating aggregate build/reuse/extend counts as correctness
- Implementing genetic crossover between unrelated code patches

## Architecture

```text
Routed web console / CLI
       |
CampaignOrchestrator ---- SQLite + append-only events
       |
       +---- Strategist (OpenCode session)
       |
       +---- 3 x Mutator -> disposable planner worktree -> diff/test gates
       |                                      |
       |                                      +-> image + isolated Compose stack
       |                                                   |
       |                                                   +-> normal Phase 2 API run
       |
       +---- Blind judge (separate OpenCode session, frozen workflows checkout)
       |
       +---- deterministic score + Markdown report + human review
```

## Search Strategy

The harness uses a three-wide beam search rather than a genetic algorithm. Every round starts from one selected parent. Independent workers each implement one hypothesis, preserving attribution. A winning candidate is evaluated on unrelated holdouts before it can become the next parent.

Patch crossover is intentionally excluded: combining independent source-policy changes creates merge noise and makes an observed result impossible to assign to one mechanism.

### Optional Investigator Loop

`investigator.enabled` opts CLI/API campaigns into persistent per-candidate investigation instead of strategist/mutator attempts; absent or disabled configuration retains existing behavior. New campaign UI defaults to enabled. Campaign control mode and unattended tool permission remain independent.

An investigator owns revisable hypotheses, not the harness's execution policy. The coordinator records each request before execution, requires evidence-backed diagnostic qualification before admitting new full-primary trials, enforces exact-patch trusted-test prerequisites, and archives action-specific requests, pins, patches, receipts/failures, logs, and planner artifacts under `investigation/action-NNN/`. A passing offline probe is optional, not the admission requirement. Finalization requires an unchanged evaluated patch and matching preregistration, full configured tests, and semantic review before the final primary/holdout/configured excluded cohorts. Test/probe success and session finalization are not correctness or promotion decisions.

Screening evaluates the entire primary pack with `investigator.primaryReplicates` (integer 1..3, default 2 for new campaigns). New-campaign initialization freezes that value; archived configurations that omitted it retain their historical fallback. Baseline and final cohorts retain `evaluation.replicates` (2 in V2); screening is not a substitute for those final cohorts. Provisional reference labels are sufficient to screen and finalize. Human-reviewed labels are not an admission prerequisite, and the semantic review is a model judgment, not a human gate. An explicit one-replicate override provides no agreement/stability measurement.

Per-session budgets bound turns, primary evaluation attempts, wall time, and agent tokens independently of planner telemetry. New primary requests blocked by diagnostic admission record `admitted: false`; they remain in the timeline but do not count as primary trials or replace the latest recorded primary comparison. Admitted failures still count, as do historical records with omitted admission metadata. SQLite stores session identity, action status, unknown usage, reasons, and harness/context pins. Stop/resume retains this history; interrupted actions are identified rather than replayed.

Explicit operator token extensions are append-only session authorization records, not campaign-config edits or scoring evidence. `InvestigationState.tokenGrants?` records `{ id, grantedAt, additionalTokens, tokensAtGrant, previousLimit, effectiveLimit, reason }`. The frozen `campaign.config.investigator.maxAgentTokens` remains the base; with no grants it is the effective cap, otherwise the last grant's `effectiveLimit` is authoritative. A grant computes `max(previousLimit, tokensAtGrant) + additionalTokens`, retaining any prior overrun instead of hiding or forgiving it. For example, 4,092,956 cumulative tokens against a 2,000,000 base plus an explicitly authorized 4,000,000-token extension yields an 8,092,956 cap. Consumers do not sum grants onto that effective cap again.

The operator CLI `extend-tokens <campaign> <variant> --tokens 4000000 --reason "..." --request-id <id>` is idempotent by request ID and targets the existing token-stopped investigation. It is not a new paid campaign or baseline. Session identity, actions, spending, Phase 2 clocks, investigation wall time, other budgets, screening/baseline/final counts, and labels remain unchanged. Budget authorization permits additional spending only; it is not human-verified product truth and does not satisfy other exhausted budgets. Mutating operations remain single-coordinator.

`runtimeAnswerLedger.ts` freezes repeated semantic answers in investigator campaigns. Its key binds the semantic question (including coverage and option meanings) to campaign/benchmark, resolved pack, workflows, environment, model/variant, versioned answer policy, and target-source context. Transient variant, replicate, run, and question IDs are provenance, not distinct answer scopes. An exclusive immutable file is bound to a SQLite commit event; later reuse checks its file, input, and answer hashes, remaps selected option IDs, and records a per-run receipt. Unbound, missing, or altered entries fail closed. New questions/contexts can still resolve new answers, and complete decision sets are not fixed. Ledger receipts, question audits, decision-set hashes, and cohort comparisons diagnose those limits; this is neither strict global replay nor verified product truth.

### Diagnostic Qualification Contract

The model adaptively selects 1..20 recorded examples, not a fixed ten-example table or a sample of assumed known errors. Twenty is a safety cap. Each example is qualified as `useful`, `uncertain`, or `not_useful`, with at least one useful or uncertain example. An existing workflow does not imply reuse is correct: `build` can be the right decision. Uncertain examples with `expectedDecision: null` are valid. Human labels are not required, and model qualification never supplies verified labels, new accuracy scores, or LLM truth grading.

The typed `review` schema captures observation/selection rationale and, per unit, requirement understanding, source/code knowledge, evidence citations, limitations, and a discriminating check before the proposed mechanism and falsifier. The coordinator resolves opaque references to bound recorded examples and bounded/redacted source or artifact text. The full prepared payload is archived at the action-local `diagnostic-review.json`, including qualified examples, citation content/integrity and completeness/truncation flags, and `structuralStatus: 'recorded'`. This records structure and provenance, not that a diagnosis is true. Its interpretation remains `unverified_model_judgment`; the review contributes no scores.

The optional `probe` action accepts author-selected `testFiles` plus `review` and the usual hypothesis/rationale; the prompt exposes the typed JSON schema. The selected Vitest test reads `HARNESS_DIAGNOSTIC_INPUT=/harness/diagnostic-input.json`. The JSON fixture is capped at 2 MiB with at most 16 KiB per citation. Candidate imports use the server paths and dependencies actually installed in the pinned test image. Execution is bounded to 300 seconds, uses an immutable test-image digest, has no network or LLM provider access, and mounts no full workflows-source or repository directories. This is a cheap offline fixture path, not full recorded-provider replay or live selected-unit adjudication; the latter is not implemented.

A successful probe result has `{ kind: 'diagnostic_probe', executionPassed: true, providerCalls: 0, imageId, inputHash, testFiles, logPaths, interpretation, diagnosticReview }`. For both probe and `evaluate_primary`, `diagnosticReview` is a compact `{ reviewHash, artifactHash, artifactPath: 'diagnostic-review.json', interpretationStatus: 'unverified_model_judgment' }` receipt. The normalized/redacted model review and complete archived payload have separate hashes. Probe success earns neither passing trusted-test credit nor a primary trial, final measurement, or promotion. The evidence-backed review is required before expensive full-primary screening; a passing probe is not. Full configured tests, exact-patch primary evaluation, and final gates are unchanged.

### Compact Evidence Access

The investigator receives a single deterministically compacted briefing attachment, bounded to 16 KiB initially and 8 KiB on session continuation. Full result bodies remain in unchanged durable trial receipts, not repeated context/history attachments. Omitted fields carry reference availability; missing capture stays unknown. The same session can use eight `harness_evidence` MCP tools: `list_observations`, `compare_trial`, `inspect_unit`, `read_evidence`, `search_source`, `research_shell`, `research_http`, and `research_output`. A second model is optional, not a retrieval prerequisite.

The coordinator's hash-bound invocation manifest registers all available primary, regression/holdout, and target-excluded evidence, including registered prior experiments and legacy controls. Access does not make regression data unseen validation. Opaque references bind observations to their benchmark, arm, replica, label basis, and source policy; excluded source is separately filtered. No tool argument can expand scope or select execution cohorts. Bounded paginated responses expose omissions and provenance, and per-call request/response receipts remain under ignored `.data/`.

## Sources Of Truth

| Data | Authority |
| --- | --- |
| Planner decisions and usage | Collected planner API and S3 artifacts |
| Candidate implementation | Frozen seed SHA plus archived binary patch |
| Expected unit disposition | Human-verified campaign label |
| Unreviewed expected disposition | Persisted blind-judge suggestion |
| Experiment narrative | Generated Markdown with preregistered assumptions, measured evidence, and a conservative conclusion |
| Human narrative context | Separate tracked sidecar; never scoring truth unless saved as a verified label |
| Historical research | Explicit manifest entries verified against pinned file hashes |
| Runtime recovery state | SQLite WAL database |
| Investigator token extension | Explicit operator budget authorization recorded in the session grant ledger; never label truth |
| Live adjudication progress | Latest accepted planner run checkpoint, projected into SQLite |

## Isolation

Each variant has a distinct planner worktree, image tag, Compose project, host ports, DynamoDB table and volume, MinIO bucket and volume, Redis instance, KB volume, and source-cache container filesystem. The environment profile and workflows SHA remain fixed at campaign creation.

Docker builds use the Dockerfile from a clean frozen seed checkout, and stacks use that checkout's Compose definition. Candidate changes are limited to configured `server/src/` and `server/test/` prefixes, so generated patches cannot alter build secrets, Compose mounts, package lifecycle scripts, or teardown targets.

Candidate tests execute from a trusted extension of the Docker builder image with Linux Git, no network, a read-only root filesystem, bounded memory/CPU/PIDs, no Linux capabilities, and only disposable tmpfs writes. `/tmp` permits execution because planner script tests create executable fixtures there; it is destroyed with the container. Generated tests never execute directly on the host checkout.

Research uses a separate operator-built `Dockerfile.research` image, resolved to an immutable image ID per invocation, with no automatic build/pull. Arbitrary shell commands run as non-root with a read-only root, no network, bounded resources, read-only candidate/source/sanitized evidence snapshots, and fresh writable `/scratch` tmpfs. Native edits keep their existing worktree path. Neither worker nor broker receives host credentials or the Docker socket. Brokered `curl`/`research_http` allow only approved public HTTPS GET/HEAD, rechecking DNS and redirects; local APIs are deliberately not proxied. The same local run data is available through typed tools and the sanitized bundle. See [the sandbox contract](src/researchSandbox.md) and [build/smoke commands](scripts/README.md).

The deployment integration test is excluded because the planner's production `.dockerignore` intentionally omits `.github/`, and candidate paths cannot modify deployment, Docker, or workflow files. Type checking and the other server tests remain mandatory.

The harness archives stack logs and S3 objects before invoking graceful planner stop and Compose teardown. Worktrees and patches remain available for inspection; the harness never pushes them.

## Agent Separation

- The strategist receives the campaign goal, hash-verified historical research, prior hypotheses, measured summaries, labels, and failures. It records the assumptions behind each proposed intervention.
- A mutator receives one hypothesis and the genericity constraints. It edits only its disposable planner worktree.
- The blind judge receives requirement-level run facts and read-only access to the frozen workflows source. It does not see the mutation or experiment score.
- After judging and stack teardown, a read-only diagnostician receives a bounded immutable reconstruction with explicit durable, Langfuse, deterministic, model-inference, and not-captured provenance. Its findings remain unverified and cannot affect scoring.
- In default search, the strategist must cite current-parent diagnosis finding IDs. The mutator receives only those selected findings and their cited evidence, counterevidence, limitations, and falsification tests. An opt-in investigator can challenge that diagnosis and preregister a different intervention; its revisions remain unverified.
- The user accepts or replaces judge suggestions in the dashboard. Accepted labels are not overwritten by later agents.

This separation reduces, but cannot eliminate, correlated errors from using one model family for implementation and evaluation.

## Promotion

Primary scoring is lexicographic: verified accuracy, verified errors, provisional accuracy, then provisional errors. Cost and latency remain comparison dimensions rather than correctness weights.

Final evaluation runs the configured repetitions of the primary pack and every holdout; V2 fixes two per cohort. Default search scores deterministic per-unit consensus. Investigator-enabled campaigns score raw-replicate mean accuracy and errors against shared labels, while retaining consensus decisions and agreement as separate descriptive measurements. Normal provisional references come from persisted baseline suggestions, and the excluded arm uses its separate baseline excluded judgment/labels; human verification retains precedence. Primary development trials use the label snapshot pinned in investigator context. Per-benchmark score-basis and cohort-comparison artifacts record references and runtime-context differences. A holdout regression against the current parent blocks promotion. Provider output is stochastic; agreement is not correctness, and repeatedly inspected holdouts are regression data rather than unseen validation.

## Security

- Coordinator child commands use argument arrays rather than host shell interpolation; arbitrary research command strings execute only inside the isolated worker.
- Campaign ZIP hashes are verified before case creation.
- S3 object keys are contained beneath the variant artifact directory.
- Environment files and secrets are not copied into reports.
- Added production lines containing campaign-specific customer/workflow terms are rejected.
- Added privileged environment, network, or process access is rejected before image construction.
- `agent.autoApprove` is opt-in because OpenCode is not an OS sandbox.

The evaluated planner receives the campaign's frozen copy of the repository `.env` so model, source, KB, requirements-advisor, and observability behavior match the selected local setup. Campaigns should use dedicated, short-lived evaluation credentials where practical because generated application code is not a security boundary even after static diff gates.

## Failure Handling

Every state transition emits a durable event. Failed variants retain logs, patches, worktrees, and reports. Stack collection is best effort and teardown runs in `finally`. Campaign limits prevent unbounded automatic search.

Diagnosis failure has its own persisted status and error and never clears measured facts, scores, or artifact-completeness state. Human label edits mark existing diagnoses stale. A stale, missing, or hash-invalid current-parent diagnosis blocks the next round unless the frozen campaign configuration contains the explicit missing-parent opt-out.

Execution failure diagnostics are separate from model-generated diagnosis and standard-result review. A blocked excluded cohort leaves completed standard results reviewable, without implying promotion eligibility. Normalized failures retain allowlisted codes, checkpoint data, and provenance, not raw exception/model messages. For existing failed slots, matching case/run archives may supply legacy codes or data without mutating SQLite or artifacts; absent or unsafe evidence stays unknown. An observed validator rejection is not a verified semantic explanation.

The harness can consume optional versioned candidate-boundary details from a `run.failed` event into `failure.details`. Planner-side emission belongs to a separate future planner commit/PR outside PR47. Only validated IDs/counts and fingerprints of unknown selections are accepted, never raw model output. Exact details absent from old archives are unrecoverable, not inferred from error codes.

An in-flight external process is currently cooperative rather than cancellable. A stop request is observed between experiments and before promotion.

## Live Dashboard Projection

The planner API remains unchanged. `PlannerClient` projects each existing run poll into a small per-variant execution record containing benchmark, replicate, case/run identity, stage, accepted adjudication progress, partial decision counts, and planner questions sent to the harness. Changed projections emit the existing durable variant event, which drives the dashboard SSE refresh.

Live counts are deliberately scoped to one benchmark replicate and labeled as partial measured output. Question successor runs replace the prior snapshot rather than adding to it, because an answered `question` adjudication can be removed and reevaluated. Final ledger decision totals continue to come only from validated replicate consensus.

Planner questions are separate from imported requirements-pack blockers. The experiment question view shows only questions sent directly to the harness and preserves their answers, resolution source, and evidence. Question identity is `(benchmark, replicate, id)`, so a provider-reused ID cannot collapse observations from different executions. Langfuse links use recorded planner case IDs, which already map to trace sessions and `case:<caseId>` tags, without adding planner instrumentation.

There is no live execution archive hydration path. Campaign APIs expose the execution projection persisted on each variant, and the frontend treats absent execution slots as pending. Read-only failure diagnostics may supplement an existing failed slot from matching archived runtime/events; this does not create executions or rewrite historical state.

## Web Console

The frontend is native ES modules under `public/`, with no framework or runtime dependency. A small History API router owns the explicit campaign routes. The HTTP server falls back to `index.html` only for valid GET/HEAD UI routes; `/api` and extension-bearing requests retain normal 404 behavior.

The shell uses a compact collapsible desktop sidebar and an accessible mobile drawer. Overview owns campaign operations and active replicate matrices. Experiments owns the filterable ledger. Lineage renders round columns with dependency connectors and an equivalent list. Experiment detail keeps Summary as its default and adds a Markdown tab beside run, question, target-excluded, and artifact views. The server renders GitHub-style Markdown through an allowlisted sanitizer, shifts report headings below the page title, and attaches stable anchors to original Markdown H1-H3 headings. The browser builds a dynamic "On this page" rail from those anchors; deeper headings do not enter the rail. Raw Markdown remains available separately. Human review is a separate route with one central dirty-draft model; navigation, campaign changes, filters, units, and operations all pass through the same guard. SSE refreshes update persisted facts without replacing the draft.

Variant creation writes the initial report before mutation or evaluation starts. Default search keeps an immutable hypothesis; investigator mode exposes the latest preregistration and retains per-action revisions in its archive. Later refreshes add parent comparisons, protocol-aware normal/excluded measurements, human-label coverage, diagnosis status, and a deterministic conclusion. Investigator reports also record session/action/budget state and distinguish raw-replicate score basis from consensus observations. Missing final facts yield an explicit failed or incomplete conclusion, not a pending or inferred successful result. A lower build count or provisional score is never phrased as verified improvement. Optional human notes are read from a separate sidecar and embedded verbatim without becoming scoring truth.

The Overview investigator section and Investigation detail tab keep agent budgets separate from planner usage. The timeline renders known result fields compactly, leaves unknown results uninterpreted, and loads artifact paths/raw details only on expansion. `investigator.updated` and running-session polling refresh the view while preserving scoped disclosure, scroll, and focus state. Session chat is not a dashboard surface.

Probe rows are explicitly labeled **Offline diagnostic probe** and display execution-only outcomes without test or score credit. Details expose the input hash, image digest, provider-call count, and unverified review receipt; primary action details expose their review receipt too. Full review contents are not automatically fetched: the existing lazy archive listing provides links for inspection. Reports include receipt hashes and artifact locators, never copied full review/source payloads. Non-admitted primary requests show **Not admitted: diagnostic review required** or the recorded action error rather than implying planner execution failed, and all local trial counts exclude `admitted: false` while preserving historical omitted values.

Agent tokens display retained cumulative usage against the last authorized effective cap, with the frozen base as the no-grant fallback. **Operator budget extensions** is a read-only, lazy disclosure showing the base and each grant's date, amount, new cap, prior usage/limit, and reason. Reasons pass through the existing diagnostic redactor and render as text, never HTML. The disclosure uses stable variant/grant identities and the existing live reconciliation helper; no grant button or new input mutation path is introduced. Historical absent grants and unknown usage are not fabricated as zero or as human-reviewed labels.

Failure diagnostics, **Explore evidence**, and **Evidence access** are lazy disclosures, separate from human label review. They preserve PR7 live behavior: stable mounted controls, scroll/focus/disclosures, unsaved drafts, deferred structural updates around open native selects, and last-good content during refresh. Diagnostic copying includes only normalized sanitized fields; missing historical access records are not invented.

Screening matrices use the latest primary action's completed replicate facts first, then its current execution snapshot count, then screening configuration. Action timestamps separate successive trials and prevent stale screening snapshots from appearing as completed final runs. Final matrices keep the complete baseline/final configured slots. Changed defaults do not rewrite archived measurements: legacy trials retain their recorded repetition counts even without the screening config field.

Replicate matrices are configured-slot projections, not lists of observed runs. For each benchmark and replicate number, the view left-joins execution state and final `replicateFacts`/`holdoutReplicateFacts`. Final facts take precedence for planner usage, live execution usage fills the current slot, and aggregate consensus usage is never added again. This keeps primary and holdout planner totals once-per-execution and excludes all harness-agent usage.

## Target-Excluded Protocols

Legacy `dedicated-control-v1` campaigns retain their separately resolved and executed control,
holdout, and excluded artifacts. Missing protocol discriminators always parse as V1, and existing
rows and sidecars are never rewritten.

New `standard-primary-v2` campaigns freeze the target workflow at campaign creation. The primary
pack is resolved once through requirements-agent or a PM-simulation fallback. PM simulation may
inspect the full frozen implementation as private decision context, but only its concise answer and
provenance enter the pack; source citations remain harness-only. The measured ZIP SHA is bound to
the runtime target configuration. Standard primary and excluded cases use those exact bytes;
standard primary is the comparison normal arm and is never copied into a second control measurement.
One normal-arm binding records the two standard case/run identities, and each comparison receipt binds
those cases to the corresponding excluded cases and hash-verified report.

Baseline execution automatically creates and calibrates V2 after the baseline image and standard
artifacts are durable. Normal primary, holdouts, and excluded cohorts start concurrently. A failed
excluded cohort blocks baseline completion or promotion but leaves archived standard facts reusable;
retry reruns only excluded work. Diagnosis and strategist history include the binding as provenance,
not as an independent observation.

## Change History

### 2026-09-08 - Bounded Research And Failure Evidence

Added a compact single briefing, scoped on-demand evidence, isolated research commands, and separate failure diagnostics to reduce repeated context while preserving durable evidence and review authority. Four-hour investigation and two-parallel-replica screening settings are unchanged. No full new campaign was run to establish an improvement; planner event-detail emission remains a separate future change outside PR47.

### 2026-09-08 - Four-Hour Investigation With Parallel Screening

New campaigns now freeze two screening replicas and a four-hour investigation budget. The live runner executes screening replicas in parallel; baseline and final V2 validation retain six parallel cases per candidate. The budget permits multiple sequential revision cycles, not four hours of overhead on a single planner run. Explicit overrides and archived campaign limits remain unchanged.

### 2026-09-08 - Lightweight Full-Primary Screening

The PR47 autonomous run completed one two-replicate screening in approximately 82 minutes. Its provisional accuracy fell from 35.2% to 33.2%; a revised patch passed targeted tests but was not evaluated. The session abandoned at turn 7 with approximately 25 minutes remaining, without finalization or an improvement claim. The initial follow-up used one full-primary screening replicate, superseded by the two-parallel-replica/four-hour defaults above; baseline/final cohorts stayed repeated. See the [aggregate investigation summary](docs/experiments/pr47-autonomous-1/investigation-summary.md); generated records and the archived live configuration remain unchanged.

### 2026-09-05 - Initial UI-first harness

Implemented frozen campaign intake, three-wide agent search, two-run primary and holdout consensus, isolated planner stacks, blind judging, human labels, artifact preservation, generated experiment Markdown, and browser-driven validation. The design favors accuracy and provenance over runtime and model cost.

### 2026-09-06 - Live engineering console

Added persisted per-replicate progress, partial decision telemetry, direct planner-question inspection, case-filtered Langfuse links, and a compact responsive internal-tool interface. Final consensus and human-reviewed truth remain distinct from live planner output.

### 2026-09-06 - Routed research workspace

Replaced the single-page hash dashboard with explicit History API routes, configured replicate matrices, filterable experiment and lineage workspaces, isolated review navigation, once-per-replicate telemetry totals, and safe server-side deep-link fallback. Removed archive hydration from the serving contract.

### 2026-09-06 - Data-backed experiment narratives

Added preregistered assumptions and intervention instructions, parent and three-arm metric summaries, conservative evidence-backed conclusions, hash-verified historical V11-V13c research inputs, preserved human-note sidecars, and an in-page Markdown tab without replacing the existing experiment summary.

### 2026-09-07 - Standard-primary target protocol

Added a versioned target protocol that freezes target identity at campaign creation, reuses one
target-safe primary pack and standard measurement as the comparison control, runs normal, holdout,
and excluded cohorts concurrently, binds comparison case identities, and preserves legacy dedicated
control campaigns without reinterpretation.
