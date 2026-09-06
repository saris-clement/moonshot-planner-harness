# trumark-deceased-accounts-v14

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

## Frozen Inputs

- Planner seed: `13bd342adbad89c1d4cd680e08d0327e54a53fe3`
- Workflows source: `304c0857c9b5aff3076de504a52ee364bd279b0d`
- Environment profile: `sha256:c74a27a40f2243e5a4f5cdc6272084a122e52c7c919aa9a743ff6a1aa879f799`
- Mode: `supervised`
- Concurrency: 3
- Maximum generated variants: 9

## Experiments

| # | Variant | Round | Hypothesis | Status | Verified | Provisional |
| ---: | --- | ---: | --- | --- | ---: | ---: |
| 0 | trumark-deceased-accounts-v14-v000 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 1 | trumark-deceased-accounts-v14-v001 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 2 | trumark-deceased-accounts-v14-v002 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 3 | trumark-deceased-accounts-v14-v003 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 4 | trumark-deceased-accounts-v14-v004 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 5 | trumark-deceased-accounts-v14-v005 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 6 | trumark-deceased-accounts-v14-v006 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 7 | trumark-deceased-accounts-v14-v007 | 0 | Unmodified campaign seed | failed | unscored | unscored |
| 8 | trumark-deceased-accounts-v14-v008 | 0 | Unmodified campaign seed | failed | unscored | unscored |
