# Research And Live Checks

## Research Sandbox

Before using `research_shell` or `research_http`, the operator must explicitly build the trusted image from the harness root, then run the real Docker smoke check:

```bash
docker build -f Dockerfile.research -t ainative-planner-research:local .
RESEARCH_DOCKER_SMOKE=1 node --import tsx --test test/researchSandbox*.test.ts
```

Without the opt-in environment variable, ordinary tests skip the real-container check. The smoke exercises arbitrary scripts/pipelines, brokered public GET/HEAD, read-only inputs, absent host credentials/Docker socket, output limits, cancellation, and cleanup. It starts disposable research containers and reads public test pages, not a planner campaign or dashboard. An operator-selected prebuilt image may use `HARNESS_RESEARCH_IMAGE`; invocations pin its immutable ID and never automatically build or pull it.

`scripts/research-curl.mjs` is the sandbox's broker client, not a host API proxy. It supports public-documentation GET/HEAD only. Local coordinator APIs are unavailable; use the typed evidence tools or sanitized `/artifacts/data.json` for local run data. Candidate/source/evidence mounts are read-only, and arbitrary research scripts can write to fresh `/scratch` tmpfs. See [the sandbox contract](../src/researchSandbox.md) for boundaries and limits.

These checks do not establish semantic correctness or full-campaign improvement. No full new campaign has been run for the compact briefing/evidence changes; four-hour investigation and two-parallel-replica settings below are unchanged.

## Opt-In Live E2E

`npm run test:live -- --live --source-config <absolute-campaign.json> --id <new-id> --port 4174`

Do not launch until the coordinating operator explicitly authorizes the start.
`--help` and invocation without `--live` never initialize or contact external services.
Ordinary `npm test` / `npm run check` only run the mocked runner tests, not live evaluation.

The runner reads the source JSON internally, requires its V2 target declaration,
two replicates, and `agent.autoApprove: false`, and preserves the source pins,
environment, packs, research, model, and other limits. It enables automatic
investigation with 12 turns, 3 primary evaluations of 2 parallel replicas,
14,400,000 ms (4 hours), and 2,000,000 reported agent tokens. It limits candidates
and candidate concurrency to 1 and sets standard replicate concurrency to 2.
V2 baseline/final validation retains six concurrent cases per candidate:
two primary, two holdout, and two target-excluded cases.

The time/token limits apply to investigation, not the entire E2E or all model
calls. Baseline, final evaluation, judging, and V2 calibration add time and cost;
in-flight coordinator actions may exceed the investigation deadline. Missing
usage telemetry prevents a reliable token cap. Planner timeout/cost ceilings
remain those in the source config. No dollar-cost estimate is guaranteed.

One process awaits `initialize`, fresh `runBaseline`, then `runAutomatic` using
one `CampaignOrchestrator`. Failed/incomplete baselines never start automatic
execution. No old scores, labels, or resolved-pack cache are imported; existing
pack resolution and strict validation run normally.

The optional `--port 4174` serves the dashboard using that same coordinator and
database. It stays open after the evaluation sequence finishes, including blocked
or failed outcomes after dashboard startup; the process does not exit until the
dashboard is closed. Omit `--port` for a runner that closes its database at the end.
Choose an unused port for a new run. Never launch a second `serve` process against
this database or rerun an existing ID to inspect it; use the already-open dashboard.

All output is under ignored `.data/live/<id>/`, including `live-config.json`,
the isolated database, frozen campaign inputs, worktrees, artifacts, reports,
`live-phases.jsonl`, and `live-report.json`. Console output contains only phase
status. Raw exceptions stay in `live-error.txt`, never on the console. The source
config and user OpenCode config are not modified. `HARNESS_DATA_DIR` is ignored.

The run directory is claimed exclusively and never deleted or reused, even after
failure. Do not run another CLI/dashboard coordinator against its database during
execution. Interrupted worktrees and patches are retained; recovery is a separate
operator action, not an automatic rerun of this script.

Exit 0 means the single investigation finalized with archived artifacts and the
coordinator reached its expected stopping condition, not verified improvement.
Exit 1 means failure; exit 2 means missing opt-in/invalid arguments or an incomplete
investigation (including budget exhaustion/abandonment). Inspect the report.
Model judgments remain unverified and are not human-reviewed labels.

The harness invokes OpenCode with `--pure` and does not add `--auto` when
`autoApprove` is false. Installed CLI help describes `--pure` as disabling external
plugins, not permissions. Existing permission configuration can still block agent
tool requests; this runner does not bypass it or modify user configuration.
