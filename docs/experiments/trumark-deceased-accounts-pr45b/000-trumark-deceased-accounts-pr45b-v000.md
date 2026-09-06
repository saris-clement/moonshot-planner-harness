# Unmodified campaign seed

## Goal

Improve generic Phase 2 source-backed adjudication accuracy using PR 45 durable diagnostic correlation. Preserve requirement, source, model, prompt, budget, and knowledge pins; distinguish measured facts, deterministic reconstruction, model diagnosis, and human truth. Reduce false build and false extend decisions without introducing false reuse or customer-specific production heuristics. Use the target-excluded arm only as a promotion guard against over-eager reuse and target leakage, never as a fitness reward.

## Hypothesis

The hypothesis below is model-generated and remains unverified until the experiment completes.

> Measure the selected seed revision before applying an experimental mutation.

Expected impact: Establish reproducible primary and holdout facts for this campaign.

Risk: Provider nondeterminism means one screening run is descriptive rather than conclusive.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr45b |
| Variant | trumark-deceased-accounts-pr45b-v000 |
| Parent | none |
| Round | 0 |
| Status | failed |
| Planner seed | `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:9e1d990b7f3af43073f0b8667c4aa7182f7eab826551ba29217065606c4b9fb4` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45b/trumark-deceased-accounts-pr45b-v000/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr45b-6f3375e796-0` |
| Artifact collection | complete |

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

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> No blind-judge result is available.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `not_started`

Input hash: unavailable

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

#### 01M1Q2R1VHAKDZHSQ7TQDBA8B2

Resolution: `source_fallback`

Question:
> What is the approved Symitar connection endpoint/environment (e.g., production vs. test region) and the specific read-only credential scope (member, death, deposit, non-mortgage consumer-loan, Visa external-loan, and Tracking 50/51/52/53 records) that this workflow must be provisioned against for production enablement?

Answer:
> Deploy in the `trumark-live` Saris environment. The workflow reads Symitar through the Saris proxy endpoint `/api/lo_systems/symitar/accounts/with-children-select-fields`, requesting member/account and name data, account Tracking records 50/51/52/53, shares/deposits and transactions, internal loans and transactions, and Visa/external-loan data. It performs no Symitar write-back, so production credentials must be read-only for that surface with no write permissions. The exact downstream SymXchange URL, production/test region, and credential secret are not present in frozen source and remain deployment-provided; the implementation requests all internal loans rather than proving a narrower non-mortgage-only permission.

Evidence:
- tools/deploy/config.json:29-35 deploys TruMark Deceased Accounts to environment `trumark-live`.
- src/modules/shared/api/symitar/client.ts:42-43 defines the account read proxy endpoint; lines 86-157 issue only the account retrieval POST.
- src/modules/shared/api/symitar/client.ts:89-127 requests account, loan, loan tracking/name/transfer/transaction, name, account tracking, share/share transaction, and external-loan/external-loan-tracking fields.
- src/customers/trumark/deceased-accounts/stages/resolve.ts:81-88 performs the sole Symitar account fetch.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:14-28 and 447-483 consume Tracking 50/51/52/53, shares, loans, and external-loan card data.
- src/customers/trumark/deceased-accounts/README.md:3-6 states the workflow is recommend-only and never writes back to Symitar.
- src/modules/shared/api/symitar/types/endpoints/setup-config.ts:1-5 shows the downstream `sym_exchange_url` is configuration; no production URL or credential appears in the workflow.

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

No blocking question required an answer.

## Holdout

Not run for this variant.

## Target-Excluded Guard

Not configured or not run for this variant.

## Failure

`analysis readiness blocked: input_incompatible`

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
