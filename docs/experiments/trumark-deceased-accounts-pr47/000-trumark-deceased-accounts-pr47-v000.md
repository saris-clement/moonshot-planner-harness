# Unmodified campaign seed

## Goal

Improve the generic accuracy, evidence quality, and repeatability of Phase 2 requirement-unit adjudication.

In normal target-present runs, the frozen workflows source already contains substantial behavior matching the reviewed requirements, yet the planner still classifies many units as build. The objective is to reduce false build and false extend decisions by improving generic source discovery, evidence hydration, evidence retention and composition, callable-boundary verification, and model interpretation.

There is no target build count. A lower build count is not itself an improvement. Build remains correct when required behavior is genuinely absent. Extend remains correct for partial, private, or incomplete implementations. Reuse requires complete, eligible, source-backed behavior through a verified callable or registered boundary. Explicit binding exclusions should remain defer, and unresolved requirements should remain question rather than being forced into another disposition.

Treat this campaign as a new campaign-local baseline. Freeze the exact requirements packs, planner revision, workflows revision, environment, model, prompts, budgets, source policy, and knowledge snapshot. Previous v14 and PR45 results are historical context only and must not be treated as directly comparable scores. Establish repeated baseline measurements before generating mutations.

Freeze the target workflow identity at campaign creation. Resolve the primary requirements pack once using target-safe question resolution. The normal target-present and target-excluded executions must use the exact same resolved pack bytes and SHA.

Evaluate every baseline and candidate through three safeguards:

1. Run the deceased-account primary benchmark with the target implementation present. This normal primary run is also the comparison control. Measure requirement-level accuracy, evidence quality, decision agreement, source references, question handling, and run stability. Do not execute a redundant second control cohort.

2. Run an unrelated workflow holdout with identical planner policy. Reject candidates that improve the primary benchmark by introducing customer, workflow, requirement-text, capability-ID, alias, or fixed-source-path specialization, or that otherwise regress the holdout.

3. Run the deceased-account target-excluded counterfactual using the exact same frozen and resolved primary requirement pack after removing the target implementation and its direct registration references. The result must contain no target leakage and must continue to make evidence-backed greenfield decisions. It must not claim reuse or extension from the removed target source, but may still reuse or extend independently eligible shared or other-workflow source. Its build rate is a diagnostic and regression guard, not a fitness reward; a high build count alone does not prove greenfield correctness.

Measured planner output is authoritative for what the planner actually did. Human-reviewed labels are authority for correctness. These remain distinct. Blind-judge suggestions, diagnoses, and strategist hypotheses are unverified model interpretations. Use provisional scores only to screen candidates. Before claiming improvement, human-review the changed units and a fixed representative sample covering build, reuse, extend, defer, and question decisions where present.

Each mutation must address one observed, source-backed causal mechanism from the current parent diagnosis and remain bounded and attributable. Preserve supporting evidence, counterevidence, limitations, and a falsification test. Prior retrieval, evidence-composition, and boundary-visibility hypotheses are research leads, not established causes.

Promote a candidate only when requirement-level reviewed accuracy improves, repeated runs remain sufficiently stable, the unrelated holdout does not regress, the target-excluded guard remains valid, and all immutable pins and cohorts match. Record regressions, uncertainties, costs, latency, token usage, and decision changes even when the hypothesis fails.

The selected seed includes PR47’s six-slot execution capacity only to improve evaluation throughput. Capacity is not the experimental fitness axis. The primary, holdout, and target-excluded cohorts may execute concurrently, but faster execution must not outrank correctness, alter budgets or cohorts, weaken persistence and transcript integrity, or be interpreted as evidence of better adjudication.

## Base Assumptions

These assumptions were recorded before execution. They are harness-authored baseline assumptions, not measured facts.

- Repeated runs with frozen inputs provide a campaign-local behavioral baseline.
- The unmodified seed is a reference observation, not evidence that its decisions are correct.

## Observed Issues

This is a baseline observation with no parent diagnosis. No causal issue is asserted.

## Planned Change

The baseline plan below is harness-authored. It is recorded before execution so the result can be evaluated against the original intervention.

> Measure the selected seed revision before applying an experimental mutation.

Implementation instructions:
> Do not modify the planner.

Expected impact: Establish reproducible primary and holdout facts for this campaign.

Risk: Provider nondeterminism means one screening run is descriptive rather than conclusive.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr47 |
| Variant | trumark-deceased-accounts-pr47-v000 |
| Parent | none |
| Round | 0 |
| Status | failed |
| Planner seed | `a24baf79e777b07a3b55d027dc5ea5a8701e6af8` |
| Workflows source | `304c0857c9b5aff3076de504a52ee364bd279b0d` |
| Environment | `sha256:6ccd5aaf328ce4570838ef78879a4b2636fe76436f89fd3610a549a9c8fabf73` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47/trumark-deceased-accounts-pr47-v000/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr47-0c9664b05e-0` |
| Artifact collection | complete |

## Baseline Metrics

No parent metrics exist. This experiment establishes a campaign-local baseline.

## Actual Facts

| Decision | Count |
| --- | ---: |
| unavailable | unavailable |

| Metric | Value |
| --- | ---: |
| Requirement units | unavailable |
| Replicates | unavailable |
| Unanimous unit decisions | unavailable |
| Empty shortlists | unavailable |
| Candidate occurrences | unavailable |
| Discovered evidence | unavailable |
| Selected source references | unavailable |
| Model calls | unavailable |
| Total tokens | unavailable |
| Cost USD | unavailable |
| Model duration ms | unavailable |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 0 |
| Provisional errors | 0 |
| Provisional accuracy | unscored |
| Persisted labels | 0 |
| Cohort pin mismatches | none |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard primary (comparison control) | reference (standard measurement) | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| Target-excluded | failed | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

The standard primary measurement is referenced as comparison normal. No additional control execution was run. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `pending`

No measured conclusion is available while the experiment is failed.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> No blind-judge result is available.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `not_started`

Input hash: unavailable

Result hash: unavailable

> No model-generated diagnosis is available.

No diagnosis findings are available.

## Requirements Questions

### deceased-account

| Metric | Count |
| --- | ---: |
| Blocking questions | 1 |
| Requirements-agent requests | 1 |
| Requirements-agent answers | 0 |
| Source fallback answers | 1 |
| Reused campaign answers | 0 |
| Planner questions | 0 |
| Planner requirements-agent requests | 0 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

#### 01M1Q2R1VHAKDZHSQ7TQDBA8B2

Resolution: `source_fallback`

Question:
> What is the approved Symitar connection endpoint/environment (e.g., production vs. test region) and the specific read-only credential scope (member, death, deposit, non-mortgage consumer-loan, Visa external-loan, and Tracking 50/51/52/53 records) that this workflow must be provisioned against for production enablement?

Answer:
> Production deployment targets Saris environment `trumark-live`. The exact SymXchange URL/region and credential are deployment-provided; source does not identify whether that endpoint is Symitar production or test. Provision read-only query access for account/member and name data, account Tracking 50/51/52/53, shares/deposits and transactions, loans and transactions, and Visa external-loan records plus external-loan tracking. No Symitar data writes are used. Deployment must confirm the customer-approved endpoint and any non-mortgage-only product restriction because the client requests all loan fields rather than enforcing that restriction.

Evidence:
- AGENTS.md:535-548 proves the deceased-accounts backend runs in `backend-runtime` and deploys through CD to environment `trumark-live`.
- src/modules/shared/api/symitar/client.ts:86-133 defines the account query as POST and requests account, name, account tracking, share/share-transaction, loan/loan-transaction, external-loan, and external-loan-tracking fields.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:13-32 maps Tracking 50 to deceased identity/date, 51/52 to share figures, and 53 to loan/Visa figures.
- src/modules/shared/api/symitar/types/endpoints/setup-config.ts:1-5 shows `sym_exchange_url` is supplied as configuration rather than fixed in source.

### catalyst-cheque

| Metric | Count |
| --- | ---: |
| Blocking questions | 0 |
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| Reused campaign answers | 0 |
| Planner questions | 0 |
| Planner requirements-agent requests | 0 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

No blocking question required an answer.

## Holdout

Not run for this variant.

## Target-Excluded Guard

Status: `failed`

Gate: `pending`

Baseline mean build rate: unscored

Candidate mean build rate: unscored

Build-rate drop: unscored

Pair validity: invalid or pending

Leakage paths: 0

Protocol: `standard-primary-v2`

Standard primary (comparison control) reference: unavailable

No additional control execution was run; the standard primary measurement is reused as comparison normal.

Excluded decisions: unavailable

Comparison lineage: unavailable

Comparison mismatches: none

Recorded error: `standard evaluation failed: POST /api/planning-cases failed (503): {"error":"SourceUnavailable"}`

Target-arm questions: 0

No target-arm runtime question was recorded.

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

`POST /api/planning-cases failed (503): {"error":"SourceUnavailable"}`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr47/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47/trumark-deceased-accounts-pr47-v000/deceased-account/facts.json` | unavailable |
| Target-excluded comparisons | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47/trumark-deceased-accounts-pr47-v000/target-excluded/comparisons/` | failed |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
