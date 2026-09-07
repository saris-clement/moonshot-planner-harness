# Deterministic evidence selection replay

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

- Unverified: the admitted evidence pool already contains sufficient relevant declarations for a meaningful subset of unstable units.
- Unverified: generic relevance and source-role metadata can select evidence without encoding desired decisions.
- Unverified: identical evidence and context will materially reduce variance if selection instability is the dominant mechanism.

## Observed Issues

### finding-model-controlled-evidence-boundary-causes-instability: replicate_instability

Authority: `unverified_model_judgment`

> Replicates shared the frozen input and knowledge snapshot but differed in accumulated decision context and in model-controlled query wording, evidence selection, and interpretation. Several units moved between build and reuse-or-extend when relevant committed declarations were selected in only one run.

Proposed generic intervention: Evaluate adjudication with deterministic pre-hydrated evidence, fixed ordering, and an explicitly pinned decision context, while logging whether each declaration was available and selected.

Supporting evidence: `evidence-9a7f4b8fd7484391`, `evidence-8d75fc31a29101ca`, `evidence-d7c6c8ea3cf6aab4`, `evidence-470bf9e1be24f22f`

Counterevidence: `evidence-024190cc32639718`, `evidence-614ff5e3a1221048`, `evidence-069bb218b3ddcc3a`

Falsification: Replay affected units with identical admitted snippets, ordering, prompts, budgets, and decision context. Persistent disposition changes would falsify retrieval and context variance as the dominant cause and isolate adjudicator interpretation.

Limitations: Only two primary replicates were captured.; Compact replicate facts are durable but integrity-unverified.; Stable counterexamples show that instability is localized rather than universal.

## Planned Change

The plan below is model-generated and remains unverified. It is recorded before execution so the result can be evaluated against the original intervention.

> The unverified diagnosis reports that frozen-input replicates differed in model-controlled evidence selection and accumulated context, with dispositions changing when relevant committed declarations were selected in only one run. Supporting evidence is evidence-9a7f4b8fd7484391, evidence-8d75fc31a29101ca, evidence-d7c6c8ea3cf6aab4, and evidence-470bf9e1be24f22f; stable counterexamples and only two primary replicates limit the claim.

Implementation instructions:
> Change only the admitted-evidence boundary: select snippets deterministically from the existing admitted pool using fixed ordering and source-role/relevance metadata, then provide identical decision context across replicates. Do not change discovery, hydration budgets, prompts, disposition rules, or eligibility checks. Log available versus selected declarations. Falsify the hypothesis if dispositions remain unstable with identical snippets, ordering, prompts, budgets, and context.

Expected impact: Separate retrieval availability from model selection and test whether a fixed evidence boundary improves repeatability and source-supported interpretation.

Risk: A deterministic selector may consistently omit evidence that model-directed exploration would have found, producing stable but incorrect adjudications.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr47-3 |
| Variant | trumark-deceased-accounts-pr47-3-v004 |
| Parent | trumark-deceased-accounts-pr47-3-v001 |
| Round | 1 |
| Status | rejected |
| Planner seed | `a24baf79e777b07a3b55d027dc5ea5a8701e6af8` |
| Workflows source | `140ec306bff8c20aa9eccde3cc2f4647ce790655` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v004/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr47-3-9c00fe3066-4` |
| Artifact collection | complete |

## Baseline Metrics

| Metric | Parent | Observed | Delta |
| --- | ---: | ---: | ---: |
| Build units | 83 | 84 | +1 |
| Reuse units | 1 | 1 | 0 |
| Extend units | 25 | 24 | -1 |
| Defer units | 16 | 16 | 0 |
| Question units | 0 | 0 | 0 |
| Decision agreement | 83.2% | 81.6% | -1.6 pp |
| Selected source references | 40 | 44 | +4 |
| Verified accuracy | unavailable | unavailable | unavailable |
| Provisional accuracy | 24.8% | 24.8% | 0.0 pp |

## Actual Facts

| Decision | Count |
| --- | ---: |
| build | 84 |
| reuse | 1 |
| extend | 24 |
| defer | 16 |
| question | 0 |

| Metric | Value |
| --- | ---: |
| Requirement units | 125 |
| Replicates | 2 |
| Unanimous unit decisions | 81.6% |
| Empty shortlists | 68 |
| Candidate occurrences | 72 |
| Discovered evidence | 298 |
| Selected source references | 44 |
| Model calls | 656 |
| Total tokens | 13783757 |
| Cost USD | 42.3755 |
| Model duration ms | 4159590 |

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
| Standard primary (comparison control) | reference (standard measurement) | 125 | 84 | 1 | 24 | 16 | 0 | 81.6% |
| Target-excluded | measured | 125 | 101 | 0 | 8 | 16 | 0 | 98.4% |

The standard primary measurement is referenced as comparison normal. No additional control execution was run. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `measured`

This section is generated from persisted measurements. It does not treat model diagnosis or blind-judge suggestions as verified truth.

The parent and candidate requirement cohorts are comparable. The measured deltas above are descriptive until correctness is human-verified.

Correctness remains unverified because no human-verified labels score this experiment. Provisional accuracy is an LLM suggestion only.

The target-excluded promotion guard is passed.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> Chunk 1: The planner repeatedly missed substantial existing TruMark deceased-accounts capability. Most affected units should reuse or extend the frozen implementation rather than build independently. Explicit exclusions remain deferred.
> Chunk 2: The frozen checkout already contains most deceased-account workflow behavior. The planner repeatedly chose build where existing production code supports reuse or extension. Two observed extend decisions reflect genuine gaps; one reuse decision is supported but cannot be cleanly classified under the provided error-only taxonomy.
> Chunk 3: The planner correctly identified eight genuine gaps or exclusions, but made twelve system errors by overlooking substantial or complete TruMark deceased-accounts capabilities already present in the frozen checkout. Most missed capabilities support extend rather than build because required values are computed internally but not exposed under the requested contract.
> Chunk 4: The frozen checkout already implements most Visa, dividend, result-breakdown, routing, count, confidentiality, and trigger behavior. Several build decisions therefore missed substantial or complete production capability. Genuine gaps remain for next-of-kin fields and a few explicit output/provenance fields.
> Chunk 5: The planner materially under-recognized the frozen checkout. Most requested behavior already exists or has direct partial extension points. One genuine implementation gap remains; three scope exclusions are correctly deferred and classified uncertain because they represent neither planner errors nor required implementation gaps.
> Chunk 6: The frozen checkout already implements most deceased-account calculations and both intake paths. The planner frequently classified existing or partial capabilities as new builds. Scope-only deferrals are correct but do not fit the gap/error taxonomy cleanly.
> Chunk 7: All five decisions understate existing frozen-checkout capability. The email route is already implemented; the four fields have partial or internal equivalents that should be extended rather than built independently.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `completed`

Input hash: `sha256:b58126d45967dd95b72a44f502cbbcb7fd6b57ccb114fb194deddf981f0d3712`

Result hash: `sha256:66636c107257f4f25f75e7fe5c7b113acdb245c6259a2ef95ff271c8317eb289`

> The strongest bounded hypothesis is that successful repository research is followed by lossy, query-sensitive evidence admission. Because reuse and extension require an admitted source-backed candidate, variations in search results, malformed pointers, unsupported evidence, and exhausted projection capacity can force otherwise similar runs across the build, extend, and reuse boundaries. Confidence does not reliably reflect this retrieval sensitivity. Target exclusion reduces instability and increases build decisions, but its passed guard establishes protocol validity rather than semantic correctness.

### finding-evidence-admission-bottleneck: evidence_hydration

Confidence: `high`

> Durable searches and committed-source reads succeeded, but candidate records were subsequently rejected through malformed-hit, unsupported-path, declaration, or projection-capacity rules. The frozen planner contract permits reuse or extension only when at least one selectable source-backed candidate is admitted, so downstream rejection can constrain the remaining decision to build even when research returned relevant material.

Supporting evidence: `evidence-31931c30b9e8089d`, `evidence-08a40867a2ef0a20`, `evidence-bee9177ef909d0b2`, `evidence-66ace54a12ad8639`, `evidence-4f3c77fb2c4a77e4`, `evidence-de8653b463646711`, `evidence-a1d7a42bef1c71c9`, `evidence-723d101138fd9b24`, `evidence-b1ff55168b7fb0da`

Counterevidence: `evidence-614ff5e3a1221048`, `evidence-024190cc32639718`, `evidence-021bc8bf71dda48e`

Falsification: Replay the pinned units with only pointer normalization, evidence ordering, and admission capacity changed. Falsify this mechanism if candidate admission rises materially without reducing build decisions, or if the previously rejected evidence proves unrelated to the units.

### finding-query-sensitive-replicates: replicate_instability

Confidence: `high`

> Under matching immutable input, source, manifest, and knowledge pins, model-selected query terms produced different admitted candidate sets. Since candidate admission controls whether reuse or extension is structurally available, this retrieval variation propagated into build-versus-reuse or build-versus-extension changes.

Supporting evidence: `evidence-9a7f4b8fd7484391`, `evidence-bb357638b9f90c8c`, `evidence-04b7c518d0f30065`, `evidence-8d75fc31a29101ca`, `evidence-d7c6c8ea3cf6aab4`, `evidence-29da264640c57b81`, `evidence-725c99bd4c4e91d1`, `evidence-08484a666567b490`, `evidence-2aa57990acc5995d`

Counterevidence: `evidence-c10227ba197ee96c`, `evidence-03b6798401f5fabc`, `evidence-83bc407250c7838d`

Falsification: Run multiple identical-pin replicates with and without canonical retrieval. Falsify the finding if canonical retrieval does not increase candidate-set overlap or reduce per-unit decision changes, or if decisions remain equally unstable after candidate sets become stable.

### finding-confidence-not-retrieval-aware: confidence_calibration

Confidence: `medium`

> High confidence was assigned both to opposing replicate decisions and to repeated build decisions made after incomplete or rejected evidence admission. Confidence therefore appears to represent decisiveness over the visible evidence rather than robustness to retrieval completeness.

Supporting evidence: `evidence-8d75fc31a29101ca`, `evidence-d7c6c8ea3cf6aab4`, `evidence-29da264640c57b81`, `evidence-725c99bd4c4e91d1`, `evidence-08484a666567b490`, `evidence-2aa57990acc5995d`, `evidence-4f3c77fb2c4a77e4`, `evidence-de8653b463646711`, `evidence-2cf1c166c7d42c6b`, `evidence-4469606faeeb98d7`, `evidence-7587903baaee45e4`, `evidence-f24cb480918d7e6a`

Counterevidence: `evidence-c0c49334607a52c7`, `evidence-c59c5612f7900b65`, `evidence-c1cd3cc375c8141d`, `evidence-470bf9e1be24f22f`, `evidence-e230bf6ec481d8c1`, `evidence-00dde19a88da6b03`

Falsification: Calibrate confidence against repeated identical-pin runs and independently reviewed labels. Falsify the finding if high-confidence decisions exhibit materially lower replicate entropy and higher verified accuracy after controlling for unit difficulty and evidence availability.

### finding-target-source-dependence: source_discovery

Confidence: `medium`

> Several units were stably classified as reuse or extension when target implementation evidence was visible and stably classified as build when that evidence was excluded. The pinned workflow resolution also lacked an exact registered implementation, making free-form source discovery the decisive route to reuse evidence.

Supporting evidence: `evidence-bb357638b9f90c8c`, `evidence-04b7c518d0f30065`, `evidence-c0c49334607a52c7`, `evidence-c59c5612f7900b65`, `evidence-545bbbe79eca877b`, `evidence-a4c8a764ca332005`, `evidence-632b9d48adecdbda`, `evidence-b6f604cd715380c3`, `evidence-10e7b3e261612004`, `evidence-1bff0f871fe6b1ee`, `evidence-470bf9e1be24f22f`, `evidence-e230bf6ec481d8c1`, `evidence-07b2201524064070`, `evidence-5a02c907fd40ff06`

Counterevidence: `evidence-b8faaee987214217`, `evidence-c10227ba197ee96c`, `evidence-4e4ce889ce85d8ef`, `evidence-a670e15b1c168864`

Falsification: Add only generic, reviewed capability abstractions and rerun both arms. Falsify the finding if normal candidate discovery and replicate stability do not improve, or if any apparent excluded-arm improvement depends on target-source leakage.

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
| Planner questions | 4 |
| Planner requirements-agent requests | 4 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner PM-simulation answers | 4 |
| Planner reused answers | 0 |
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

#### question.87405e6a299d61e4feef1040

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan identified as a HELOC?

Answer:
> Use `HELOC L{loan number}$ {balance}`, with the zero-padding removed and the balance shown as plain dollars to two decimals, without a currency symbol or thousands separators. Example: `HELOC L1$ 49529.28`.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.ba767a22766fafdbe3db36cc

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact text format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC?

Answer:
> Use `HELOC L{loan number}$ {amount}`. Strip leading zeroes from the loan number and format the amount with exactly two decimals, no dollar sign or thousands separators, for example `HELOC L1$ 49529.28`.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.adf7577d279e67fa6752ad0e

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> For each Visa result line, what exact value should the required “share ID” field contain?

Answer:
> Use `cardN`, where `N` is the card’s zero-based position in the external-loan list: `card0` for the first Visa, `card1` for the second, and so on.

Evidence:
- PM simulation evidence is retained in the immutable harness agent transcript.

#### question.f62e99429f2115271ce597a6

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact keyable value format should be used for HELOC consumer loans, including the placement of the `HELOC ` prefix relative to the loan identifier or description?

Answer:
> Use `HELOC L<loan-number>$ <amount>`, for example `HELOC L1$ 49529.28`. Place `HELOC ` immediately before the loan identifier; do not include or append the loan description.

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
| Planner questions | 2 |
| Planner requirements-agent requests | 2 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner PM-simulation answers | 2 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

#### question.f506f948553f3d6a9cd6d286

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> Does this example define two outcomes: Grid Account "0001234567" with MICR "1234567" returns "1234567" without a warning, while Grid Account "000" returns "0"?

Answer:
> Yes, these are two outcomes. Verify both the matched-account no-warning case and the all-zero case returning "0".

Evidence:
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:77-81
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:307-320

#### question.86242b8d724b793063bebf05

Resolution: `pm_simulation`

Authority: `unverified_pm_simulation`

This answer is simulated PM input, not human-verified authority.

Question:
> What exact pass, review, and fail rules should be applied for required values, MICR, duplicate notification values, corporate separation, and return-reason mapping?

Answer:
> Pass only when extraction succeeds, every required value is present, and no warning exists; review complete records with conflicts, invalid formats, or low confidence, and fail extraction failures or missing required values. Left-pad MICR values to nine digits, review non-nine-digit or conflicting values, copy the first-deposit MICR into bank-to-notify without a second requirement, and keep each corporate in separate outputs with unrecognized filenames under Unknown. Prefer the alpha return reason, fall back to the numeric mapping, review disagreements, fail unmapped numeric reasons, default unknown alpha reasons to generic J, and use code 0's alpha description for remarks.

Evidence:
- src/customers/catalyst/cheque-verification-combined/format-results.ts:202-226
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:289-367
- src/customers/catalyst/cheque-verification-combined/agents/cheque-workflow-agent.ts:735-811
- src/customers/catalyst/cheque-verification-combined/types.ts:36-249

## Holdout

- catalyst-cheque: 2 runs, 68.1% unanimous decisions; 116 units; build=65, reuse=3, extend=39, defer=9, question=0; verified=unscored, provisional=15.5%

## Target-Excluded Guard

Status: `completed`

Gate: `passed`

Baseline mean build rate: 81.6%

Candidate mean build rate: 80.0%

Build-rate drop: 2.0%

Pair validity: valid

Leakage paths: 0

Protocol: `standard-primary-v2`

Standard primary (comparison control) reference: benchmark `deceased-account`, resolved artifact `sha256:ea37e334c9e63df68af692fc8d6555797fd72955ed6070ca1f74759672d78eff`, lineage replicate 1 case `62RQV3XPJX7T1MK5AA7XSWFS9J` run `run.eb025f5d801a747c665662a2`; replicate 2 case `0W06Q7Z3AXZMQ9BEQQEE9ZCJQQ` run `run.af0951d1e0693659a000e58b`

No additional control execution was run; the standard primary measurement is reused as comparison normal.

Excluded decisions: build=101, reuse=0, extend=8, defer=16, question=0

Comparison lineage: replicate 1: normal case `62RQV3XPJX7T1MK5AA7XSWFS9J` run `run.eb025f5d801a747c665662a2`, excluded case `674NCQJGXB2WXZG5JF1H831DYM` run `run.a925e9b7989cf6e82a6785b4`; replicate 2: normal case `0W06Q7Z3AXZMQ9BEQQEE9ZCJQQ` run `run.af0951d1e0693659a000e58b`, excluded case `6Y2VH0V3NE1RGWPZ77DXRV9QJX` run `run.2d07fe24f190fcecc47613ff`

Comparison mismatches: none

Recorded error: none

Target-arm questions: 10

- excluded: What exact row format should the Key into Symitar summary use for a consumer loan whose Symitar description identifies it as a HELOC? -> Use `HELOC L<n>$ <amount>` on Tracking 53, with the loan ID unpadded and the amount in plain dollars with two decimals and no thousands separator, for example `HELOC L1$ 49529.28`. If the figure cannot be determined, use `HELOC L<n>$ needs review`. (pm_simulation)
- excluded: What condition should produce “not recorded” rather than “unmatched” for a populated record-level figure slot? -> Use “not recorded” when the slot is populated but contains no monetary amount. A recorded zero is still a figure; only a blank amount qualifies. (pm_simulation)
- excluded: What exact keyable format should be used for a HELOC principal value, including the `HELOC ` prefix, amount formatting, and any separator? -> Use `HELOC L{loan-number}$ {amount}`, for example `HELOC L1$ 49529.28`. Use one space after `HELOC` and before the amount; format the amount with exactly two decimal places, no dollar sign, and no thousands separator. (pm_simulation)
- excluded: What exact text format should the Key into Symitar summary use for a home-equity line of credit under Tracking 53? -> Use `HELOC L{loan number}$ {amount}`, with the loan number unpadded and the amount shown without commas to exactly two decimal places, for example `HELOC L1$ 49529.28`. (pm_simulation)
- excluded: Which approved Symitar connection should this workflow use, and where are its read-only credentials and permissions for member, death, deposit, consumer-loan, Visa, and tracking data configured? -> Use TruMark’s approved production SymXchange connection. Its read-only service credentials and access to member, death, deposit, consumer-loan, Visa, and tracking data must be maintained in the Saris-managed TruMark Symitar integration configuration, not supplied per run. (pm_simulation)
- excluded: What exact keyable value format should be used for HELOC loans, including the prefix, spacing, and the value that follows? -> Use `HELOC L<number>$ <amount>`: uppercase `HELOC`, one space, the loan number without leading zeros prefixed by uppercase `L` and followed by `$`, then one space and the date-of-death balance as plain dollars with exactly two decimals and no commas (for example, `HELOC L1$ 49529.28`). (pm_simulation)

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

`holdout regression: catalyst-cheque`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr47-3/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v004/deceased-account/facts.json` | archived |
| Parent measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v001/deceased-account/facts.json` | archived |
| Diagnosis input | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v004/diagnosis/diagnosis-input-b58126d45967dd95b72a44f502cbbcb7fd6b57ccb114fb194deddf981f0d3712.json` | completed |
| Model diagnosis | `model_inference` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v004/diagnosis/diagnosis-result-b58126d45967dd95b72a44f502cbbcb7fd6b57ccb114fb194deddf981f0d3712.json` | completed |
| Target-excluded comparisons | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr47-3/trumark-deceased-accounts-pr47-3-v004/target-excluded/comparisons/` | completed |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
