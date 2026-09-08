# Research Sandbox Contract

Trusted coordinator API (not agent-supplied scope):

```ts
import { runResearchShell, readResearchUrl, readResearchOutput } from './researchSandbox.js';

const scope = {
  worktreePath: '/absolute/candidate-worktree',
  sourceRoots: [{ name: 'workflows', path: '/absolute/frozen-arm-workflows' }],
  scratchDirectory: '/absolute/harness/.data/arm/research',
  artifactDirectory: '/absolute/published-sanitized-evidence',
  allowedHttpHosts: ['nodejs.org', 'developer.mozilla.org'], // optional, default deny
};
const result = await runResearchShell(scope, { command: 'rg "planner" /candidate; jq . /artifacts/facts.json', timeoutMs: 30_000 });
const docs = await readResearchUrl(scope, { url: 'https://nodejs.org/api/fs.html' });
const next = result.pagination[0];
if (next) await readResearchOutput(scope, { ...next, offset: next.nextOffset });
```

All scope directories must already exist. Scratch must be under ignored `.data`, disjoint from all inputs. Give each arm its own scratch directory. `sourceRoots` must explicitly identify the arm's frozen workflows/source snapshots, not live upstream directories. The coordinator must pause native edits while a snapshot is published. `artifactDirectory` must contain only a coordinator-curated, sanitized bundle, never raw campaign roots, logs, `.env`, or credential downloads. Filename filtering and text redaction are defense in depth, not a claim to detect arbitrary secrets.

## Build And Test

The operator, not the model, builds the trusted image once:

```sh
docker build -f Dockerfile.research -t ainative-planner-research:local .
RESEARCH_DOCKER_SMOKE=1 node --import tsx --test test/researchSandbox*.test.ts
```

The Dockerfile-specific ignore file restricts the build context to trusted broker/wrapper code. No source, evidence, credentials or `.git` enters the image. The coordinator may choose a prebuilt image via `HARNESS_RESEARCH_IMAGE`; every invocation resolves it to an immutable SHA and records that SHA. No automatic image pulls, package installation, host configuration changes, or paid model/planner calls occur in the API.

## Files And Shell

- `/candidate`: filtered, read-only snapshot of the candidate; native model edits remain in the existing edit path.
- `/sources/<name>`: explicit filtered, read-only frozen source roots.
- `/artifacts`: filtered, read-only published evidence bundle.
- `/scratch`: 128 MiB writable tmpfs, fresh for each invocation. Write and execute Python, Node, shell scripts here. Scripts do not persist to another call.
- `/tmp`: 32 MiB writable, non-executable tmpfs.
- `.git`, symlinks, hardlinks, binaries, oversized files, credentials and raw logs are omitted. Git file/directory comparison works (`git diff --no-index`); host repository history/config/hooks are deliberately unavailable. Publish selected sanitized history as evidence if needed.

Arbitrary shell pipelines and installed utilities are allowed. There is no shell command whitelist. The worker is non-root with read-only root filesystem, no capabilities, no-new-privileges, bounded CPU/memory/PIDs/file sizes, no host filesystem or Docker socket, and `--network none` (including no external DNS). Only sanitized input snapshots are bind-mounted. Writable files never bind back onto the host.

## HTTP Boundary

The worker connects through a read-only mounted Unix socket to a separate trusted broker container. The socket works with Docker Desktop on Darwin. The broker has network egress but no candidate, evidence, host credentials or Docker socket. No TCP ports are published; no shared network or host coordinator address is exposed to the worker.

`curl` is an actual broker client supporting common `-sSfL`, `-I`, `-i`, `-o FILE`, `--url`, and `-X GET|HEAD` forms. Unsupported HTTP features fail explicitly; arbitrary shell commands are not restricted. The broker independently rejects non-GET/HEAD, bodies, credential/custom headers, non-HTTPS, non-443 ports, IP literals, credentials in URLs, unapproved hosts, private/special-use DNS answers, and unsafe redirects. TLS uses the checked DNS address directly; redirects repeat all checks. It never forwards caller headers, cookies, provider keys or upstream credentials. Limits: 2 MiB per response, 15 seconds per redirect chain, 5 redirects, 32 requests and 8 MiB returned per invocation, 4 concurrent reads.

Local coordinator APIs are deliberately **not** proxied in this version. Publish exact read-only results into the sanitized evidence bundle instead. This avoids exposing mutation routes or `.env` downloads. Operator-approved public hosts can receive URL paths/queries; approve documentation/read-only destinations only. GET-only cannot make a badly designed upstream mutation endpoint read-only, nor prevent disclosure of research contents deliberately included in an allowed-host URL.

## Outputs And Lifecycle

Results include exit code, timeout/abort/output-limit flags, immutable image and snapshot pins, 16 KiB inline stdout/stderr, full bounded output artifact paths, and pagination references. `readResearchOutput` returns bounded byte-offset pages. Outputs are redacted before publication, including across original stdout chunk boundaries. Four MiB per stream is a hard limit: exceeding it kills the invocation and sets `outputLimitExceeded`; no unbounded "full log" is retained. A manifest records scope, command, limits and execution status under ignored scratch. These are measured shell results, not verified judgments.

`timeoutMs` is the worker execution limit (100..300000 ms, default 30000), separate from bounded Docker setup/cleanup. `signal?: AbortSignal` is supported on both run/read calls. Normal completion, timeout, abort and handled SIGINT/SIGTERM remove both containers and their unique socket volume; no networks are created. Cleanup errors are surfaced with exact resource names. No worktrees are removed, and published evidence/output stays archived. A hard coordinator kill (SIGKILL), Docker daemon failure or machine crash can prevent cleanup; resources carry `ainative.research=true` plus invocation-specific names for operator recovery. The broker also has a 360-second lifetime cap.
