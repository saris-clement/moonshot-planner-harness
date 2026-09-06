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

## Hypothesis

The hypothesis below is model-generated and remains unverified until the experiment completes.

> Measure the selected seed revision before applying an experimental mutation.

Expected impact: Establish reproducible primary and holdout facts for this campaign.

Risk: Provider nondeterminism means one screening run is descriptive rather than conclusive.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-v14 |
| Variant | trumark-deceased-accounts-v14-v004 |
| Parent | none |
| Round | 0 |
| Status | failed |
| Planner seed | `13bd342adbad89c1d4cd680e08d0327e54a53fe3` |
| Workflows source | `304c0857c9b5aff3076de504a52ee364bd279b0d` |
| Environment | `sha256:c74a27a40f2243e5a4f5cdc6272084a122e52c7c919aa9a743ff6a1aa879f799` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v004/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-v14-7c3dced3ac-4` |
| Artifact collection | incomplete |

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

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> No blind-judge result is available.

## Holdout

Not run for this variant.

## Failure

`command failed (1): docker compose --env-file /Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-v14/environment.env --env-file /Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v004/stack.env --project-name eval-trumark-deceased-accounts-v14-4-3c2ce73cbd --project-directory /Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/worktrees/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v004 --file /Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/worktrees/trumark-deceased-accounts-v14/frozen-planner/docker-compose.yml up -d --no-build --wait --wait-timeout 300 ceased-accounts-v14-4-3c2ce73cbd-kb Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-redis-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-redis-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-planner-1 Creating   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-planner-1 Created   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-redis-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-redis-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Exited   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Healthy   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Exited   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Exited   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-planner-1 Starting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-planner-1 Started   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-redis-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-planner-1 Waiting   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-1 Healthy   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-redis-1 Healthy   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-volume-init-1 Exited   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-ddb-init-1 Exited   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-init-1 Exited   Container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-minio-1 Healthy  container eval-trumark-deceased-accounts-v14-4-3c2ce73cbd-planner-1 is unhealthy`

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
