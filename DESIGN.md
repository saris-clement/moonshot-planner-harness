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
| Live adjudication progress | Latest accepted planner run checkpoint, projected into SQLite |

## Isolation

Each variant has a distinct planner worktree, image tag, Compose project, host ports, DynamoDB table and volume, MinIO bucket and volume, Redis instance, KB volume, and source-cache container filesystem. The environment profile and workflows SHA remain fixed at campaign creation.

Docker builds use the Dockerfile from a clean frozen seed checkout, and stacks use that checkout's Compose definition. Candidate changes are limited to configured `server/src/` and `server/test/` prefixes, so generated patches cannot alter build secrets, Compose mounts, package lifecycle scripts, or teardown targets.

Candidate tests execute from a trusted extension of the Docker builder image with Linux Git, no network, a read-only root filesystem, bounded memory/CPU/PIDs, no Linux capabilities, and only disposable tmpfs writes. `/tmp` permits execution because planner script tests create executable fixtures there; it is destroyed with the container. Generated tests never execute directly on the host checkout.

The deployment integration test is excluded because the planner's production `.dockerignore` intentionally omits `.github/`, and candidate paths cannot modify deployment, Docker, or workflow files. Type checking and the other server tests remain mandatory.

The harness archives stack logs and S3 objects before invoking graceful planner stop and Compose teardown. Worktrees and patches remain available for inspection; the harness never pushes them.

## Agent Separation

- The strategist receives the campaign goal, hash-verified historical research, prior hypotheses, measured summaries, labels, and failures. It records the assumptions behind each proposed intervention.
- A mutator receives one hypothesis and the genericity constraints. It edits only its disposable planner worktree.
- The blind judge receives requirement-level run facts and read-only access to the frozen workflows source. It does not see the mutation or experiment score.
- After judging and stack teardown, a read-only diagnostician receives a bounded immutable reconstruction with explicit durable, Langfuse, deterministic, model-inference, and not-captured provenance. Its findings remain unverified and cannot affect scoring.
- The strategist must cite current-parent diagnosis finding IDs. The mutator receives only those selected findings and their cited evidence, counterevidence, limitations, and falsification tests.
- The user accepts or replaces judge suggestions in the dashboard. Accepted labels are not overwritten by later agents.

This separation reduces, but cannot eliminate, correlated errors from using one model family for implementation and evaluation.

## Promotion

Primary scoring is lexicographic: verified accuracy, verified errors, provisional accuracy, then provisional errors. Cost and latency remain comparison dimensions rather than correctness weights.

Every variant runs two repetitions of the primary pack and every unrelated holdout in parallel. Scoring uses a deterministic per-unit consensus while preserving all individual run facts and total cost. A holdout regression against the current parent blocks promotion. Provider output is stochastic, so decision agreement remains a first-class result rather than being hidden by the consensus.

## Security

- Child commands use argument arrays rather than shell interpolation.
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

An in-flight external process is currently cooperative rather than cancellable. A stop request is observed between experiments and before promotion.

## Live Dashboard Projection

The planner API remains unchanged. `PlannerClient` projects each existing run poll into a small per-variant execution record containing benchmark, replicate, case/run identity, stage, accepted adjudication progress, partial decision counts, and planner questions sent to the harness. Changed projections emit the existing durable variant event, which drives the dashboard SSE refresh.

Live counts are deliberately scoped to one benchmark replicate and labeled as partial measured output. Question successor runs replace the prior snapshot rather than adding to it, because an answered `question` adjudication can be removed and reevaluated. Final ledger decision totals continue to come only from validated replicate consensus.

Planner questions are separate from imported requirements-pack blockers. The experiment question view shows only questions sent directly to the harness and preserves their answers, resolution source, and evidence. Question identity is `(benchmark, replicate, id)`, so a provider-reused ID cannot collapse observations from different executions. Langfuse links use recorded planner case IDs, which already map to trace sessions and `case:<caseId>` tags, without adding planner instrumentation.

There is no archive hydration path. Campaign APIs expose the execution projection persisted on each variant, and the frontend treats absent execution slots as pending.

## Web Console

The frontend is native ES modules under `public/`, with no framework or runtime dependency. A small History API router owns the explicit campaign routes. The HTTP server falls back to `index.html` only for valid GET/HEAD UI routes; `/api` and extension-bearing requests retain normal 404 behavior.

The shell uses a compact collapsible desktop sidebar and an accessible mobile drawer. Overview owns campaign operations and active replicate matrices. Experiments owns the filterable ledger. Lineage renders round columns with dependency connectors and an equivalent list. Experiment detail keeps Summary as its default and adds a Markdown tab beside run, question, target-excluded, and artifact views. The server renders GitHub-style Markdown through an allowlisted sanitizer, shifts report headings below the page title, and attaches stable anchors to original Markdown H1-H3 headings. The browser builds a dynamic "On this page" rail from those anchors; deeper headings do not enter the rail. Raw Markdown remains available separately. Human review is a separate route with one central dirty-draft model; navigation, campaign changes, filters, units, and operations all pass through the same guard. SSE refreshes update persisted facts without replacing the draft.

Variant creation writes the initial report before mutation or evaluation starts. The immutable hypothesis record supplies assumptions, selected parent diagnosis findings, instructions, expected impact, and risk. Later refreshes add parent comparisons, protocol-aware normal/excluded measurements, human-label coverage, diagnosis status, and a deterministic conclusion. A lower build count or provisional score is never phrased as verified improvement. Optional human notes are read from a separate sidecar and embedded verbatim without becoming scoring truth.

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
