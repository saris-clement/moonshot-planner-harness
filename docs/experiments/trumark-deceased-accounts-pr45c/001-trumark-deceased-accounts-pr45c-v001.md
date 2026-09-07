# Stage behavioral and structural retrieval

## Goal

Improve generic Phase 2 source-backed adjudication accuracy using PR 45 durable diagnostic correlation. Preserve requirement, source, model, prompt, budget, and knowledge pins; distinguish measured facts, deterministic reconstruction, model diagnosis, and human truth. Reduce false build and false extend decisions without introducing false reuse or customer-specific production heuristics. Use the target-excluded arm only as a promotion guard against over-eager reuse and target leakage, never as a fitness reward.

## Base Assumptions

These assumptions were recorded before execution. They are model-generated and unverified.

- Unverified model-generated assumption: behavioral and structural query decomposition retrieves relevant declarations that compound queries currently miss.
- Unverified model-generated assumption: enclosing-module and caller fallback adds useful context within the existing evidence budget.
- Unverified model-generated assumption: the cited declarations actually support the disputed behavior under human review.

## Observed Issues

### finding-retrieval-recall-under-semantic-drift: source_discovery

Authority: `unverified_model_judgment`

> Compound queries combining requirement identifiers, output-field terminology, and behavioral prose often ranked unrelated declarations or returned no exact lexical hits. Hydration and committed-source reads succeeded, but relevant implementation declarations were consequently absent from the selectable evidence set, leading the planner to infer that new implementation was required.

Proposed generic intervention: Use staged retrieval: begin with separate behavioral and structural queries, expand field terminology into implementation concepts, and fall back from symbol results to their enclosing module and callers before concluding absence. Preserve the existing source-integrity checks.

Supporting evidence: `evidence-5bece13361db7ebe`, `evidence-00758e54293bc6e0`, `evidence-2186475755a7f2d2`, `evidence-3cef64a325603d46`

Counterevidence: `evidence-6e9d562312e9b250`, `evidence-e230bf6ec481d8c1`, `evidence-dc0590541284f88f`

Falsification: Replay the affected units with identical pins, model, prompt, and budget while changing only retrieval to staged query expansion plus enclosing-module fallback. Reject this finding if relevant committed declarations are not retrieved more often or if build decisions do not decrease.

Limitations: The relevant-behavior assessment relies partly on blind-judge interpretation rather than human verification.; The target-excluded comparison is a separate guard and does not establish normal-run truth.

## Planned Change

The plan below is model-generated and remains unverified. It is recorded before execution so the result can be evaluated against the original intervention.

> The unverified diagnosis links compound-query semantic drift to missing relevant declarations despite successful source reads (supporting evidence-5bece13361db7ebe, evidence-00758e54293bc6e0, evidence-2186475755a7f2d2, evidence-3cef64a325603d46). Counterevidence shows some relevant material was retrieved under the existing process (evidence-6e9d562312e9b250, evidence-e230bf6ec481d8c1, evidence-dc0590541284f88f). The diagnosis relies partly on model judgment and the target-excluded arm cannot establish truth.

Implementation instructions:
> Change only retrieval planning: issue separate behavioral and structural queries, translate requested field language into generic implementation concepts, and fall back from symbol hits to enclosing modules and callers. Preserve all pins, budgets, source-integrity checks, evidence limits, and adjudication policy. Falsify the hypothesis if affected units do not retrieve relevant committed declarations more consistently, or if independently reviewed accuracy does not improve. Use the target-excluded arm only to reject increased target leakage or unsupported reuse.

Expected impact: Improve source coverage under vocabulary mismatch so dispositions are based on relevant executable evidence rather than unsupported absence inference.

Risk: Query expansion may add irrelevant evidence or exhaust fixed limits, while the diagnosed relevance of existing behavior remains unverified.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-pr45c |
| Variant | trumark-deceased-accounts-pr45c-v001 |
| Parent | trumark-deceased-accounts-pr45c-v000 |
| Round | 1 |
| Status | failed |
| Planner seed | `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a` |
| Workflows source | `27634f5226176003153c6ec2a3e1c579072ff7be` |
| Environment | `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v001/variant.patch` |
| Image | `ainative-planner-eval:trumark-deceased-accounts-pr45c-bede783bef-1` |
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

### deceased-account

| Metric | Count |
| --- | ---: |
| Blocking questions | 1 |
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| Reused campaign answers | 1 |
| Planner questions | 0 |
| Planner requirements-agent requests | 0 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

#### 01M1Q2R1VHAKDZHSQ7TQDBA8B2

Resolution: `source_fallback`

Question:
> What is the approved Symitar connection endpoint/environment (e.g., production vs. test region) and the specific read-only credential scope (member, death, deposit, non-mortgage consumer-loan, Visa external-loan, and Tracking 50/51/52/53 records) that this workflow must be provisioned against for production enablement?

Answer:
> Provision against the `trumark-live` deployment. The workflow requires read access to member/account and name data, account Tracking 50/51/52/53, shares/deposits and share transactions, child loans and loan transactions, and Visa/external-loan records and tracking. Source applies no mortgage/non-mortgage loan filter. Symitar access is read-only; the workflow performs no Symitar write-back. The exact SymXchange URL/region and credential secret are deployment-provided and are not present in source.

Evidence:
- tools/deploy/config.json:29-35 — TruMark Deceased Accounts targets environment `trumark-live`.
- src/customers/trumark/deceased-accounts/stages/resolve.ts:81-88 — runtime reads the member through `getAccountSelectFields`; no config endpoint is called.
- src/modules/shared/api/symitar/client.ts:89-127 — request selects all account, name, account-tracking, share/share-transaction, loan/loan-transaction, external-loan, and external-loan-tracking fields, with unfiltered loan and external-loan children.
- src/customers/trumark/deceased-accounts/stages/resolve.ts:4-10 — workflow consumes Tracking 50/51/52/53.
- src/customers/trumark/deceased-accounts/README.md:3-6 — workflow is recommend-only and never writes back to Symitar.
- src/modules/shared/api/symitar/types/endpoints/setup-config.ts:1-6 — exact `sym_exchange_url` is a setup/deployment value; deceased-accounts source does not provide it.

### unrelated-holdout

| Metric | Count |
| --- | ---: |
| Blocking questions | 0 |
| Requirements-agent requests | 0 |
| Requirements-agent answers | 0 |
| Source fallback answers | 0 |
| Reused campaign answers | 0 |
| Planner questions | 0 |
| Planner requirements-agent requests | 0 |
| Planner requirements-agent answers | 0 |
| Planner source fallback answers | 0 |
| Planner reused answers | 0 |
| Planner human answers | 0 |

No blocking question required an answer.

## Holdout

Not run for this variant.

## Target-Excluded Guard

Not configured or not run for this variant.

## Failure

`command failed (2): docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 --memory 4g --cpus 4 --tmpfs "/tmp:rw,exec,nosuid,size=1g" --tmpfs "/root/.npm:rw,noexec,nosuid,size=128m" --tmpfs "/app/.local:rw,noexec,nosuid,size=1g" --tmpfs "/app/server/node_modules/.vite-temp:rw,noexec,nosuid,size=256m" --env CI=1 --entrypoint npm ainative-planner-eval:trumark-deceased-accounts-pr45c-bede783bef-1-test run typecheck npm error Lifecycle script `typecheck` failed with error: npm error code 2 npm error path /app/server npm error workspace @ainative-planner/server@0.1.0 npm error location /app/server npm error command failed npm error command sh -c tsc --noEmit`

## Evidence Ledger

| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
| Frozen campaign inputs | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/campaigns/trumark-deceased-accounts-pr45c/campaign.json` | hash-pinned |
| Current measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v001/deceased-account/facts.json` | unavailable |
| Parent measured facts | `observed_durable` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-pr45c/trumark-deceased-accounts-pr45c-v000/deceased-account/facts.json` | archived |
| Human labels | `human_verified` | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/harness.sqlite` | 0 verified |

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

No human-authored notes have been added.

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
