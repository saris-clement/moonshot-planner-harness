# AI Native Planner Eval Harness

Local research harness for running agent-generated Phase 2 planner experiments against frozen requirements packs and workflows source.

It is deliberately a one-machine tool: one coordinator process, SQLite state, disposable Git worktrees, isolated Docker Compose projects, and a dependency-free routed web console. It does not alter the planner API and never pushes planner branches.

## What It Does

- Freezes the planner seed, workflows source, primary pack, holdout packs, and environment profile.
- Uses GPT-5.6 Sol through OpenCode to propose and implement bounded generic changes.
- Builds and runs up to three isolated planner stacks concurrently.
- Stops each evaluation after Phase 2.
- Collects API output, Docker logs, image metadata, generated patches, and local S3 objects.
- Uses a separate blind LLM session to suggest per-unit expected decisions.
- Resolves imported blocking questions through requirements-agent first, then a concise source-grounded fallback, and records every answer.
- Persists human-reviewed labels independently from model suggestions.
- Reconstructs bounded, cited post-run diagnoses from durable planner/S3 artifacts, optional Langfuse observations, frozen source references, judge evidence, labels, and replicate facts before proposing a planner mutation.
- Generates one Markdown record per experiment under `docs/experiments/<campaign>/`.
- Runs two primary and two holdout repetitions in parallel for every variant, then scores their unit-level consensus.

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

Open `http://127.0.0.1:4173` and select **New campaign**. The UI collects and validates the research goal, exact seed revisions, repository paths, environment file, primary ZIP, holdout ZIP, repeat count, search width, and automatic-mode limit.

The console uses real History API routes and can be refreshed at any valid deep link:

- `/` and `/campaigns/new`
- `/campaigns/<id>/overview`, `/campaigns/<id>/experiments`, and `/campaigns/<id>/lineage`
- `/campaigns/<id>/experiments/<variant>?tab=summary|runs|questions|artifacts`
- `/campaigns/<id>/review/<variant>?benchmark=<name>&unit=<key>&filter=<filter>`

The server serves `index.html` only for these GET/HEAD UI paths. API paths and extension-bearing paths never receive the UI fallback.

Initialization copies the environment file and both ZIPs into the ignored campaign data directory, records their hashes, and uses only those frozen copies afterward. Environment contents are never copied into reports. If the local planner API requires authentication, expose its token to the harness as `PLANNER_EVAL_API_TOKEN` in that file.

Optional diagnosis-time Langfuse reads use `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` from that frozen campaign environment. Reads are case/run filtered and capped; credentials and authorization headers are never persisted. Missing or failed Langfuse telemetry is recorded as incomplete optional evidence and does not invalidate durable run facts.

All campaign operations after the server starts are available in the UI: create, baseline, retry failed baseline, run a supervised or automatic round, stop, resume, review labels, inspect planner questions and their answers, inspect artifacts, open Langfuse traces, open Markdown, and promote a candidate.

The overview separates live execution from durable experiment results. Each active experiment matrix synthesizes every configured benchmark and replicate slot, then joins persisted execution state and final replicate facts. Completed, current, and pending rows remain visible together; pending measurements use dashes rather than zero. Live decisions are the latest accepted checkpoint and can change after a planner question or successor run.

The experiment ledger supports URL-synchronized lifecycle, round, lineage, result, search, and sort controls. The lineage view uses the same lexicographic score ordering as promotion and keeps verified accuracy, provisional accuracy, agreement, holdout state, cohort drift, latency, and planner tokens separate rather than manufacturing a composite score.

Campaign and experiment descriptions are collapsed by default and have copy actions for reuse. Each observed replicate links to the shared staging Langfuse project with its own `case:<caseId>` filter; experiment-level links include every persisted case.

Timing and usage distinguish end-to-end variant elapsed time, Phase 2 elapsed time, per-replicate wall time, and planner model duration. Planner calls, input/output/total tokens, and cost are summed once per primary or holdout replicate from final facts when available, otherwise from live execution state. The displayed total-token value is inclusive of reasoning. Strategist, mutator, and judge usage is not included in planner totals.

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

The blind judge sees the exact frozen workflows checkout and the selected run facts. It does not receive the candidate hypothesis or planner patch.

Blocking requirements questions are resolved once per campaign before evaluation. The harness calls the configured online requirements-agent first. If it raises or cannot answer, a separate GPT-5.6 Sol session inspects the frozen workflows source. The resulting derived evaluation pack, original/resolved hashes, question text, answer, evidence, and per-experiment request/reuse counts are persisted and shown in Markdown.

## Data Layout

```text
.data/
  harness.sqlite                 durable coordinator state
  campaigns/<id>/                frozen config, goal, agent history
    environment.env              mode-0600 frozen runtime profile
    packs/                       immutable benchmark ZIP copies
  worktrees/<id>/                planner candidates and frozen workflows source
  artifacts/<id>/<variant>/      raw output, patches, logs, S3 objects
    diagnosis/                   immutable bounded inputs, manifests, optional telemetry, prompts, logs, and results
docs/experiments/<id>/           trackable Markdown facts and conclusions
```

Raw packs, source excerpts, model events, and logs stay in ignored `.data/`. Experiment Markdown contains hashes, aggregates, interpretation provenance, and artifact references without copying raw source text.

## Verification

```bash
npm run check
npm run build
```

The test suite covers persistence, scoring precedence, cohort drift, command argument safety, and the complete planner HTTP sequence through Phase 2 without touching Phase 3.

## Current Operational Limits

- A stop request prevents the next iteration and automatic promotion, but does not terminate a model call already in flight.
- Two repetitions are the default. Increase `evaluation.replicates` for confirmation campaigns when decision agreement remains weak.
- Campaign execution is single-coordinator. Do not run dashboard and mutating CLI commands against the same campaign simultaneously.
- Node currently labels built-in SQLite as experimental; all state is also represented by raw artifacts and generated Markdown.
- Live execution projections must be persisted in SQLite. The server does not hydrate missing execution state from archived artifacts.
