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
| Campaign | trumark-deceased-accounts-pr47-3 |
| Variant | trumark-deceased-accounts-pr47-3-v001 |
| Parent | none |
| Round | 0 |
| Status | completed |
| Planner seed | `a24baf79e777b07a3b55d027dc5ea5a8701e6af8` |
| Workflows source | `140ec306bff8c20aa9eccde3cc2f4647ce790655` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr47-3-9c00fe3066-1` |
| Artifact collection | complete |

## Baseline Metrics

No parent metrics exist. This experiment establishes a campaign-local baseline.

## Actual Facts

| Decision | Count |
| --- | ---: |
| build | 83 |
| reuse | 1 |
| extend | 25 |
| defer | 16 |
| question | 0 |

| Metric | Value |
| --- | ---: |
| Requirement units | 125 |
| Replicates | 2 |
| Unanimous unit decisions | 83.2% |
| Empty shortlists | 68 |
| Candidate occurrences | 72 |
| Discovered evidence | 287 |
| Selected source references | 40 |
| Model calls | 671 |
| Total tokens | 12979265 |
| Cost USD | 38.5846 |
| Model duration ms | 4657431 |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 125 |
| Provisional errors | 94 |
| Provisional accuracy | 24.8% |
| Persisted labels | 241 |
| Cohort pin mismatches | none |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard primary (comparison control) | reference (standard measurement) | 125 | 83 | 1 | 25 | 16 | 0 | 83.2% |
| Target-excluded | measured | 125 | 105 | 0 | 4 | 16 | 0 | 95.2% |

The standard primary measurement is referenced as comparison normal. No additional control execution was run. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `measured`

This section is generated from persisted measurements. It does not treat model diagnosis or blind-judge suggestions as verified truth.

This run establishes a baseline observation; it does not establish that the planner decisions are correct or that the planner improved.

Correctness remains unverified because no human-verified labels score this experiment. Provisional accuracy is an LLM suggestion only.

The target-excluded promotion guard is passed.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> Chunk 1: The planner substantially under-read the frozen checkout. Most build decisions concern capabilities already implemented in the TruMark deceased-accounts workflow and should be reuse or extend. Explicit exclusions were correctly deferred, and the renewed-certificate example correctly requires extension for missing presentation metadata.
> Chunk 2: The frozen checkout already implements most requested deceased-account behavior. The planner repeatedly overlooked exact or substantial existing capabilities, especially email routing, Symitar retrieval, calculations, comparison, rendering, and keyable summaries. One observed extend decision correctly identifies a remaining projection gap.
> Chunk 3: The planner repeatedly missed the substantial existing TruMark deceased-accounts implementation. Twelve units should reuse or extend customer-specific production code rather than build from scratch; four scope exclusions are correctly deferred; two extensions and one partially covered acceptance branch represent genuine gaps.
> Chunk 4: The frozen checkout already contains substantial TruMark deceased-account logic. Most observed build decisions missed existing or partial capabilities and should be reuse or extend. The two explicit exclusions are valid deferrals; dividend presentation fields still require extensions.
> Chunk 5: The planner materially under-recognized the frozen checkout. Most requested behavior already exists wholly or partially in the TruMark deceased-accounts workflow, making several build decisions system errors. Genuine gaps remain where exact output contracts, required-date enforcement, finer per-type counts, or explicit internal fields are absent.
> Chunk 6: The planner missed substantial existing deceased-accounts capability in 12 units. Four observed extend decisions correctly identify remaining output-contract gaps, three exclusions are correctly deferred, and the internally superseded Visa example is judged against its later direction-neutral rule.
> Chunk 7: The planner missed one complete entrypoint and three substantial partial field capabilities. Only dividend_basis_days is correctly classified as extend.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `completed`

Input hash: `sha256:038f5a76bae6b9ed5f0cb0a05b481a6603aaebeb836c886de5c9f58a049f201f`

Result hash: `sha256:c8581bedc7980b252cc03141e8cd646564f320ed6500b2ad51dab1553b97711a`

> Durable V2 records show successful search and committed-source reads, not KB unavailability. The bounded evidence indicates that unresolved exact workflow identity removed workflow-level evidence, leaving narrow candidate ranking and model-directed repository discovery to recover existing behavior. Literal vocabulary mismatch, bounded hydration, and evidence selection then produced replicate-sensitive build versus reuse-or-extend decisions. Blind-judge disagreements and this causal diagnosis remain unverified model interpretations.

### finding-exact-workflow-resolution-gap: workflow_resolution

Confidence: `high`

> Both primary replicates durably resolved the requested workflow as new because no exact implementation or harness registration matched its identifier, despite frozen source containing a related implementation. This removed workflow-level capability evidence before unit adjudication and made reuse detection depend on later repository discovery.

Supporting evidence: `evidence-bb357638b9f90c8c`, `evidence-04b7c518d0f30065`

Counterevidence: `evidence-470bf9e1be24f22f`, `evidence-614ff5e3a1221048`

Falsification: Repeat resolution after supplying one canonical identity consistently across requirements, implementation metadata, and registration. If workflow-level evidence remains absent or unit dispositions do not become more stable, identity resolution is not a material cause.

### finding-shortlist-coverage-shifts-burden-to-discovery: candidate_ranking

Confidence: `medium`

> Compatibility and lexical-overlap filtering produced empty or non-specific frozen shortlists for units later associated with committed implementation. Empty shortlists did not deterministically force build, but they transferred the entire capability-existence decision to bounded, model-directed source discovery.

Supporting evidence: `evidence-0054d4c8fbd44df6`, `evidence-723d101138fd9b24`, `evidence-463b8aea8bd823e1`

Counterevidence: `evidence-470bf9e1be24f22f`, `evidence-024190cc32639718`, `evidence-614ff5e3a1221048`

Falsification: Provide identical source-derived candidates to all replicates without changing the adjudicator. If empty-shortlist units retain the same build rate and instability, shortlist coverage is not a material contributor.

### finding-literal-vocabulary-source-discovery-gap: source_discovery

Confidence: `medium`

> Fallback searches used exact requirement-shaped identifiers or field vocabulary. Durable searches then returned zero hits or unrelated declarations even though broader behavioral searches could recover relevant committed source elsewhere. This can misclassify an absent field name or projection as an absent underlying capability.

Supporting evidence: `evidence-002bdcb13cf682f0`, `evidence-026586bda98679c9`, `evidence-01452dba0826308a`

Counterevidence: `evidence-470bf9e1be24f22f`, `evidence-8d75fc31a29101ca`, `evidence-024190cc32639718`

Falsification: Compare exact-vocabulary retrieval with behavior-expanded retrieval under identical budgets. If the expanded strategy does not increase admission of relevant committed declarations, vocabulary mismatch is not the operative cause.

### finding-ranked-hydration-amplifies-retrieval-variance: evidence_hydration

Confidence: `high`

> Hydration admitted evidence in rank order under bounded file, byte, role, visibility, and path constraints. Durable receipts record malformed-hit and exhausted-slot rejection. For the same requirement, one replicate selected relevant committed declarations and chose extend while another completed two searches, read no source, selected nothing, and chose build.

Supporting evidence: `evidence-8d75fc31a29101ca`, `evidence-d7c6c8ea3cf6aab4`, `evidence-0054d4c8fbd44df6`

Counterevidence: `evidence-470bf9e1be24f22f`, `evidence-024190cc32639718`, `evidence-2028c2d0e4cb9ed7`

Falsification: Replay affected units with repaired hit structure and identical enlarged or relevance-aware evidence allocations. If source admission rises without reducing decision variance, hydration is incidental and adjudicator interpretation is the stronger mechanism.

### finding-model-controlled-evidence-boundary-causes-instability: replicate_instability

Confidence: `high`

> Replicates shared the frozen input and knowledge snapshot but differed in accumulated decision context and in model-controlled query wording, evidence selection, and interpretation. Several units moved between build and reuse-or-extend when relevant committed declarations were selected in only one run.

Supporting evidence: `evidence-9a7f4b8fd7484391`, `evidence-8d75fc31a29101ca`, `evidence-d7c6c8ea3cf6aab4`, `evidence-470bf9e1be24f22f`

Counterevidence: `evidence-024190cc32639718`, `evidence-614ff5e3a1221048`, `evidence-069bb218b3ddcc3a`

Falsification: Replay affected units with identical admitted snippets, ordering, prompts, budgets, and decision context. Persistent disposition changes would falsify retrieval and context variance as the dominant cause and isolate adjudicator interpretation.

## Requirements Questions

### deceased-account

| Metric | Count |
| --- | ---: |
| Blocking questions | 1 |
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| PM-simulation answers | 1 |
| Reused campaign answers | 1 |
| Planner questions | 5 |
| Planner requirements-agent requests | 4 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 4 |
| Planner PM-simulation answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 1 |

#### 01M1Q2R1VHAKDZHSQ7TQDBA8B2

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What is the approved Symitar connection endpoint/environment (e.g., production vs. test region) and the specific read-only credential scope (member, death, deposit, non-mortgage consumer-loan, Visa external-loan, and Tracking 50/51/52/53 records) that this workflow must be provisioned against for production enablement?

Answer:
> The production target is TruMark’s live environment, but the exact Symitar endpoint/region and required read-only credential grant are not yet approved. Treat this as a production-enablement gap and do not enable go-live until access to the specified data is validated with no write permissions.

Evidence:
- tools/deploy/config.json:29-35
- src/customers/trumark/deceased-accounts/README.md:3-6
- src/modules/shared/api/symitar/client.ts:89-127
- src/modules/shared/api/symitar/types/endpoints/setup-config.ts:1-6

#### question.77787c2ff12d3d70e8012ef0

Resolution: `human_answer`

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan identified as a HELOC?

Answer:
> Use `HELOC L{loan number}$ {amount}` under Tracking 53, with the loan number unpadded and the amount rendered with exactly two decimals and no thousands separator, for example `HELOC L1$ 49529.28`.

Evidence:
- human operator answer

#### question.4c1f945556465e6b59c7fb5f

Resolution: `source_fallback`

Question:
> What exact keyable value format should be used for HELOC loans, including placement of the `HELOC ` prefix and the remaining loan identifier or value?

Answer:
> Use `HELOC L<loan-id>$ <amount>`, with `HELOC ` first, followed by `L` plus the 1–4 digit loan identifier, then `$ ` and the amount. Example: `HELOC L1$ 49529.28`. `HELOC $ <amount>` is unkeyed and should not be used when the loan must be explicitly identified.

Evidence:
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:101-118 defines the prefix, loan key, identifier, and amount grammar
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.test.ts:334-342 proves `HELOC L1$ 49529.28` keys loan `0001`
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.test.ts:344-357 proves `HELOC $ 20476.92` is unkeyed and requires sole-open-loan inference

#### question.68f423273e7072f8eaa9a886

Resolution: `source_fallback`

Question:
> What exact text format should the Key into Symitar summary use for a HELOC consumer-loan row?

Answer:
> Use `HELOC L<loan number>$ <amount>`, for example `HELOC L1$ 49529.28`.

Evidence:
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:101-118 defines the hand-keyed slot grammar with optional `HELOC` prefix, `L` loan key, loan number, `$`, and amount.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.test.ts:334-342 proves `HELOC L1$ 49529.28` as the keyed HELOC loan format.

#### question.0285c6bce1fe4b15f9264e32

Resolution: `source_fallback`

Question:
> For Tracking 53, should a HELOC loan number preserve leading zeros (for example, “L0041$ 8120.55”) or be normalized to “L41$ 8120.55”?

Answer:
> Preserve leading zeros. Tracking 53 represents loan IDs in canonical four-digit, zero-padded form, so use “HELOC L0041$ 8120.55.”

Evidence:
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:48-52 defines Tracking 53 loanId as zero-padded, e.g. '0001'.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:423-440 pads parsed Tracking 53 loan numbers to four digits and stores that padded ID.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.test.ts:334-341 verifies 'HELOC L1$ 49529.28' becomes loanId '0001'.

#### question.ce497b110b6f6f77df1d16db

Resolution: `source_fallback`

Question:
> What exact format should the keyable value use for a home-equity line of credit, including the `HELOC ` prefix and the value that follows it?

Answer:
> Use `HELOC L<loan-number>$ <amount>`, e.g. `HELOC L1$ 49529.28`. The `L` value is the Symitar loan ID (1–4 digits); the amount follows `$`.

Evidence:
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:101-118 defines the slot grammar
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:421-440 maps `l{n}` to the zero-padded held loan ID
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.test.ts:334-342 proves `HELOC L1$ 49529.28` as a keyed loan figure

### catalyst-cheque

| Metric | Count |
| --- | ---: |
| Blocking questions | 0 |
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| PM-simulation answers | 0 |
| Reused campaign answers | 0 |
| Planner questions | 1 |
| Planner requirements-agent requests | 1 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 1 |
| Planner PM-simulation answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

#### question.477bcb065c1297d3ffcd1f75

Resolution: `source_fallback`

Question:
> When Paid Date is blank or unreadable and Return Reason is not numeric 0, what deposit-date value must be produced, given that this derivation must always produce a value?

Answer:
> Produce the literal placeholder "???" for EADepositDate.

Evidence:
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:19 defines MISSING as "???".
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:94-97 returns MISSING when Paid Date is blank or invalid.
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:346-349 uses formatted Paid Date whenever Return Reason is not exactly "0".

## Holdout

- catalyst-cheque: 2 runs, 73.3% unanimous decisions; 116 units; build=59, reuse=4, extend=44, defer=9, question=0; verified=unscored, provisional=19.0%

## Target-Excluded Guard

Status: `completed`

Gate: `passed`

Baseline mean build rate: 81.6%

Candidate mean build rate: 81.6%

Build-rate drop: 0.0%

Pair validity: valid

Leakage paths: 0

Protocol: `standard-primary-v2`

Standard primary (comparison control) reference: benchmark `deceased-account`, resolved artifact `sha256:ea37e334c9e63df68af692fc8d6555797fd72955ed6070ca1f74759672d78eff`, lineage replicate 1 case `4TGWJZVP503RDX0ED80TAAAJDR` run `run.94ac0fb8b5a76a28a0ed00d1`; replicate 2 case `36S5FN1ZERN7WZ5W344464VKWN` run `run.9b7631b1c8605c47611f0256`

No additional control execution was run; the standard primary measurement is reused as comparison normal.

Excluded decisions: build=105, reuse=0, extend=4, defer=16, question=0

Comparison lineage: replicate 1: normal case `4TGWJZVP503RDX0ED80TAAAJDR` run `run.94ac0fb8b5a76a28a0ed00d1`, excluded case `3Y0PSB8KKPBHYN5H9YECGPYR60` run `run.afbc5687a9743e59c321f62f`; replicate 2: normal case `36S5FN1ZERN7WZ5W344464VKWN` run `run.9b7631b1c8605c47611f0256`, excluded case `7R798TVM7RNPR6GRAYD1YDNGTR` run `run.153b1bff9eef28a0a6b66712`

Comparison mismatches: none

Recorded error: none

Target-arm questions: 14

- excluded: What exact row format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC? -> Use `HELOC L{loan number}$ {balance}`, for example `HELOC L1$ 49529.28`. Format the balance with two decimals, no currency symbol or thousands separator. (pm_simulation)
- excluded: What final format should be used for the Tracking 53 entry for a HELOC, including the loan-number prefix, spacing, currency symbol, commas, and decimal places? -> Use `HELOC L<loan number>$ <amount>`, for example `HELOC L1$ 49529.28`. Use one space after `HELOC` and after `$`, no space between `L`, the unpadded loan number, and `$`; omit commas and format the amount to exactly two decimal places. (pm_simulation)
- excluded: Which account-record destinations are approved for member account number, member name, and date of death, and which communication surfaces count as general messages? -> Store the member account number as the canonical case-record key, and store the deceased member’s name and date of death on that same record using the authoritative deceased-tracking data; omit either optional value when unavailable. Human-authored emails, forwards, replies, and multi-message threads are general messages; only a standalone automated deceased notification from the approved sender is treated as the specialized notification. (pm_simulation)
- excluded: What exact keyable value format should be used for HELOC consumer loans? -> Use `HELOC L{loan number}$ {amount}`, with the loan number unpadded and the dollar amount shown to two decimals without commas, for example `HELOC L1$ 49529.28`. (pm_simulation)
- excluded: What exact Tracking 53 text format should be used for a consumer loan whose Symitar description identifies it as a HELOC? -> Use `HELOC L{loan number}$ {amount}`, with leading zeros removed and the amount shown without commas to exactly two decimals. Example: `HELOC L1$ 49529.28`. (pm_simulation)
- excluded: Which approved Symitar connection should the workflow use, and which read-only permission scopes or credentials are available for member, death, deposit, consumer-loan, Visa, and tracking data? -> Use TruMark’s existing production SymXchange connection through the approved Saris integration; do not provision workflow-specific credentials. The service account must be read-only for member/account and death data, Tracking 50–53, deposits and transactions, consumer loans and transactions, and Visa/external-loan data; no Symitar write permissions are approved. (pm_simulation)
- excluded: Is the Tracking 53 slot text for this example confirmed as exactly “HELOC L0041$ 8120.55”, including spacing, loan-number padding, currency symbols, and decimal formatting? -> Use exactly “HELOC L41$ 8120.55”. The loan number is not zero-padded. (pm_simulation)
- excluded: What exact text should Tracking 53 contain for the sample HELOC loan 0041 with supported principal at death of $8,120.55? -> HELOC L41$ 8120.55 (pm_simulation)
- excluded: What exact keyable format should be used for home-equity lines of credit, including the `HELOC ` prefix and the value that follows it? -> Use `HELOC L<loan number>$ <date-of-death balance>`, with the loan number unpadded and the balance as plain dollars with exactly two decimals, for example `HELOC L1$ 49529.28`. (pm_simulation)

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr47-3/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/deceased-account/facts.json` | archived |
| Diagnosis input | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/diagnosis/diagnosis-input-038f5a76bae6b9ed5f0cb0a05b481a6603aaebeb836c886de5c9f58a049f201f.json` | completed |
| Model diagnosis | `model_inference` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/diagnosis/diagnosis-result-038f5a76bae6b9ed5f0cb0a05b481a6603aaebeb836c886de5c9f58a049f201f.json` | completed |
| Target-excluded comparisons | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/target-excluded/comparisons/` | completed |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
