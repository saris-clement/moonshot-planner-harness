# trumark-deceased-accounts-pr45c

## Goal

Improve generic Phase 2 source-backed adjudication accuracy using PR 45 durable diagnostic correlation. Preserve requirement, source, model, prompt, budget, and knowledge pins; distinguish measured facts, deterministic reconstruction, model diagnosis, and human truth. Reduce false build and false extend decisions without introducing false reuse or customer-specific production heuristics. Use the target-excluded arm only as a promotion guard against over-eager reuse and target leakage, never as a fitness reward.

## Frozen Inputs

- Planner seed: `a0dac3ec7b416b27dd3b4260717cdfea7dd8232a`
- Workflows source: `27634f5226176003153c6ec2a3e1c579072ff7be`
- Environment profile: `sha256:24e705dace7c21ce1569d4cec477a5a392264b0f174c8f84929b98e475d3ff8d`
- Mode: `supervised`
- Concurrency: 3
- Replicate concurrency: 2
- Maximum generated variants: 9
- Effective replicate protocol: 2 runs at concurrency 2
- Target-excluded workflow: `trumark/deceased-accounts`
- Target-excluded baseline: trumark-deceased-accounts-pr45c-v000

## Target-Excluded Evaluations

- trumark-deceased-accounts-pr45c-v000: completed; gate=passed; build drop=0.0%

## Experiments

| # | Variant | Round | Hypothesis | Status | Verified | Provisional |
| ---: | --- | ---: | --- | --- | ---: | ---: |
| 0 | trumark-deceased-accounts-pr45c-v000 | 0 | Unmodified campaign seed | completed | unscored | 28.0% |
| 1 | trumark-deceased-accounts-pr45c-v001 | 1 | Stage behavioral and structural retrieval | failed | unscored | unscored |
| 2 | trumark-deceased-accounts-pr45c-v002 | 1 | Compose selected evidence into a coverage chain | starting | unscored | unscored |
| 3 | trumark-deceased-accounts-pr45c-v003 | 1 | Verify callable boundaries separately from implementation visibility | failed | unscored | unscored |
