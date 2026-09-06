# Unmodified campaign seed

## Goal

Improve the generic accuracy of Phase 2 requirement-unit adjudication.

The root problem appears in normal planner runs where the existing target implementation is available as evidence and is not excluded through the `exclude-target-implementation` policy. These runs currently classify many requirement units as build even though substantial corresponding behavior already exists in the workflows source. This suggests failures in source discovery, candidate ranking, evidence hydration, evidence retention, or model interpretation.

The objective is not to minimize the build count or make it zero. Some requirements describe genuine gaps between the requested workflow and the current implementation, so a correct result must retain evidence-backed build and extend decisions. The goal is progressive improvement toward accurate classification, not perfection or a predetermined decision distribution.

The current requirements pack is newer than the packs used by earlier experiments, including v13c. Previous decision counts are therefore historical context only and must not be treated as directly comparable scores. Before generating mutations, establish a new repeated baseline using this campaign’s exact requirements-pack hashes, selected planner seed, workflows revision, environment, model, prompts, budgets, and knowledge snapshot. Evaluate every candidate against this campaign-local baseline.

For every requirement unit, determine whether build, reuse, extend, defer, or question is justified by the frozen requirements, workflows source, tool transcripts, and committed evidence. Distinguish genuine implementation gaps from planner-system errors. A planner-system error may include failed source discovery, poor candidate ranking, missing evidence hydration, evidence lost before adjudication, incorrect interpretation, invalid tool usage, or unsupported confidence.

Prioritize reducing false build and false extend decisions without introducing false reuse. Reuse must remain supported by complete, eligible, exported evidence. Partial or private implementation should generally support extend rather than reuse. Build remains correct where the requested behavior is genuinely absent.

Use the historical experiment Markdown, including the original baseline and v13c findings, as factual research context. Treat measured run output and human-reviewed requirement labels as authority. LLM judgments are suggestions only. Decision counts are diagnostic signals, not optimization targets.

Every hypothesis must address an observed causal failure mechanism and produce a bounded, attributable change. Record its assumptions, exact pins, actual results, requirement-level decision changes, confirmed system errors, genuine gaps, regressions, uncertainties, and next actions in experiment Markdown.

Never optimize specifically for TruMark, deceased accounts, singular/plural aliases, fixed requirement text, customer names, workflow names, source paths, capability IDs, or an expected build count. Do not introduce pack-specific production heuristics. Every candidate must run the primary pack and unrelated holdout packs repeatedly, preserve meaningful source-backed evidence, and avoid regressions on human-verified labels.

Accuracy, evidence quality, reproducibility, and genericity are the objectives. Time, token usage, monetary cost, and achieving a superficially attractive decision distribution are secondary.

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
| Campaign | trumark-deceased-accounts-v14-origin-main |
| Variant | trumark-deceased-accounts-v14-origin-main-v007 |
| Parent | none |
| Round | 0 |
| Status | completed |
| Planner seed | `13bd342adbad89c1d4cd680e08d0327e54a53fe3` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:c74a27a40f2243e5a4f5cdc6272084a122e52c7c919aa9a743ff6a1aa879f799` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14-origin-main/trumark-deceased-accounts-v14-origin-main-v007/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-v14-origin-606b2e0431-7` |
| Artifact collection | complete |

## Baseline Metrics

No parent metrics exist. This experiment establishes a campaign-local baseline.

## Actual Facts

| Decision | Count |
| --- | ---: |
| build | 105 |
| reuse | 0 |
| extend | 6 |
| defer | 14 |
| question | 0 |

| Metric | Value |
| --- | ---: |
| Requirement units | 125 |
| Replicates | 3 |
| Unanimous unit decisions | 89.6% |
| Empty shortlists | 68 |
| Candidate occurrences | 72 |
| Discovered evidence | 12 |
| Selected source references | 9 |
| Model calls | 1017 |
| Total tokens | 5637913 |
| Cost USD | 16.8906 |
| Model duration ms | 5497378 |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 125 |
| Provisional errors | 105 |
| Provisional accuracy | 16.0% |
| Persisted labels | 241 |
| Cohort pin mismatches | none |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | measured | 125 | 105 | 0 | 6 | 14 | 0 | 89.6% |
| Target-safe control | failed | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| Target-excluded | failed | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

The control and excluded arms use the same target-safe pack. The excluded arm is a promotion guard, not a fitness reward.

## Conclusion

Status: `measured`

This section is generated from persisted measurements. It does not treat model diagnosis or blind-judge suggestions as verified truth.

This run establishes a baseline observation; it does not establish that the planner decisions are correct or that the planner improved.

Correctness remains unverified because no human-verified labels score this experiment. Provisional accuracy is an LLM suggestion only.

Causal interpretation is not final because diagnosis status is not_started.

The target-safe control and target-excluded comparison is failed; the conclusion is incomplete until it finishes.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> Chunk 1: The planner substantially missed the existing TruMark deceased-accounts implementation. Most units are already implemented or require targeted extension rather than greenfield construction.
> Chunk 2: The checkout already contains a substantial TruMark deceased-accounts workflow, Symitar integration, email routing, calculations, comparisons, review output, and tracking summaries. Most observed build decisions missed directly reusable code; requirements introducing explicit persisted or renamed fields should extend that implementation rather than start anew. Repair: Both build decisions overlooked existing deceased-accounts implementations and should be reuse.
> Chunk 3: 14 planner decisions missed substantial existing or partial capability; 6 correctly identified genuine gaps or binding deferrals.
> Chunk 4: Of 20 units, 17 are system errors where substantial existing capability was overlooked or treated as greenfield. Three observed decisions correctly reflect genuine gaps or explicit deferrals.
> Chunk 5: 15 planner decisions missed substantial existing capability; 5 correctly identified intentionally absent or deferred work.
> Chunk 6: The frozen checkout contains a substantial TruMark deceased-accounts implementation that the planner repeatedly missed. Most build decisions should have been reuse or extend; the two explicit scope exclusions are correctly deferred.
> Chunk 7: One build decision overlooks a complete existing entrypoint, while three field builds overlook partial implementations that should be extended. The dividend-basis decision correctly identifies a genuine extension gap.

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
| Planner questions | 8 |
| Planner requirements-agent requests | 8 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 8 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

#### 01M1Q2R1VHAKDZHSQ7TQDBA8B2

Resolution: `source_fallback`

Question:
> What is the approved Symitar connection endpoint/environment (e.g., production vs. test region) and the specific read-only credential scope (member, death, deposit, non-mortgage consumer-loan, Visa external-loan, and Tracking 50/51/52/53 records) that this workflow must be provisioned against for production enablement?

Answer:
> Deploy in Saris environment `trumark-live`. The downstream Symitar/SymXchange hostname, region, and secret are deployment-provided and are not present in source. The workflow uses the Saris read endpoint `POST /api/lo_systems/symitar/accounts/with-children-select-fields` and currently requests broad read access to member/account names, Tracking 50/51/52/53 death and recorded figures, deposits/shares and transactions, loans and transactions/tracking, and Visa external-loan records. It performs no Symitar write-back; provision read-only credentials with no write permissions. Source does not prove a narrower non-mortgage-only loan credential scope because the request includes all loan fields.

Evidence:
- tools/deploy/config.json:29-36 identifies TruMark Deceased Accounts deployment target as `trumark-live`.
- src/modules/shared/api/symitar/client.ts:42-43,86-133 uses the account select-fields POST endpoint and requests all account, loan, name, tracking, share/transaction, and external-loan/tracking fields.
- src/modules/shared/api/symitar/customers/trumark/decorate-deceased.ts:17-28 maps Tracking 50 to deceased name/date, 51/52 to share figures, and 53 to loan and credit-card figures.
- src/customers/trumark/deceased-accounts/README.md:3-15 explicitly states the workflow reads these records and never writes back to Symitar.

#### question.e38971c924c6fdcbe9f97235

Resolution: `source_fallback`

Question:
> What exact text format should the Key into Symitar summary use for a home-equity line of credit (HELOC) row?

Answer:
> Use `HELOC L{loan-number}$ {amount}`, with the numeric loan ID stripped of leading zeros and the amount as plain dollars with exactly two decimals, no currency symbol or thousands separator. Example: `HELOC L1$ 49529.28`. If undetermined, use `HELOC L1$ needs review`.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:119-132
- src/customers/trumark/deceased-accounts/summary-block.ts:197-204
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-249

#### question.df3b9541d82bf5ade4a503e9

Resolution: `source_fallback`

Question:
> What exact keyable format should be used for a HELOC principal, including the `HELOC ` prefix, amount formatting, and any date or separator rules?

Answer:
> Use `HELOC L<n>$ <amount>`, e.g. `HELOC L1$ 49529.28`. Strip leading zeros from the loan ID, use single spaces, and format the principal as plain dollars with exactly two decimals, no leading `$`, and no thousands separators. Do not include a date or dividend-year line: Tracking 53 has no div-year field. Add `HELOC ` only when the Symitar description contains the whole word `HELOC` case-insensitively; do not infer it from variants such as `HEOC`.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:99-102 defines whole-word, case-insensitive HELOC detection and excludes the HEOC typo
- src/customers/trumark/deceased-accounts/summary-block.ts:120-132 builds `L<n>$` from the numeric loan ID and formats dollars to two decimals without `$` or thousands separators
- src/customers/trumark/deceased-accounts/summary-block.ts:197-204 constructs `${prefix}${entityLabel('L', loan.loanId)} ${amountToken(cents)}`
- src/customers/trumark/deceased-accounts/summary-block.ts:264-267 states Tracking 53 has no dividend year
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-248 proves `HELOC L1$ 49529.28`

#### question.b121757309f046e85304d800

Resolution: `source_fallback`

Question:
> How should a consumer loan whose Symitar description identifies it as a HELOC be formatted in the Key into Symitar summary?

Answer:
> Prefix the standard loan entry with `HELOC `, yielding `HELOC L{loan number}$ {amount}`. Strip leading zeros from the loan number; format the amount as plain dollars with two decimals, no dollar sign or thousands separator. Do not include the Symitar description itself.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:192-204
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-249
- src/customers/trumark/deceased-accounts/summary-block.test.ts:268-276

#### question.87740f65475d5324e19aca9f

Resolution: `source_fallback`

Question:
> What exact keyable format should be used for HELOC principal values, including the placement of the required “HELOC ” prefix?

Answer:
> Use `HELOC L{loan-number}$ {principal}`. Place `HELOC ` at the very start, immediately before the loan key. Render principal as plain dollars with two decimals, no currency symbol or thousands separators; e.g. `HELOC L1$ 49529.28`.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:120-132
- src/customers/trumark/deceased-accounts/summary-block.ts:173-203
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-249

#### question.45571eef181942415b398c8b

Resolution: `source_fallback`

Question:
> How should a consumer loan identified as a HELOC be formatted in the Key into Symitar summary?

Answer:
> Format it on Tracking 53 as `HELOC L{loan-number}$ {amount}`, stripping leading zeros from the loan ID and rendering the amount with exactly two decimals, no currency symbol, and no thousands separator. Example: `HELOC L1$ 49529.28`. Apply the `HELOC ` prefix only when that loan ID’s Symitar description contains the whole word `HELOC` (case-insensitive).

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:99-102 defines whole-word, case-insensitive HELOC identification from the Symitar description.
- src/customers/trumark/deceased-accounts/summary-block.ts:192-203 joins descriptions by loan ID and formats the line as the optional `HELOC ` prefix plus `L{number}$ {amount}`.
- src/customers/trumark/deceased-accounts/summary-block.ts:128-132 specifies two decimal places with no dollar sign or thousands separator.
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-248 proves `0001` with a HELOC description and 4,952,928 cents renders as `HELOC L1$ 49529.28`.

#### question.2df406468d31bd43e65d3762

Resolution: `source_fallback`

Question:
> What exact review reason should appear when an open Visa’s death date and balance-observed date differ?

Answer:
> Needs review — the card record carries only its current balance, and the date of death does not fall in the month this case was run on or before the day it was run, so that balance is not the one held at the death.

Evidence:
- src/customers/trumark/deceased-accounts/results.ts:177-180
- src/customers/trumark/deceased-accounts/stages/dod-balance.ts:532-550

#### question.38db4a28a4217a6ea66f7a51

Resolution: `source_fallback`

Question:
> Which exact account-record locations and Deposit Operations task result are approved to display member account number, member name, and date of death?

Answer:
> Display is implemented in `trumark-live` as follows: the registered account record uses `deceased-account` for customer-facing runs and redirects Draft runs to `deceased-account-internal`; fields are `accountNumber`, `nameOfDeceased`, and `dateOfDeath` (name/date omitted when absent). The backend Deposit Operations result displays account number in `_identifier` and `_metadata.account_number`, member name in `_results.applicant_name`, and date of death in `_results.description` and `_metadata.date_of_death` (metadata omitted when absent). The desktop trigger additionally displays the entered account number in its own `_results.description`, but not name or date of death. The workflow reads Symitar/Tracking 50, performs only a best-effort Records upsert, and never writes back to Symitar.

Evidence:
- src/customers/trumark/deceased-accounts/record.ts:132-143
- src/customers/trumark/deceased-accounts/README.md:270-278
- src/customers/trumark/deceased-accounts/results.ts:1125-1128
- src/customers/trumark/deceased-accounts/results.ts:1161-1167
- src/customers/trumark/deceased-accounts-trigger/index.ts:87-97
- src/customers/trumark/deceased-accounts/index.ts:4-13
- tools/deploy/config.json:29-35

#### question.400e670c6e48c1eab3019941

Resolution: `source_fallback`

Question:
> What exact keyable format should be used for home-equity lines of credit, including the `HELOC ` prefix and the value that follows it?

Answer:
> Use `HELOC L<loan-number>$ <balance>`, where the zero-padded Symitar loan ID is rendered as its numeric loan number and the balance is plain dollars with two decimals, no leading `$` or comma. Example: `HELOC L1$ 49529.28`.

Evidence:
- src/customers/trumark/deceased-accounts/summary-block.ts:120-132 defines `L<number>$` and two-decimal plain-dollar formatting
- src/customers/trumark/deceased-accounts/summary-block.ts:173-203 emits `HELOC ` + loan label + balance
- src/customers/trumark/deceased-accounts/summary-block.test.ts:242-249 pins the exact output `HELOC L1$ 49529.28`

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

#### question.0357a9f60fe6c5a7f24539f5

Resolution: `source_fallback`

Question:
> If a produced normal new notification has any of the three fixed EARNS fields set to something other than exactly “NA”, should it trigger manual review or only be reported as a diagnostic while the run completes?

Answer:
> Diagnostic only. The three fixed fields are emitted as exactly "NA" but are excluded from the needsManualReview calculation, so a diagnostic assertion may report a deviation without routing the record to manual review.

Evidence:
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:330-333 sets EADepositorAcct, EABranch, and EATrace to "NA".
- src/customers/catalyst/cheque-verification-combined/earns-transform.ts:354-367 computes needsManualReview only from missing dynamic fields or warnings; the three fixed fields are not included.
- src/customers/catalyst/cheque-verification-combined/agents/cheque-workflow-agent.ts:773-775 routes records using needsManualReview.

## Holdout

- unrelated-holdout: 3 runs, 82.8% unanimous decisions; 116 units; build=93, reuse=0, extend=18, defer=5, question=0; verified=unscored, provisional=7.8%

## Target-Excluded Guard

Status: `failed`

Gate: `pending`

Baseline mean build rate: unscored

Candidate mean build rate: unscored

Build-rate drop: unscored

Pair validity: invalid or pending

Leakage paths: 0

Control decisions: unavailable

Excluded decisions: unavailable

Comparison mismatches: none

Recorded error: `Calibration attempt interrupted after a holdout model-budget failure; partial replicates are not reusable.`

Target-arm questions: 0

No target-arm runtime question was recorded.

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.

## Failure

None recorded.

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-v14-origin-main/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14-origin-main/trumark-deceased-accounts-v14-origin-main-v007/deceased-account/facts.json` | archived |
| Target-excluded comparisons | `deterministic_reconstruction` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14-origin-main/trumark-deceased-accounts-v14-origin-main-v007/target-excluded/comparisons/` | failed |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
