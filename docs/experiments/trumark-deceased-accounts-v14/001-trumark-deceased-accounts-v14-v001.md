# Unmodified campaign seed

## Goal

Improve the generic accuracy of Phase 2 requirement-unit adjudication.

The root problem appears in normal planner runs where the existing target implementation is available as evidence and is not excluded through the `exclude-target-implementation` policy. These runs currently classify many requirement units as build even though substantial corresponding behavior already exists in the workflows source. This suggests failures in source discovery, candidate ranking, evidence hydration, evidence retention, or model interpretation.

The objective is not to minimize the build count or make it zero. Some requirements describe genuine gaps between the requested workflow and the current implementation, so a correct result must retain evidence-backed build and extend decisions. The goal is progressive improvement toward accurate classification, not perfection or a predetermined decision distribution.

The current requirements pack is newer than the packs used by earlier experiments, including v13c. Previous decision counts are therefore historical context only and must not be treated as directly comparable scores. Before generating mutations, establish a new repeated baseline using this campaign’s exact requirements-pack hashes, selected planner seed, workflows revision, environment, model, prompts, budgets, and knowledge snapshot. Evaluate every candidate against this campaign-local baseline.

For every requirement unit, determine whether build, reuse, extend, defer, or question is justified by the frozen requirements, workflows source, tool transcripts, and committed evidence. Distinguish genuine implementation gaps from planner-system errors. A planner-system error may include failed source discovery, poor candidate ranking, missing evidence hydration, evidence lost before adjudication, incorrect interpretation, invalid tool usage, or unsupported confidence.

Prioritize reducing false build and false extend decisions without introducing false reuse. Reuse must remain supported by complete, eligible, exported evidence. Partial or private implementation should generally support extend rather than reuse. Build remains correct where the requested behavior is genuinely absent.

Use the historical experiment Markdown, including the original baseline and v13c findings, as factual research context. Treat measured run output and human-reviewed requirement labels as authority. LLM judgments are suggestions only. Decision counts are diagnostic signals, not optimization targets.

Every hypothesis must address an observed causal failure mechanism and produce a bounded, attributable change. Record its assumptions, exact pins, actual results, requirement-level decision changes, confirmed system errors, genuine gaps, regressions, uncertainties, and next actions in experiment Markdown.

Never optimize specifically for TruMark, deceased accounts, singular/plural aliases, fixed requirement text, customer names, workflow names, source paths, capability IDs, or an expected build count. Do not introduce pack-specific production heuristics. Every candidate must run the primary pack and unrelated holdout packs repeatedly, preserve meaningful source-backed evidence, and avoid regressions on human-verified labels.

Accuracy, evidence quality, reproducibility, and genericity are the objectives. Time, token usage, monetary cost, and achieving a superficially attractive decision distribution are secondary.

## Hypothesis

The hypothesis below is model-generated and remains unverified until the experiment completes.

> Measure the selected seed revision before applying an experimental mutation.

Expected impact: Establish reproducible primary and holdout facts for this campaign.

Risk: Provider nondeterminism means one screening run is descriptive rather than conclusive.

## Provenance

| Field | Value |
| --- | --- |
| Campaign | trumark-deceased-accounts-v14 |
| Variant | trumark-deceased-accounts-v14-v001 |
| Parent | none |
| Round | 0 |
| Status | failed |
| Planner seed | `13bd342adbad89c1d4cd680e08d0327e54a53fe3` |
| Workflows source | `304c0857c9b5aff3076de504a52ee364bd279b0d` |
| Environment | `sha256:c74a27a40f2243e5a4f5cdc6272084a122e52c7c919aa9a743ff6a1aa879f799` |
| Primary pack | `sha256:1b264a17073c8d4218d950b3b6b7712a933f52b542fe1897f7f3feff6c8b2520` |
| Patch | `/Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/artifacts/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v001/variant.patch` |
| Image | not built |
| Artifact collection | incomplete |

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
| Persisted labels | 0 |
| Cohort pin mismatches | none |

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

> No blind-judge result is available.

## Holdout

Not run for this variant.

## Failure

`command failed (1): docker buildx build --load --tag ainative-planner-eval:trumark-deceased-accounts-v14-7c3dced3ac-1 --file /Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/worktrees/trumark-deceased-accounts-v14/frozen-planner/Dockerfile --build-arg PLANNER_BUILD_REVISION=13bd342adbad89c1d4cd680e08d0327e54a53fe3 --build-arg PLANNER_BUILD_SOURCE=https://github.com/Saris-AI/moonshot-planner-poc --build-arg PLANNER_PUBLIC_BASE= /Users/cflodrops/Documents/dev/playground/test-bootstrap/bootstrap/services/ainative-planner-eval-harness/.data/worktrees/trumark-deceased-accounts-v14/trumark-deceased-accounts-v14-v001 tend: Readline #19 11.63 debconf: unable to initialize frontend: Readline #19 11.63 debconf: (This frontend requires a controlling tty.) #19 11.63 debconf: falling back to frontend: Teletype #19 11.63 debconf: unable to initialize frontend: Teletype #19 11.63 debconf: (This frontend requires a controlling tty.) #19 11.63 debconf: falling back to frontend: Noninteractive #19 11.78 Updating certificates in /etc/ssl/certs... #19 11.98 150 added, 0 removed; done. #19 11.99 Setting up perl (5.40.1-6) ... #19 11.99 Setting up libp11-kit0:arm64 (0.25.5-3) ... #19 12.00 Setting up libgssapi-krb5-2:arm64 (1.21.3-5+deb13u1) ... #19 12.00 Setting up libreadline8t64:arm64 (8.2-6) ... #19 12.01 Setting up libpython3.13-stdlib:arm64 (3.13.5-2+deb13u4) ... #19 12.01 Setting up libpython3-stdlib:arm64 (3.13.5-1) ... #19 12.01 Setting up libgnutls30t64:arm64 (3.8.9-3+deb13u4) ... #19 12.02 Setting up python3.13 (3.13.5-2+deb13u4) ... #19 12.34 Setting up libpsl5t64:arm64 (0.21.2-1.1+b1) ... #19 12.34 Setting up python3 (3.13.5-1) ... #19 12.35 running python rtupdate hooks for python3.13... #19 12.35 running python post-rtupdate hooks for python3.13... #19 12.38 Setting up liberror-perl (0.17030-1) ... #19 12.38 Setting up librtmp1:arm64 (2.4+20151223.gitfa8646d.1-2+b5) ... #19 12.38 Setting up libngtcp2-crypto-gnutls8:arm64 (1.11.0-1+deb13u1) ... #19 12.39 Setting up libcurl3t64-gnutls:arm64 (8.14.1-2+deb13u4) ... #19 12.39 Setting up git (1:2.47.3-0+deb13u1) ... #19 12.40 Processing triggers for libc-bin (2.41-12+deb13u1) ... #19 12.42 Processing triggers for ca-certificates (20250419) ... #19 12.42 Updating certificates in /etc/ssl/certs... #19 12.59 0 added, 0 removed; done. #19 12.59 Running hooks in /etc/ca-certificates/update.d... #19 12.59 done. #19 DONE 12.7s #27 [production  3/14] WORKDIR /app #27 DONE 0.0s #28 [production  4/14] COPY package.json package-lock.json .npmrc ./ #28 DONE 0.0s #29 [production  5/14] COPY server/package.json ./server/ #29 DONE 0.0s #30 [production  6/14] COPY web/package.json ./web/ #30 DONE 0.0s #31 [production  7/14] RUN --mount=type=secret,id=github_token     --mount=type=secret,id=packages_token,required=false     set -eu;     if [ -s /run/secrets/packages_token ]; then TOKEN="$(cat /run/secrets/packages_token)";     else TOKEN="$(cat /run/secrets/github_token)"; fi;     printf '//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > /root/.npmrc     && npm ci --omit=dev --ignore-scripts     && npm cache clean --force     && rm -f /root/.npmrc #31 0.097 cat: /run/secrets/github_token: No such file or directory #31 ERROR: process "/bin/sh -c set -eu;     if [ -s /run/secrets/packages_token ]; then TOKEN=\"$(cat /run/secrets/packages_token)\";     else TOKEN=\"$(cat /run/secrets/github_token)\"; fi;     printf '//npm.pkg.github.com/:_authToken=%s\\n' \"$TOKEN\" > /root/.npmrc     && npm ci --omit=dev --ignore-scripts     && npm cache clean --force     && rm -f /root/.npmrc" did not complete successfully: exit code: 1 ------  > [production  7/14] RUN --mount=type=secret,id=github_token     --mount=type=secret,id=packages_token,required=false     set -eu;     if [ -s /run/secrets/packages_token ]; then TOKEN="$(cat /run/secrets/packages_token)";     else TOKEN="$(cat /run/secrets/github_token)"; fi;     printf '//npm.pkg.github.com/:_authToken=%s\n' "$TOKEN" > /root/.npmrc     && npm ci --omit=dev --ignore-scripts     && npm cache clean --force     && rm -f /root/.npmrc: 0.097 cat: /run/secrets/github_token: No such file or directory ------ ERROR: failed to build: failed to solve: process "/bin/sh -c set -eu;     if [ -s /run/secrets/packages_token ]; then TOKEN=\"$(cat /run/secrets/packages_token)\";     else TOKEN=\"$(cat /run/secrets/github_token)\"; fi;     printf '//npm.pkg.github.com/:_authToken=%s\\n' \"$TOKEN\" > /root/.npmrc     && npm ci --omit=dev --ignore-scripts     && npm cache clean --force     && rm -f /root/.npmrc" did not complete successfully: exit code: 1`

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
