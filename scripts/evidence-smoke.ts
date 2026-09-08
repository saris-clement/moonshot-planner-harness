/** Opt-in, one-turn paid smoke: npm run test:evidence-smoke -- --live.
 * Never included in ordinary check/test execution. Synthetic inputs and raw logs stay in .data.
 * This does not construct an orchestrator, run planner cases, edit global configuration, or resume sessions.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentRunner } from '../src/agents.js';
import { HarnessDatabase } from '../src/db.js';
import { evidenceScopeFromContext, readEvidenceLedger } from '../src/evidenceAccess.js';
import type { InvestigationState, InvestigatorTurnResult } from '../src/investigator.js';
import { runCommand } from '../src/process.js';
import { CampaignConfigSchema, HypothesisSchema, type RunFacts } from '../src/types.js';

const model = 'openai/gpt-5.6-sol';
const version = '1.18.29';
const maximumMs = 600_000;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const usage = 'npm run test:evidence-smoke -- --live';
// The receipt must contain this actual command, not an agent-written claim about having run it.
const shellCommand = `set -eu
rg SMOKE_SENTINEL /candidate/smoke-fixture.json /sources
jq -c '{arm:.observation.arm,unit_count:(.replicates[0].facts.units|length)}' /artifacts/data.json
python3 - <<'PY'
import json
f = json.load(open('/candidate/smoke-fixture.json'))
e = json.load(open('/artifacts/data.json'))
print(json.dumps({'smoke_sentinel': f['SMOKE_SENTINEL'], 'sum': sum(f['numbers']), 'unit_count': len(e['replicates'][0]['facts']['units']), 'snapshotRef': e['snapshotRef']}))
PY
curl -sSfI https://nodejs.org/api/fs.html
curl -sSfi https://nodejs.org/api/fs.html -o /scratch/docs.http
python3 - <<'PY'
import json, hashlib
h, body = open('/scratch/docs.http', 'rb').read().split(b'\\r\\n\\r\\n', 1)
print(json.dumps({'http_method': 'GET', 'http_status': int(h.splitlines()[0].split()[1]), 'body_bytes': len(body), 'body_sha256': hashlib.sha256(body).hexdigest(), 'node_docs': b'Node.js' in body}))
PY`;

export async function runEvidenceSmoke(args: string[]): Promise<number> {
  let options;
  try { options = parseArgs({ args, options: { live: { type: 'boolean' }, help: { type: 'boolean' } } }).values; }
  catch { process.stdout.write(`Invalid arguments. ${usage}\n`); return 2; }
  if (options.help || !options.live) {
    process.stdout.write(`${usage}\nDisabled in ordinary checks. Explicit --live authorizes one ${model} turn, at most 10 minutes; no planner cases.\n`);
    return options.help ? 0 : 2;
  }
  const started = Date.now();
  const workspace = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const id = `smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // Ignore HARNESS_DATA_DIR: this smoke may only write beneath THIS worktree's ignored .data.
  const root = path.join(workspace, '.data/evidence-smoke', id);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const report: Record<string, unknown> = { schemaVersion: 1, synthetic: true, id, root, model, expectedOpenCodeVersion: version,
    maxWallTimeMs: maximumMs, startedAt: new Date(started).toISOString(), status: 'failed', turnsDispatched: 0 };
  process.stdout.write(`Evidence smoke artifacts: ${root}\n`);
  let database: HarnessDatabase | undefined;
  let result: InvestigatorTurnResult | undefined;
  let sessionId: string | null = null;
  let manifestPath: string | undefined;
  const current = path.join(root, 'artifacts', id, `${id}-v001`);
  const parent = path.join(root, 'artifacts', id, `${id}-v000`);
  const worktree = path.join(root, 'worktrees', id, `${id}-v001`);
  const source = path.join(path.dirname(worktree), 'frozen-workflows');
  const frozen = new Map<string, string>();
  const put = async (filename: string, value: unknown) => {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    frozen.set(filename, digest(bytes));
  };
  try {
    const cli = await runCommand('opencode', ['--version'], { timeoutMs: 10_000, logPath: path.join(root, 'opencode-version.log') });
    report.openCodeVersion = cli.stdout.trim();
    assert.equal(cli.stdout.trim(), version, 'unexpected OpenCode version; no model dispatched');
    const image = await runCommand('docker', ['image', 'inspect', '--format={{.Id}}', process.env.HARNESS_RESEARCH_IMAGE ?? 'ainative-planner-research:local'],
      { timeoutMs: 10_000, logPath: path.join(root, 'research-image.log') });
    report.researchImage = image.stdout.trim();
    assert.match(image.stdout.trim(), /^sha256:[a-f0-9]{64}$/);
    const sentinel = `EVIDENCE_SMOKE_${randomUUID().replaceAll('-', '_')}`;
    await put(path.join(worktree, 'smoke-fixture.json'), { SMOKE_SENTINEL: sentinel, numbers: [19, 23] });
    await put(path.join(source, 'fixture.ts'), `export const SMOKE_SENTINEL = ${JSON.stringify(sentinel)};\n`);
    const facts = (changed: boolean): RunFacts => ({
      status: 'completed', sampleSize: 1, decisionAgreement: 1, unitCount: 3,
      decisions: { reuse: changed ? 1 : 2, build: changed ? 2 : 1, extend: 0, defer: 0, question: 0 },
      shortlist: { empty: 1, nonempty: 2, candidates: 2 }, evidence: { discovered: 2, selectedSourceRefs: 2 },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 },
      pins: { source: 'synthetic-smoke-fixture-not-a-planner-run' },
      units: Array.from({ length: 3 }, (_, index) => ({ id: `unit-${index}`, key: `unit-${index}`,
        ref: { entity: 'requirement', anchor: String(index) }, kind: 'behavior', semantics: `Synthetic requirement ${index}`,
        decision: index === 2 || (changed && index === 1) ? 'build' : 'reuse', confidence: 'high',
        rationale: 'Synthetic fixture interpretation, not measured planner output or verified correctness.',
        selectedCandidateIds: index === 2 ? [] : ['synthetic-candidate'], discoveredEvidenceCount: index === 2 ? 0 : 1,
        shortlistCandidateCount: index === 2 ? 0 : 1, uncoveredSemantics: [], sourceRefs: [{ path: 'fixture.ts' }],
      })),
    });
    const baseline = facts(false);
    const trial = facts(true);
    const labels = baseline.units.map((unit) => ({ campaignId: id, benchmark: 'primary', unitKey: unit.key,
      expectedDecision: unit.decision, status: 'suggested', rationale: 'Synthetic provisional label.' }));
    const labelSetHash = digest(JSON.stringify(labels));
    await put(path.join(parent, 'primary/replicate-1/facts.json'), baseline);
    await put(path.join(current, 'investigator-reference.json'), { labels, labelSetHash,
      baseline: { id: `${id}-v000`, facts: baseline, replicateFacts: [baseline] } });
    await put(path.join(current, 'investigation/action-001/receipt.json'), { artifactDirectory: 'investigation/action-001',
      result: { facts: trial, replicateFacts: [trial], labelSetHash } });
    const goal = `SYNTHETIC TRANSPORT SMOKE ONLY, not a planner experiment. In this single turn, use direct harness_evidence tools (no subagent) to list observations, compare the action-001 trial against its frozen baseline, inspect a returned unit, search_source for SMOKE_SENTINEL, and read_evidence using a returned source evidenceRef. Then invoke research_shell with that TRIAL observationRef and the following command verbatim. It exercises arbitrary rg, jq, a small Python script, and real public-documentation curl HEAD and GET. Do not echo guessed outputs instead.\n\n${shellCommand}\n\nNo native code edits, staging, tests, evaluations, or Docker outside the research helper. No additional model/agent delegation. After inspecting actual tool responses, return action abandon with the complete hypothesis and a truthful rationale summarizing observations and limitations. Abandon means this synthetic check intentionally makes no planner change. If MCP tools/image/HTTP are unavailable, report that honestly and abandon; never claim success from imagined results. Suggested labels and synthetic facts are not verified planner correctness.`;
    const hypothesis = HypothesisSchema.parse({ title: 'Verify evidence transport without changing planner code',
      rationale: 'A synthetic fixture can check real tool transport without running planner cases.',
      instructions: 'Complete the direct evidence and research-shell smoke in the objective, make no edits, and return abandon.',
      expectedImpact: 'Transport evidence only; no claim about planner quality.', risk: 'Missing tool receipts mean the smoke failed.', findingIds: [], assumptions: [] });
    const context = { goal, primary: { name: 'primary', role: 'primary' }, baseline: { id: `${id}-v000`, decisions: baseline.decisions },
      artifacts: { current, parent, workflowsSource: source, priorExperiments: [{ id: `${id}-v000`, directory: parent }] } };
    const contextPath = path.join(current, 'investigator-context.json');
    await put(contextPath, context);
    const config = CampaignConfigSchema.parse({ id, goal, plannerRepo: worktree, workflowsRepo: source,
      environmentFile: path.join(root, 'unused.env'), seedRevision: 'synthetic', workflowsRevision: 'synthetic',
      agent: { command: 'opencode', model, autoApprove: false },
      investigator: { enabled: true, maxTurns: 1, maxPrimaryEvaluations: 1, maxWallTimeMs: maximumMs, maxAgentTokens: 100_000 },
      benchmarks: [{ name: 'primary', role: 'primary', zipPath: path.join(root, 'unused-primary.zip') },
        { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'unused-holdout.zip') }] });
    await put(path.join(root, 'campaign.json'), config);
    database = new HarnessDatabase(path.join(root, 'harness.sqlite'));
    const campaign = database.createCampaign(config, 'synthetic-no-git-revision', digest(await readFile(path.join(source, 'fixture.ts'))), 'no-environment-loaded', 'synthetic');
    database.createVariant({ id: `${id}-v000`, campaignId: id, parentVariantId: null, round: 0, ordinal: 0, hypothesis });
    const variant = database.createVariant({ id: `${id}-v001`, campaignId: id, parentVariantId: `${id}-v000`, round: 1, ordinal: 1, hypothesis });
    const state: InvestigationState = { schemaVersion: 1, sessionId: null, status: 'running', startedAt: new Date(started).toISOString(),
      updatedAt: new Date().toISOString(), turnCount: 0, agentTokens: 0, agentCostUsd: 0, reason: null, actions: [] };
    const runner = new AgentRunner(campaign, async (command, argv, options) => {
      assert.equal(report.turnsDispatched, 0, 'only one model invocation is authorized');
      assert.equal(command, 'opencode');
      assert.ok(argv.includes('--pure'));
      assert.equal(argv[argv.indexOf('--model') + 1], model);
      assert.equal(argv.filter((arg) => arg === '--file').length, 1);
      assert.equal(options?.env?.OPENCODE_EXPERIMENTAL_CODE_MODE, 'false');
      const configuration = JSON.parse(options!.env!.OPENCODE_CONFIG_CONTENT!);
      assert.deepEqual(Object.keys(configuration.mcp), ['harness_evidence'], 'smoke must not start other MCP servers');
      const builder = configuration.agent[argv[argv.indexOf('--agent') + 1]!];
      // Process-local tightening only: preserve the actual integration and provider configuration.
      builder.permission.edit = 'deny';
      builder.permission.task = 'deny';
      const mcp = configuration.mcp.harness_evidence;
      manifestPath = mcp.command[mcp.command.indexOf('--manifest') + 1];
      report.turnsDispatched = 1;
      report.attachmentBytes = (await readFile(argv[argv.indexOf('--file') + 1]!)).length;
      await writeFile(path.join(root, 'dispatch.json'), JSON.stringify({ command, argv, model, pure: true, codeMode: false,
        timeoutMs: options!.timeoutMs, mcp, edit: 'deny', task: 'deny' }), { flag: 'wx', mode: 0o600 });
      return runCommand(command, argv, { ...options, env: { ...options!.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration) } });
    });
    try {
      result = await runner.investigate(variant, worktree, current, contextPath, state, null, (value) => {
        sessionId = value;
        process.stdout.write(`Evidence smoke session: ${value}\n`);
      });
    } catch (error) {
      await writeFile(path.join(root, 'agent-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx', mode: 0o600 });
    }
    report.sessionId = sessionId;
    report.usage = result?.usage ?? null;
    report.action = result?.action.action ?? null;
    const log = await readFile(path.join(current, 'investigator-turn-001.jsonl'), 'utf8').catch(() => '');
    report.transcriptBytes = Buffer.byteLength(log);
    const eventTools: Record<string, number> = {};
    for (const line of log.split('\n')) {
      try { const event = JSON.parse(line); if (event.type === 'tool_use' && typeof event.part?.tool === 'string') eventTools[event.part.tool] = (eventTools[event.part.tool] ?? 0) + 1; } catch { /* Stderr is preserved in the same raw log. */ }
    }
    report.eventTools = eventTools;
    const scope = evidenceScopeFromContext(campaign, variant, worktree, current, context);
    const summaries = [];
    let cursor: string | null = null;
    do {
      const page = await readEvidenceLedger(scope, { limit: 100, ...(cursor ? { cursor } : {}) });
      summaries.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    const tools: Record<string, { calls: number; errors: number; responseBytes: number }> = {};
    const successful = new Set<string>();
    const assertions = { compared: false, shell: false, httpHead: false, httpGet: false };
    for (const summary of summaries) {
      const requestBytes = await readFile(path.join(current, summary.requestRef));
      const responseBytes = await readFile(path.join(current, summary.responseRef));
      const receipt = JSON.parse(await readFile(path.join(current, path.dirname(summary.responseRef), 'receipt.json'), 'utf8'));
      assert.equal(digest(requestBytes), receipt.requestSha256);
      assert.equal(digest(responseBytes), receipt.responseSha256);
      assert.ok(manifestPath);
      assert.equal(digest(await readFile(manifestPath)), receipt.manifestSha256);
      assert.ok(responseBytes.length <= 65_536);
      const request = JSON.parse(requestBytes.toString());
      const response = JSON.parse(responseBytes.toString());
      const tool = tools[summary.tool] ??= { calls: 0, errors: 0, responseBytes: 0 };
      tool.calls++; tool.errors += response.isError ? 1 : 0; tool.responseBytes += responseBytes.length;
      if (response.isError) continue;
      successful.add(summary.tool);
      const value = JSON.parse(response.content[0].text);
      if (summary.tool === 'compare_trial') assertions.compared ||= value.totalMatched === 3 && value.summary.changedUnitCount === 1;
      if (summary.tool === 'research_shell' && request.arguments.command.trim() === shellCommand && value.exitCode === 0 && !value.aborted && !value.timedOut) {
        const stdoutPath = await realpath(path.join(current, value.artifacts.stdout));
        assert.ok(stdoutPath.startsWith(`${current}${path.sep}`));
        const stdout = await readFile(stdoutPath, 'utf8');
        const rows = stdout.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        assertions.shell ||= rows.some((row) => row.smoke_sentinel === sentinel && row.sum === 42 && row.unit_count === 3 && row.snapshotRef === request.arguments.observationRef);
        assertions.httpHead ||= /^HTTP\/1\.1 200\r?$/m.test(stdout);
        const http = rows.find((row) => row.http_method === 'GET');
        assertions.httpGet ||= http?.http_status === 200 && http.body_bytes > 1_000 && http.node_docs === true && /^[a-f0-9]{64}$/.test(http.body_sha256);
        report.research = { invocationId: value.invocationId, imageId: value.imageId, snapshotSha256: value.snapshotSha256,
          stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: digest(stdout), stderrBytes: (await readFile(path.join(current, value.artifacts.stderr))).length,
          sentinel, sum: 42, unitCount: 3, httpGet: http ?? null, httpHead200: assertions.httpHead };
      }
    }
    report.tools = tools; report.receiptCount = summaries.length; report.assertions = assertions;
    for (const [filename, expected] of frozen) assert.equal(digest(await readFile(filename)), expected, 'synthetic input changed');
    assert.deepEqual(await readdir(worktree), ['smoke-fixture.json'], 'unexpected worktree edits or attachment residue');
    report.fixtureUnchanged = true;
    for (const name of ['list_observations', 'compare_trial', 'inspect_unit', 'search_source', 'read_evidence', 'research_shell']) assert.ok(successful.has(name), `missing successful typed MCP receipt: ${name}`);
    assert.ok(Object.values(assertions).every(Boolean), 'receipt-backed command/fixture/HTTP checks were not all observed');
    assert.equal(result?.action.action, 'abandon', 'expected a structured abandon, not a planner action');
    assert.ok(sessionId && sessionId === result.sessionId);
    assert.equal(Object.keys(eventTools).some((name) => ['bash', 'edit', 'write', 'apply_patch', 'task'].includes(name)), false, 'unexpected host execution/edit/delegation attempt');
    report.status = 'passed';
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    await writeFile(path.join(root, 'smoke-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx', mode: 0o600 });
  } finally {
    report.sessionId = sessionId;
    const resources: string[] = [];
    const leftovers: string[] = [];
    try {
      if (manifestPath) {
        const scratch = path.join(path.dirname(manifestPath), 'scratch');
        for (const call of await readdir(scratch)) for (const invocation of await readdir(path.join(scratch, call))) {
          if (!/^research-[a-f0-9-]{36}$/.test(invocation)) continue;
          for (const [kind, name] of [['container', `${invocation}-worker`], ['container', `${invocation}-broker`], ['volume', `${invocation}-socket`]]) {
            resources.push(name!);
            const inspection = await runCommand('docker', [kind!, 'inspect', name!], { allowFailure: true, timeoutMs: 10_000 });
            if (inspection.exitCode === 0 || !/no such|not found/i.test(inspection.stderr)) leftovers.push(name!);
          }
        }
      }
      report.cleanup = { checkedResources: resources, leftovers, archivesPreserved: true };
      if (leftovers.length) report.status = 'failed';
    } catch { report.cleanup = { verified: false, archivesPreserved: true }; report.status = 'failed'; }
    database?.close();
    report.elapsedMs = Date.now() - started;
    await writeFile(path.join(root, 'smoke-report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  return report.status === 'passed' ? 0 : 1;
}

if (import.meta.main) runEvidenceSmoke(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
  process.stderr.write('Evidence smoke failed before report publication; inspect .data/evidence-smoke locally.\n');
  process.exitCode = 1;
});
