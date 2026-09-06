# Deceased Account Phase 2 Historical Baseline

## Purpose

Preserve the first source-policy observation imported from the planner repository. This record is historical context, not campaign gold truth and not a valid causal control for later prompt, source, model, or knowledge pins.

## Actual Facts

| Metric | Value |
| --- | ---: |
| Case status at capture | failed |
| Requirement units | 109 |
| Build | 89 |
| Reuse | 1 |
| Extend | 8 |
| Defer | 11 |
| KB calls | 185 |
| Failed or rejected KB calls | 44 |
| Build-time target-source hits | 10 |
| Target-source hits not hydrated | 9 |

## Known Invalidity

The requirements identity was `trumark/deceased-account`, while the implemented workflow was `trumark/deceased-accounts`. The observed workflow resolution therefore classified the target as absent. The source JSON explicitly requires an exact, source-proved identity for later comparison.

## Provenance

- Imported from `ainative-planner/docs/experiments/deceased-account-phase2-baseline.json`.
- Canonical imported facts remain in [`deceased-account-phase2-baseline.json`](./deceased-account-phase2-baseline.json).
- Source workflows commit: `140ec306bff8c20aa9eccde3cc2f4647ce790655`.
- Captured: `2026-09-05T07:00:27.000Z`.

## Interpretation

The low reuse count is not itself proof of a planner error. The useful evidence is that 40 build units coincided with failed tool calls and nine target-source hits were not committed as hydrated evidence. Those observations motivate investigation; human-reviewed requirement labels remain necessary to establish correctness.
