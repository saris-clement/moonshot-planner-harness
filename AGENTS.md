# ainative-planner-eval-harness

One-off, local evaluation harness for agent-driven Phase 2 planner experiments.

## Rules

1. Measured planner output and human-reviewed labels are distinct sources.
2. Never present an LLM judgment as verified truth.
3. Every run records immutable pack, planner, workflows, model, prompt, budget, and KB pins.
4. Customer-specific terms may appear in campaign data and tests, never as production heuristics.
5. The harness never pushes planner branches and never removes a worktree containing an unarchived patch.
6. Raw packs, source excerpts, model output, and logs stay under ignored `.data/`.

## Commands

- `npm run cli -- init --config campaign.json`
- `npm run cli -- baseline <campaign-id>`
- `npm run cli -- round <campaign-id>`
- `npm run cli -- serve --port 4173`
- `npm run check`
