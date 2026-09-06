# Phase 2 evidence retrieval and adjudication handoff

Status: working handoff; current experimental direction, not a final design
Date: 2026-09-05

This document is the starting point for continuing Phase 2 evidence-retrieval and adjudication work.
It describes the general planner problem, the authority and replay contracts that constrain any
solution, the evidence funnel, the experimental method, and the current direction. The
`trumark/deceased-account` pack appears only as a frozen evaluation fixture. It must not become a
source of workflow-specific production behavior.

## Evidence language

Every substantive claim below uses one of these labels:

| Label | Meaning |
| --- | --- |
| **Observed** | Computed from a frozen analysis, transcript, trace, checked-in baseline, or current implemented contract. |
| **Audit** | Human judgment after reading source at the frozen commit; useful evidence, but not a deterministic oracle. |
| **Hypothesis** | A proposed explanation or intervention that requires an isolated experiment. |
| **Invariant** | A product, authority, safety, or replay property that experiments must preserve. |

The detailed fixture measurements and audit method are in the
[retrieval study](./deceased-account-phase2-retrieval-study.md). The checked-in
[V11 baseline](./deceased-account-phase2-baseline.json),
[V12 observation](./deceased-account-phase2-v12-observation.json),
[V13 observation](./deceased-account-phase2-v13-observation.json), and
[V13b observation](./deceased-account-phase2-v13b-observation.json) are compact comparison inputs, not
substitutes for the published analyses and durable transcripts.

## Product mission and authority

**Invariant.** The planner is the human-reviewed requirements-to-builder planning stage. It compares
reviewed desired behavior with implemented capability and produces a reviewable, versioned account of
what can be reused, what must change, what must be built, and what remains uncertain. Phase 2 creates
the source-backed decision matrix; Phase 3 turns that matrix into milestones, validation gates, and
eventual builder work. See [AGENTS.md](../../AGENTS.md), [DESIGN.md](../../DESIGN.md), and
[How Phase 2 analyzes requirements](../../HOW_PHASE_2_ANALYZES_REQUIREMENTS.md).

**Invariant.** Requirements are product authority: they define the behavior the product should have.
Frozen source is implementation authority: it proves what executable behavior exists at the selected
commit. Source may reveal a reusable basis or a conflict, but it does not rewrite a reviewed
requirement. Conversely, a clear requirement does not prove that implementation is absent.

**Invariant.** Database rows, availability snapshots, catalog declarations, and runtime configuration
are not capability authority. They may preserve planner state, constrain eligibility, or point toward
code, but only verified source at the exact frozen Git commit proves implemented capability. DynamoDB
and S3/MinIO remain durable business truth for runs and content-addressed planner artifacts; that is
different from being authority for what the workflows repository implements.

**Invariant.** The solution must remain workflow-independent. Workflow identity, paths, symbols, and
business nouns are inputs and evidence, never hard-coded retrieval policy. A change that improves one
fixture by encoding its directory, singular/plural alias, field names, or known declarations is a
failed product experiment even if its fixture score rises.

**Invariant.** The solution must be idempotent, auditable, and historically replayable. Repeated
requests converge through idempotency keys and immutable successors; canonical artifacts and hashes
bind every decision to its context; old cases retain the contracts they froze. Replayability means an
agent can reconstruct and verify what inputs, policies, evidence, and provider interactions produced
a result. It does not mean a nondeterministic provider is guaranteed to emit identical output on a new
call.

## What Phase 2 decides

**Observed.** Phase 2 deterministically decomposes eligible reviewed `solution/main` nodes into stable,
atomic requirement units. A unit is one independently adjudicated trigger, document, field, check,
system, action, output, cardinality constraint, or user-visible behavior. The model does not create,
merge, or rename these units.

**Invariant.** Every eligible unit must receive exactly one disposition before publication:

| Disposition | Decision meaning | Required evidence or uncertainty |
| --- | --- | --- |
| `reuse` | Existing supported implementation fully covers the required behavior. | Selected eligible production evidence and exact frozen source tuples; no uncovered semantics. |
| `extend` | Existing implementation is a valid base, but required behavior remains. | Selected eligible production evidence, exact source tuples, and explicit uncovered semantics. |
| `build` | The supported evidence available to this adjudication did not prove a reusable or extendable base. | No selected candidate; explicit uncovered semantics. This is not repository-wide proof of absence. |
| `defer` | The unit is explicitly outside active planning or is blocked by declared scope. | No selected candidate; the deferral basis remains explicit. |
| `question` | A material product, external, compliance, security, configuration, or proof fact is needed. | Explicit uncertainty and a durable, context-bound question; low confidence is not silently converted into work. |

**Invariant.** Every decision carries requirement references, bounded evidence, confidence, and either
coverage or explicit uncertainty. The planner defines scope and proof, while the builder owns files,
classes, libraries, and implementation design.

**Invariant.** Atomic `build` counts are not ticket counts. Phase 3 may group many fields, checks, and
behaviors into one vertical implementation ticket. A false `build` still matters because it states,
incorrectly, that no supported implementation basis was selected for that requirement atom; reducing
the count without improving evidence precision is not success.

## Why the problem is hard

| Constraint | Consequence |
| --- | --- |
| **Observed:** the frozen manifest is a deterministic shortlist, not an exhaustive repository map. | An empty shortlist cannot prove absence; relevant private or undeclared implementation may remain elsewhere in source. |
| **Invariant:** the global, multi-repository KB is discovery only. | KB rank, prose, title, symbol, and path are leads. They never become source authority, and unrelated repositories or prose must be filtered. |
| **Invariant:** frozen Git is authority. | Every useful pointer must resolve to a tracked, allowed, UTF-8 blob and qualifying declaration at the exact commit and tree. A current branch or working tree cannot substitute. |
| **Observed:** requirement and code vocabularies diverge. | Generated requirement IDs, normalized field contracts, and business prose may not match implementation names, abbreviations, or control-flow vocabulary. Exact lexical fallback can succeed where broad semantic retrieval fails, and vice versa. |
| **Invariant:** adjudication remains unit-local. | Bounded behavior context may come only from explicit authored dependencies and field/check references. The current unit remains the sole decision target; evidence found for a related unit is not implicitly shared. |
| **Invariant:** production and tests have different authority. | Executable production declarations can support selection. Tests, fixtures, mocks, scenarios, scripts, and internal test workflows are supporting-only and cannot become implementation source references. |
| **Observed:** providers are nondeterministic. | One run cannot establish a causal effect; decision churn can occur despite identical requirements, source, KB, and model pins. |
| **Invariant:** context is bounded. | Search hits, qualified pointers, file slots, role bytes, total bytes, selected candidates, calls, tokens, duration, and cost all have explicit ceilings. More evidence can crowd out better evidence or distract selection. |
| **Invariant:** audit and recovery are durable. | Checkpoints, transcripts, usage, decisions, questions, receipts, and published analyses must survive restart without replaying an ambiguous paid call. |

## Frozen invariants

Any experiment or implementation candidate must preserve all of the following.

1. **Invariant: exact pins.** Freeze the original and normalized requirements identities; revision and
   export hash; source repository, commit, tree, observation, and blob identities; manifest,
   availability, harness, and source-policy hashes; KB generation and snapshot; model provider,
   model, and configuration; prompt and prompt hash; tool schema/protocol; decomposition, ranking,
   context, search, hydration, projection, and exclusion algorithms; decision-set context; and all
   budgets relevant to dispatch.
2. **Invariant: requirements authority.** Reviewed requirements define desired behavior. A source
   mismatch is reported as a conflict or delta, never resolved by silently adopting source behavior.
3. **Invariant: no KB prose authority.** KB prose can explain or guide another search. It cannot prove
   implementation, widen the frozen manifest by assertion, or support a final source reference.
4. **Invariant: verify selected tuples.** Every selected `(capability, path, symbol, commit)` tuple is
   projected by the server and re-read from frozen Git. Phase 3 verifies its declaration, visibility,
   role, range, and hashes before consuming it.
5. **Invariant: tests are supporting-only.** Test evidence can clarify intent and behavior but cannot
   be selected or cited as implementation authority.
6. **Invariant: private declarations are extend-only.** A unique executable private top-level
   JavaScript or TypeScript declaration may prove a modification base, but cannot be promoted to a
   reusable public capability. `reuse` requires exported production evidence.
7. **Invariant: no source-policy leakage.** A path or capability excluded by source policy cannot
   appear in ranking, tool-visible results, hydration, transient evidence, transcripts, selections,
   rationales, Phase 3 research, tickets, or plan evidence.
8. **Invariant: counterfactual exclusion is explicit.** Target exclusion retains observed resolution,
   manifest, source, and harness facts for audit while removing the exact proved implementation root
   and owned capability IDs from the planning view. Shared and other-workflow code remains eligible.
   See [ADR 0041](../adr/0041-counterfactual-target-exclusion-and-phase2-retrieval.md).
9. **Invariant: compact persistence.** Large source windows are transient. Persist exact paths,
   symbols, roles, declaration previews, line ranges, ranks, hashes, byte counts, operation lineage,
   admission counts, selection policy, truncation flags, and rejection reasons, but not raw large
   source. Model-authored persisted text must not smuggle those windows into durable state.
10. **Invariant: historical compatibility.** A new version may add new pins and contracts, but old
    versioned prompts, tool schemas, algorithms, artifacts, optional fields, and cases remain readable
    and verifiable under their frozen semantics. Never retrofit a historical case with current pins.
11. **Invariant: deterministic identities.** Canonical serialization, stable ordering, content hashes,
    unit IDs, request hashes, question IDs, checkpoint lineage, and published analysis hashes do not
    depend on provider completion order or mutable local state.
12. **Invariant: explicit exclusions.** Every manifest exclusion, malformed or unsafe pointer,
    unsupported role, quota rejection, duplicate, and source-policy rejection remains observable.
    Unknown stages are reported as unknown, never zero.

## The end-to-end evidence funnel

**Invariant.** Diagnose each boundary independently. A downstream correct-looking disposition does
not prove that upstream retrieval worked, and a large raw hit count does not prove that useful evidence
reached the model.

```text
requirement unit
    |
    v
query -> raw hit -> qualified pointer -> frozen source read
                                             |
                                             v
                                  projection / admission
                                             |
                                             v
                                      model selection
                                             |
                                             v
                                        disposition
                                             |
                                             v
                                  Phase 3 verification
```

| Boundary | Distinct failure class | Metrics that belong at this boundary |
| --- | --- | --- |
| Unit -> query | Query omitted a code-shaped identifier, used synthetic vocabulary absent from source, mixed incompatible concepts, leaked target knowledge, or was never issued. Provider/tool transport may also fail. | Queries and effective request hashes by mode, calls per unit, zero-query units, failed calls, latency, exact identifier preservation, and frozen scope/prefix. |
| Query -> raw hit | The KB did not retrieve relevant code, returned zero, ranked it beyond the bounded result set, or returned only irrelevant/prose results. | Raw hits, zero-result calls, relevant hit rate on pre-registered labels, ranks, repository distribution, target/shared/other-workflow fixture instrumentation, and irrelevant-hit rate. |
| Raw hit -> qualified pointer | A result was prose, malformed, outside authority, excluded by policy, a declaration-only type, or lacked a parseable repository path and symbol. | Qualified pointer count and ratio, filtered rank, and rejection counts by exact reason. Do not merge policy rejection with provider failure. |
| Qualified pointer -> frozen source read | The path was untracked, unsafe, a symlink, invalid UTF-8, missing at the commit, blob-mismatched, or the nominated declaration was absent/non-unique/non-executable. | Hydration attempts, successful reads, Git blob hashes, read failures, declaration validation failures, and source-policy drops. |
| Source read -> projection/admission | A valid declaration was supporting-only, duplicated, too large, unprojectable, or arrived after role, file, or byte capacity was exhausted. | Production/test admissions separately, admitted files and bytes, declaration-window coverage, slot/byte exhaustion, duplicates, rejected relevant declarations, and unused reserved capacity. |
| Admission -> model selection | The model ignored precise evidence, selected a broad generic anchor, failed to combine complementary evidence, or changed selection nondeterministically. | Selected discoveries, selection per admitted relevant pointer, false selections, selected source roles, selection churn across repeats, and focused-cohort precision/recall. |
| Selection -> disposition | The rubric demanded an exact generated contract instead of recognizing an implementation primitive, overstated absence, made false `reuse`, mishandled explicit deferral, or concealed a requirements-state conflict. | Disposition transitions by stable unit ID, source-backed `reuse`/`extend`, blinded false-build audit, likely-valid-build controls, uncovered semantics, confidence calibration, question/defer volume, and conflict counts reported separately. |
| Disposition -> Phase 3 verification | A selected tuple, visibility claim, compact preview, role, line range, hash, or exclusion policy cannot be reproduced from the frozen commit. | Verification pass/fail by tuple and reason, source-policy leakage, hash agreement, missing declarations, role/visibility mismatches, and analysis-to-plan evidence continuity. |

**Observed.** V13 introduced one `EvidenceGroundingV1` receipt per unit so search calls, hits,
pointers, attempts, reads, admissions, bytes, selections, operations, and rejection reasons can be
checked for internally possible relationships. [ADR 0042](../adr/0042-qualified-search-hydration.md)
defines the production/test envelopes, transient source windows, compact persistence, and Phase 3
re-verification contract.

## Experimental discipline

1. **Invariant: freeze cohorts before outcomes.** Keep hard misses, prior successes, likely-valid
   builds, requirements conflicts, shared/other-workflow selections, supporting-test-only cases, and
   explicit zero-usage exclusions. Do not replace an inconvenient unit after observing a trial.
2. **Invariant: change one variable when causal attribution matters.** Query, KB retrieval, pointer
   qualification, source projection, admission capacity, selection prompt, disposition rubric,
   confidence policy, and reconciliation are separate axes. Combined candidates come only after their
   components have independent measurements.
3. **Invariant: start cheapest.** Use deterministic transcript replay for admission policies,
   retrieval-only trials against the frozen KB for query policies, and fixed-evidence model trials for
   rubric or confidence changes. Run focused end-to-end cohorts before a paid full-pack smoke run.
4. **Invariant: preserve regressions and controls.** A candidate must retain prior valid evidence,
   explicit exclusions, source/test authority, counterfactual filtering, and likely-valid builds. Hits
   or admissions gained by losing these controls are not progress.
5. **Invariant: never optimize build count alone.** Optimize source-aware decision quality: relevant
   hit, admission, selection, justified disposition, calibrated uncertainty, and verified Phase 3
   continuity. Track false `reuse`, false `extend`, and conflict suppression as first-class harms.
6. **Invariant: repeat nondeterministic finalists.** One provider result is an observation. Repeat
   model-involving finalists under identical pins and report run, analysis, and trace IDs plus
   selection/disposition variance.
7. **Invariant: account for every cost.** Calls, latency, input/output tokens, provider cost,
   production/test bytes, source reads, and rejected work remain measured even when correctness is the
   current optimization priority.

**Observed.** The pre-registered focused cohorts, metrics, independent axes, and cheapest-first sequence are in
[Phase 2 V13c experiment axes](./phase2-v13c-experiment-axes.md).

## What V11 through V13b established

**Observed.** These four cases held the requirements, source, KB, and model listed below fixed while
prompt, tool protocol, projection, provider configuration, and exclusion behavior evolved. They are
therefore comparable research observations, not a one-variable causal trial.

| Frozen input | Exact value |
| --- | --- |
| Requirements workflow | `trumark/deceased-account` (evaluation fixture only) |
| Export / revision | `38b74ad46bf3` / `51` |
| Source commit | `140ec306bff8c20aa9eccde3cc2f4647ce790655` |
| Source tree | `443509a2c4fa4ffa0d56a4df57c615e44c8ef530` |
| KB generation | `1863` |
| KB snapshot | `sha256:7646fe1380ebd2a53b9f309619bd3911549a82398cc7622ae8ac8e3054f804c3` |
| Model | `gpt-5.6-sol` |

**Observed.** Exact artifact identities:

| Version | Case | Run | Analysis | Langfuse trace |
| --- | --- | --- | --- | --- |
| V11 | `7PQFRQT9H876E8M58K8T8Q5WYW` | `run.a9ecb3f824f2c5698bdaab62` | `analysis.a8f4dae248c76bb983added2` | `3292c1d041fac76cfc7c9ce61f4609bd` |
| V12 | `3PTXXJDVQP1AQN6E3JMZEP4WKP` | `run.0cda18a9a45430d9a7a463f6` | `analysis.601f2e5ce8b681997ccb191e` | `64a85fc2e572b848c415d37a212d1a88` |
| V13 | `5W8NBBN2Y8Z4CEWBEA61E4B910` | `run.9b1099e8438403fcaa6eabc3` | `analysis.c2e2ead475739f7418089bcd` | `80c62f769ec050c79e137dbf37fc8642` |
| V13b | `3W93A4Y6WVAZJRCWN76BR25G2M` | `run.7d4766256078a5d88a89f50d` | `analysis.effe6095224e80dedbaecdc7` | `6ade5b116b203ebb2e3d6125bba79664` |

**Observed.** Aggregate outcomes and paid usage:

| Version | Build | Reuse | Extend | Defer | Input tokens | Output tokens | Cost (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V11 | 89 | 1 | 8 | 11 | 1,325,161 | 58,689 | 4.8691535 |
| V12 | 86 | 0 | 11 | 12 | 1,528,857 | 54,463 | 5.320731 |
| V13 | 81 | 0 | 16 | 12 | 2,938,029 | 60,463 | 9.737880 |
| V13b | 74 | 2 | 21 | 12 | 5,683,761 | 71,969 | 17.668266 |

**Observed.** The core funnel measurements are more informative than the declining build count:

| Version | KB operations | Failed transcript entries | Search hits | Qualified pointers | Source reads | Production / test admissions | Selected discoveries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V11 | 185 | 44 | unknown | unknown | unknown | unknown | unknown |
| V12 | 180 | 0 | unknown | unknown | unknown | unknown | unknown |
| V13 | 175 | 1 | 1,013 | 382 | 148 | 105 / 20 | 12 |
| V13b | 188 | 0 | 2,251 | 1,431 | 415 | 257 / 59 | 20 |

**Observed: V11.** The manifest and exported-symbol-oriented bridge left 89 of 109 units as `build`.
Forty-four of 185 KB calls failed or were rejected. Ten build-time searches returned target source,
but nine target hits did not become committed evidence. Discovery visibility and evidence commitment
were both broken.

**Observed: V12.** Tool/schema alignment made all 180 KB calls succeed, and unique executable private
top-level declarations became eligible for `extend`. Eleven units returned target source, eight
received target evidence, and five selected it; four of those eight hydrations projected a file prefix
that omitted the nominated declaration. Reliable calls did not remove the search-to-evidence gap, and
builds moved only from 89 to 86.

**Observed: V13.** Automatic qualified-title hydration, declaration-centered windows, separate
production/test authority, and grounding receipts repaired the two-step hydration defect. Target
hit/admission/selection reached 12/12/9 units; disposition reached 81 builds and 16 extends. One KB
engine error remained. V13's original frozen top-ten score was 5/10.

**Observed: V13b.** Scoped query behavior expanded retrieval: target
hit/admission/production-admission/selection reached 42/40/37/14 units, and dispositions reached 74
builds, two reuses, and 21 extends. Yet the frozen top-ten score fell to 3/10. Six V13 `extend` units
became V13b `build`; 796 automatic hydration candidates were rejected for slot exhaustion, including
150 target-path occurrences. V13b projected 5,787,911 production bytes and 1,382,491 test bytes,
2.63 times V13's combined projected bytes, and cost 1.81 times V13.

**Audit.** Human review of all 74 V13b builds classified 30 as clearly existing implementation and
likely false `build`, 28 as an existing primitive and likely `extend`, nine as likely valid `build`,
and seven as requirements-state conflicts. This audit is evidence that aggregate build reduction did
not establish build precision; it is not a deterministic label oracle.

**Observed.** The fixture deliberately retains singular requirements identity and plural
implementation identity. No production alias heuristic follows from it. Detailed transitions,
rejections, top-ten units, source examples, durations, and audit cohorts remain in the
[retrieval study](./deceased-account-phase2-retrieval-study.md) rather than being duplicated here.

## Current lessons

1. **Observed:** hydration can work while retrieval fails. V13 can faithfully verify and project a
   qualified title, but no hydration mechanism can recover source that the bounded query never
   returns.
2. **Observed:** more hits and admissions can reduce selection precision. V13b greatly increased every
   upstream count while regressing the original top-ten score and six prior extends.
3. **Observed:** broad evidence can exhaust cumulative slots before precise fallback. Exact fallback
   declarations such as `computeShareDodBalance(s)` and `isUsableAccrualPeriod` arrived after broad
   evidence had consumed the shared envelope and were rejected as `evidence_slots_exhausted`.
4. **Audit:** exact generated field contracts can trigger build-versus-extend rubric errors. Source
   may already resolve, calculate, or render the required behavior without exposing the normalized
   field name or final output contract; that usually argues for evaluating `extend`, not declaring
   implementation absent.
5. **Observed:** evidence is unit-local. A related field, check, or behavior may discover the decisive
   declaration, but sibling adjudications do not currently inherit it. Any evidence-sharing experiment
   must retain per-unit relevance, provenance, and bounds.
6. **Audit:** requirements-state conflicts are separate from retrieval. Better source retrieval cannot
   reconcile reviewed desired state with contradictory implementation state. The conflict must be
   surfaced without allowing source to override requirements.
7. **Hypothesis:** retrieval, admission order, evidence selection, disposition rubric, confidence, and
   requirements reconciliation are independent bottlenecks. Treating any one as the sole cause will
   hide regressions at the others.

## Current experimental direction

**Hypothesis.** At the time of writing, the next candidate should preserve V13b query and retrieval
behavior, including the broad hybrid/code envelope, while adding a separate evidence envelope for the
scoped fallback. Broad evidence must not consume the fallback's capacity before its more precise
results can be evaluated. This can be tested as an admission/projection change without first changing
query generation or the disposition rubric.

**Invariant.** V13c is not declared successful. Measure the separate fallback envelope with frozen
transcript replay and focused cohorts first. Then confirm that any admission gain becomes relevant
selection and a source-justified disposition. Only after retrieval and admission are measured should a
fixed-evidence experiment change the build-versus-extend rubric; changing both would destroy causal
attribution.

**Invariant.** Correctness and source-aware decisions are the primary objective for this stage. Cost
and projected source bytes are deliberately secondary while the funnel is being repaired, but they
are never ignored: continue reporting calls, reads, role-separated bytes, tokens, latency, and USD for
every trial. A later efficiency pass must operate on a configuration that first demonstrates decision
quality.

## How to resume

### Read in this order

1. [AGENTS.md](../../AGENTS.md) for topology, commands, and golden rules.
2. [DESIGN.md](../../DESIGN.md) for current frozen-input, authority, prompt, tool, and replay contracts.
3. [How Phase 2 analyzes requirements](../../HOW_PHASE_2_ANALYZES_REQUIREMENTS.md) for decomposition,
   ranking, evidence, adjudication, questions, checkpoints, and publication.
4. [ADR 0041](../adr/0041-counterfactual-target-exclusion-and-phase2-retrieval.md) for source-policy
   exclusion and private-declaration authority.
5. [ADR 0042](../adr/0042-qualified-search-hydration.md) for qualified hydration, evidence envelopes,
   receipts, compact persistence, and V13b.
6. [The retrieval study](./deceased-account-phase2-retrieval-study.md) for exact observations, joins,
   transitions, manual audit, and limitations.
7. [The V13c axes](./phase2-v13c-experiment-axes.md) for frozen cohorts, metrics, controls, and
   cheapest-first experiments.
8. The three checked-in JSON baselines linked at the top of this document. Treat missing historical
   dimensions as `unknown`, not zero.

### Read the implementation boundaries

**Observed.** Start with these source files; do not infer behavior from this handoff alone:

| Concern | Source |
| --- | --- |
| Requirement/adjudication and grounding contracts | `server/src/contracts/analysisV1.ts`, `server/src/contracts/phase2RuntimeV1.ts` |
| Decomposition and candidate ranking | `server/src/phase2/decomposeRequirements.ts`, `server/src/phase2/rankCandidates.ts` |
| Manifest evidence and discovered evidence | `server/src/phase2/assembleEvidence.ts`, `server/src/phase2/hydrateDiscoveredEvidence.ts` |
| Run/checkpoint/question/transcript/publication orchestration | `server/src/phase2/analysisService.ts` |
| Provider prompt, tools, containment, and usage | `server/src/model/anthropicPlannerModel.ts` |
| Phase 2 API | `server/src/http/phase2.ts` |
| Comparison report | `server/src/cli/compareEvidenceVisibility.ts`, `server/src/experiments/evidenceVisibilityComparison.ts` |

### Run locally

**Observed.** The deterministic repository gate is:

```bash
npm run check
```

**Observed.** The self-contained stack is:

```bash
docker compose up --build
```

**Observed.** For host development, initialize local dependencies and then run the API/UI:

```bash
docker compose up -d ddb-init minio-init redis
npm run dev
```

**Observed.** Compare an already-completed normal and target-excluded pair without mutations:

```bash
npm run experiment:compare -- \
  --base-url http://127.0.0.1:3121 \
  --normal-case-id <normal-case-id> \
  --excluded-case-id <counterfactual-case-id> \
  --baseline docs/experiments/deceased-account-phase2-v13b-observation.json \
  --out .local/e2e/phase2-comparison.json
```

**Observed.** The comparison command performs GETs against the planner and writes only the requested
local report. It validates shared pins and known baseline requirements/source/KB/model identity,
reports decision, usage, and generic per-unit-grounding totals, and scans available Phase 3 evidence
for excluded-source leakage. Prompt, configuration, tool, hydration, and grounding-version differences
are intentional experiment dimensions rather than identity mismatches. Historical missing identity or
evidence fields remain explicit unknowns, not zeroes.

**Invariant.** Public analysis receipts support automatic totals for searches, hits, pointers,
attempts, reads, production/test admissions, projected bytes, selections, and rejection reasons. They
do not retain target-path hit lists or complete admitted-but-unpersisted path cohorts. Target-path
funnels, target build cohorts, and target-path exhaustion counts therefore remain `null` in
`experiment:compare`. Reconstruct those metrics during the post-run research write-up by joining
durable transcript entries with Langfuse generations on `toolUseId`, `requirementOrdinal`, and
`requirementUnitId`.

### Locate evidence

**Observed.** Case and run records, current IDs, statuses, checkpoint references, and artifact metadata
are structured state in DynamoDB. Content-addressed requirements, checkpoints, analyses, and compact
tool-transcript segments are in S3/MinIO. The disposable Git cache is only a source-read cache and is
not business truth.

**Observed.** Use `GET /api/planning-cases/:caseId/runs`,
`GET /api/planning-cases/:caseId/runs/:runId`, and
`GET /api/planning-cases/:caseId/analysis` to locate and inspect published run/analysis state. Per-unit
V13+ grounding receipts live in the published analysis. Durable transcript entries retain
content-free hydration receipts and operation lineage; transient large source windows do not.

**Observed.** Langfuse holds the model generations and tool/source observations on the Phase 2 trace.
Join V13+ generations to durable transcript entries by `requirementOrdinal`, `requirementUnitId`, and
`toolUseId`; do not treat transcript `attempt` as requirement order. Record the Langfuse root trace ID
beside case, run, and analysis IDs as the artifact ledger above does.

### Create and record experiments safely

1. **Invariant:** a fresh case freezes the current requirements, source, KB, model, prompt, tool,
   algorithm, policy, and budget pins. Do not assume it inherited a historical experiment's profile;
   inspect the resolved input set.
2. **Invariant:** never mutate, reset, or retrofit a historical case, run, analysis, baseline, or raw
   trace. Create an immutable successor for an eligible retry or a fresh case for changed inputs.
3. **Invariant:** pre-register the cohort, source labels, controls, one changed variable, acceptance
   gates, rejection gates, and cost ceiling before observing model outcomes.
4. **Observed:** record a new observation as a compact JSON baseline only after recomputing totals from
   the published analysis and durable transcript. Include purpose, capture time, case/run/analysis IDs,
   requirements identities, resolved hashes and versions, disposition/usage totals, funnel receipts,
   failure/rejection counts, and comparison limitations.
5. **Invariant:** add a dated Markdown observation or extend the detailed study with an artifact-ledger
   row, exact Langfuse trace ID, method, Observed/Audit/Hypothesis labels, controls, regressions, and raw
   local artifact filenames. Keep raw large analyses, transcripts, and traces outside Git unless a
   separate retention decision says otherwise.
6. **Invariant:** run `npm run check` after implementation changes and `git diff --check` for every
   documentation patch. Do not deploy merely to validate an offline replay or documentation update.

## Decision checklist

Before accepting an experimental candidate, answer every item explicitly:

- **Invariant:** Are requirements, source commit/tree, KB generation/snapshot, model/configuration,
  prompt, tools, algorithms, budgets, cohort, and source policy exactly pinned and reported?
- **Invariant:** Is the changed variable isolated from query, projection, selection, rubric,
  confidence, and reconciliation axes that are meant to remain fixed?
- **Observed:** Did relevant raw hits improve, or did only total hits improve?
- **Observed:** Did qualified pointers survive frozen-Git verification with explicit rejection reasons?
- **Observed:** Did exact relevant production evidence reach admission without promoting tests or
  private declarations beyond their authority?
- **Observed:** Did the model select the relevant evidence, not merely receive it?
- **Audit:** Do changed `reuse`/`extend`/`build` dispositions match frozen source and clearly state the
  remaining requirement delta?
- **Observed:** Were prior valid extends/reuses, likely-valid builds, shared-source controls, explicit
  defers, and counterfactual exclusions preserved?
- **Observed:** Are requirements conflicts reported separately rather than counted as retrieval wins?
- **Invariant:** Can Phase 3 re-read every selected tuple and reproduce hashes, visibility, role, range,
  and source-policy eligibility?
- **Observed:** Are calls, failures, rejections, bytes, tokens, latency, cost, and nondeterministic
  variance fully reported?
- **Invariant:** Does the change generalize without fixture paths, aliases, nouns, symbols, or expected
  answers encoded in production policy?

## Non-goals and anti-overfitting rules

- **Invariant:** Do not implement workflow business behavior in the planner.
- **Invariant:** Do not turn the evaluation fixture's singular/plural identity into alias inference.
- **Invariant:** Do not prefer a known target directory, customer prefix, symbol, or field name except
  where a frozen, general source-scope contract supplies it as data.
- **Invariant:** Do not treat the manifest, KB, database, tests, model rationale, or a search miss as
  proof of implemented capability or repository-wide absence.
- **Invariant:** Do not widen `reuse`; private or incomplete implementation remains `extend` at most.
- **Invariant:** Do not solve retrieval by removing unit-local traceability, source verification,
  content bounds, explicit exclusions, compact persistence, or counterfactual policy.
- **Invariant:** Do not optimize aggregate builds, hits, admissions, tokens, or cost in isolation.
- **Invariant:** Do not let requirements-state reconciliation make source the product authority.
- **Invariant:** Do not combine multiple unmeasured V13c axes and then assign causality to one of them.
- **Invariant:** Do not call a single nondeterministic run, a focused-cohort pass, or better hydration a
  successful general solution. Success requires repeated source-aware decisions, preserved controls,
  and Phase 3-verifiable evidence under exact frozen pins.
