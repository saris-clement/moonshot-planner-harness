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

Input hash: `sha256:f816e465cb8f6a52175426bf9757ecb64512ec3cd69a2bc7469b393faac7b3a1`

Result hash: `sha256:a250716100f2e5447011c03d609c22bdde0e3de34d20d80431c463ed57c8f60c`

> The measured artifacts suggest that most false build or extend decisions arose after functioning search and source-read operations: relevant implementations were inconsistently retrieved, fragmented across declaration-level evidence, or interpreted too narrowly. A deliberate private-declaration rule also converted behaviorally complete discoveries into extend decisions. High confidence frequently survived weak or unstable evidence. No broad tool or source infrastructure outage is established.

### finding-retrieval-recall-under-semantic-drift: source_discovery

Confidence: `high`

> Compound queries combining requirement identifiers, output-field terminology, and behavioral prose often ranked unrelated declarations or returned no exact lexical hits. Hydration and committed-source reads succeeded, but relevant implementation declarations were consequently absent from the selectable evidence set, leading the planner to infer that new implementation was required.

Supporting evidence: `evidence-5bece13361db7ebe`, `evidence-00758e54293bc6e0`, `evidence-2186475755a7f2d2`, `evidence-3cef64a325603d46`

Counterevidence: `evidence-6e9d562312e9b250`, `evidence-e230bf6ec481d8c1`, `evidence-dc0590541284f88f`

Falsification: Replay the affected units with identical pins, model, prompt, and budget while changing only retrieval to staged query expansion plus enclosing-module fallback. Reject this finding if relevant committed declarations are not retrieved more often or if build decisions do not decrease.

### finding-fragmented-evidence-underproves-workflow: planner_interpretation

Confidence: `high`

> Broad workflow outcomes span orchestration, calculations, and result assembly, while selectable evidence is declaration-oriented and bounded. The adjudicator sometimes treated each fragment as proving only a partial foundation instead of composing mutually consistent source snippets into evidence for the existing end-to-end behavior.

Supporting evidence: `evidence-470bf9e1be24f22f`, `evidence-14c61ec8606b9e6b`, `evidence-2aa57990acc5995d`, `evidence-aaf7f14834115fb9`

Counterevidence: `evidence-e230bf6ec481d8c1`, `evidence-08484a666567b490`, `evidence-d0f5a50b49a6a69c`

Falsification: Present the same committed snippets in two forms, independently and as a verified call-chain coverage matrix. Reject this finding if disposition accuracy and stability do not improve with the composed representation.

### finding-visibility-policy-overconstrains-reuse: evidence_retention

Confidence: `high`

> The planner discovered behavior matching the requested entrypoint but classified its selected declaration as private top-level evidence. The frozen policy permits such evidence only for extension, so declaration visibility overrode behavioral completeness and repeatedly prevented reuse.

Supporting evidence: `evidence-614ff5e3a1221048`, `evidence-024190cc32639718`, `evidence-006740da806a7c7b`

Counterevidence: `evidence-4e4ce889ce85d8ef`, `evidence-08484a666567b490`

Falsification: Add a boundary-verification signal without changing source visibility, then replay the unit. Reject this finding if the decision remains extend despite verified callable-boundary evidence, or if allowing such evidence creates false reuse decisions on controls.

### finding-confidence-not-conditioned-on-evidence-strength: confidence_calibration

Confidence: `high`

> High-confidence build decisions were emitted even when no discovered candidate was selected, many search hits were malformed or displaced by evidence limits, and alternate replicates or the blind judge identified existing behavior. Confidence therefore tracked requirement clarity more strongly than certainty about implementation absence.

Supporting evidence: `evidence-5bece13361db7ebe`, `evidence-bfcc99560bc8d004`, `evidence-5a02c907fd40ff06`, `evidence-463b8aea8bd823e1`, `evidence-259143ca04a111f1`

Counterevidence: `evidence-e230bf6ec481d8c1`, `evidence-d0f5a50b49a6a69c`

Falsification: Evaluate calibration on human-labeled units, comparing current confidence with evidence-conditioned confidence using reliability curves and high-confidence error rate. Reject this finding if conditioning does not improve calibration out of sample.

### finding-primary-replicate-disposition-instability: replicate_instability

Confidence: `high`

> With immutable inputs and pins, primary replicates changed dispositions for numerous units, principally between build and extend or reuse. Unit-level evidence shows that different runs retrieved or selected different fragments of the same implementation, allowing downstream interpretation to cross disposition boundaries.

Supporting evidence: `evidence-9a7f4b8fd7484391`, `evidence-924179f306953eec`, `evidence-470bf9e1be24f22f`, `evidence-e230bf6ec481d8c1`, `evidence-2aa57990acc5995d`, `evidence-08484a666567b490`

Counterevidence: `evidence-930748412667f4bb`, `evidence-c10227ba197ee96c`

Falsification: Run at least ten identical replicates before and after deterministic evidence ordering. Reject this finding if unit-level disposition disagreement does not decline without degrading independently reviewed accuracy.

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
| Planner human answers | 0 |

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

Status: `completed`

Gate: `passed`

Baseline mean build rate: 78.8%

Candidate mean build rate: 78.8%

Build-rate drop: 0.0%

Pair validity: valid

Leakage paths: 0

Control decisions: build=82, reuse=2, extend=25, defer=16, question=0

Excluded decisions: build=102, reuse=0, extend=7, defer=16, question=0

Comparison mismatches: none

Recorded error: none

Target-arm questions: 11

- control: What exact Key into Symitar row format should be used for a consumer loan whose Symitar description identifies it as a HELOC? -> Use `HELOC L<loan-number>$`, removing leading zeros. Example: loan ID `0001` uses key `HELOC L1$`. (source_fallback)
- control: What approved Symitar connection and read-only permission scopes will be available for member, death, deposit, consumer-loan, Visa, and tracking data? -> Use the TruMark live backend's Saris API Symitar/SymXchange proxy with read access to member/account and name fields; Tracking 50-53, including death name/date; deposit shares and share transactions; consumer loans and loan transactions/tracking/names/transfers; and Visa external-loan current balance/close-date and tracking data. Visa history is unavailable, so backdated card balances are out of scope. The workflow is recommend-only and never writes to Symitar; its only write is a separate records-api case-summary upsert. The exact SymXchange endpoint and credentials/secrets are deployment-provided. (source_fallback)
- control: What exact keyable-value format should be used for home-equity lines of credit, including the `HELOC ` prefix and the value that follows it? -> Use `HELOC L<loan-number>$ <amount>`, for example `HELOC L1$ 49529.28`. The loan number is unpadded; the amount is plain dollars with exactly two decimals, no leading `$` and no thousands separators. (source_fallback)
- control: What exact text format should the Key into Symitar summary use for a home-equity line of credit row? -> Use `HELOC L{loan-number}$ {amount}`, with the zero-padded loan ID rendered as a number and the amount as plain dollars with exactly two decimals, no currency symbol or thousands separators. Example: `HELOC L1$ 49529.28`. If the amount cannot be determined, use `HELOC L1$ needs review`. (source_fallback)
- control: What is the approved Symitar connection for production, and which read-only permission scopes or service account should it use for member, death, deposit, consumer-loan, Visa, and tracking data? -> Production is the `trumark-live` backend deployment. It accesses Symitar through the Saris API proxy at `/api/lo_systems/symitar/accounts/with-children-select-fields`; the underlying SymXchange URL and credentials are deployment-provided. Use a read-only deployment service account permitted to read member/account and name data, account Tracking 50-53, deposits/shares and transactions, consumer loans and related transactions/tracking/name/transfer/application data, and external loans (PSCU/Visa) with tracking. No Symitar write permission is required. The source does not specify a named service account or named permission scopes, so those exact values remain deployment-provided. (source_fallback)
- control: What exact keyable-value format should be used for home-equity lines of credit, including the `HELOC ` prefix and the value that follows it? -> Use `HELOC L<loan-number>$ <amount>`, for example `HELOC L1$ 49529.28`. The loan number is unpadded; the amount is plain dollars with exactly two decimals, no leading `$` and no thousands separators. (reused_source_answer)
- excluded: For a consumer loan whose Symitar description identifies it as a HELOC, what exact text format should appear in the Key into Symitar summary? -> Use `HELOC L{loan number}$ {amount}`. Remove leading zeros from the loan number and render the amount with exactly two decimals and no thousands separator; for example, `HELOC L41$ 8120.55`. (human_answer)
- excluded: What exact keyable format should be used for a HELOC principal, including placement of the `HELOC ` prefix relative to the amount? -> Use `HELOC L{loan number}$ {principal amount}`. Place `HELOC ` before the normalized loan label, remove leading zeros from the loan number, and place the principal amount after `$ ` with exactly two decimals and no thousands separator; for example, `HELOC L41$ 8120.55`. (human_answer)
- excluded: What exact text format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC? -> Use `HELOC L{loan number}$ {amount}`. Remove leading zeros from the loan number and render the amount with exactly two decimals and no thousands separator; for example, `HELOC L41$ 8120.55`. (human_answer)
- excluded: What approved Symitar connection should this workflow use, and which read-only permission scopes are available for member, death, deposit, consumer-loan, Visa, and tracking data? -> Use the `trumark-live` deployment with the deployment-provided SymXchange endpoint and secret. Provision read-only access for member/name/death data, deposits and shares, consumer loans, Visa or external loans, and Tracking 50/51/52/53, with no Symitar write permission. (human_answer)
- excluded: What exact keyable format should be used for HELOC principal values, including the required prefix and spacing? -> Use `HELOC L{loan number}$ {principal amount}` with one space after `HELOC` and one space after `$`. Remove leading zeros from the loan number and render the principal with exactly two decimals and no thousands separator; for example, `HELOC L41$ 8120.55`. (human_answer)

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
