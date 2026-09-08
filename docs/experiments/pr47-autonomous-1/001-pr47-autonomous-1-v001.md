# Provider-floor bounded evidence hydration

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

- Early provider-ranked qualified candidates carry useful relevance that lexical overlap should not displace.
- A portion of the fixed envelope remains sufficient to rescue query-relevant lower-ranked declarations.
- Provider rank remains deterministic within each returned search result.

## Observed Issues

### finding-capacity-sensitive-evidence-loss: evidence_retention

Authority: `legacy_current_parent_diagnosis`

This legacy experiment predates finding snapshots. The displayed parent finding was not preregistered and may change after re-diagnosis.

> Hydration applies fixed file and byte quotas, admits at most one projected declaration per path, and stops after quotas are satisfied. Across measured funnels, searches and source reads succeeded, yet evidence-slot exhaustion and malformed-hit rejection removed large portions of retrieved candidates. For an observed changing unit, one replicate selected admitted evidence and returned extend while the other admitted less evidence, selected none, and returned build.

Proposed generic intervention: Allocate hydration capacity by semantic novelty and decision relevance before projection, use deterministic tie-breaking, and prevent low-value duplicate or malformed hits from consuming the opportunity to inspect later qualified candidates.

Supporting evidence: `evidence-d4d39407ec48103b`, `evidence-062aeec537543a6e`, `evidence-904b2c31fc24ba54`, `evidence-57b02be7477d4f31`, `evidence-cd80bd1a79267c04`, `evidence-4191859291f86980`, `evidence-319013cde46060c9`, `evidence-183888855ceef893`

Counterevidence: `evidence-05e42b71f37b44f6`, `evidence-093fb303087c5f81`, `evidence-01e6e3b1e1de85c3`, `evidence-d6b71465405cb4bf`

Falsification: Replay identical durable search results under larger and relevance-prioritized projection budgets. Falsify the mechanism if selected evidence and dispositions remain unchanged despite materially fewer slot-exhaustion rejections.

Limitations: Rejection counts are occurrences rather than unique missing capabilities.; Successful source reads demonstrate that the KB was available; this finding concerns downstream qualification and retention.

## Planned Change

The plan below is the latest investigator preregistration, not an immutable original hypothesis. It remains unverified; per-action revisions are preserved in the investigation archive.

> Action-005 showed that replacing provider order with lexical ranking was too disruptive, while one changed unit demonstrated that bounded relevance can rescue useful non-leading evidence. A hybrid policy might retain provider-ranked precision while using remaining fixed capacity for query-relevant candidates, but this was not evaluated.

Implementation instructions:
> Preserve a provider-ranked floor equal to half the fixed total-file envelope rounded up, then rank remaining qualified candidates by generic normalized query-to-symbol/path relevance, using provider rank as fallback. Preserve all inspection, file, byte, policy, visibility, executability, and projection limits without workflow-specific constants.

Expected impact: Unverified: provider-ranked evidence might recover relative to action-005 while retaining occasional lower-ranked relevant declarations. No improvement is claimed because the revised patch received only targeted test coverage.

Risk: The provider floor may still retain irrelevant evidence or leave insufficient relevance capacity. Search-result variation prevents clean causal attribution, the only completed primary evaluation regressed, no human-verified labels were available, and promotion safeguards were not run.

## Investigation

Session state is operational telemetry. Hypotheses, rationales, and reasons are unverified interpretations; test success is not planner correctness.

### Session

| Field | Value |
| --- | --- |
| Session | ses_f812c5469ffeFOwZVOwX5iz2SX |
| Session status | abandoned |
| Started | 2026-09-08T02:23:15.157Z |
| Updated | 2026-09-08T03:57:53.163Z |
| Agent cost USD | unknown |
| revision | 2ba718c4a80e5e64ca9ebb0bebec0ba55a7728ae |
| dirtyPatchHash | sha256:9cc21dd3ffca98f0943567f2c0995e9b335f08294ac5250d170f0db9595b26a6 |
| runtimeSourceHash | sha256:c609365173d9fef64471e3a3fe2be6122bded37653f4919e9fc4327861ba4748 |
| contextHash | sha256:21b5e01e4d54b6934f3ede51ce6b96bfc46fb86df8d7204afbf0b045c0642e38 |
| mutationBaselineTree | sha256:c299351b06328ea261d9e4db8ad142bc1947dd5540e91dd0fb2fe66d7b0a8366 |
| labelSetHash | sha256:097e014f0d6603e73f5489be8c7c7151972a650b0000d259f44c86630d9b269c |

Recorded reason (unverified interpretation):
> The unrestricted treatment was falsified by action-005: provisional accuracy fell from 0.352 to 0.332, discovered evidence from 317 to 298, and selected source references from 47 to 41. The provider-floor revision passed targeted tests in action-006 but remains unevaluated, and the remaining wall-time budget is materially shorter than action-005's evaluation duration. It would be unsafe to claim improvement or finalize without primary, holdout, target-excluded, and human-review safeguards.

### Budgets

These are per-investigator budgets, separate from planner usage. Primary evaluation attempts include failed actions. Wall time is the elapsed session span at the last persisted update, not model duration.

| Budget | Used | Limit |
| --- | ---: | ---: |
| Turns | 7 | 12 |
| Primary evaluation attempts | 1 | 3 |
| Wall elapsed at last update ms | 5678006 | 7200000 |
| Agent tokens | unknown | 2000000 |

### Action Timeline

| Action | Kind | Status | Hypothesis (unverified) | Patch | Recorded outcome | Artifact directory |
| --- | --- | --- | --- | --- | --- | --- |
| action-003 | test | failed | Relevance-aware bounded evidence hydration | sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | No treatment beyond inherited parent. Make a bounded change or abandon. Artifacts: investigation/action-003 | investigation/action-003 |
| action-004 | test | completed | Relevance-aware bounded evidence hydration | sha256:285c4f273fab4721b82e2f46797f9a074657605b79064f633ae7ba73eb07b32b | Tests passed (execution only) | investigation/action-004 |
| action-005 | evaluate_primary | completed | Relevance-aware bounded evidence hydration | sha256:285c4f273fab4721b82e2f46797f9a074657605b79064f633ae7ba73eb07b32b | Trial verified: unknown; provisional: 33.2%. Baseline verified: unknown; provisional: 35.2%. Label set: sha256:097e014f0d6603e73f5489be8c7c7151972a650b0000d259f44c86630d9b269c | investigation/action-005 |
| action-006 | test | completed | Provider-floor bounded evidence hydration | sha256:1d6f065dd4a4483fdff7ea6395d17bb8d319652ce036405330334deb4ce16bcc | Tests passed (execution only) | investigation/action-006 |
| action-007 | abandon | completed | Provider-floor bounded evidence hydration | sha256:1d6f065dd4a4483fdff7ea6395d17bb8d319652ce036405330334deb4ce16bcc | Abandoned; no improvement asserted | investigation/action-007 |

Targeted trusted tests precede primary development trials. Finalization requires full configured tests and semantic review before final primary, holdout, and configured excluded cohorts. A finalized session is not a completed experiment or a promotion decision. Trial facts remain separate from final facts below.

Action directories are relative to this variant's ignored artifact root. Requests, pins, patches, receipts or failure records, logs, runtime question audits, transitions, and raw results remain there; they are not copied into this summary.

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
| Variant | pr47-autonomous-1-v001 |
| Parent | pr47-autonomous-1-v000 |
| Round | 1 |
| Status | rejected |
| Planner seed | `a24baf79e777b07a3b55d027dc5ea5a8701e6af8` |
| Workflows source | `140ec306bff8c20aa9eccde3cc2f4647ce790655` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v001/investigation/action-007/variant.patch` |
| Patch hash | `sha256:1d6f065dd4a4483fdff7ea6395d17bb8d319652ce036405330334deb4ce16bcc` |
| Image | not built |
| Artifact collection | incomplete |

## Baseline Metrics

| Metric | Parent | Observed | Delta |
| --- | ---: | ---: | ---: |
| Build units | 83 | unavailable | unavailable |
| Reuse units | 1 | unavailable | unavailable |
| Extend units | 25 | unavailable | unavailable |
| Defer units | 16 | unavailable | unavailable |
| Question units | 0 | unavailable | unavailable |
| Decision agreement | 77.6% | unavailable | unavailable |
| Selected source references | 47 | unavailable | unavailable |
| Verified accuracy | unavailable | unavailable | unavailable |
| Provisional accuracy | 35.2% | unavailable | unavailable |

## Actual Facts

Consensus decision counts and agreement describe the final cohort only, not trial scores. Raw-replicate mean accuracy is reported separately.

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

## Score Basis

Accuracy and errors use the raw-replicate mean against a shared label reference, not majority-consensus accuracy. Missing labeled units count as errors; a missing accuracy is unknown, not zero. Consensus decisions and agreement remain descriptive observations. Normal scoring uses persisted baseline provisional labels; excluded scoring uses its separate baseline judgment and labels. Human-verified labels retain precedence. Fresh candidate judgments are interpretations, not a replacement baseline reference. Trial label snapshots are hash-bound in investigator context; final score-basis artifacts record the labels used at scoring time.

Runtime answers are not globally frozen. Question audits, decision-set hashes, and cohort-comparison artifacts diagnose context differences; matching input pins alone do not establish strict replay.

Per-benchmark score-basis.json and cohort-comparison.json files remain in the ignored artifact archive; target-excluded scoring keeps its own reference.

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | unavailable |
| Verified errors | unavailable |
| Verified accuracy | unscored |
| Provisional labels | unavailable |
| Provisional errors | unavailable |
| Provisional accuracy | unscored |
| Persisted labels | 241 |
| Cohort pin mismatches | unavailable |

## Experiment Arms

| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Standard | rejected (no final facts) | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

No target-safe control or target-excluded result is available for this experiment.

## Conclusion

Status: `incomplete`

No final measured facts are available. Experiment lifecycle: `rejected`. Investigator session: `abandoned`. Development trials and passing tests do not establish a final outcome.

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

`The unrestricted treatment was falsified by action-005: provisional accuracy fell from 0.352 to 0.332, discovered evidence from 317 to 298, and selected source references from 47 to 41. The provider-floor revision passed targeted tests in action-006 but remains unevaluated, and the remaining wall-time budget is materially shorter than action-005's evaluation duration. It would be unsafe to claim improvement or finalize without primary, holdout, target-excluded, and human-review safeguards.`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/campaigns/pr47-autonomous-1/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v001/deceased-account/facts.json` | unavailable |
| Investigator session and actions | `observed_durable` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/harness.sqlite` | abandoned |
| Investigator trial archive | `mixed_authority` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v001/investigation/` | see per-action status; not final cohort evidence |
| Parent measured facts | `observed_durable` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/artifacts/pr47-autonomous-1/pr47-autonomous-1-v000/deceased-account/facts.json` | archived |
| Human labels | `human_verified` | `/var/folders/2m/d_6yq4x1073d7ysl50hkb2m40000gn/T/opencode/moonshot-planner-harness-autonomous/.data/live/pr47-autonomous-1/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
