# Phase 2 V13c experiment axes

Status: next observation selected, no results claimed

Date: 2026-09-05

## Objective

V13c should identify which independent stage limits source-aware disposition: query generation,
retrieval, projection/admission, evidence selection, disposition policy, confidence, or reconciliation
with reviewed requirements. The deceased-account pack remains an evaluation fixture, not a source of
workflow-specific production rules.

## Selected next observation

V13c selects the cumulative evidence-exhaustion axis: preserve V13b retrieval, exclusions, and
disposition policy while giving the first exact frozen-scope lexical/fuzzy fallback an independent
transient envelope equal to the broad-search envelope. The selected aggregate ceiling is ten files
and 512 KiB, while each search remains within five files and 256 KiB and persisted/selected evidence
remains capped at five. The V13c provider-visible prompt bytes are identical to V13b; only versioned
server-side capacity, tool, configuration, hydration, and grounding pins differ. Correctness and
evidence visibility are primary for this observation; bytes and cost are secondary measurements.

This records the configuration to observe; it does not claim an experimental result. Causal
interpretation is limited to removing cross-call cumulative exhaustion. Because the added envelope
contains both file slots and bytes, V13c does not isolate whether cardinality or byte capacity within
that envelope matters. The pure cardinality-only and byte-only axes below remain future experiments.

This document proposes experiments, not a final design. Each trial changes one variable while the
requirements, source commit/tree, KB generation/snapshot, model, cohort, search result limit, and all
other relevant pins remain fixed. See the [retrieval study](./deceased-account-phase2-retrieval-study.md)
for run IDs, raw artifact filenames, and the audit.

## Baseline signals

The low-hanging-fruit hypothesis is that increasing evidence slots will recover exact fallback
source. It is plausible but incomplete.

**Evidence for the hypothesis:** V13b automatic search hydration rejected 796 candidates for slot
exhaustion, including 150 target-path occurrences. `computeShareDodBalance(s)` and
`isUsableAccrualPeriod` were exact fallback hits rejected only after broad evidence had consumed the
cumulative slots. [V13b analysis/transcript]

One target-path model-issued `kb_get` adds one rejection outside automatic search hydration. The
persisted receipt totals are therefore 797 slot rejections overall and 151 for the target path.

**Evidence against treating it as sufficient:** only two of 42 target-hit units failed to admit any
target evidence, while selection reached only 14 units. Among builds, 22 admitted target production
evidence and still remained `build`; 19 of 24 target-hit builds admitted the same broad
`dividendBasisClause` anchor. Fifty builds had no target hit at all. More slots cannot repair a query
miss or a disposition rubric that ignores admitted implementation. [V13b analysis/transcript and
manual audit]

**Cost warning:** V13b projected 5,787,911 production bytes plus 1,382,491 test bytes, used 5,683,761
input tokens, and cost USD 17.668266. V13 projected 2,257,435 plus 465,255 bytes, used 2,938,029 input
tokens, and cost USD 9.737880. Blind expansion would begin from 2.63 times the projected bytes and
1.81 times the cost of V13. [V13/V13b analyses]

The earlier cheapest-first proposal was a 256 KiB aggregate, cap-preserving trial. The selected V13c
observation intentionally does not use that configuration: it adds one complete independent fallback
envelope, raising aggregate cardinality and bytes together to ten files and 512 KiB. Pure
cardinality-only and byte-only trials remain available for later attribution.

## Experimental contract

- Freeze workflow export `38b74ad46bf3`, revision 51; source commit
  `140ec306bff8c20aa9eccde3cc2f4647ce790655`, tree
  `443509a2c4fa4ffa0d56a4df57c615e44c8ef530`; KB generation 1863, snapshot
  `sha256:7646fe1380ebd2a53b9f309619bd3911549a82398cc7622ae8ac8e3054f804c3`;
  and model `gpt-5.6-sol`.
- Freeze the cohort and expected-source labels before viewing candidate outcomes.
- Change one axis at a time. A combined configuration is tested only after its components have
  independent measurements.
- Separate deterministic replay, KB retrieval, projection, and model adjudication results. Do not
  attribute a downstream disposition change to retrieval when only the prompt changed.
- Preserve production/test authority and source verification. Supporting tests never become
  implementation authority.
- Keep transient projection cardinality distinct from persisted and selected evidence. Current
  `MAX_DISCOVERED_EVIDENCE`, analysis `discoveredEvidence`, runtime `selectedCandidateIds`, and
  analysis `selectedCandidateIds` caps are five; a visibility experiment must account for those
  contracts without silently widening final selection.
- Report every failed or rejected tool operation; unknown is not zero.
- Repeat model-involving finalists because one provider output is not a causal result.

## Frozen focused cohorts

### Original top ten

Use the exact ten units in the retrieval study. The V13b baseline score is 3/10; V13's reference score
is 5/10. Do not replace hard examples after seeing a trial.

### V13 extend-regression cohort

Freeze the six V13 `extend` units that became V13b `build`:

| Unit | Requirement anchor |
| --- | --- |
| `unit.2a787b38a5b1711dd9417b6b` | `overview/entrypoints/manual-user-interface-launch` |
| `unit.47571bd0e5c7ae07ecca03d9` | `fields/recorded_figure_attribution_outcome` |
| `unit.94eaa2963f6ea24dee047a3b` | `fields/undetermined_figure_review_count` |
| `unit.9c753bd6a635b1896d1d442e` | `fields/deceased_member_name` |
| `unit.9f638e4efd1303282826ca9b` | `fields/dividend_period_start` |
| `unit.b9688475a4661b7dc8aa9045` | `fields/recorded_figure_disagreement_count` |

Three are already in the top ten, leaving 13 unique units in the minimum focused union. Keep
`unit.06d91aeb6d3d6f6b81361d28`, the explicit out-of-scope unit corrected from V13 `extend` to V13b
`defer`, as an exclusion guard rather than counting it as an extend regression. [V13/V13b analyses]

Before a full run, add regression controls from the audited likely-valid builds, requirements-state
conflicts, shared-source selections, supporting-test-only evidence, and the nine deterministic
zero-usage exclusions. The selections and expected labels must be frozen before trials begin.

## Metrics

Metrics must be reported per focused cohort and, when run, over all 109 units.

| Metric | Definition | V13b full-run reference |
| --- | --- | ---: |
| Target hit | Units with at least one returned target-path title | 42 |
| Target admission | Units with any admitted target evidence | 40 |
| Target production admission | Units with admitted target production evidence | 37 |
| Target selection | Units selecting relevant target production evidence | 14 |
| Exact-source rejections | Pre-registered relevant declarations rejected by reason; report unique declarations and occurrences | Target-path proxy: 150 slot and 59 non-executable search occurrences |
| Top-ten score | Correct source-aware outcomes in the frozen original cohort | 3/10 |
| V13 extend regressions | Six frozen `extend->build` units still not source-backed extend/reuse | 6 |
| False-build audit | Blinded audit counts: clearly existing, likely extend, valid build, conflict | 30 / 28 / 9 / 7 among 74 builds |
| Input tokens / cost | Sum from adjudication usage | 5,683,761 / USD 17.668266 |
| Tool failures | Failed transcript entries, separated from policy rejections | 0 |
| Source bytes | Production and test projection bytes, reported separately | 5,787,911 / 1,382,491 |
| Requirements conflicts | Pre-registered source-versus-reviewed-state conflicts, not silently forced to build | 7 in the manual audit |

Target-path metrics are fixture instrumentation. Also report relevant shared/other-workflow evidence
and false selections so a trial cannot improve by overfitting the target directory.

The automatic `experiment:compare` report derives only generic grounding and rejection totals from
the strict public analysis. It must leave target-path funnels, build cohorts, and target-path
exhaustion deltas unknown. The post-run research write-up reconstructs those fixture metrics from
durable transcripts plus the Langfuse `toolUseId`/requirement-ordinal join described in the retrieval
study.

## Independent axes

### A. Future file-slot cardinality under the same byte cap

**Variable:** change the transient production-file cap from 4 to 7 and the linked total-file cap from
5 to 8. Keep the test-file cap at 2 and retain the 192 KiB production, 64 KiB test, and 256 KiB
combined byte caps, as well as the same search results, ranking, windows, prompt, and model
configuration. Moving the production and total cardinality limits together is one cardinality-envelope
variant; increasing only total files would remain blocked by the production cap for production-heavy
evidence.

Persisted `discoveredEvidence` and final `selectedCandidateIds` remain capped at five. Feasibility
must account for `MAX_DISCOVERED_EVIDENCE` and the runtime/analysis contract caps, explicitly
separating transient model visibility from final persisted selection rather than conflating them.

**Expected signal:** later exact declarations are admitted; `evidence_slots_exhausted` falls for the
pre-registered exact-source set without increasing projected bytes beyond the existing cap.

**Risk:** eight smaller or low-value windows may increase evidence fragmentation and selection noise.
The total cap may remain the actual bottleneck, producing no change.

**Accept if:** exact-source admission rises, top-ten and extend-regression outcomes do not worsen,
source bytes stay within the frozen cap, and irrelevant selection does not increase.

**Reject if:** only raw admission count rises, exact-source selection/disposition does not, or any
gain depends on exceeding the byte cap.

### B. Future byte-envelope expansion

**Variable:** raise only the projection byte envelope while retaining five files and the same
retrieval/ranking. Production and combined caps should move as one pre-registered budget factor;
test authority remains separately capped.

**Expected signal:** declarations already blocked by bytes, rather than file count, become admissible.

**Risk:** more irrelevant broad-window text increases input tokens, cost, and model distraction.
V13b already admitted substantial broad evidence without selecting the exact implementation.

**Accept if:** exact-source selections and focused-cohort score improve enough to justify the measured
token/cost delta, with no new V13 extend regression or false reuse.

**Reject if:** bytes, tokens, or cost increase while exact-source selection and audited build
precision remain flat. Do not test simultaneous production `4->7`, total `5->8`, and byte expansion
first; that confounds cardinality and byte envelopes. A combined blunt expansion is only an
interaction trial after axes A and B.

### C. Fallback slot reservation

**Variable:** keep five files and 256 KiB total, but reserve two production file slots for a scoped
fallback. All other ranking and projection behavior stays fixed.

**Expected signal:** exact fallback hits such as the two pre-registered slot-rejected examples gain
admission without increasing the budget.

**Risk:** unused reservations reduce broad-search coverage when no fallback is needed. A fallback can
also be confidently wrong.

**Accept if:** fallback exact-source admission and selection rise, reserved capacity waste is
reported, and broad-only control units do not lose required evidence.

**Reject if:** reservation merely trades one set of relevant rejections for another or lowers the
top-ten/regression-control score.

### D. Specificity-based replacement and refill

**Variable:** keep the same slots and bytes, but allow a later higher-specificity fallback candidate
to replace lower-specificity broad evidence. Pre-register the specificity comparison; do not use the
known target path as a preference.

**Expected signal:** exact identifier or strongly aligned declaration evidence displaces generic
anchors, reducing broad-evidence collapse.

**Risk:** unstable replacement can discard complementary context or encode a brittle specificity
heuristic.

**Accept if:** pre-registered exact declarations replace lower-ranked generic evidence, selected
source relevance and focused-cohort score improve, and deterministic replay is stable.

**Reject if:** churn increases without fewer exact-source rejections, or replacement favors target
location rather than query/source alignment.

### E. Union ranking before projection

**Variable:** collect broad and scoped candidate pointers first, rank their union once, and only then
project source. Keep search calls, limits, five files, 256 KiB, ranking features, and prompt fixed.

**Expected signal:** query order no longer lets the broad search monopolize cumulative slots.

**Risk:** always waiting for fallback can add retrieval latency, and incomparable score scales may
make the union rank unstable.

**Accept if:** order sensitivity disappears in deterministic replay, exact-source admission rises,
and source bytes/tool failures do not increase.

**Reject if:** union ranking cannot be made deterministic across search modes or improves hit volume
without selection/disposition quality.

### F. Broad-window size

**Variable:** reduce only declaration-window size for broad-search evidence; leave fallback windows,
file count, total cap, ranking, and prompt unchanged.

**Expected signal:** less generic context consumes the byte budget, leaving room for exact evidence
and reducing model distraction.

**Risk:** the declaration may require nearby control flow or types; smaller windows can make valid
evidence misleading or incomplete. It does not solve file-slot exhaustion by itself.

**Accept if:** exact-source admission or selection rises with lower projected bytes/tokens and no
increase in unsupported rationales during source audit.

**Reject if:** source verification still passes but auditors lose the context needed to justify the
disposition, or file-slot rejection remains unchanged.

### G. Evidence sharing across related behavior units

**Variable:** make already verified evidence from an explicitly related behavior unit available to
one sibling unit; keep queries, per-unit disposition prompt, and total per-unit cap fixed. Compare
against no sharing.

**Expected signal:** one source read can expose a behavior implemented across several atomic fields
or acceptance units, reducing repeated misses and cost.

**Risk:** relevance can leak across merely adjacent requirements, correlating false decisions. It can
also obscure unit-local provenance.

**Accept if:** sibling exact-source selection rises, every shared snippet retains unit-visible
provenance, input tokens/source bytes fall or remain bounded, and unrelated controls do not move.

**Reject if:** sharing creates false reuse/extend, hides which query found the evidence, or turns a
requirements conflict into an unsupported consensus.

### H. Query strategy

**Variable:** change query construction only. Compare current synthetic requirement identifiers with
a pre-registered strategy that preserves exact identifiers but also emits source-vocabulary terms
from verified context. Keep modes, limits, prefix, projection, and adjudication fixed.

**Expected signal:** the 50 no-target builds, especially the 36 hybrid queries dominated by synthetic
`snake_case`, gain relevant hits without broadening the source authority.

**Risk:** source-vocabulary expansion can overfit the fixture or leak target knowledge into the query.

**Accept if:** target and relevant shared-source hit rates rise on the focused and regression cohorts,
zero-result lexical calls fall, tool failures remain zero, and irrelevant hit/selection rates do not
rise.

**Reject if:** gains require hard-coded workflow symbols/paths, disappear outside the fixture, or
increase hits without admission and eventual selection.

### I. Disposition rubric

**Variable:** hold retrieved and admitted evidence bytes exactly fixed; change only the adjudication
rubric for distinguishing absent implementation from an existing primitive that lacks the exact
normalized requirement contract.

**Expected signal:** admitted-but-build cases move toward `extend` when source implements the behavior
but not its final required shape. Likely valid builds remain builds.

**Risk:** a permissive rubric can relabel superficial similarity as implementation coverage.

**Accept if:** blinded false-build/likely-extend audit counts improve, valid-build controls remain
build, source references justify every changed disposition, and false reuse remains zero.

**Reject if:** the model selects generic anchors without explaining the implementation delta, or the
change merely lowers build count.

### J. Confidence gating

**Variable:** change only confidence policy. For example, prohibit high-confidence `build` when
source discovery failed to produce a relevant hit or when retrieved evidence conflicts with the
rationale; leave the disposition itself unchanged.

**Expected signal:** the 50 no-target high-confidence builds become honest uncertainty rather than
unsupported certainty, making retrieval failures measurable and reviewable.

**Risk:** confidence can collapse globally without improving retrieval, creating review noise.

**Accept if:** false high-confidence builds fall, likely valid-build controls retain justified
confidence, and question/defer volume remains within a pre-registered review budget.

**Reject if:** confidence changes indiscriminately, masks a stable disposition defect, or is inferred
from target-path absence rather than evidence sufficiency.

### K. Requirements-state reconciliation

**Variable:** hold source evidence and disposition rubric fixed; add a separate reconciliation step
that compares reviewed requirement state with observed implementation state before final confidence.

**Expected signal:** the seven pre-registered audit conflicts are surfaced as conflicts instead of
being silently forced into high-confidence build/extend.

**Risk:** the planner may over-question normal requirement deltas or treat source as product
authority. Requirements still define desired behavior; source defines implemented capability.

**Accept if:** known conflicts are surfaced with both requirement and source references, non-conflict
controls do not move, and conflict count is reported independently from retrieval misses.

**Reject if:** reconciliation rewrites requirements, suppresses valid new work, or uses the fixture's
identity mismatch as a production alias.

## Cheapest-first sequence

1. **Deterministic transcript replay.** Reuse frozen V13b hit lists and source receipts for the
   13-unit focused union. Compare production `4->7` and total `5->8` transient files at the same 256
   KiB, two-slot reservation, replacement/refill, union ranking, and smaller broad windows. Leave
   test cardinality and persisted/selected caps unchanged. No model call and no new 109-unit run.
   Report exact-source admission/rejection, role bytes, and order sensitivity.
2. **Retrieval-only query trial.** Run query variants on the same frozen KB snapshot for the focused
   union and pre-registered controls. Do not project source or call the adjudicator. Report target and
   relevant shared-source hits, zero-result calls, irrelevant-hit rate, latency, and tool failures.
3. **Fixed-evidence adjudication trial.** Freeze identical admitted snippets and compare disposition
   rubric, confidence gating, and requirements reconciliation separately. Repeat model trials; report
   top-ten score, six V13 extend regressions, false-build audit, conflict handling, tokens, and cost.
4. **Focused end-to-end trial.** Integrate only one winning axis at a time over the focused union plus
   regression controls. Confirm that upstream gains survive selection and disposition.
5. **Broader regression trial.** Exercise likely-valid builds, shared/other-workflow evidence,
   supporting-test-only cases, and deterministic exclusions. Reject target-directory overfitting.
6. **One 109-unit smoke run.** Run only after a candidate passes focused gates. If favorable, repeat
   before claiming an effect; compare exact run/analysis/trace IDs and every frozen pin.

## Gates before another 109-unit run

These are proposed experiment gates, not an implementation choice:

- Restore at least V13's 5/10 top-ten reference without adding a new V13 extend regression.
- Reduce the six-unit V13 extend-regression count and preserve the explicit-exclusion guard.
- Improve exact-source admission and selection, not merely total hit or admitted-snippet count.
- Show a blinded reduction in clearly false builds or likely-extend builds while preserving the
  pre-registered likely-valid builds.
- Keep tool failures at zero in the focused trials.
- For future cap-preserving axes, do not exceed the per-envelope 256 KiB total; require lower or equal
  focused-cohort source bytes and disclose input-token/cost deltas.
- For any byte-expansion axis, pre-register a cost ceiling and reject a result whose only improvement
  is more evidence volume.
- Surface requirements conflicts separately; do not score them as retrieval corrections.
- Preserve source/test authority, frozen-source verification, and complete provenance.

Passing these gates would justify a full experiment. It would not by itself prescribe which V13c
mechanism should ship.
