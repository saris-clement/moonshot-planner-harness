# Unmodified campaign seed

## Goal

Improve generic Phase 2 source-backed adjudication accuracy using PR 45 durable diagnostic correlation. Preserve requirement, source, model, prompt, budget, and knowledge pins; distinguish measured facts, deterministic reconstruction, model diagnosis, and human truth. Reduce false build and false extend decisions without introducing false reuse or customer-specific production heuristics. Use the target-excluded arm only as a promotion guard against over-eager reuse and target leakage, never as a fitness reward.

## Base Assumptions

No explicit assumptions were captured for this legacy hypothesis.

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
| Campaign | trumark-deceased-accounts-pr45 |
| Variant | trumark-deceased-accounts-pr45-v000 |
| Parent | none |
| Round | 0 |
| Status | failed |
| Planner seed | `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:c74a27a40f2243e5a4f5cdc6272084a122e52c7c919aa9a743ff6a1aa879f799` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45/trumark-deceased-accounts-pr45-v000/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr45-35e2f0bb57-0` |
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
| Standard | pending | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

No target-safe control or target-excluded result is available for this experiment.

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
> Deploys to `trumark-live` and reads Symitar through the Saris proxy; the actual SymXchange host/region and credential are deployment-provided. Provision a read-only identity for member/account data, deceased data in Tracking 50, deposits/shares and transactions, loans and transactions, Visa/PSCU external loans, and Tracking 50/51/52/53. No Symitar write-back is performed. Note: source requests all loan fields with an empty loan filter, so it does not itself enforce a non-mortgage-only boundary; that restriction must be enforced by deployment credentials/proxy policy.

Evidence:
- tools/deploy/config.json:29-35 — TruMark Deceased Accounts targets `trumark-live`.
- src/customers/trumark/deceased-accounts/stages/resolve.ts:81-88 — workflow calls `getAccountSelectFields` through the Saris Symitar client.
- src/modules/shared/api/symitar/client.ts:89-127 — request includes account, names, tracking, shares/share transactions, loans/loan transactions, and external loans; `loan_filter` is empty.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:17-21 — Tracking 50 contains deceased name/date; 51/52 contain share figures; 53 contains loan and card figures.
- src/customers/trumark/deceased-accounts/README.md:3-6 — workflow is recommend-only and never writes back to Symitar.

### unrelated-holdout

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

Not configured or not run for this variant.

## Failure

`POST /api/planning-cases/5G8QW5W8H275206QZYZANP54E8/runs failed (409): {"error":"AnalysisNotReady"}`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr45/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45/trumark-deceased-accounts-pr45-v000/deceased-account/facts.json` | unavailable |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
