# Compose selected evidence into a coverage chain

## Goal

Improve generic Phase 2 source-backed adjudication accuracy using PR 45 durable diagnostic correlation. Preserve requirement, source, model, prompt, budget, and knowledge pins; distinguish measured facts, deterministic reconstruction, model diagnosis, and human truth. Reduce false build and false extend decisions without introducing false reuse or customer-specific production heuristics. Use the target-excluded arm only as a promotion guard against over-eager reuse and target leakage, never as a fitness reward.

## Base Assumptions

These assumptions were recorded before execution. They are model-generated and unverified.

- Unverified model-generated assumption: the selected fragments contain enough linked evidence to establish broader behavior when composed.
- Unverified model-generated assumption: deterministic composition, rather than additional retrieval, changes the adjudicator's interpretation.
- Unverified model-generated assumption: call and data-flow links can be reconstructed reliably from the available committed source.

## Observed Issues

### finding-fragmented-evidence-underproves-workflow: planner_interpretation

Authority: `unverified_model_judgment`

> Broad workflow outcomes span orchestration, calculations, and result assembly, while selectable evidence is declaration-oriented and bounded. The adjudicator sometimes treated each fragment as proving only a partial foundation instead of composing mutually consistent source snippets into evidence for the existing end-to-end behavior.

Proposed generic intervention: Aggregate evidence into a behavior-coverage matrix across entrypoint, computation, serialization, and tests. Permit a decision to be supported by a verified chain of declarations rather than requiring one declaration to prove the entire workflow.

Supporting evidence: `evidence-470bf9e1be24f22f`, `evidence-14c61ec8606b9e6b`, `evidence-2aa57990acc5995d`, `evidence-aaf7f14834115fb9`

Counterevidence: `evidence-e230bf6ec481d8c1`, `evidence-08484a666567b490`, `evidence-d0f5a50b49a6a69c`

Falsification: Present the same committed snippets in two forms, independently and as a verified call-chain coverage matrix. Reject this finding if disposition accuracy and stability do not improve with the composed representation.

Limitations: Different decisions may also reflect model sampling rather than evidence composition alone.; Only a bounded subset of mismatched or unstable units was retained.

## Planned Change

The plan below is model-generated and remains unverified. It is recorded before execution so the result can be evaluated against the original intervention.

> The unverified diagnosis suggests declaration-level fragments underprove behavior spanning entrypoints, computation, serialization, and tests (supporting evidence-470bf9e1be24f22f, evidence-14c61ec8606b9e6b, evidence-2aa57990acc5995d, evidence-aaf7f14834115fb9). Counterevidence includes fragments that may genuinely prove only partial behavior (evidence-e230bf6ec481d8c1, evidence-08484a666567b490, evidence-d0f5a50b49a6a69c). Sampling variation and the bounded retained unit set limit causal confidence.

Implementation instructions:
> Keep retrieval and selected snippets unchanged. Change only their adjudicator-facing representation by deterministically organizing mutually linked evidence into a behavior-coverage matrix covering boundary, computation, output, and tests, with explicit missing links. Require source-backed call or data-flow relationships and prohibit inferring coverage from mere co-location. Falsify the hypothesis through paired replay if the same snippets represented as a matrix do not improve independently reviewed disposition accuracy or stability.

Expected impact: Improve interpretation of end-to-end behavior without increasing retrieval volume or treating isolated declarations as complete implementations.

Risk: The matrix could overcompose unrelated fragments and create unsupported reuse unless every link remains explicit and source-backed.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr45c |
| Variant | trumark-deceased-accounts-pr45c-v002 |
| Parent | trumark-deceased-accounts-pr45c-v000 |
| Round | 1 |
| Status | running |
| Planner seed | `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v002/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr45c-bede783bef-2` |
| Artifact collection | incomplete |

## Baseline Metrics

| Metric | Parent | Observed | Delta |
| --- | ---: | ---: | ---: |
| Build units | 82 | unavailable | unavailable |
| Reuse units | 4 | unavailable | unavailable |
| Extend units | 23 | unavailable | unavailable |
| Defer units | 16 | unavailable | unavailable |
| Question units | 0 | unavailable | unavailable |
| Decision agreement | 81.6% | unavailable | unavailable |
| Selected source references | 42 | unavailable | unavailable |
| Verified accuracy | unavailable | unavailable | unavailable |
| Provisional accuracy | 28.0% | unavailable | unavailable |

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
| Persisted labels | 241 |
| Cohort pin mismatches | none |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | pending | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| Target-safe control | waiting_for_input | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| Target-excluded | waiting_for_input | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

The control and excluded arms use the same target-safe pack. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `pending`

No measured conclusion is available while the experiment is running.

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
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| Reused campaign answers | 1 |
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
> Provision against the `trumark-live` deployment. The workflow requires read access to member/account and name data, account Tracking 50/51/52/53, shares/deposits and share transactions, child loans and loan transactions, and Visa/external-loan records and tracking. Source applies no mortgage/non-mortgage loan filter. Symitar access is read-only; the workflow performs no Symitar write-back. The exact SymXchange URL/region and credential secret are deployment-provided and are not present in source.

Evidence:
- tools/deploy/config.json:29-35 — TruMark Deceased Accounts targets environment `trumark-live`.
- src/customers/trumark/deceased-accounts/stages/resolve.ts:81-88 — runtime reads the member through `getAccountSelectFields`; no config endpoint is called.
- src/modules/shared/api/symitar/client.ts:89-127 — request selects all account, name, account-tracking, share/share-transaction, loan/loan-transaction, external-loan, and external-loan-tracking fields, with unfiltered loan and external-loan children.
- src/customers/trumark/deceased-accounts/stages/resolve.ts:4-10 — workflow consumes Tracking 50/51/52/53.
- src/customers/trumark/deceased-accounts/README.md:3-6 — workflow is recommend-only and never writes back to Symitar.
- src/modules/shared/api/symitar/types/endpoints/setup-config.ts:1-6 — exact `sym_exchange_url` is a setup/deployment value; deceased-accounts source does not provide it.

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

Status: `waiting_for_input`

Gate: `pending`

Baseline mean build rate: unscored

Candidate mean build rate: unscored

Build-rate drop: unscored

Pair validity: invalid or pending

Leakage paths: 0

Control decisions: unavailable

Excluded decisions: unavailable

Comparison lineage: unavailable

Comparison mismatches: none

Recorded error: none

Target-arm questions: 0

No target-arm runtime question was recorded.

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr45c/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v002/deceased-account/facts.json` | unavailable |
| Parent measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v000/deceased-account/facts.json` | archived |
| Target-excluded comparisons | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v002/target-excluded/comparisons/` | waiting_for_input |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
