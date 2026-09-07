# AI Native Planner Eval Harness

Local research harness for running agent-generated Phase 2 planner experiments against frozen requirements packs and workflows source.

It is deliberately a one-machine tool: one coordinator process, SQLite state, disposable Git worktrees, isolated Docker Compose projects, and a dependency-free routed web console. It does not alter the planner API and never pushes planner branches.

## What It Does

- Freezes the planner seed, workflows source, primary pack, holdout packs, environment profile, and optional campaign research files.
- Uses GPT-5.6 Sol through OpenCode to propose and implement bounded generic changes.
- Isolates each current mutation from its inherited parent diff and runs a patch-bound hypothesis-compliance review before image build or planner execution.
- Builds and runs up to three isolated planner stacks concurrently.
- Stops each evaluation after Phase 2.
- Collects API output, Docker logs, image metadata, generated patches, and local S3 objects.
- Uses a separate blind LLM session to suggest per-unit expected decisions.
- Resolves imported blocking questions through requirements-agent first, then a concise source-grounded fallback, and records every answer.
- Persists human-reviewed labels independently from model suggestions.
- Reconstructs bounded, cited post-run diagnoses from durable planner/S3 artifacts, optional Langfuse observations, frozen source references, judge evidence, labels, and replicate facts before proposing a planner mutation. Compact funnel aggregates cover every archived adjudication while detailed evidence is stratified across failures, controls, disagreements, and holdouts.
- Generates one Markdown research record per experiment before execution and refreshes it with measured facts, evidence, and a conservative conclusion afterward.
- Preserves optional human-authored context in a separate `docs/experiments/<campaign>/human/<variant>.md` sidecar that report refreshes never overwrite.
- For target-enabled campaigns, resolves one target-safe primary pack and runs two normal-primary, two holdout, and two target-excluded repetitions concurrently. The normal primary is the comparison control; no duplicate control cohort runs.

## Prerequisites

- Node.js 24+
- Docker with Compose and Buildx
- OpenCode with access to `openai/gpt-5.6-sol`
- GitHub CLI authenticated with `repo` and `read:packages` scopes for ephemeral image-build secrets
- Local planner and workflows Git repositories
- An immutable primary requirements ZIP and at least one unrelated holdout ZIP
- A planner environment file containing the same runtime configuration used by the intended cohort

Candidate worktrees do not share host dependency directories. Image builds use the planner Dockerfile and lockfile, and tests execute from the isolated builder image.

## Setup

```bash
npm install
npm run cli -- serve --port 4173
```

Open `http://127.0.0.1:4173` and select **New campaign**. The UI collects and validates the research goal, exact seed revisions, repository paths, environment file, primary ZIP, holdout ZIP, repeat count, search width, and automatic-mode limit. An optional target-excluded workflow freezes protocol V2 at campaign creation and requires exactly two repetitions.

The console uses real History API routes and can be refreshed at any valid deep link:

- `/` and `/campaigns/new`
- `/campaigns/<id>/overview`, `/campaigns/<id>/experiments`, and `/campaigns/<id>/lineage`
- `/campaigns/<id>/experiments/<variant>?tab=summary|markdown|runs|questions|target-excluded|artifacts`
- `/campaigns/<id>/review/<variant>?benchmark=<name>&unit=<key>&filter=<filter>`

The server serves `index.html` only for these GET/HEAD UI paths. API paths and extension-bearing paths never receive the UI fallback.

Initialization copies the environment file, ZIPs, and optional absolute `researchPaths` into the ignored campaign data directory, records their hashes, and uses only those frozen copies afterward. Research is exposed to the diagnostician and strategist as `historical_context_only`; it may inform hypotheses but is never current-run evidence. Environment contents are never copied into reports. If the local planner API requires authentication, expose its token to the harness as `PLANNER_EVAL_API_TOKEN` in that file.

Optional diagnosis-time Langfuse reads use `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` from that frozen campaign environment. Reads are case/run filtered and capped; credentials and authorization headers are never persisted. Missing or failed Langfuse telemetry is recorded as incomplete optional evidence and does not invalidate durable run facts.

All campaign operations after the server starts are available in the UI: create, baseline, retry failed baseline, run a supervised or automatic round, stop, resume, review labels, inspect planner questions and their answers, inspect artifacts, open Langfuse traces, read safely rendered experiment Markdown with a heading-derived section navigator, and promote a candidate. A V2 baseline automatically calibrates its target-excluded guard; later V2 retries rerun only the excluded cohort and reuse archived standard artifacts.

The overview separates live execution from durable experiment results. Each active experiment matrix synthesizes every configured benchmark and replicate slot, then joins persisted execution state and final replicate facts. Completed, current, and pending rows remain visible together; pending measurements use dashes rather than zero. V2 target sections show only excluded executions and identify the standard primary rows as the comparison control. Live decisions are the latest accepted checkpoint and can change after a planner question or successor run.

The experiment ledger supports URL-synchronized lifecycle, round, lineage, result, search, and sort controls. The lineage view uses the same lexicographic score ordering as promotion and keeps verified accuracy, provisional accuracy, agreement, holdout state, cohort drift, latency, and planner tokens separate rather than manufacturing a composite score.

Campaign and experiment descriptions are collapsed by default and have copy actions for reuse. Each observed replicate links to the shared staging Langfuse project with its own `case:<caseId>` filter; experiment-level links include every persisted case.

Timing and usage distinguish end-to-end variant elapsed time, Phase 2 elapsed time, per-replicate wall time, and planner model duration. Planner calls, input/output/total tokens, and cost are summed once per standard primary or holdout replicate from final facts when available, otherwise from live execution state. Target-excluded usage is displayed separately and never added to standard totals. The displayed total-token value is inclusive of reasoning. Strategist, mutator, and judge usage is not included in planner totals.

The CLI remains an optional recovery surface:

```bash
npm run cli -- init --config campaign.example.json
npm run cli -- baseline phase2-source-policy-search
npm run cli -- diagnose phase2-source-policy-search phase2-source-policy-search-v000
npm run cli -- round phase2-source-policy-search
npm run cli -- promote phase2-source-policy-search phase2-source-policy-search-v001
npm run cli -- auto phase2-source-policy-search
```

## Supervised And Automatic Modes

`supervised` runs one three-wide round and waits for promotion in the dashboard.

`automatic` repeatedly selects the strongest primary result and makes it the next parent only when every holdout remains non-regressing. It stops at `maxVariants`, after the configured number of rounds without improvement, or after a stop request. Replicates use a separate bounded concurrency, defaulting to two per planner stack.

OpenCode permissions remain authoritative. Set `agent.autoApprove` only when you accept unattended tool use in disposable worktrees. The mutator is instructed not to commit, push, alter Git configuration, or run Docker; the coordinator owns those operations.

For generated variants, the inherited parent state is staged before mutation so `mutation.patch` contains only the current treatment while `variant.patch` remains the cumulative candidate diff. A separate read-only agent checks that treatment against the selected generic intervention and falsification test. The structured verdict is hash-bound and explicitly `unverified_model_judgment`; `uncertain`, missing intervention behavior, missing required regression coverage, no-op mutations, or reviewer-side input changes fail closed before expensive execution.

Generated tests run in a networkless, read-only, resource-bounded Docker builder container rather than on the host. Planner stacks receive the campaign's immutable copy of the repository `.env`; the harness overrides only isolated infrastructure names and ports, frozen source identity, image identity, and an approved GitHub CLI token fallback when source credentials are absent.

## Scoring Semantics

Decision counts are observations, not fitness.

- Verified accuracy uses only labels saved by a person in the dashboard.
- Live build/reuse/extend counts are partial measured planner output for one replicate, not correctness or variant consensus.
- Provisional accuracy uses persisted LLM suggestions for still-unreviewed units.
- Existing verified labels always outrank new model output.
- Candidate and baseline requirement-unit/pin drift is recorded as a cohort mismatch.
- Every run must contain nonempty units, complete adjudications, runtime pins, model usage, semantics, and rationale before it is considered meaningful.
- Lower cost and latency are visible but do not override correctness.
- Model-generated diagnosis is shown separately and never contributes to numeric scoring. A next round requires a current, hash-verified parent diagnosis unless the campaign explicitly sets `diagnosis.allowMissingParent` to `true`. Use `npm run cli -- diagnose <campaign-id> <variant-id>` to backfill or retry an archived variant; the equivalent API is `POST /api/campaigns/<campaign-id>/variants/<variant-id>/diagnose`.
- Hypothesis-compliance verdicts gate execution but never contribute to numeric scoring or become verified evidence. Failed and operationally incomplete reviews remain visible in experiment history.

The blind judge sees the exact frozen workflows checkout and the selected run facts. It does not receive the candidate hypothesis or planner patch.

Blocking requirements questions are resolved once per campaign before evaluation. The harness calls the configured online requirements-agent first. For V2, if requirements-agent raises or cannot answer, a PM-simulation session may privately inspect the full frozen implementation and return a concise product or operational decision. Only that brief answer and PM-simulation provenance enter the shared requirements pack; source citations remain harness-only audit evidence. The answer is rejected if it exposes the target identity, path, symbols, capability IDs, or implementation narration. Normal and excluded cases then use the exact same resolved ZIP. Original/resolved hashes, question text, answer, evidence, and per-experiment request/reuse counts are persisted and shown in Markdown.

## Data Layout

```text
.data/
  harness.sqlite                 durable coordinator state
  campaigns/<id>/                frozen config, goal, agent history
    environment.env              mode-0600 frozen runtime profile
    packs/                       immutable benchmark ZIP copies
    research/                    hash-pinned optional research copies and manifest
  worktrees/<id>/                planner candidates and frozen workflows source
  artifacts/<id>/<variant>/      raw output, patches, logs, S3 objects
    mutation.patch               current treatment relative to the inherited parent
    hypothesis-compliance/       immutable prompts, logs, and patch-bound verdict
    diagnosis/                   immutable bounded inputs, manifests, optional telemetry, prompts, logs, and results
docs/experiments/<id>/           trackable Markdown facts and conclusions
  human/<variant>.md             optional human context, never generator-owned
docs/experiments/history/        hash-pinned historical research materials
```

Raw packs, source excerpts, model events, and logs stay in ignored `.data/`. Experiment Markdown contains preregistered assumptions and instructions, hashes, parent metrics, measured aggregates, interpretation provenance, target protocol and normal-arm binding, a conservative conclusion, and artifact references without copying raw source text. Campaign-configured research is copied and hash-pinned at initialization. Shared historical strategist context remains separately enumerated by `docs/experiments/history/manifest.json`; every imported file is verified by SHA-256 before use.

## Verification

```bash
npm run check
npm run build
```

The test suite covers persistence, scoring precedence, cohort drift, command argument safety, and the complete planner HTTP sequence through Phase 2 without touching Phase 3.

## Current Operational Limits

- A stop request prevents the next iteration and automatic promotion, but does not terminate a model call already in flight.
- Two repetitions are the default. Increase `evaluation.replicates` for confirmation campaigns when decision agreement remains weak.
- New campaigns reserve twelve hours of aggregate Phase 2 model duration so V13 cohorts up to 144 requirement units fit the five-call, five-minute per-unit envelope.
- V2 target-enabled campaigns fix the repetition count at two. With one holdout, all three cohorts start together for six planner cases per variant; a three-wide round may therefore sustain up to eighteen concurrent provider operations across isolated stacks.
- Campaign execution is single-coordinator. Do not run dashboard and mutating CLI commands against the same campaign simultaneously.
- Hypothesis compliance is a conservative same-model semantic review. It reduces obviously unfaithful experiments but may reject a valid mutation and is not independent correctness evidence.
- Node currently labels built-in SQLite as experimental; all state is also represented by raw artifacts and generated Markdown.
- Live execution projections must be persisted in SQLite. The server does not hydrate missing execution state from archived artifacts.
