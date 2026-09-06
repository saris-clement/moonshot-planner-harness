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
| Campaign | trumark-deceased-accounts-pr45c |
| Variant | trumark-deceased-accounts-pr45c-v000 |
| Parent | none |
| Round | 0 |
| Status | completed |
| Planner seed | `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v000/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr45c-bede783bef-0` |
| Artifact collection | complete |

## Actual Facts

| Decision | Count |
| --- | ---: |
| build | 82 |
| reuse | 4 |
| extend | 23 |
| defer | 16 |
| question | 0 |

| Metric | Value |
| --- | ---: |
| Requirement units | 125 |
| Replicates | 2 |
| Unanimous unit decisions | 81.6% |
| Empty shortlists | 68 |
| Candidate occurrences | 72 |
| Discovered evidence | 305 |
| Selected source references | 42 |
| Model calls | 660 |
| Total tokens | 13737454 |
| Cost USD | 42.5934 |
| Model duration ms | 4037471 |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 125 |
| Provisional errors | 90 |
| Provisional accuracy | 28.0% |
| Persisted labels | 241 |
| Cohort pin mismatches | none |

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> Chunk 1: The frozen checkout already contains substantial deceased-accounts production logic. Most observed build decisions missed or understated that implementation; remaining work generally calls for extension of existing behavior rather than a new build.
> Chunk 2: The frozen checkout already contains substantial TruMark deceased-account functionality. Most units are reusable; remaining gaps should extend existing private or partial logic rather than start from scratch.
> Chunk 3: The frozen checkout already contains substantial TruMark deceased-account capability. Ten planner results missed or underused existing implementations; five are genuine gaps or intentional deferrals; four need extension; one remains an unresolved specification question.
> Chunk 4: The frozen checkout already implements most Visa, count, trigger, identity, privacy, and routing behavior. The planner frequently classified existing or extensible TruMark capability as greenfield work.
> Chunk 5: The planner frequently overlooked the existing TruMark deceased-accounts workflow. Several requirements are already implemented or need only extension. Explicit out-of-scope units were correctly deferred; access-control guarantees and principal terminology remain uncertain.
> Chunk 6: Most gaps are extensions of substantial existing TruMark deceased-account logic, not greenfield builds. The clearest planner misses are routed-email intake, loan zero fallback, death-detail handling, review reasons, record identifiers, card-state derivation, and posting-order logic already present in production.
> Chunk 7: Three planner decisions missed existing or partial capabilities; one correctly identified an extension gap; the inbound deceased-email lane is already implemented end to end.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `completed`

Input hash: `sha256:4ad12a52336976263fd12f6ba6f4e84547f8a36b15c561aa95d9faf1fd827fba`

> The bounded evidence suggests that deterministic shortlist recall and bounded evidence retention, rather than tool unavailability, made some decisions depend heavily on which committed declarations advisory discovery surfaced. This produced material replicate instability and confidence changes under otherwise pinned inputs. These conclusions are unverified model interpretations.

### finding-structured-shortlist-recall-gap: candidate_ranking

Confidence: `high`

> The deterministic ranker produced an empty shortlist for a broad workflow-level behavior because its kind and normalized-term overlap rules did not admit lower-level implementation evidence. Advisory discovery subsequently hydrated committed production declarations, showing that an empty shortlist did not establish absence of an implementation foundation.

Supporting evidence: `evidence-470bf9e1be24f22f`, `evidence-e230bf6ec481d8c1`, `evidence-00dde19a88da6b03`

Counterevidence: `evidence-018f33cfc1aab49b`

Falsification: Construct generic cases where a frozen repository contains a complete implementation represented by several lower-level declarations but no exact prose match. Compare deterministic shortlist recall before and after the change while holding requirements, source, model, prompt, and budget pins fixed. Reject this finding if the existing ranker consistently admits the implementation evidence.

### finding-bounded-fragment-retention-sensitivity: evidence_retention

Confidence: `medium`

> Successful searches produced many qualified pointers and committed-source reads, but projection quotas rejected numerous candidates after evidence slots were exhausted. One replicate retained calculation-oriented fragments and selected two of them, while another retained a result-oriented fragment and selected one. Because the model adjudicates only the retained projection, different admitted fragments can change whether end-to-end coverage appears proven.

Supporting evidence: `evidence-470bf9e1be24f22f`, `evidence-e230bf6ec481d8c1`

Counterevidence: `evidence-024190cc32639718`, `evidence-006740da806a7c7b`

Falsification: Replay fixed generic cases with identical search results while permuting hit order. Reject this finding if admitted semantic-role coverage and final decisions remain invariant, or if increasing role-balanced retention does not reduce decision variance.

### finding-material-replicate-instability: replicate_instability

Confidence: `high`

> Persisted replicate facts report decision changes across multiple units. For the inspected unit, one durable replicate returned medium-confidence extension and another returned high-confidence reuse after selecting different discovered evidence. Confidence therefore tracked the model's sampled evidence interpretation rather than a replicate-stable measure of evidence completeness.

Supporting evidence: `evidence-9a7f4b8fd7484391`, `evidence-470bf9e1be24f22f`, `evidence-e230bf6ec481d8c1`

Counterevidence: `evidence-930748412667f4bb`, `evidence-7925d20bf8b5393c`, `evidence-bf7ffef3288f873e`

Falsification: Run repeated adjudications with identical immutable pins and quantify per-unit decision and confidence agreement. Reject this finding if the observed disagreement falls within a predefined reliability bound and confidence consistently predicts agreement or verified correctness.

## Requirements Questions

### deceased-account

| Metric | Count |
| --- | ---: |
| Blocking questions | 1 |
| Requirements-agent requests | 1 |
| Requirements-agent answers | 0 |
| Source fallback answers | 1 |
| Reused campaign answers | 0 |
| Planner questions | 4 |
| Planner requirements-agent requests | 4 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 4 |
| Planner reused answers | 0 |

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

#### question.8e14e5059d044369483ad931

Resolution: `source_fallback`

Question:
> What exact text format should a home-equity line of credit use in the Key into Symitar summary?

Answer:
> Use `HELOC L{loanNumber}$ {amount}`, e.g. `HELOC L1$ 49529.28`. The amount has exactly two decimals, no leading `$`, and no thousands separator; use `needs review` when undetermined.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:127-133
- src/customers/trumark/deceased-accounts/summary-block.ts:197-204
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-249

#### question.7e6ae37292955b4dc7562ec6

Resolution: `source_fallback`

Question:
> What exact keyable value format should be used for home-equity lines of credit, including the `HELOC ` prefix and the text that follows it?

Answer:
> Use `HELOC L{loan number without leading zeros}$ {dollar amount with exactly two decimals}`, with no currency symbol or thousands separators. Example: `HELOC L1$ 49529.28`.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:120-132 defines the `L{number}$` label, strips zero padding numerically, and formats plain dollars to two decimals.
- src/customers/trumark/deceased-accounts/summary-block.ts:197-204 prepends literal `HELOC ` and emits `${prefix}${entityLabel(...)} ${amountToken(...)}`.
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-248 proves `0001` and 4,952,928 cents render exactly as `HELOC L1$ 49529.28`.

#### question.9b973d71c1c39deeb341ca77

Resolution: `source_fallback`

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan identified as a HELOC?

Answer:
> Use `HELOC L{loanId-with-leading-zeros-removed}$ {amount}`; format the amount with two decimals, no dollar sign, and no thousands separator. Example: `HELOC L1$ 49529.28`. If undetermined, use `HELOC L1$ needs review`.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:197-204 constructs HELOC loan lines
- src/customers/trumark/deceased-accounts/summary-block.ts:127-133 defines two-decimal amount formatting and the `needs review` fallback
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-249 asserts `HELOC L1$ 49529.28`

#### question.00a21ede9982c332942c3812

Resolution: `source_fallback`

Question:
> Should the Tracking 53 entry for HELOC loan 0041 and principal-at-death $8,120.55 be exactly “HELOC L0041$ 8120.55”, or should a different formatting rule apply?

Answer:
> Use “HELOC L41$ 8120.55”, not “HELOC L0041$ 8120.55”. Leading zeros are removed. The “HELOC ” prefix applies only when the matched Symitar description contains the whole word HELOC.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:111-125 converts the ID with Number() before building the L{number}$ label
- src/customers/trumark/deceased-accounts/summary-block.ts:198-203 conditionally adds the HELOC prefix and formats cents as a two-decimal amount
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-248 proves loan 0001 renders as “HELOC L1$ 49529.28”

### unrelated-holdout

| Metric | Count |
| --- | ---: |
| Blocking questions | 0 |
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| Reused campaign answers | 0 |
| Planner questions | 1 |
| Planner requirements-agent requests | 1 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 1 |
| Planner reused answers | 0 |

#### question.37d4b726fe4cc16ac3288bd8

Resolution: `source_fallback`

Question:
> What exact pass, review, and fail criteria apply to the MICR, duplicate notification value, corporate separation, and return-reason mapping checks?

Answer:
> Statuses are cheque-level, not four independent checks. FAIL applies if extraction fails or any required field is `???`; REVIEW applies when required fields exist but a transform warning exists; otherwise PASS. MICR: drawee MICR prefers header Credit Union ID, falls back to image transit number, pads to 9 digits, and reviews on source mismatch, non-9-digit/non-numeric output, or configured confidence below 0.4; missing fails. BOFD MICR similarly pads `bofdTR`, reviews if invalid/low-confidence, and fails if missing. Duplicate notification value: `EABankToNotifyMICR` is always copied exactly from `EABankOfFirstDepositMICR`; it has no independent status check. Corporate separation: filename character index 3 maps A=Alloya, C=Corporate One, D=Catalyst CU, M=Corporate America, T=Volunteer T; everything else groups as Unknown. Outputs are generated per group; Unknown itself does not cause review/fail, and each corporate node inherits its worst cheque status. Return-reason mapping: alpha code has priority; if both alpha and recognized numeric return code are present but map to different EARNS codes, REVIEW. With no alpha, a recognized numeric code passes mapping; an unknown/missing numeric code produces `???` and FAIL. An unknown alpha defaults to EARNS `J` without warning. Numeric mappings are: A=1/01/51/57; B=2/02/56; D=3/03/4/04/55; F=5/05/36; E=8/08/54; I=9/09/52/62/67; J=16/22/23/24/25/29/60/72/74/77/78/79/80/81; M=18; G=19; U=20; H=21; L=26/68; P=27; C=28; N=65.

Evidence:
- src/customers/catalyst/cheque-verification-combined/format-results.ts:202-225
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:84-89,192-217,289-305,335-367
- src/customers/catalyst/cheque-verification-combined/config.ts:34-36
- src/customers/catalyst/cheque-verification-combined/types.ts:9-29,36-65,101-149,235-249
- src/customers/catalyst/cheque-verification-combined/agents/cheque-workflow-agent.ts:735-781
- src/customers/catalyst/cheque-verification-combined/format-results.ts:270-289

## Holdout

- unrelated-holdout: 2 runs, 69.0% unanimous decisions; 116 units; build=70, reuse=4, extend=32, defer=10, question=0; verified=unscored, provisional=23.3%

## Target-Excluded Guard

Status: `failed`

Gate: `pending`

Baseline mean build rate: unscored

Candidate mean build rate: unscored

Build-rate drop: unscored

Pair validity: invalid or pending

Leakage paths: 0

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
