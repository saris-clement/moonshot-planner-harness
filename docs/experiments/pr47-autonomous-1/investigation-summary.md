# PR47 Autonomous Investigation Summary

This aggregate research summary records the live campaign alongside the preserved [candidate report](001-pr47-autonomous-1-v001.md) and [baseline report](000-pr47-autonomous-1-v000.md). Timing and targeted-test totals come from archived action records and trusted test logs. This is not a replacement generated report, a human-review sidecar, or a verified scoring label. No raw source excerpts or session transcript are included.

## Outcome

No improvement was established. The only completed primary trial scored lower against its provisional reference. The revised patch received targeted test coverage but no primary evaluation, final cohorts, or promotion.

| Observation | Aggregate result | Interpretation limit |
| --- | --- | --- |
| First full-primary screening | Two sequential replicates; approximately 82 minutes | Recorded before the new screening-count default |
| Provisional baseline accuracy | 35.2% | LLM-suggested reference, not human-verified correctness |
| Provisional trial accuracy | 33.2%, a decrease of 2.0 percentage points | Observed screening regression; not proof of a causal mechanism |
| Revised provider-floor patch | 103 targeted tests passed | Execution evidence only; revised accuracy remains unknown |
| Session conclusion | Abandoned at turn 7 with approximately 25 minutes remaining | Not finalized or promoted; insufficient time for another trial of the observed duration |

The abandonment was a conservative budget decision. It did not convert test success into an accuracy claim, and it did not pretend the revised treatment had passed final evaluation. No human-verified labels were available for these scores.

## Protocol Clarification

Provisional labels are acceptable for primary screening and finalization. Human review is not a prerequisite for either operation. The archived agent reason mentions human-review safeguards; that is preserved unverified interpretation, not a coordinator admission rule. Semantic compliance review is also a model judgment. Human-reviewed evidence is required to describe a result as human-verified correctness, but its absence does not prohibit provisional experiments.

## Future Screening

Future investigator trials default to `investigator.primaryReplicates: 1`, configurable from 1 to 3. Every screening replicate still evaluates the full primary pack; only repetition count changes. Baseline and final evaluation retain `evaluation.replicates`, which remains 2 for V2, with final holdout and target-excluded safeguards unchanged.

A single screening replicate cannot measure agreement or establish stability. It is a budget-conscious development signal, not a replacement for repeated final evaluation. The observed 82-minute trial motivates reducing early repetition cost; it does not guarantee a particular duration or quality benefit for future runs.

The archived campaign had no `primaryReplicates` field and actually completed two trial replicates. Its configuration, database, generated reports, and measurements are not rewritten by the new default. Historical UI counts must come from recorded trial results or live execution metadata before using configuration as a fallback.
