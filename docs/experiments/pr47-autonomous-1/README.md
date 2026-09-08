# pr47-autonomous-1

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

## Frozen Inputs

- Planner seed: `a24baf79e777b07a3b55d027dc5ea5a8701e6af8`
- Workflows source: `140ec306bff8c20aa9eccde3cc2f4647ce790655`
- Environment profile: `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d`
- Mode: `automatic`
- Concurrency: 1
- Replicate concurrency: 1
- Maximum generated variants: 1
- Compliance repairs per hypothesis: 1
- Effective replicate protocol: 2 runs at concurrency 2
- Target-excluded workflow: `trumark/deceased-accounts`
- Target-excluded baseline: pr47-autonomous-1-v000

## Compliance Throughput

| Metric | Count |
| --- | ---: |
| Hypotheses with attempts | 0 |
| First-pass compliant | 0 |
| Compliant after bounded repair | 0 |
| Compliance-exhausted hypotheses | 0 |
| Executed generated variants | 0 |

## Investigator Sessions

Investigator budgets and primary development attempts are separate from final planner cohorts. Session finalization is not promotion; reasons and hypotheses remain unverified.

| Variant | Session | Status | Turns | Primary attempts | Agent tokens |
| --- | --- | --- | ---: | ---: | ---: |
| pr47-autonomous-1-v001 | ses_f812c5469ffeFOwZVOwX5iz2SX | abandoned | 7 | 1 | unknown |

Score basis: raw-replicate mean; consensus decisions remain separate. Runtime answers are not globally frozen. See each experiment report for budgets, action outcomes, and artifact locators.

## Target-Excluded Evaluations

- pr47-autonomous-1-v000: completed; gate=passed; build drop=0.0%

## Experiments

| # | Variant | Round | Hypothesis | Status | Verified | Provisional |
| ---: | --- | ---: | --- | --- | ---: | ---: |
| 0 | pr47-autonomous-1-v000 | 0 | Unmodified campaign seed | completed | unscored | 35.2% |
| 1 | pr47-autonomous-1-v001 | 1 | Provider-floor bounded evidence hydration | rejected | unscored | unscored |
