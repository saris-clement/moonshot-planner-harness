# Behavior-derived discovery queries

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

These assumptions were recorded before execution. They are model-generated and unverified.

- Unverified: requirement behavior can be translated into stable generic predicates without pack-specific vocabulary.
- Unverified: relevant implementations use discoverable operational or data-flow terms even when contract names differ.
- Unverified: admitted committed declarations will provide enough context for adjudication to distinguish complete, partial, and absent behavior.

## Observed Issues

### finding-literal-vocabulary-source-discovery-gap: source_discovery

Authority: `unverified_model_judgment`

> Fallback searches used exact requirement-shaped identifiers or field vocabulary. Durable searches then returned zero hits or unrelated declarations even though broader behavioral searches could recover relevant committed source elsewhere. This can misclassify an absent field name or projection as an absent underlying capability.

Proposed generic intervention: Construct discovery queries from behavioral predicates, data flow, and neighboring operations in addition to exact contract vocabulary, while requiring committed-source evidence for selection.

Supporting evidence: `evidence-002bdcb13cf682f0`, `evidence-026586bda98679c9`, `evidence-01452dba0826308a`

Counterevidence: `evidence-470bf9e1be24f22f`, `evidence-8d75fc31a29101ca`, `evidence-024190cc32639718`

Falsification: Compare exact-vocabulary retrieval with behavior-expanded retrieval under identical budgets. If the expanded strategy does not increase admission of relevant committed declarations, vocabulary mismatch is not the operative cause.

Limitations: Zero-hit searches establish retrieval outcomes, not that suitable implementation existed.; Semantic equivalence between differently named structures remains partly model interpretation.

## Planned Change

The plan below is model-generated and remains unverified. It is recorded before execution so the result can be evaluated against the original intervention.

> The unverified diagnosis records zero-hit or irrelevant results when discovery used requirement-shaped identifiers, while broader behavioral searches sometimes recovered committed source. Supporting evidence is evidence-002bdcb13cf682f0, evidence-026586bda98679c9, and evidence-01452dba0826308a; counterevidence shows existing discovery sometimes succeeded. Zero hits do not prove suitable behavior existed, and semantic equivalence remains model interpretation.

Implementation instructions:
> Change only query construction: deterministically add one bounded query derived from behavioral predicates, inputs, outputs, and neighboring operations. Keep retrieval, hydration, evidence limits, adjudication, and source-validation rules unchanged. Compare exact-only and behavior-expanded retrieval receipts. Falsify the hypothesis if expanded queries do not admit additional relevant committed declarations under identical budgets.

Expected impact: Improve discovery of differently named implementations without weakening source-backed eligibility or directly steering dispositions.

Risk: Behavior expansion may retrieve semantically adjacent but ineligible code, increasing noise or false reuse unless callable-boundary verification rejects it.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr47-3 |
| Variant | trumark-deceased-accounts-pr47-3-v002 |
| Parent | trumark-deceased-accounts-pr47-3-v001 |
| Round | 1 |
| Status | review |
| Planner seed | `a24baf79e777b07a3b55d027dc5ea5a8701e6af8` |
| Workflows source | `140ec306bff8c20aa9eccde3cc2f4647ce790655` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v002/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr47-3-9c00fe3066-2` |
| Artifact collection | complete |

## Baseline Metrics

| Metric | Parent | Observed | Delta |
| --- | ---: | ---: | ---: |
| Build units | 83 | 97 | +14 |
| Reuse units | 1 | 0 | -1 |
| Extend units | 25 | 12 | -13 |
| Defer units | 16 | 16 | 0 |
| Question units | 0 | 0 | 0 |
| Decision agreement | 83.2% | 92.0% | +8.8 pp |
| Selected source references | 40 | 20 | -20 |
| Verified accuracy | unavailable | unavailable | unavailable |
| Provisional accuracy | 24.8% | 19.2% | -5.6 pp |

## Actual Facts

| Decision | Count |
| --- | ---: |
| build | 97 |
| reuse | 0 |
| extend | 12 |
| defer | 16 |
| question | 0 |

| Metric | Value |
| --- | ---: |
| Requirement units | 125 |
| Replicates | 2 |
| Unanimous unit decisions | 92.0% |
| Empty shortlists | 68 |
| Candidate occurrences | 72 |
| Discovered evidence | 260 |
| Selected source references | 20 |
| Model calls | 699 |
| Total tokens | 9621954 |
| Cost USD | 32.0514 |
| Model duration ms | 4876543 |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 125 |
| Provisional errors | 101 |
| Provisional accuracy | 19.2% |
| Persisted labels | 241 |
| Cohort pin mismatches | analysis pins |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard primary (comparison control) | reference (standard measurement) | 125 | 97 | 0 | 12 | 16 | 0 | 92.0% |
| Target-excluded | measured | 125 | 104 | 0 | 5 | 16 | 0 | 97.6% |

The standard primary measurement is referenced as comparison normal. No additional control execution was run. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `measured`

This section is generated from persisted measurements. It does not treat model diagnosis or blind-judge suggestions as verified truth.

The result is not causally comparable with its parent because of: analysis pins.

Correctness remains unverified because no human-verified labels score this experiment. Provisional accuracy is an LLM suggestion only.

The standard-primary reference and target-excluded comparison is failed; the conclusion is incomplete until it finishes.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> Chunk 1: The planner substantially under-read the frozen checkout. Most requested behavior already exists in the TruMark deceased-accounts workflow and should be reused or extended rather than built anew. The three explicit exclusions were correctly deferred.
> Chunk 2: The frozen checkout already implements most core deceased-account behavior. Eight units retain genuine gaps or need extension; the remainder were missed existing capability.
> Chunk 3: The frozen checkout already contains a substantial TruMark deceased-accounts workflow. Most build decisions missed exact or partial customer-specific capabilities and should be reuse or extend. Explicit scope exclusions remain defer decisions.
> Chunk 4: The planner correctly identified several genuine additions, but repeatedly overlooked the frozen checkout's substantial deceased-account implementation, including Visa handling, dividend proration, per-type counts, PII-safe routing, and both workflow triggers.
> Chunk 5: The planner correctly identified several genuine gaps, but repeatedly chose build where the frozen checkout already contains reusable or extensible deceased-account capabilities. The strongest misses are the unified result, tracking-entry rendering, date-of-death handling, record eligibility, calculations, counts, and Visa descriptions.
> Chunk 6: The frozen checkout already implements most deceased-account calculations. The planner repeatedly treated existing domain logic as absent rather than identifying reuse or extension points. Explicitly excluded work remains correctly deferred; only selected posting-detail exposure is a correctly identified implementation gap.
> Chunk 7: All five build decisions overlook existing capability. The email route is already implemented end-to-end; the four field requirements have substantial but differently shaped or incomplete implementations that should be extended rather than rebuilt.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `completed`

Input hash: `sha256:8c65f76526ca55bfc6de2cba029001f6a22ab2b476a40d16e2302843692d3d8a`

Result hash: `sha256:a0bc404eea849c488a41846d0d6d1e5013b0f1aadfa074f28c25304f4dbfbb3b`

> The retained evidence suggests under-reuse is primarily caused by search-query mismatch, downstream evidence rejection, and unstable interpretation of admitted evidence, rather than KB or transcript infrastructure failure. Confidence was often high despite weak or rejection-heavy grounding. These conclusions are unverified model interpretations, not human-verified truth.

### finding-search-query-semantic-miss: source_discovery

Confidence: `high`

> Schema-V2 searches completed successfully, but exact-identifier and broad requirement-language queries returned either no hits or unrelated declarations. The adjudicator consequently treated existing behavior as absent. Separate blind-judge interpretations cite frozen implementation evidence for the same units, making semantic retrieval mismatch a falsifiable explanation rather than a KB outage.

Supporting evidence: `evidence-91d830b904f30c01`, `evidence-6a2a363e752b1437`, `evidence-5bece13361db7ebe`, `evidence-463b8aea8bd823e1`, `evidence-470bf9e1be24f22f`, `evidence-00dde19a88da6b03`

Counterevidence: `evidence-127898c218b79e46`, `evidence-1d090166ff200ecf`

Falsification: Replay the affected units with the same pins and budget, changing only query generation and reranking. Reject this finding if relevant committed evidence is still not retrieved or if improved retrieval does not reduce unsupported build decisions.

### finding-hydration-rejection-bottleneck: evidence_hydration

Confidence: `high`

> Durable schema-V2 records show successful searches and source-read attempts followed by zero admitted evidence because hits were classified as malformed or non-executable. The deterministic hydrator applies format, path, declaration, duplication, and capacity gates before evidence reaches adjudication. Thus the loss occurs after KB retrieval, not because the KB was unavailable.

Supporting evidence: `evidence-fc6cf50be2410c69`, `evidence-e8a0ba07e11806e5`, `evidence-56e714bc21cd3f7c`, `evidence-05108849ab2cf6a8`, `evidence-657a48b5eddec6f5`

Counterevidence: `evidence-127898c218b79e46`, `evidence-d3429b2bd321923a`

Falsification: Replay recorded tool results through an instrumented hydrator. Reject this finding if normalization and fallback admission produce no additional relevant committed snippets or if admitted snippets do not alter adjudication quality.

### finding-evidence-selection-instability: replicate_instability

Confidence: `high`

> Persisted replicates changed decisions for multiple units. For representative units, runs with similar admitted-source, test, and search counts alternated between build with no selected discovery and extend with a selected discovery. This indicates that final evidence selection and interpretation, not merely retrieval availability, can change the decision.

Supporting evidence: `evidence-9a7f4b8fd7484391`, `evidence-2028c2d0e4cb9ed7`, `evidence-d3429b2bd321923a`, `evidence-37e7c19a63a06e4d`, `evidence-b15fa56a5a20d884`

Counterevidence: `evidence-c10227ba197ee96c`, `evidence-127898c218b79e46`

Falsification: Run repeated adjudications over an identical frozen evidence bundle. Reject this finding if candidate selection and decisions remain invariant, or if observed variation is fully explained by different admitted snippets.

### finding-overconfident-negative-conclusions: confidence_calibration

Confidence: `medium`

> Several build decisions were marked high confidence despite empty shortlists, no selected discovered evidence, or rejection-heavy search receipts. Blind-judge interpretations independently suggested existing or extendable behavior. The confidence signal therefore appears insufficiently conditioned on evidence coverage and rejection quality.

Supporting evidence: `evidence-933940d6170ce0eb`, `evidence-716bb197c948f6eb`, `evidence-470bf9e1be24f22f`, `evidence-fc6cf50be2410c69`, `evidence-58f6552d23ea5b15`

Counterevidence: `evidence-d3429b2bd321923a`, `evidence-127898c218b79e46`, `evidence-46c7b06276faa1c1`

Falsification: Evaluate calibration on human-reviewed labels across repeated runs. Reject this finding if high-confidence negative conclusions have accuracy comparable to high-confidence source-backed decisions after controlling for evidence coverage.

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
| Planner questions | 8 |
| Planner requirements-agent requests | 8 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner PM-simulation answers | 7 |
| Planner reused answers | 1 |
| Planner human answers | 0 |

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

#### question.49d1a786ea804163fbf29672

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC?

Answer:
> Use `HELOC L<loan number>$ <amount>`, with leading zeros removed and the amount shown as a plain decimal with two digits, no commas or additional dollar sign. Example: `HELOC L1$ 49529.28`.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.8881469fbdd059737bb8b28e

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> Is an approved Symitar connection available with read access to member, death, deposit, non-mortgage consumer-loan, Visa, and tracking data?

Answer:
> Yes, all required read access is available through the approved read-only connection.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.291b1b00d95dc30ccb2d3a09

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> Which account record types are approved to display the member account number, member name, and date of death?

Answer:
> Both the customer-facing deceased-account record and the draft/internal deceased-account-internal record are approved to display those fields.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.013fe9735ed4d365b443a27b

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> Which Symitar record rule determines whether the current balance uses a dated or undated balance?

Answer:
> Use the latest Symitar transaction on or before the date of death that contains a New Balance; that produces a dated balance using its effective date. If no qualifying transaction exists, the current balance is undated and may be used only when retained history covers the death month, no later balance-bearing transaction exists, and the current balance is zero; otherwise require review or the archived statement.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.ba52bb9f40c1767ef733e2f4

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact keyable format should be used for a HELOC principal value, including the required `HELOC ` prefix and placement of the amount or other text?

Answer:
> Use `HELOC L{loan-number}$ {value}`, for example `HELOC L1$ 49529.28`. Put the two-decimal amount after the `$` with no currency symbol or commas; use `needs review` in that same position when unavailable.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.d5e10766bf02dcd7f79e030b

Resolution: `reused_source_answer`

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC?

Answer:
> Use `HELOC L<loan number>$ <amount>`, with leading zeros removed and the amount shown as a plain decimal with two digits, no commas or additional dollar sign. Example: `HELOC L1$ 49529.28`.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.8528f17e94ab7fc064b93a65

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> Which member PII, if any, must appear in the task result, given that next-of-kin name, address, phone, and relationship must be excluded?

Answer:
> The task result must include the deceased member’s name, account number, and date of death. No next-of-kin or other contact details should appear.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.49fb77d8a0ebffdd8c45d59c

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact keyable output format is required for a HELOC principal, including placement of the `HELOC ` prefix and the principal value?

Answer:
> Use `HELOC L<loan-number>$ <principal>`, with `HELOC ` at the start and the principal as an ungrouped decimal with two digits, e.g. `HELOC L1$ 49529.28`.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

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
| Planner source fallback answers | 0 |
| Planner PM-simulation answers | 1 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

#### question.fa09617799688cc3e0423dd1

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What are the approved alpha and numeric return-reason mapping tables the workflow must use?

Answer:
> Alpha: A=NSF; B=UCF; C=Stop Payment; D=Closed Account; E=UTLA; F=Frozen/Blocked Account; G=Stale Dated; H=Post Dated; I=Endorsement Missing; J=Endorsement Irregular; K=Signature(s) Missing; L=Signature(s) Irregular, Suspected Forgery; M=Non-Cash Item (Non-Negotiable); N=Altered/Fictitious Item/Suspected Counterfeit/Counterfeit; O=Unable to Process; P=Item outside of stated dollar amount limit; Q=Not Authorized; R=Branch/Account Sold (Wrong Bank); S=Refer to Maker; T=Item cannot be re-presented; U=Unusable Image; V=Image Fails Security Check; W=Cannot determine Amount; X=Refer to Image; Y=Duplicate Presentment; Z=Forgery; 3=Warranty Breach; 4=RCC Warranty Breach (Rule 8); 5=Forged and Counterfeit Warranty Breach (Rule 9); 6=Retired/Ineligible/Failed Institution Routing Number. Numeric: 1/01=NSF; 2/02=Closed Account; 3/03 and 4/04=UTLA; 5/05 and 36=Endorsement Missing; 8/08=Stop Payment; 9/09=UCF; 16=Frozen/Blocked Account; 18=Post Dated; 19=Endorsement Irregular; 20=Signature(s) Missing; 21=Signature(s) Irregular, Suspected Forgery; 22=Non-Cash Item (Non-Negotiable); 23=Item outside of stated dollar amount limit; 24=Not Authorized; 25=Branch/Account Sold (Wrong Bank); 26=Refer to Maker; 27=Cannot determine Amount; 28=Forgery; 29=Warranty Breach; 51/57=NSF; 52/62/67=UCF; 54=Stop Payment; 55=UTLA; 56=Closed Account; 60=Altered/Fictitious Item/Suspected Counterfeit/Counterfeit; 65=Stale Dated; 68=Refer to Maker; 72=Unusable Image; 74=Duplicate Presentment; 77=Item cannot be re-presented; 78=Refer to Image; 79=RCC Warranty Breach (Rule 8); 80=Forged and Counterfeit Warranty Breach (Rule 9); 81=Retired/Ineligible/Failed Institution Routing Number.

Evidence:
- src/customers/catalyst/cheque-verification-combined/types.ts:67-99
- src/customers/catalyst/cheque-verification-combined/types.ts:151-233
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:219-230

## Holdout

- catalyst-cheque: 2 runs, 87.1% unanimous decisions; 116 units; build=95, reuse=0, extend=12, defer=9, question=0; verified=unscored, provisional=8.6%

## Target-Excluded Guard

Status: `failed`

Gate: `pending`

Baseline mean build rate: unscored

Candidate mean build rate: unscored

Build-rate drop: unscored

Pair validity: valid

Leakage paths: 0

Protocol: `standard-primary-v2`

Standard primary (comparison control) reference: benchmark `deceased-account`, resolved artifact `sha256:ea37e334c9e63df68af692fc8d6555797fd72955ed6070ca1f74759672d78eff`, lineage replicate 1 case `6EMCSGQQ2WZCPEH825MQV5VY05` run `run.a9ceb7de3d240063d3d15b35`; replicate 2 case `0P0B5P5WK775FG5BT821ZGW7WW` run `run.f6c37f420a612b037ce39586`

No additional control execution was run; the standard primary measurement is reused as comparison normal.

Excluded decisions: build=104, reuse=0, extend=5, defer=16, question=0

Comparison lineage: replicate 1: normal case `6EMCSGQQ2WZCPEH825MQV5VY05` run `run.a9ceb7de3d240063d3d15b35`, excluded case `4YZAMKJXKGZ0X4Q7GNTYTANAQ4` run `run.5823e6a6ea1a84f240d1dd0f`; replicate 2: normal case `0P0B5P5WK775FG5BT821ZGW7WW` run `run.f6c37f420a612b037ce39586`, excluded case `7XHJX1Y2JRRSAS73GGZPEK7VZT` run `run.a7474a71e00a4562e310c945`

Comparison mismatches: none

Recorded error: `target-blind judge referenced the excluded implementation`

Target-arm questions: 15

- excluded: What exact text format should the Key into Symitar summary use for a HELOC row under Tracking 53? -> Use `HELOC L{loan number}$ {amount}`, for example `HELOC L1$ 49529.28`. Remove leading zeros from the loan number and format the amount with exactly two decimals, no currency symbol or thousands separators. (pm_simulation)
- excluded: Which approved Symitar connection and credential reference should the workflow use, and is it read-only with access to every listed data category? -> Use TruMark’s existing production SymXchange connection through the managed Saris integration, with the credential reference already bound to that customer integration; do not supply separate credentials. It must be read-only and authorized for all requested account, tracking, share, transaction, loan, name, application, transfer, and external-loan data. (pm_simulation)
- excluded: What exact keyable format should be used for HELOC principal values, including the prefix, spacing, and amount/date layout? -> Use `HELOC L<loan-number>$ <amount>`, with single spaces, an unpadded loan number, and an amount formatted as plain dollars with two decimals, no commas or additional `$` (for example, `HELOC L1$ 49529.28`). Do not append a date. (pm_simulation)
- excluded: What exact text format should be used for a HELOC row in the Key into Symitar summary? -> Use `HELOC L{loan number}$ {amount}`, for example `HELOC L1$ 49529.28`. Use two decimal places with no leading dollar sign or thousands separator; substitute `needs review` when the amount is undetermined. (pm_simulation)
- excluded: What calculation and evidence rules determine prorated_dividend for each eligible share or certificate? -> For each share or certificate funded on or before death, sum valid dividend postings in the death month and prorate them over that month’s earning window, clipped by funding and closure dates, counting the death date as a full day. If nothing has posted, use a live Closing Dividend accrual divided by days accrued through the day before the run, multiplied by days lived through death; round half up to the nearest cent. Use only confirmed dividend transactions, report zero only when no dividend is provably due, and otherwise leave the amount undetermined when accrual or history evidence is incomplete. (pm_simulation)
- excluded: What approved Symitar connection, environment, and read-only credential scopes should the workflow use to access member, death, deposit, consumer-loan, Visa, and tracking data? -> Use the production deployment’s configured SymXchange connection profile. Its service identity must be limited to read-only account select-fields for member and account data, deceased Tracking 50, deposits and share transactions, internal consumer-loan records and history, external Visa loan and tracking data, and Tracking 51 through 53; the exact environment, profile, and credentials are deployment-provided, and no Symitar write permission is allowed. (human_answer)
- excluded: What formatting rule should produce the keyable value for each record type from the approved amount, including which figures are unsupported? -> Convert cents to plain dollars with exactly two decimals, no currency symbol or thousands separators. Use `s<number>$ amount` for shares and certificates, adding `IRA ` for IRA/Roth certificates; use optional `HELOC L<number>$ amount` for loans and `VISA $ amount` for cards, with the card description in a separate column. Use `needs review` instead of zero when unavailable; backdated card balances and loan/card interest figures are unsupported. (pm_simulation)

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr47-3/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v002/deceased-account/facts.json` | archived |
| Parent measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/deceased-account/facts.json` | archived |
| Diagnosis input | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v002/diagnosis/diagnosis-input-8c65f76526ca55bfc6de2cba029001f6a22ab2b476a40d16e2302843692d3d8a.json` | completed |
| Model diagnosis | `model_inference` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v002/diagnosis/diagnosis-result-8c65f76526ca55bfc6de2cba029001f6a22ab2b476a40d16e2302843692d3d8a.json` | completed |
| Target-excluded comparisons | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v002/target-excluded/comparisons/` | failed |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
