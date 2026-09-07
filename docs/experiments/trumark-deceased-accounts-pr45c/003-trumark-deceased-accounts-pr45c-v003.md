# Verify callable boundaries separately from implementation visibility

## Goal

Improve generic Phase 2 source-backed adjudication accuracy using PR 45 durable diagnostic correlation. Preserve requirement, source, model, prompt, budget, and knowledge pins; distinguish measured facts, deterministic reconstruction, model diagnosis, and human truth. Reduce false build and false extend decisions without introducing false reuse or customer-specific production heuristics. Use the target-excluded arm only as a promotion guard against over-eager reuse and target leakage, never as a fitness reward.

## Base Assumptions

These assumptions were recorded before execution. They are model-generated and unverified.

- Unverified model-generated assumption: callable-boundary metadata can be verified deterministically from generic source structure.
- Unverified model-generated assumption: private declarations linked to a verified boundary accurately prove its externally observable behavior.
- Unverified model-generated assumption: the current error is caused by visibility policy rather than an actual behavioral gap.

## Observed Issues

### finding-visibility-policy-overconstrains-reuse: evidence_retention

Authority: `unverified_model_judgment`

> The planner discovered behavior matching the requested entrypoint but classified its selected declaration as private top-level evidence. The frozen policy permits such evidence only for extension, so declaration visibility overrode behavioral completeness and repeatedly prevented reuse.

Proposed generic intervention: Distinguish reuse of an externally callable workflow boundary from direct import of an internal declaration. Require an exported or registered boundary for reuse, but allow private implementation evidence to prove behavior when that boundary is independently verified.

Supporting evidence: `evidence-614ff5e3a1221048`, `evidence-024190cc32639718`, `evidence-006740da806a7c7b`

Counterevidence: `evidence-4e4ce889ce85d8ef`, `evidence-08484a666567b490`

Falsification: Add a boundary-verification signal without changing source visibility, then replay the unit. Reject this finding if the decision remains extend despite verified callable-boundary evidence, or if allowing such evidence creates false reuse decisions on controls.

Limitations: The visibility restriction is deliberate and protects against claiming that private helpers are reusable APIs.; The counterclaim of behavioral completeness is model-generated and unverified.

## Planned Change

The plan below is model-generated and remains unverified. It is recorded before execution so the result can be evaluated against the original intervention.

> The unverified diagnosis reports that private declaration visibility overrode otherwise matching behavior (supporting evidence-614ff5e3a1221048, evidence-024190cc32639718, evidence-006740da806a7c7b). Counterevidence indicates the visibility restriction is deliberate and some private helpers must not be treated as reusable interfaces (evidence-4e4ce889ce85d8ef, evidence-08484a666567b490). Behavioral completeness is model-generated, and the finding currently rests on a bounded example.

Implementation instructions:
> Change only evidence-retention semantics: independently verify an exported, registered, or otherwise externally callable boundary, then permit linked private declarations to prove that boundary's behavior without declaring those private symbols reusable APIs. Retain the existing restriction when no boundary is verified. Falsify the hypothesis if the disputed disposition remains unchanged with verified boundary evidence or if normal controls or the target-excluded guard gain unsupported reuse.

Expected impact: Distinguish reuse of an existing callable behavior from direct reuse of its private implementation while preserving API-safety constraints.

Risk: Incorrect boundary linkage could weaken the private-evidence safeguard and produce false reuse decisions.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr45c |
| Variant | trumark-deceased-accounts-pr45c-v003 |
| Parent | trumark-deceased-accounts-pr45c-v000 |
| Round | 1 |
| Status | failed |
| Planner seed | `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | none |
| Image | not built |
| Artifact collection | incomplete |

## Baseline Metrics

| Metric | Parent | Observed | Delta |
| --- | ---: | ---: | ---: |
| Build units | 82 | unavailable | unavailable |
| Reuse units | 4 | unavailable | unavailable |
| Extend units | 23 | unavailable | unavailable |
| Defer units | 16 | unavailable | unavailable |
| Question units | 0 | unavailable | unavailable |
| Decision agreement | 81.6% | unavailable | unavailable |
| Selected source references | 42 | unavailable | unavailable |
| Verified accuracy | unavailable | unavailable | unavailable |
| Provisional accuracy | 28.0% | unavailable | unavailable |

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
| Persisted labels | 241 |
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

`diff changes files outside the allowed paths: web/src/api.ts`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr45c/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v003/deceased-account/facts.json` | unavailable |
| Parent measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v000/deceased-account/facts.json` | archived |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
