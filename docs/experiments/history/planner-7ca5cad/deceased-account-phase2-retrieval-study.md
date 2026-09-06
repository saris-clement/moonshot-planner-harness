# Deceased-account Phase 2 retrieval study

Status: research observation, not an implementation decision

Date: 2026-09-05

## Scope and evidence labels

The `trumark/deceased-account` pack is an evaluation fixture for Phase 2 retrieval and
adjudication. It is not production workflow logic, and the observations below must not be turned
into workflow-specific ranking rules. The useful question is general: when source already contains
relevant behavior, where does Phase 2 lose it between retrieval, admission, selection, and
disposition?

This document uses four labels deliberately:

- **Observed** means computed from the frozen analysis, transcript, or Langfuse trace listed below.
- **Audit** means a human judgment after reading the source at the frozen commit. It is not model
  output and is not a deterministic oracle.
- **Hypothesis** means a possible explanation that still needs an isolated experiment.
- **Limitation** marks a boundary on what these runs can establish.

All run totals in this document were rechecked against the raw local artifacts. The checked-in JSON
files are compact baselines; they are not substitutes for the published analyses and transcripts.

## Artifact ledger

| Version | Case | Run | Analysis | Langfuse trace |
| --- | --- | --- | --- | --- |
| V11 | `7PQFRQT9H876E8M58K8T8Q5WYW` | `run.a9ecb3f824f2c5698bdaab62` | `analysis.a8f4dae248c76bb983added2` | `3292c1d041fac76cfc7c9ce61f4609bd` |
| V12 | `3PTXXJDVQP1AQN6E3JMZEP4WKP` | `run.0cda18a9a45430d9a7a463f6` | `analysis.601f2e5ce8b681997ccb191e` | `64a85fc2e572b848c415d37a212d1a88` |
| V13 | `5W8NBBN2Y8Z4CEWBEA61E4B910` | `run.9b1099e8438403fcaa6eabc3` | `analysis.c2e2ead475739f7418089bcd` | `80c62f769ec050c79e137dbf37fc8642` |
| V13b | `3W93A4Y6WVAZJRCWN76BR25G2M` | `run.7d4766256078a5d88a89f50d` | `analysis.effe6095224e80dedbaecdc7` | `6ade5b116b203ebb2e3d6125bba79664` |

Checked-in baselines:

- [V11 baseline](./deceased-account-phase2-baseline.json)
- [V12 observation](./deceased-account-phase2-v12-observation.json)
- [V13 observation](./deceased-account-phase2-v13-observation.json)
- [V13b observation](./deceased-account-phase2-v13b-observation.json)
- [ADR 0041: counterfactual target exclusion and Phase 2 retrieval](../adr/0041-counterfactual-target-exclusion-and-phase2-retrieval.md)
- [ADR 0042: qualified search hydration](../adr/0042-qualified-search-hydration.md)

The following raw artifacts were local analysis inputs outside the repository. Their filenames are
recorded for reproducibility, but they are intentionally not linked from checked-in documentation:

- V11: `v11-7pq-analysis.json`, `v11-7pq-transcript.json`,
  `v11-7pq-langfuse-trace.json`
- V12: `v12-3pt-analysis.json`, `phase2-case-3ptxx/transcript.json`,
  `phase2-case-3ptxx/langfuse-trace.json`
- V13: `v13-5w8-analysis.json`, `v13-5w8-transcript.json`,
  `v13-5w8-langfuse-trace.json`, `v13-top10-comparison.json`
- V13b: `v13b-3w93-analysis.json`, `v13b-3w93-transcript.json`,
  `v13b-3w93-langfuse-trace.json`

## Frozen comparison pins

The comparison held the business and source inputs fixed while the Phase 2 retrieval/adjudication
configuration changed:

| Input | Frozen value | Evidence |
| --- | --- | --- |
| Requirements workflow | `trumark/deceased-account` | V11-V13b analyses |
| Export / revision | `38b74ad46bf3` / `51` | V11-V13b analyses |
| Source commit | `140ec306bff8c20aa9eccde3cc2f4647ce790655` | V11-V13b analyses |
| Source tree | `443509a2c4fa4ffa0d56a4df57c615e44c8ef530` | V11-V13b analyses |
| KB generation | `1863` | V11-V13b analyses and transcripts |
| KB snapshot | `sha256:7646fe1380ebd2a53b9f309619bd3911549a82398cc7622ae8ac8e3054f804c3` | V11-V13b analyses and transcripts |
| Model | `gpt-5.6-sol` | V11-V13b analyses and Langfuse traces |

The prompt, tool protocol, projection, and provider configuration pins intentionally differ by
iteration. Therefore these are direct observations under frozen source inputs, not a single-variable
causal trial.

## Method

1. Recompute disposition and usage totals from each published analysis's 109 adjudications.
2. Recompute tool status and operation counts from each durable transcript.
3. For V13 and V13b, read `requirementOrdinal` and `requirementUnitId` from Langfuse generation
   metadata, extract each `toolUseId` from that requirement's generation messages, and join the
   `toolUseId` to its durable transcript result. Transcript `attempt` is not treated as the
   requirement order.
4. Treat a target hit as a returned title under
   `workflows/src/customers/trumark/deceased-accounts/`; treat admission and selection as separate
   events under the corresponding frozen source path.
5. Count search-hit and rejection occurrences, not unique symbols, unless the table says otherwise.
6. Compare dispositions by stable requirement-unit ID.
7. Read the source at the frozen commit for every V13b `build` and classify it manually, without
   changing the run result.

The singular requirements identity and plural implementation path are intentionally left as
observed. No singular/plural production heuristic is inferred from this fixture.

## The original problem and iterations

### V11: retrieval could find source but usually could not commit it

**Observed.** V11's frozen catalog shortlist and exported-symbol-oriented hydration left 89 of 109
atomic requirement units as `build`. It made 185 KB calls; 44 failed or were rejected. Ten
build-time searches returned source from the target implementation, but nine of those target hits
were not hydrated. The result was a visibility failure as much as a ranking failure: source could
appear in raw research without becoming admissible evidence. [V11 analysis, transcript, baseline]

### V12: reliable tools and private declarations, but a two-step hydration gap

**Observed.** V12 aligned the tool schema, added bounded behavior context, and allowed a verified
private top-level declaration to prove `extend`, not `reuse`. All 180 KB calls succeeded. Of 11 units
whose search results hit target source, eight received target evidence and five selected it. Four of
the eight target hydrations projected a file prefix that omitted the nominated declaration. The
disposition moved only from 89 to 86 builds. [V12 analysis, transcript, observation]

### V13: automatic qualified hydration made the funnel observable

**Observed.** V13 automatically verified qualified search titles against the frozen source,
separated production and supporting-test authority, projected declaration-centered windows, and
persisted grounding receipts. Its transient per-attempt limits were four production files, two test
files, five files total, 192 KiB production, 64 KiB tests, and 256 KiB combined. It reached target
hit/admission/selection in 12/12/9 units and moved to 81 builds and 16 extends. One KB engine error
remained. [V13 analysis, transcript, observation; ADR 0042; `evidenceProjectionLimits.ts`]

### V13b: scoped retrieval improved aggregate coverage but exposed selection and rubric failures

**Observed.** V13b preserved code-shaped identifiers, started with hybrid/code search, allowed one
fuzzy lexical fallback with a frozen customer prefix, raised valid search limits to 20, and
deterministically bypassed nine explicit out-of-scope units. It produced 74 builds, two reuses, and
21 extends. Target hit/admission/production-admission/selection reached 42/40/37/14 units. However,
the original top-ten score fell from V13's 5/10 to 3/10, and the source audit found that aggregate
`build` reduction did not imply high build precision. [V13b analysis and transcript]

## Aggregate outcomes

**Observed.** Dispositions are counts of atomic requirement-unit adjudications.

| Version | Build | Reuse | Extend | Defer | Evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| V11 | 89 | 1 | 8 | 11 | V11 analysis/baseline |
| V12 | 86 | 0 | 11 | 12 | V12 analysis/observation |
| V13 | 81 | 0 | 16 | 12 | V13 analysis/observation |
| V13b | 74 | 2 | 21 | 12 | V13b analysis |

These build counts are not ticket counts. A requirement pack is decomposed into atomic fields,
checks, actions, and behaviors; Phase 3 can regroup them into implementation work. They still expose
missed implementation coverage: a false `build` unit asserts that no adequate implementation basis
was selected for that requirement atom, even when one eventual ticket might cover many such atoms.

## Cost and latency

**Observed.** `Duration` is the sum of adjudication usage durations in the published analysis.
`Trace latency` is the Langfuse root-trace wall latency, so it includes orchestration overhead and is
not expected to equal the summed duration.

| Version | Input tokens | Output tokens | Duration (ms) | Trace latency (s) | Cost (USD) | Evidence |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| V11 | 1,325,161 | 58,689 | 1,312,158 | 1,347.839 | 4.8691535 | V11 analysis/trace |
| V12 | 1,528,857 | 54,463 | 1,161,706 | 1,199.787 | 5.320731 | V12 analysis/trace |
| V13 | 2,938,029 | 60,463 | 1,334,838 | 1,372.251 | 9.737880 | V13 analysis/trace |
| V13b | 5,683,761 | 71,969 | 1,493,680 | 1,530.621 | 17.668266 | V13b analysis/trace |

V13b used 1.81 times V13's cost. Its projected source plus test bytes rose from 2,722,690 to
7,170,402, or 2.63 times V13. These ratios are arithmetic over the observed analysis totals; they do
not isolate which V13b change caused the increase.

## Retrieval funnel

**Observed.** V11 and V12 predate the V13 grounding receipt, so unavailable stages are marked
unknown rather than zero.

| Stage | V11 | V12 | V13 | V13b | Evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| Tool transcript entries | 188 | 182 | 179 | 189 | transcripts |
| KB operations (excluding requirements questions) | 185 | 180 | 175 | 188 | transcripts |
| Failed transcript entries | 44 | 0 | 1 | 0 | transcripts |
| `requirements_question` calls | 3 | 2 | 4 | 1 | transcripts |
| `kb_search` calls | 148 | 95 | 125 | 177 | transcripts |
| Search hits | unknown | unknown | 1,013 | 2,251 | grounding receipts |
| Qualified pointers | unknown | unknown | 382 | 1,431 | grounding receipts |
| Hydration attempts | unknown | unknown | 156 | 442 | grounding receipts |
| Source reads | unknown | unknown | 148 | 415 | grounding receipts |
| Production admissions | unknown | unknown | 105 | 257 | grounding receipts |
| Test admissions | unknown | unknown | 20 | 59 | grounding receipts |
| Discovered selections | unknown | unknown | 12 | 20 | grounding receipts |
| Production bytes | unknown | unknown | 2,257,435 | 5,787,911 | grounding receipts |
| Test bytes | unknown | unknown | 465,255 | 1,382,491 | grounding receipts |

V13b's 177 searches were 100 hybrid/code calls and 77 lexical/fuzzy calls. Every effective limit was
20, and every lexical call used `workflows/src/customers/trumark/` as its title prefix. [V13b
transcript]

### Target-source funnel

| Version | Units hit | Units admitted | Units production-admitted | Units selected | Evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| V12 | 11 | 8 | not recorded | 5 | V12 analysis/observation |
| V13 | 12 | 12 | not separately reported | 9 | V13 analysis/transcript |
| V13b | 42 | 40 | 37 | 14 | V13b analysis/transcript |

The unit-level V13b admission gap was only two, but that hides symbol-level loss. Search returned many
target declarations after broad evidence had already consumed the cumulative slots.

## Rejections

**Observed.** These are occurrence counts, not unit counts. V13 totals include every grounding
operation. The V13b column below counts automatic search hydration so it remains attributable to the
177 searches.

| Reason | V13 receipt total | V13b search-only hydration | Evidence |
| --- | ---: | ---: | --- |
| `malformed_hit` | 630 | 780 | analyses/transcripts |
| `evidence_slots_exhausted` | 208 | 796 | analyses/transcripts |
| `non_executable_declaration` | 24 | 96 | analyses/transcripts |
| `unsupported_path` | 5 | 30 | analyses/transcripts |
| `sensitive_source` | 7 | 0 | analyses/transcripts |
| `duplicate_candidate` | 10 | 0 | analyses/transcripts |

One later model-issued V13b `kb_get` added one target-path `evidence_slots_exhausted` rejection.
Consequently the persisted V13b receipt total is 797 rather than the search-only 796. Target-path
search rejections were 150 slot exhaustion and 59 non-executable declarations; including that
`kb_get` makes target slot exhaustion 151. This distinction prevents mixing automatic hydration with
model-directed follow-up. [V13b analysis/transcript]

## V13b build cohorts

**Observed.** Of 74 V13b builds, 24 had at least one raw target hit, 22 admitted target production
source, 50 had no target hit, and 58 admitted some production evidence from any eligible path.
[V13b analysis/transcript]

For the 50 no-target builds:

- 49 made a scoped lexical call; 46 of those calls returned zero hits.
- Their 50 hybrid calls returned 960 hits but no target hit.
- 36 of those hybrid queries included synthetic `snake_case` vocabulary; the matching source often
  used different terms.
- All 50 still emitted high-confidence `build`.

For the 24 target-hit builds:

- Searches produced 162 target-hit occurrences over 37 unique target titles.
- Search results recorded 79 target slot-exhaustion rejections and 39 target non-executable
  rejections. The target-path `kb_get` maps through Langfuse to ordinal 43,
  `unit.6dd498521123f99d43e08e24`, which is in this cohort; it raises the persisted cohort slot count
  to 80.
- 19 admitted the same `results.ts::dividendBasisClause` anchor. This is evidence of broad-evidence
  collapse, not proof that the anchor was irrelevant in every unit.

## Decision transitions

**Observed.** Stable requirement-unit IDs make churn visible.

| V12 to V13 | Build | Extend | Defer |
| --- | ---: | ---: | ---: |
| Build | 78 | 7 | 1 |
| Extend | 3 | 8 | 0 |
| Defer | 0 | 1 | 11 |

The 12 off-diagonal V12-to-V13 decisions comprised seven `build->extend`, three `extend->build`, one
`build->defer`, and one `defer->extend`. The last transition was an explicit-exclusion error, not a
retrieval success. [V12/V13 analyses and V13 observation]

| V13 to V13b | Build | Reuse | Extend | Defer |
| --- | ---: | ---: | ---: | ---: |
| Build | 67 | 2 | 12 | 0 |
| Extend | 6 | 0 | 9 | 1 |
| Defer | 1 | 0 | 0 | 11 |

The 22 off-diagonal V13-to-V13b decisions comprised 12 `build->extend`, two `build->reuse`, six
`extend->build`, one `defer->build`, and one `extend->defer`. The last transition corrected V13's
explicit-exclusion error. Aggregate movement toward reuse/extend therefore coexisted with six losses
of prior `extend` coverage. [V13/V13b analyses]

## Original top-ten cohort

The cohort is frozen from the original V11 target-hit investigation. A check mark means the run made
the expected source-aware correction; the disposition itself remains in the adjacent column.

| # | Requirement | V11 | V12 | V13 | V13b | V13b target evidence |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `prorated_dividend` | build | extend | extend (corrected) | extend (corrected) | hit, admitted, selected |
| 2 | combined dividend-total / Tracking 51 acceptance | build | build | build | build | no hit |
| 3 | `tracking_entry_status` | build | build | build | extend (corrected) | hit, admitted, selected |
| 4 | `recorded_figure_attribution_outcome` | build | extend | extend (corrected) | build | no hit |
| 5 | `dividend_as_of_date` / current-dividend cutoff | build | build | build | build | hit and admitted, not selected |
| 6 | `$2.00 / 20 * 21` acceptance | build | build | extend (corrected) | extend (corrected) | hit, admitted, selected |
| 7 | `undetermined_figure_review_count` | build | build | extend (corrected) | build | no hit |
| 8 | `recorded_figure_disagreement_count` | build | build | extend (corrected) | build | no hit |
| 9 | `accept-account-number` | build | build | build | build | hit and admitted, not selected |
| 10 | `recorded_figure_comparison_outcome` | build | extend | build | build | no hit |

V13 corrected rows 1, 4, 6, 7, and 8: 5/10. V13b corrected rows 1, 3, and 6: 3/10; rows 4,
7, and 8 regressed from V13. [V11-V13b analyses, V13 top-ten comparison, V13b transcript]

## Manual audit of all 74 V13b builds

**Audit.** The auditor read source at the frozen commit and classified each build by whether the
required behavior appeared to exist, had an implementation primitive suitable for extension, was
genuinely absent, or conflicted with the reviewed requirements state.

| Combined judgment | Builds |
| --- | ---: |
| Clearly existing implementation; likely false `build` | 30 |
| Existing primitive; `extend` likely | 28 |
| Likely valid `build` | 9 |
| Requirements-state conflict | 7 |
| Total audited | 74 |

The retrieval cohorts explain different failure modes:

| Cohort | Manual class | Builds |
| --- | --- | ---: |
| 24 target-hit builds | A: clearly existing | 8 |
| 24 target-hit builds | B: partial implementation / likely extend | 13 |
| 24 target-hit builds | C: likely valid build | 1 |
| 24 target-hit builds | D: directly relevant code found but rejected | 2 |
| 50 no-target builds | Definite retrieval miss | 20 |
| 50 no-target builds | Probable retrieval miss / likely extend | 15 |
| 50 no-target builds | Plausible valid build | 8 |
| 50 no-target builds | Requirements-state conflict | 7 |

These judgments do not mean every existing atom should become a separate ticket or a `reuse`.
Private or incomplete source generally supports `extend`; exact requirements may still require new
work. The audit does show that high-confidence `build` was frequently stronger than the retrieved
and manually observed source justified.

### Representative source paths through the funnel

| Unit | Observed funnel | Audit judgment |
| --- | --- | --- |
| `unit.3f4ee36328b98ef58d200a96`, Gather available account evidence | The broad search admitted `results.ts::dividendBasisClause`. The exact lexical fallback then returned `dod-balance.ts::computeShareDodBalances` and `computeShareDodBalance`; both were rejected as `evidence_slots_exhausted`, and the unit remained high-confidence `build`. | Directly relevant executable evidence arrived too late for the cumulative slots. |
| `unit.9f638e4efd1303282826ca9b`, `dividend_period_start` | The broad search again admitted `dividendBasisClause`. The exact fallback returned `dod-dividend.ts::isUsableAccrualPeriod`; it was rejected as `evidence_slots_exhausted`, and the unit remained high-confidence `build`. | Existing dividend-period behavior supports at least an extension decision. |
| `unit.9c753bd6a635b1896d1d442e`, `deceased_member_name` | Target source was hit and broad `results.ts::dividendBasisClause` evidence was admitted, but no target source was selected; the rationale required an exact normalized field contract. | The frozen source resolves and renders the deceased member name. Treating absence of the exact normalized contract as absence of implementation is likely a rubric error. |
| `unit.4d44524593d77e4633d58890`, first-work persistence acceptance | Hybrid search returned no hits. Lexical search returned only the declaration-only `DividendPosting` type, rejected as `non_executable_declaration`; the unit remained `build`. | Likely valid build: source does not persist the first-work basis across later runs. |

Other manually confirmed existing misses included the manual trigger
`deceased-accounts-trigger/index.ts::main`, DOD share balances
`computeShareDodBalance(s)`, Symitar resolution `resolveDeceasedAccount`, Visa calculation
`computeCardDodBalance`, comparison behavior in `recordedFigure`/`figureVerdict`, and result counts in
`buildResults`. **Audit:** these examples are source-reading judgments, not additional transcript
hits.

## Interpretation

**Observed:** V13 fixed the V12 search-to-hydration break. V13b materially increased hits,
admissions, and selected discoveries, but it also increased evidence volume and decision churn.

**Hypothesis:** V13b has at least three independent bottlenecks:

- Retrieval: many no-target hybrid queries used requirements vocabulary absent from source.
- Projection: broad early evidence consumed file slots before higher-specificity fallback results.
- Adjudication: admitted implementation was sometimes rejected as insufficient because it did not
  expose the exact normalized requirement field or contract.

**Hypothesis:** requirements-state conflicts are a fourth class. Better retrieval cannot reconcile a
reviewed requirement that materially disagrees with source state; forcing such cases into confident
`build` or `extend` can conceal the conflict.

The observed data do not establish which remedy is best. In particular, more evidence slots could
recover late exact hits, but it could also admit more irrelevant broad evidence and amplify input
cost or selection noise. Independent V13c axes are defined in
[Phase 2 V13c experiment axes](./phase2-v13c-experiment-axes.md).

## Limitations

- Each version is one provider run. Model output is nondeterministic.
- The frozen source, requirements, KB, and model make comparison possible, but prompt, protocol,
  budget, query policy, projection, and explicit-exclusion behavior changed across versions.
- The fixture preserves a singular requirements workflow and plural implementation identity. It is
  useful for measurement but must not create a production alias rule.
- Target-path metrics are fixture instrumentation. A generally useful retrieval system must also
  preserve shared and other-workflow evidence.
- V11 predates grounding receipts, so its missing funnel stages cannot be reconstructed as zeros.
- Rejection counts are occurrences and can include repeated symbols across searches.
- The 74-build audit is a point-in-time human source audit. The four categories contain judgment,
  especially the boundary between likely `extend` and valid `build`.
- The study measures Phase 2 coverage and disposition, not Phase 3 ticket grouping, implementation
  quality, or production outcomes.
