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
| Campaign | trumark-deceased-accounts-v14 |
| Variant | trumark-deceased-accounts-v14-v006 |
| Parent | none |
| Round | 0 |
| Status | failed |
| Planner seed | `13bd342adbad89c1d4cd680e08d0327e54a53fe3` |
| Workflows source | `304c0857c9b5aff3076de504a52ee364bd279b0d` |
| Environment | `sha256:c74a27a40f2243e5a4f5cdc6272084a122e52c7c919aa9a743ff6a1aa879f799` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v006/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-v14-7c3dced3ac-6` |
| Artifact collection | incomplete |

## Baseline Metrics

No parent metrics exist. This experiment establishes a campaign-local baseline.

## Actual Facts

| Decision | Count |
| --- | ---: |
| unavailable | unavailable |

| Metric | Value |
| --- | ---: |
| Requirement units | unavailable |
| Replicates | unavailable |
| Unanimous unit decisions | unavailable |
| Empty shortlists | unavailable |
| Candidate occurrences | unavailable |
| Discovered evidence | unavailable |
| Selected source references | unavailable |
| Model calls | unavailable |
| Total tokens | unavailable |
| Cost USD | unavailable |
| Model duration ms | unavailable |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | 0 |
| Verified errors | 0 |
| Verified accuracy | unscored |
| Provisional labels | 0 |
| Provisional errors | 0 |
| Provisional accuracy | unscored |
| Persisted labels | 0 |
| Cohort pin mismatches | none |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | pending | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

No target-safe control or target-excluded result is available for this experiment.

## Conclusion

Status: `pending`

No measured conclusion is available while the experiment is failed.

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> No blind-judge result is available.

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: `not_started`

Input hash: unavailable

Result hash: unavailable

> No model-generated diagnosis is available.

No diagnosis findings are available.

## Requirements Questions

Question resolution did not run.

## Holdout

Not run for this variant.

## Target-Excluded Guard

Not configured or not run for this variant.

## Failure

`command failed (1): docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true --volume ainative-planner-kb:/source:ro --volume eval-trumark-deceased-accounts-v14-6-4c866f8f86-kb:/target busybox:1.37.0 sh -c "cp -a /source/. /target/ && chown -R 1001:1001 /target" n: /target/generations/generation-553/kb/history/segment.001861.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001451.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000787.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000891.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000701.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001768.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001649.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001081.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000225.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000984.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000904.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000856.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000788.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000712.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000118.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000873.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000189.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000319.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000902.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001651.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001227.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000338.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.001814.log: Operation not permitted chown: /target/generations/generation-553/kb/history/segment.000387.log: Operation not permitted chown: /target/generations/generation-553/kb/history: Operation not permitted chown: /target/generations/generation-553/kb/history: Operation not permitted chown: /target/generations/generation-553/kb/code.idx: Operation not permitted chown: /target/generations/generation-553/kb/embed.idx: Operation not permitted chown: /target/generations/generation-553/kb/wal.log: Operation not permitted chown: /target/generations/generation-553/kb/snapshot.001863.bin: Operation not permitted chown: /target/generations/generation-553/kb/git.idx: Operation not permitted chown: /target/generations/generation-553/kb/LOCK: Operation not permitted chown: /target/generations/generation-553/kb/snapshot.001862.bin: Operation not permitted chown: /target/generations/generation-553/kb: Operation not permitted chown: /target/generations/generation-553/kb: Operation not permitted chown: /target/generations/generation-553/engine-stats.json: Operation not permitted chown: /target/generations/generation-553/kb.old.20260827T020942_829000: Operation not permitted chown: /target/generations/generation-553/kb.old.20260827T020942_829000: Operation not permitted chown: /target/generations/generation-553/kb.lock: Operation not permitted chown: /target/generations/generation-553/snapshot-pin.json: Operation not permitted chown: /target/generations/generation-553: Operation not permitted chown: /target/generations/generation-553: Operation not permitted chown: /target/generations: Operation not permitted chown: /target/generations: Operation not permitted chown: /target/refresh.lock: Operation not permitted chown: /target: Operation not permitted chown: /target: Operation not permitted`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-v14/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v006/deceased-account/facts.json` | unavailable |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
