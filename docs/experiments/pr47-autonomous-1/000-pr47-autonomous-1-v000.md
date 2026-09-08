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

## Investigation

Enabled; no investigator session recorded for this variant. Baseline evaluation is separate.

## Hypothesis Compliance Preflight

This preflight is a model-generated semantic review and is never measured or human-verified truth.

Status: `not_required`

No compliance result is available.

### Attempt History

No append-only attempt history exists for this legacy result.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | pr47-autonomous-1 |
| Variant | pr47-autonomous-1-v000 |
| Parent | none |
| Round | 0 |
| Status | completed |
| Planner seed | `a24baf79e777b07a3b55d027dc5ea5a8701e6af8` |
| Workflows source | `140ec306bff8c20aa9eccde3cc2f4647ce790655` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/private/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v000/variant.patch` |
| Patch hash | `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Image | `ainative-planner-eval:pr47-autonomous-1-b742451367-0` |
| Artifact collection | complete |

## Baseline Metrics

No parent metrics exist. This experiment establishes a campaign-local baseline.

## Actual Facts

Consensus decision counts and agreement describe the final cohort only, not trial scores. Raw-replicate mean accuracy is reported separately.

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
| Unanimous unit decisions | 77.6% |
| Empty shortlists | 68 |
| Candidate occurrences | 72 |
| Discovered evidence | 317 |
| Selected source references | 47 |
| Model calls | 664 |
| Total tokens | 14694809 |
| Cost USD | 49.7546 |
| Model duration ms | 4864337 |

## Score Basis

Accuracy and errors use the raw-replicate mean against a shared label reference, not majority-consensus accuracy. Missing labeled units count as errors; a missing accuracy is unknown, not zero. Consensus decisions and agreement remain descriptive observations. Normal scoring uses persisted baseline provisional labels; excluded scoring uses its separate baseline judgment and labels. Human-verified labels retain precedence. Fresh candidate judgments are interpretations, not a replacement baseline reference. Trial label snapshots are hash-bound in investigator context; final score-basis artifacts record the labels used at scoring time.

Runtime answers are not globally frozen. Question audits, decision-set hashes, and cohort-comparison artifacts diagnose context differences; matching input pins alone do not establish strict replay.

Per-benchmark score-basis.json and cohort-comparison.json files remain in the ignored artifact archive; target-excluded scoring keeps its own reference.

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 125 |
| Provisional errors | 81 |
| Provisional accuracy | 35.2% |
| Persisted labels | 241 |
| Cohort pin mismatches | none |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard primary (comparison control) | reference (standard measurement) | 125 | 83 | 1 | 25 | 16 | 0 | 77.6% |
| Target-excluded | measured | 125 | 101 | 0 | 8 | 16 | 0 | 96.8% |

The standard primary measurement is referenced as comparison normal. No additional control execution was run. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `measured`

This section is generated from persisted measurements. It does not treat model diagnosis or blind-judge suggestions as verified truth.

This run establishes a baseline observation; it does not establish that the planner decisions are correct or that the planner improved.

Correctness remains unverified because no human-verified labels score this experiment. Provisional accuracy is an LLM suggestion only.

The target-excluded promotion guard is passed.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> Chunk 1: Static review found extensive existing TruMark deceased-accounts capability. Most build decisions overlooked production logic already covering the requirement and should be reuse or extend. Explicit exclusions were correctly deferred; two genuine additions remain.
> Chunk 2: Static review found extensive existing TruMark deceased-account capability. Most build decisions should be extend or reuse; one observed extend reflects a genuine remaining presentation gap.
> Chunk 3: Static review found substantial existing TruMark deceased-accounts capability. Twelve planner decisions missed reusable or extendable production code, three correctly identified genuine extension gaps, and five scope exclusions are classified uncertain because the required enum has no no-error classification.
> Chunk 4: Static review found substantial existing TruMark deceased-accounts capability that the planner repeatedly missed. Fifteen build decisions should instead reuse or extend committed production behavior; three units represent genuine new work; two exclusions are correctly deferred.
> Chunk 5: Static review found substantial existing deceased-accounts capability that the planner overlooked. Several build decisions should be extend or reuse; genuine gaps remain around required DOD enforcement, next-of-kin fields, exact counters, formatting, and exposed basis data.
> Chunk 6: Static review found substantial existing deceased-accounts capability that the planner overlooked. Several new field contracts still require extensions, while explicit later-version exclusions are correctly deferred.
> Chunk 7: Four planner decisions missed existing capability that should be reused or extended; dividend_basis_days correctly requires extension.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `completed`

Input hash: `sha256:f00198a6d9cd7584616212a1a0109f30e4f0e2c7d42d6496bd2cad9574f5cd23`

Result hash: `sha256:f1db378d4b9ed4c03efd79a4d9840ad1252c51df8216a51992082aac90432dfa`

> The measured behavior is more consistent with narrow deterministic candidate matching, capacity-sensitive evidence hydration, and overconfident replicate variability than with KB unavailability. Durable records show successful searches and source reads, but many candidates were rejected or not selected. All causal interpretations remain unverified model judgments.

### finding-narrow-shortlist-fallback: candidate_ranking

Confidence: `medium`

> Deterministic ranking requires complete normalized-term matches or a minimum declared-input/output overlap. Semantically relevant requirements can therefore receive empty shortlists and become dependent on model-directed discovery. Durable examples then range from selecting discovered source as an extension to returning build after retrieved hits were rejected, making the final disposition sensitive to fallback interpretation rather than a stable initial candidate set.

Supporting evidence: `evidence-de0e2a9ec91f4543`, `evidence-259e52a98b4a71ed`, `evidence-917131fe30785596`, `evidence-68f50e2e8584d7f5`, `evidence-9bf00260f837bd6c`, `evidence-1226b7a2a8505592`, `evidence-988cc8ea1d564769`, `evidence-a46805d5fa3e70eb`

Counterevidence: `evidence-550508d220a1b379`, `evidence-feaba24b3c7d2b17`, `evidence-aceff156467de000`, `evidence-2950c73287cfe313`, `evidence-3c457a36cc395ef7`, `evidence-5b99fe01d6c9e06c`

Falsification: Replay the same pinned units with an expanded semantic shortlist but unchanged adjudication and evidence policy. Falsify the mechanism if empty-shortlist frequency falls without reducing model-judged errors or replicate disagreement.

### finding-capacity-sensitive-evidence-loss: evidence_retention

Confidence: `high`

> Hydration applies fixed file and byte quotas, admits at most one projected declaration per path, and stops after quotas are satisfied. Across measured funnels, searches and source reads succeeded, yet evidence-slot exhaustion and malformed-hit rejection removed large portions of retrieved candidates. For an observed changing unit, one replicate selected admitted evidence and returned extend while the other admitted less evidence, selected none, and returned build.

Supporting evidence: `evidence-d4d39407ec48103b`, `evidence-062aeec537543a6e`, `evidence-904b2c31fc24ba54`, `evidence-57b02be7477d4f31`, `evidence-cd80bd1a79267c04`, `evidence-4191859291f86980`, `evidence-319013cde46060c9`, `evidence-183888855ceef893`

Counterevidence: `evidence-05e42b71f37b44f6`, `evidence-093fb303087c5f81`, `evidence-01e6e3b1e1de85c3`, `evidence-d6b71465405cb4bf`

Falsification: Replay identical durable search results under larger and relevance-prioritized projection budgets. Falsify the mechanism if selected evidence and dispositions remain unchanged despite materially fewer slot-exhaustion rejections.

### finding-high-confidence-replicate-instability: confidence_calibration

Confidence: `high`

> With immutable inputs and pins, many units changed disposition across persisted replicates, including build-versus-extend and reuse-versus-build changes. Most sampled changes retained high confidence in at least one replicate. This indicates that confidence is primarily expressing within-run rationale strength rather than sensitivity to alternative retrieval and evidence-selection trajectories.

Supporting evidence: `evidence-7c6f12d3f3d19ff3`, `evidence-9a7f4b8fd7484391`, `evidence-319013cde46060c9`, `evidence-183888855ceef893`, `evidence-6869cb0466a7d8b3`, `evidence-1d62cdc0d7545b93`

Counterevidence: `evidence-c10227ba197ee96c`, `evidence-550508d220a1b379`, `evidence-feaba24b3c7d2b17`, `evidence-d50635740f89bea3`

Falsification: Run additional pinned replicates and compare confidence against decision agreement. Falsify the mechanism if high-confidence decisions exhibit materially higher agreement than medium-confidence decisions after controlling for evidence completeness.

## Requirements Questions

### deceased-account

| Metric | Count |
| --- | ---: |
| Blocking questions | 1 |
| Requirements-agent requests | 1 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| PM-simulation answers | 1 |
| Reused campaign answers | 0 |
| Planner questions | 5 |
| Planner requirements-agent requests | 5 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner PM-simulation answers | 4 |
| Planner reused answers | 1 |
| Planner human answers | 0 |

#### 01M1Q2R1VHAKDZHSQ7TQDBA8B2

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What is the approved Symitar connection endpoint/environment (e.g., production vs. test region) and the specific read-only credential scope (member, death, deposit, non-mortgage consumer-loan, Visa external-loan, and Tracking 50/51/52/53 records) that this workflow must be provisioned against for production enablement?

Answer:
> Use the live production Symitar integration; the exact endpoint, profile, and service identity are deployment-provided. Provision read-only access to member/account and death data, all deposits and transaction history, all returned internal loans and transactions, Visa external loans, and Tracking 50–53 records, with no Symitar write permissions.

Evidence:
- tools/deploy/config.json:29-36 identifies the approved live deployment environment
- src/modules/shared/api/symitar/client.ts:89-133 selects account, share, loan, external-loan, transaction, and tracking data through the configured proxy
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:14-21,162-239,242-443 maps death and Tracking 50/51/52/53 data
- src/customers/trumark/deceased-accounts/README.md:3-6 states the production behavior is recommendation-only and never writes to Symitar
- AGENTS.md:163-171 assigns integration endpoints and secrets to deployment-managed integration configuration

#### question.14858a61334f59f3c0632067

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact Tracking 53 row format should be used for a consumer loan whose Symitar description identifies it as a HELOC?

Answer:
> Use `HELOC L<n>$ <amount>`, where `<n>` is the loan ID without leading zeros and `<amount>` is plain dollars with two decimals, no dollar sign or comma. Example: `HELOC L1$ 49529.28`; use `needs review` instead of the amount if undetermined.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.d1e07d8904e2a5f086ec89cb

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact direction-neutral review reason should be shown when an open Visa death date and fixed balance-observed date fall in different months?

Answer:
> Needs review — the card record carries only its current balance, and the date of death does not fall in the month this case was run on or before the day it was run, so that balance is not the one held at the death.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.f64f439c50f4faa154d503f0

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact keyable format should be used for HELOC principal values?

Answer:
> Use `HELOC L<loan number>$ <dollars.cents>`, for example `HELOC L1$ 49529.28`. Use exactly two decimals, with no currency symbol before the amount and no thousands separators.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.912f0edcba4e6ed05a921ff3

Resolution: `reused_source_answer`

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC?

Answer:
> Use `HELOC L<loan-number>$ <balance>`, with the loan number unpadded and the balance as plain dollars with two decimals and no thousands separator, for example `HELOC L1$ 49529.28`. If undetermined, use `HELOC L1$ needs review`.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.15c243e4387d1608a5bc3522

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact keyable-value format should be used for a home-equity line of credit, including the prefix, spacing, and principal amount format?

Answer:
> Use `HELOC L1$ 49529.28`: `HELOC` + one space + `L` and the unpadded loan number immediately followed by `$` + one space + the principal amount with exactly two decimals, no commas, and no leading dollar sign.

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
| Planner questions | 0 |
| Planner requirements-agent requests | 0 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner PM-simulation answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

No blocking question required an answer.

## Holdout

- catalyst-cheque: 2 runs, 75.9% unanimous decisions; 116 units; build=63, reuse=4, extend=40, defer=9, question=0; verified=unscored, provisional=27.2%

## Target-Excluded Guard

Status: `completed`

Gate: `passed`

Baseline mean build rate: 79.2%

Candidate mean build rate: 79.2%

Build-rate drop: 0.0%

Pair validity: valid

Leakage paths: 0

Protocol: `standard-primary-v2`

Standard primary (comparison control) reference: benchmark `deceased-account`, resolved artifact `sha256:9b0e81c6caeb416f0dc72ad46848e81d60649c7a3e89cd873b5ae896e08b8777`, lineage replicate 1 case `0YZZCQM0QG2Y6JX1FCY1QGRJZG` run `run.df46392984d00913005b3570`; replicate 2 case `63WSD5H3EWHD7C0ZAH8C45C7JM` run `run.5ba3c6c1d556285bd485ec62`

No additional control execution was run; the standard primary measurement is reused as comparison normal.

Excluded decisions: build=101, reuse=0, extend=8, defer=16, question=0

Comparison lineage: replicate 1: normal case `0YZZCQM0QG2Y6JX1FCY1QGRJZG` run `run.df46392984d00913005b3570`, excluded case `0GQ5VYX6E9R49KDW1QXC2W2RXK` run `run.095deda6143560392b6507b5`; replicate 2: normal case `63WSD5H3EWHD7C0ZAH8C45C7JM` run `run.5ba3c6c1d556285bd485ec62`, excluded case `528WPSHFJ7AAPKDDM6ESF1RHA2` run `run.2c74b3702a7249931d4d55e1`

Comparison mismatches: none

Recorded error: none

Target-arm questions: 10

- excluded: What exact row format should be used for a consumer loan whose Symitar description identifies it as a HELOC in the Key into Symitar summary? -> Use `HELOC L<loan number>$ <balance>`, for example `HELOC L1$ 49529.28`. Remove leading zeros from the loan number and do not include the Symitar description itself. (pm_simulation)
- excluded: Which member PII fields must appear in the task result, given that next-of-kin name, address, phone, and relationship must be excluded? -> Include only the deceased member’s account number, name, and date of death. Exclude all next-of-kin details. (pm_simulation)
- excluded: What exact keyable-value format must be used for a HELOC principal, including the `HELOC ` prefix, amount formatting, spacing, and any effective-date text? -> Use `HELOC L<loan-number>$ <amount>`, for example `HELOC L1$ 49529.28`. Include one space after `HELOC` and after the `$`; format the amount with exactly two decimals, no currency symbol, and no thousands separators. Do not include effective-date text in the keyable value. (pm_simulation)
- excluded: What exact text format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC? -> Use `HELOC L<loan-number>$ <balance>`, with the loan number unpadded and the balance as plain dollars with two decimals and no thousands separator, for example `HELOC L1$ 49529.28`. If undetermined, use `HELOC L1$ needs review`. (pm_simulation)
- excluded: What exact keyable text format should be used for an in-scope home-equity line of credit, including the `HELOC ` prefix and principal value? -> Use `HELOC L{loan-number}$ {principal}`, with the loan number unpadded and principal as plain dollars to two decimal places, without commas or another dollar sign. Example: `HELOC L1$ 49529.28`. (pm_simulation)

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/campaigns/pr47-autonomous-1/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v000/deceased-account/facts.json` | archived |
| Diagnosis input | `deterministic_reconstruction` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v000/diagnosis/diagnosis-input-f00198a6d9cd7584616212a1a0109f30e4f0e2c7d42d6496bd2cad9574f5cd23.json` | completed |
| Model diagnosis | `model_inference` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v000/diagnosis/diagnosis-result-f00198a6d9cd7584616212a1a0109f30e4f0e2c7d42d6496bd2cad9574f5cd23.json` | completed |
| Target-excluded comparisons | `deterministic_reconstruction` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v000/target-excluded/comparisons/` | completed |
| Human labels | `human_verified` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
