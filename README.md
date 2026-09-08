# AI Native Planner Eval Harness

Local research harness for running agent-generated Phase 2 planner experiments against frozen requirements packs and workflows source.

It is deliberately a one-machine tool: one coordinator process, SQLite state, disposable Git worktrees, isolated Docker Compose projects, and a dependency-free routed web console. It does not alter the planner API and never pushes planner branches.

## What It Does

- Freezes the planner seed, workflows source, primary pack, holdout packs, environment profile, and optional campaign research files.
- Uses GPT-5.6 Sol through OpenCode to propose and implement bounded generic changes.
- Isolates each current mutation from its inherited parent diff. Default search reviews compliance before execution; opt-in investigators test and measure development trials before final semantic review.
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
- `/campaigns/<id>/experiments/<variant>?tab=summary|investigation|markdown|runs|questions|target-excluded|artifacts`
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

`automatic` repeatedly selects the strongest primary result and makes it the next parent only when every holdout remains non-regressing. In default strategist/mutator search, a structured semantic compliance failure receives at most `limits.hypothesisComplianceRepairAttempts` repairs on the same variant and worktree (default one). If a whole batch exhausts only semantic/no-op repairs and hypothesis budget remains, automatic mode generates a replacement batch. That search stops at `maxVariants`, after the configured number of rounds without improvement, after mixed operational failures, or after a stop request. Replicates use a separate bounded concurrency, defaulting to two per planner stack.

OpenCode permissions remain authoritative. Set `agent.autoApprove` only when you accept unattended tool use in disposable worktrees. The mutator is instructed not to commit, push, alter Git configuration, or run Docker; the coordinator owns those operations.

In default strategist/mutator search, the inherited parent state is staged before mutation so `mutation.patch` contains only the current treatment while `variant.patch` remains the cumulative candidate diff. Bounded context files are copied temporarily into each pure agent worktree, hash-checked after use, and removed before diff capture. A separate read-only agent checks that treatment against the selected generic intervention, locally testable regression boundaries, and falsification test. Compliance V2 requires both the intervention and code regression to pass. It may mark repeated frozen-cohort accuracy, recall, or stability measurements as `deferred_to_evaluation` because the coordinator performs those full runs after preflight; this does not claim the hypothesis succeeded. A failed semantic verdict is fed back once to the same mutator without changing the hypothesis or consuming another variant ID. Every attempt retains immutable treatment, candidate, context, verdict, and hash provenance. The structured verdict is hash-bound and explicitly `unverified_model_judgment`; `uncertain`, exhausted intervention gaps, missing regression coverage, unchanged repairs, or agent-side input changes fail closed before expensive execution.

Generated tests run in a networkless, read-only, resource-bounded Docker builder container rather than on the host. Planner stacks receive the campaign's immutable copy of the repository `.env`; the harness overrides only isolated infrastructure names and ports, frozen source identity, image identity, and an approved GitHub CLI token fallback when source credentials are absent.

## Autonomous Investigator

CLI/API campaigns opt in with `investigator.enabled: true`; omission or `false` preserves default strategist/mutator search. `campaign.example.json` explicitly opts in. New UI campaigns enable the investigator by default, with an opt-out checkbox and advanced budgets. This is independent of `mode: supervised|automatic` and does not enable unattended OpenCode permissions.

Each candidate keeps one investigator session and a revision/action ledger. The agent may challenge the parent diagnosis, revise its hypothesis, request trusted targeted tests, request primary development evaluations, finalize, or abandon. A primary evaluation requires passing tests on the exact patch. Finalization requires an evaluated unchanged patch and matching preregistered hypothesis, then full configured tests and semantic compliance review. Final primary, holdout, and configured target-excluded cohorts run afterward; a finalized session alone is not a completed experiment or promotion.

`investigator.primaryReplicates` controls **full-primary** screening: integer 1 through 3, default 2 for new campaigns, running in parallel. This controls repetitions, not requirement coverage. Baseline and final evaluation still use `evaluation.replicates`, unchanged at 2 for V2. The advanced UI control is independent of those final repetitions. Provisional labels are acceptable for screening and finalization; human-reviewed labels are not a prerequisite for either. Semantic compliance review is an unverified model check, not a human-review gate. Do not present provisional scores as verified correctness.

Defaults per investigator are 12 turns, 3 primary evaluation attempts, 14,400,000 ms (4 hours) wall time, and 2,000,000 agent tokens. Wall time covers the whole investigate/edit/test/screen/revise loop, not a single planner run; baseline and final validation are outside that budget. Failed primary attempts count toward the trial budget. New-campaign initialization freezes the two-replica default; existing explicit limits and historical omitted screening values retain their previous behavior. Stop/resume preserves the session and action history; interrupted actions are marked rather than silently replayed. Unknown usage remains unknown, not zero.

Runs shows primary-only screening slots before finalization and the full configured cohorts afterward. Archived trial results determine their recorded replicate count; live snapshots determine observed counts before configuration is used as a fallback. A historical two-replicate trial is never reinterpreted as one because the new field was absent. For one replicate, agreement is not measured, even if the stored consensus helper yields 100%; a single observation cannot establish repeatability.

Overview shows session state and budgets; the Investigation tab shows hypothesis revisions, action outcomes, trial scores, and lazy artifact/log links. Markdown records the same operational evidence without copying session chat or raw trial output. Agent interpretations, passing tests, provisional labels, and human-reviewed truth remain distinct. The runtime answer ledger freezes repeated semantic answers within a pinned context, not every decision context or complete decision set; matching pack/source pins alone do not establish strict replay.

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

Investigator-enabled campaigns score accuracy and errors as raw-replicate means, not majority-consensus accuracy. Normal scoring reuses persisted provisional labels established by the baseline; excluded scoring uses its separate baseline excluded judgment and labels. Human verification retains precedence. Primary trials use a hash-bound label snapshot and rescore the parent replicates against that same reference. Consensus decisions and agreement remain descriptive. `score-basis.json`, `cohort-comparison.json`, and runtime question audits identify scoring references and context differences; fresh candidate judgments do not replace existing baseline suggestions.

Imported blocking requirements questions are resolved once per campaign before evaluation. The harness calls the configured online requirements-agent first. For V2, if requirements-agent raises or cannot answer, a PM-simulation session may privately inspect the full frozen implementation and return a concise product or operational decision. Only that brief answer and PM-simulation provenance enter the shared requirements pack; source citations remain harness-only audit evidence. The answer is rejected if it exposes the target identity, path, symbols, capability IDs, or implementation narration. Normal and excluded cases then use the exact same resolved ZIP. Original/resolved hashes, question text, answer, evidence, and per-experiment request/reuse counts are persisted and shown in Markdown.

Planner runtime questions remain separate. For investigator campaigns, `runtimeAnswerLedger.ts` commits an immutable answer for each semantic question and pinned context: campaign, benchmark, resolved pack, workflows, environment, model/variant, answer-policy version, and target-source policy. The question key includes response kind, prompt, type, owner, coverage IDs, and option meanings, not transient run/question IDs. Repeated matching questions reuse the committed answer across executions; selected options are remapped to current IDs. Each reuse checks file/input/answer hashes against the SQLite commitment and writes a per-run receipt. Missing, modified, or unbound entries fail closed. New semantic questions or contexts can add entries, and planner decision sets can still vary. This is scoped answer reuse, not complete replay or human-verified product truth.

## Data Layout

```text
.data/
  harness.sqlite                 durable coordinator state
  campaigns/<id>/                frozen config, goal, agent history
    environment.env              mode-0600 frozen runtime profile
    packs/                       immutable benchmark ZIP copies
    research/                    hash-pinned optional research copies and manifest
    runtime-answer-ledger/       immutable scoped answers bound to SQLite commit events
  worktrees/<id>/                planner candidates and frozen workflows source
  artifacts/<id>/<variant>/      raw output, patches, logs, S3 objects
    mutation.patch               current treatment relative to the inherited parent
    investigator-context.json    hash-bound advisory context and score-reference locator
    investigator-reference.json  hash-bound parent facts/replicates and trial labels
    investigation/action-NNN/    trial requests, pins, patches, receipts/failures, logs, and collected run artifacts
    hypothesis-compliance/       immutable prompts, logs, and patch-bound verdict
    diagnosis/                   immutable bounded inputs, manifests, optional telemetry, prompts, logs, and results
docs/experiments/<id>/           trackable Markdown facts and conclusions
  human/<variant>.md             optional human context, never generator-owned
docs/experiments/history/        hash-pinned historical research materials
```

Raw packs, source excerpts, model events, and logs stay in ignored `.data/`. Experiment Markdown contains preregistered assumptions and instructions, hashes, parent metrics, measured aggregates, interpretation provenance, investigator sessions/actions/budgets when enabled, score basis, target protocol and normal-arm binding, a conservative conclusion, and artifact references without copying raw source text. Failed runs with no final facts are reported as failed; other absent final measurements remain incomplete, never inferred from successful development trials. Campaign-configured research is copied and hash-pinned at initialization. Shared historical strategist context remains separately enumerated by `docs/experiments/history/manifest.json`; every imported file is verified by SHA-256 before use.

## Verification

```bash
npm run check
npm run build
```

The test suite covers persistence, scoring precedence, cohort drift, command argument safety, and the complete planner HTTP sequence through Phase 2 without touching Phase 3.

### Opt-In Live Check

Ordinary `npm run check` uses isolated fixtures and mocked live-runner tests; it does not start a live evaluation. For a **new, explicitly authorized** live run on an unused port:

```bash
npm run test:live -- --live --source-config /absolute/path/to/campaign.json --id new-live-campaign --port 4174
```

`--port 4174` serves the dashboard from the same sole coordinator and database while it runs initialization, a fresh baseline, and one automatic investigator candidate. The dashboard remains open after the sequence finishes for inspection; no second `serve` process is needed. Without `--port`, the runner closes its database on completion. The runner exclusively claims a fresh `.data/live/<id>/` and never resumes or overwrites an existing run. Do not repeat this command or start another coordinator against an active run, including the existing dashboard on port 4174. See [the live-runner notes](scripts/README.md) for budgets, stopping conditions, and artifact locations.

## Current Operational Limits

The [PR47 live investigation summary](docs/experiments/pr47-autonomous-1/investigation-summary.md) records an approximately 82-minute, sequential two-replicate primary trial with provisional accuracy falling from 35.2% to 33.2%. The revised patch passed 103 targeted tests but was not evaluated; the agent abandoned at turn 7 with about 25 minutes left. No improvement or final candidate outcome was established. The initial follow-up used single-replica screening; current new-campaign defaults instead provide two parallel replicas and a four-hour investigation budget. The archived campaign's configuration and measurements remain unchanged.

- A stop request prevents the next iteration and automatic promotion, but does not terminate a model call already in flight.
- New full-primary investigator screening defaults to two parallel replicas. Baseline/final repetitions remain separately configured; V2 requires two. An explicit single-replica override cannot measure agreement.
- New campaigns reserve twelve hours of aggregate Phase 2 model duration so V13 cohorts up to 144 requirement units fit the five-call, five-minute per-unit envelope.
- V2 target-enabled campaigns fix baseline/final repetition counts at two. With one holdout, those three final cohorts start together for six planner cases per variant; a three-wide round may therefore sustain up to eighteen concurrent provider operations across isolated stacks. Development screening runs only the primary pack with its separate `investigator.primaryReplicates` count.
- Campaign execution is single-coordinator. Do not run dashboard and mutating CLI commands against the same campaign simultaneously.
- Hypothesis compliance is a conservative same-model semantic review. It reduces obviously unfaithful experiments but may reject a valid mutation and is not independent correctness evidence.
- Node currently labels built-in SQLite as experimental; all state is also represented by raw artifacts and generated Markdown.
- Live execution projections must be persisted in SQLite. The server does not hydrate missing execution state from archived artifacts.
