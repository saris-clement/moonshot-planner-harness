import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { S3Client } from '@aws-sdk/client-s3';
import { AgentRunner } from '../src/agents.js';
import { sha256File, writeResolvedCampaignConfig } from '../src/config.js';
import { HarnessDatabase } from '../src/db.js';
import { hypothesisComplianceResultPath } from '../src/hypothesisCompliance.js';
import { canonicalHash } from '../src/metrics.js';
import { runInvestigatorLoop } from '../src/investigatorLoop.js';
import type { InvestigationActionRecord, InvestigationState, InvestigatorAction } from '../src/investigator.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import { ensureHarnessPaths, harnessPaths, variantArtifactDirectory } from '../src/paths.js';
import { runCommand } from '../src/process.js';
import { startDashboard } from '../src/server.js';
import { captureAndGateDiff, prepareVariantWorktree, stageMutationBaseline, type StackHandle } from '../src/stack.js';
import { CampaignConfigSchema, HypothesisSchema, HypothesisComplianceOutputV2Schema, type Benchmark,
  type CampaignRecord, type RunFacts, type TargetExcludedConfig, type TargetExcludedEvaluationRecord,
  type VariantRecord } from '../src/types.js';

const hypothesis = HypothesisSchema.parse({ title: 'Initial diagnosis', rationale: 'Observed evidence loss',
  instructions: 'Investigate and preserve qualified evidence', expectedImpact: 'Uncertain effect', risk: 'Diagnosis may be false' });

interface Internals {
  ensureFrozenPlannerSource: (campaign: CampaignRecord) => Promise<string>;
  ensureFrozenWorkflowsSource: (campaign: CampaignRecord) => Promise<string>;
  runVariant: (campaign: CampaignRecord, variant: VariantRecord, mutate: boolean) => Promise<VariantRecord>;
  runInvestigatorCandidate: (campaign: CampaignRecord, variant: VariantRecord, worktree: string, artifacts: string, baseline: string) => Promise<VariantRecord>;
  runInvestigatorRound: (campaign: CampaignRecord) => Promise<VariantRecord[]>;
  runBenchmarkReplicates: (campaign: CampaignRecord, variant: VariantRecord, stack: StackHandle, benchmark: Benchmark, token?: string, options?: { replicateCount?: number }) => Promise<{ facts: RunFacts; replicates: RunFacts[]; questions: [] }>;
  resolveV2PrimaryBenchmark: (campaign: CampaignRecord, benchmark: Benchmark) => Promise<{ benchmark: Benchmark }>;
  verifyVariantHypothesisCompliance: (campaign: CampaignRecord, variant: VariantRecord) => Promise<void>;
  targetExcludedEvaluationReady: (campaign: CampaignRecord, config: TargetExcludedConfig, evaluation: TargetExcludedEvaluationRecord | null, baseline: boolean) => boolean;
  promoteUnlocked: (campaignId: string, variantId: string) => Promise<VariantRecord>;
}

async function fixture(mode: 'supervised' | 'automatic' = 'supervised') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'investigator-orchestration-'));
  const paths = harnessPaths(root);
  await ensureHarnessPaths(paths);
  const repo = path.join(root, 'planner');
  await mkdir(path.join(repo, 'server/src'), { recursive: true });
  await writeFile(path.join(repo, 'server/src/evidence.ts'), 'export const evidence = false;\n');
  await runCommand('git', ['init', '--quiet'], { cwd: repo });
  await runCommand('git', ['add', '.'], { cwd: repo });
  await runCommand('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture seed'], { cwd: repo });
  const seed = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const database = new HarnessDatabase(paths.database);
  const config = CampaignConfigSchema.parse({
    id: 'investigation', goal: 'Investigate observed evidence loss without claiming verified improvement.', mode,
    plannerRepo: repo, workflowsRepo: repo, seedRevision: seed, workflowsRevision: seed,
    environmentFile: path.join(paths.root, 'environment.env'), investigator: { enabled: true },
    limits: { concurrency: 1, maxVariants: 1 }, evaluation: { replicates: 1 },
    benchmarks: [{ name: 'primary', role: 'primary', zipPath: path.join(paths.root, 'primary.zip') },
      { name: 'holdout', role: 'holdout', zipPath: path.join(paths.root, 'holdout.zip') }],
  });
  // Deliberately mismatched frozen environment prevents any Docker/provider execution in preflight tests.
  await writeFile(config.environmentFile, 'FIXTURE_ONLY=1\n');
  database.createCampaign(config, seed, seed, `sha256:${'0'.repeat(64)}`, 'fixture');
  const facts: RunFacts = { status: 'completed', sampleSize: 1, decisionAgreement: 1, unitCount: 0,
    decisions: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
    shortlist: { empty: 0, nonempty: 0, candidates: 0 }, evidence: { discovered: 0, selectedSourceRefs: 0 },
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 }, pins: {}, units: [] };
  const parent = database.createVariant({ id: 'investigation-v000', campaignId: config.id, parentVariantId: null,
    round: 0, ordinal: 0, hypothesis });
  database.updateVariant(parent.id, { status: 'completed', facts, replicateFacts: [facts] });
  const campaign = database.updateCampaign(config.id, { currentParentVariantId: parent.id });
  const variant = database.createVariant({ id: 'investigation-v001', campaignId: config.id, parentVariantId: parent.id,
    round: 1, ordinal: 1, hypothesis });
  const worktree = await prepareVariantWorktree(paths, campaign, variant, null, null);
  const baseline = await stageMutationBaseline(worktree);
  await writeFile(path.join(worktree, 'server/src/evidence.ts'), 'export const evidence = true;\n');
  const artifacts = variantArtifactDirectory(paths, campaign.id, variant.id);
  await mkdir(artifacts, { recursive: true });
  const contextPath = path.join(artifacts, 'investigator-context.json');
  await writeFile(contextPath, JSON.stringify({ labels: [], labelSetHash: 'frozen', baseline: { facts, replicateFacts: [facts] } }));
  const referencePath = path.join(artifacts, 'investigator-reference.json');
  await writeFile(referencePath, await readFile(contextPath));
  const timestamp = new Date().toISOString();
  const state: InvestigationState = { schemaVersion: 1, sessionId: 'ses-durable', status: 'running',
    startedAt: timestamp, updatedAt: timestamp, turnCount: 0, agentTokens: 0, agentCostUsd: 0, reason: null,
    actions: [], harnessPins: { mutationBaselineTree: baseline, contextHash: await sha256File(contextPath), referenceHash: await sha256File(referencePath) } };
  database.updateVariant(variant.id, { status: 'mutating', worktreePath: worktree, investigation: state });
  const orchestrator = new CampaignOrchestrator(paths, database);
  orchestrator.refreshReports = async () => {};
  const internal = orchestrator as unknown as Internals;
  internal.ensureFrozenPlannerSource = async () => repo;
  internal.ensureFrozenWorkflowsSource = async () => repo;
  const capture = await captureAndGateDiff(campaign, variant, worktree, artifacts);
  const patchHash = await sha256File(capture.patchPath);
  return { root, database, campaign, variant, state, worktree, artifacts, baseline, patchHash, orchestrator, internal,
    close: async () => { database.close(); await rm(root, { recursive: true, force: true }); } };
}

function record(state: InvestigationState, kind: string, status: InvestigationActionRecord['status'], patchHash: string | null): InvestigationActionRecord {
  return { id: `action-${String(state.actions.length + 1).padStart(3, '0')}`, kind, hypothesis,
    rationale: 'Previous request', status, startedAt: state.startedAt,
    completedAt: status === 'completed' ? state.updatedAt : null, patchHash, artifactDirectory: null,
    result: status === 'completed' ? { passed: true } : null, error: null };
}

async function fakeDocker(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const bin = path.join(f.root, 'bin');
  const callsPath = path.join(f.root, 'docker-calls.jsonl');
  await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), `#!${process.execPath} --
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') console.log('sha256:' + 'a'.repeat(64));
`);
  await chmod(path.join(bin, 'docker'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  await writeFile(f.campaign.config.environmentFile, 'GITHUB_TOKEN=fixture-only\nPLANNER_KB_MODE=disabled\n');
  f.campaign.environmentSha = await sha256File(f.campaign.config.environmentFile);
  // No Docker daemon, registry, S3 endpoint, or provider is contacted by these tests.
  t.mock.method(S3Client.prototype, 'send', async () => ({ Contents: [] }));
  return async (): Promise<string[][]> => (await readFile(callsPath, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as string[]);
}

test('post-turn budget stops archive the latest unexecuted mutation and hypothesis', async (t) => {
  const f = await fixture();
  try {
    f.campaign.config.investigator!.maxAgentTokens = 5;
    const revised = { ...hypothesis, title: 'Revised but not tested' };
    t.mock.method(AgentRunner.prototype, 'investigate', async () => {
      await writeFile(path.join(f.worktree, 'server/src/evidence.ts'), "export const evidence = 'revised';\n");
      return { sessionId: f.state.sessionId!, usage: { tokens: 6, costUsd: 0 },
        action: { action: 'test' as const, rationale: 'Test revised code', hypothesis: revised } };
    });
    const result = await f.internal.runInvestigatorCandidate(f.campaign, f.database.getVariant(f.variant.id), f.worktree, f.artifacts, f.baseline);
    assert.equal(result.investigation?.status, 'budget_exhausted');
    assert.equal(result.investigation?.actions.length, 0);
    assert.equal(result.hypothesis.title, revised.title);
    assert.notEqual(result.patchHash, f.patchHash);
    assert.match(await readFile(result.patchPath!, 'utf8'), /'revised'/);
    const receipt = JSON.parse(await readFile(path.join(path.dirname(result.patchPath!), 'receipt.json'), 'utf8'));
    assert.equal(receipt.kind, 'investigator_terminal_snapshot');
    assert.equal(receipt.patchHash, result.patchHash);
    assert.equal(result.facts, null);
    assert.equal(result.artifactCollectionComplete, false);
  } finally { await f.close(); }
});

async function exhaustedFixture() {
  const f = await fixture('automatic');
  f.state.status = 'budget_exhausted';
  f.state.turnCount = 2; // Turn 2 overshot the cap before its returned action could be recorded.
  f.state.agentTokens = 4_092_956;
  f.state.agentCostUsd = 12.34;
  f.state.reason = 'Investigation token budget exhausted.';
  f.state.actions.push(record(f.state, 'test', 'completed', f.patchHash));
  f.database.updateVariant(f.variant.id, { investigation: f.state, status: 'rejected', error: f.state.reason,
    patchPath: path.join(f.artifacts, 'variant.patch'), patchHash: f.patchHash });
  f.database.updateCampaign(f.campaign.id, { status: 'stopped_max_variants' });
  return f;
}

const tokenExtension = { requestId: 'operator-4m', additionalTokens: 4_000_000, reason: 'Operator authorized four million additional tokens.' };

async function budgetDashboard(t: TestContext) {
  const f = await exhaustedFixture();
  const server = startDashboard({ port: 0, publicDirectory: path.resolve('public'), database: f.database, orchestrator: f.orchestrator });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await f.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin}/api/campaigns/${f.campaign.id}/variants/${f.variant.id}/extend-tokens`;
  const post = (body: unknown = tokenExtension, headers: Record<string, string> = {}, url = endpoint) =>
    fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { ...f, origin, endpoint, post };
}

test('token grant HTTP rejects cross-origin requests and invalid JSON arguments before invoking mutation', async (t) => {
  const f = await budgetDashboard(t);
  const extend = t.mock.method(f.orchestrator, 'extendInvestigatorTokens');
  const variant = f.database.getVariant(f.variant.id);
  const campaign = f.database.getCampaign(f.campaign.id);
  const events = f.database.listEvents(f.campaign.id);
  for (const [headers, expected] of [
    [{ origin: 'https://foreign.invalid' }, /cross-origin mutation rejected/],
    [{ origin: f.origin, 'sec-fetch-site': 'cross-site' }, /cross-site mutation rejected/],
    [{ origin: f.origin, 'content-type': 'text/plain' }, /application\/json/],
  ] as const) {
    // Invalid JSON proves the origin/content-type guard runs before body parsing, not just before persistence.
    const response = await fetch(f.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{invalid' });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, expected);
  }
  const malformed = await fetch(f.endpoint, { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: '{invalid' });
  assert.equal(malformed.status, 400);
  await malformed.json();
  for (const body of [
    null, {}, { ...tokenExtension, additionalTokens: 0 }, { ...tokenExtension, additionalTokens: -1 },
    { ...tokenExtension, additionalTokens: 1.5 }, { ...tokenExtension, additionalTokens: '4000000' },
    { ...tokenExtension, additionalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { ...tokenExtension, requestId: '../escape' }, { ...tokenExtension, requestId: '' },
    { ...tokenExtension, reason: '  ' }, { ...tokenExtension, reason: 'x'.repeat(8_001) },
    { ...tokenExtension, variantId: 'body-cannot-override-path' },
  ]) {
    const response = await f.post(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json() as { error: string }).error, 'string');
  }
  assert.equal(extend.mock.callCount(), 0);
  assert.deepEqual(f.database.getVariant(f.variant.id), variant);
  assert.deepEqual(f.database.getCampaign(f.campaign.id), campaign);
  assert.deepEqual(f.database.listEvents(f.campaign.id), events);
});

test('token grant HTTP binds the URL campaign and current parent before changing the requested variant', async (t) => {
  const f = await budgetDashboard(t);
  f.database.createCampaign({ ...f.campaign.config, id: 'other' }, f.campaign.seedSha, f.campaign.workflowsSha, f.campaign.environmentSha, 'fixture');
  for (const [url, expected] of [
    [f.endpoint.replace(`/campaigns/${f.campaign.id}/`, '/campaigns/other/'), /another campaign/],
    [f.endpoint.replace(`/variants/${f.variant.id}/`, '/variants/missing-variant/'), /variant not found/],
    [f.endpoint.replace(`/variants/${f.variant.id}/`, `/variants/${f.variant.parentVariantId}/`), /no existing investigator session/],
  ] as const) {
    const before = f.database.getVariant(f.variant.id);
    const events = f.database.listEvents(f.campaign.id);
    const response = await f.post(tokenExtension, {}, url);
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, expected);
    assert.deepEqual(f.database.getVariant(f.variant.id), before);
    assert.deepEqual(f.database.listEvents(f.campaign.id), events);
  }
  f.database.updateCampaign(f.campaign.id, { currentParentVariantId: f.variant.id });
  const before = f.database.getVariant(f.variant.id);
  const campaign = f.database.getCampaign(f.campaign.id);
  const stale = await f.post();
  assert.equal(stale.status, 400);
  assert.match((await stale.json() as { error: string }).error, /no longer the current campaign parent/);
  assert.deepEqual(f.database.getVariant(f.variant.id), before);
  assert.deepEqual(f.database.getCampaign(f.campaign.id), campaign);
});

test('token grant HTTP is idempotent, returns only the requested grant and current status, and never autoexecutes', async (t) => {
  const f = await budgetDashboard(t);
  const frozen = f.database.getCampaign(f.campaign.id).config;
  const prior = f.database.getVariant(f.variant.id).investigation!;
  const auto = t.mock.method(f.orchestrator, 'runAutomatic', async () => { throw new Error('must not autoexecute'); });
  const round = t.mock.method(f.orchestrator, 'runRound', async () => { throw new Error('must not start a round'); });
  const run = t.mock.method(f.internal, 'runVariant', async () => { throw new Error('must not execute a variant'); });
  const agent = t.mock.method(AgentRunner.prototype, 'investigate', async () => { throw new Error('must not invoke the agent'); });
  const initial = await f.post();
  assert.equal(initial.status, 200);
  const grant = f.database.getVariant(f.variant.id).investigation!.tokenGrants![0]!;
  const expected = { variantId: f.variant.id, status: 'mutating', grant };
  assert.deepEqual(await initial.json(), expected);
  assert.equal(grant.effectiveLimit, 8_092_956);
  const granted = f.database.getVariant(f.variant.id);
  const events = f.database.listEvents(f.campaign.id);
  const duplicate = await f.post();
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), expected);
  assert.deepEqual(f.database.getVariant(f.variant.id), granted);
  assert.deepEqual(f.database.listEvents(f.campaign.id), events);
  for (const changes of [{ reason: 'Changed authorization' }, { additionalTokens: 1 }]) {
    const changed = await f.post({ ...tokenExtension, ...changes });
    assert.equal(changed.status, 400);
    assert.match((await changed.json() as { error: string }).error, /different arguments/);
  }
  assert.deepEqual(f.database.getVariant(f.variant.id), granted);
  assert.deepEqual(f.database.listEvents(f.campaign.id), events);
  for (const key of ['sessionId', 'agentTokens', 'agentCostUsd', 'turnCount', 'startedAt', 'actions', 'harnessPins'] as const) {
    assert.deepEqual(granted.investigation![key], prior[key], key);
  }
  assert.equal(granted.investigation!.status, 'stopped');
  assert.equal(f.database.getCampaign(f.campaign.id).status, 'ready');
  assert.deepEqual(f.database.getCampaign(f.campaign.id).config, frozen);
  assert.equal(f.database.listVariants(f.campaign.id).length, 2);
  f.database.updateVariant(f.variant.id, { status: 'stopped' });
  const current = await f.post();
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { ...expected, status: 'stopped' });
  for (const mock of [auto, round, run, agent]) assert.equal(mock.mock.callCount(), 0);
});

function budgetCli(f: Awaited<ReturnType<typeof exhaustedFixture>>, args: string[]) {
  return runCommand(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'extend-tokens', ...args], {
    cwd: f.root, env: { ...process.env, HARNESS_DATA_DIR: f.orchestrator.paths.root }, allowFailure: true, timeoutMs: 10_000,
  });
}

test('token grant CLI validates arguments and preserves the frozen config and session while returning only the grant summary', async () => {
  const f = await exhaustedFixture();
  try {
    const ids = [f.campaign.id, f.variant.id];
    const flags = ['--tokens', '4000000', '--reason', tokenExtension.reason, '--request-id', tokenExtension.requestId];
    const campaign = f.database.getCampaign(f.campaign.id);
    const prior = f.database.getVariant(f.variant.id);
    const beforeEvents = f.database.listEvents(f.campaign.id);
    const configBytes = f.database.database.prepare('SELECT config_json FROM campaigns WHERE id = ?').get(f.campaign.id)?.config_json;
    const configPath = path.join(f.orchestrator.paths.campaigns, campaign.id, 'campaign.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeResolvedCampaignConfig(configPath, campaign.config, campaign.seedSha, campaign.workflowsSha);
    const frozenConfig = await readFile(configPath);
    for (const args of [
      [], [f.campaign.id], [...ids, '--tokens', '4000000', '--request-id', tokenExtension.requestId],
      [...ids, '--tokens', '4000000', '--reason', tokenExtension.reason],
      [...ids, '--reason', tokenExtension.reason, '--request-id', tokenExtension.requestId],
      ...['0', '-1', '1.5', 'Infinity', 'NaN', '9007199254740992'].map((value) => [...ids, '--tokens', value, ...flags.slice(2)]),
      [...ids, ...flags.slice(0, 4), '--request-id', '../escape'],
    ]) {
      const result = await budgetCli(f, args);
      assert.notEqual(result.exitCode, 0, JSON.stringify(args));
      assert.equal(result.stdout, '');
      assert.deepEqual(f.database.getVariant(f.variant.id), prior);
      assert.deepEqual(f.database.getCampaign(f.campaign.id), campaign);
      assert.deepEqual(f.database.listEvents(f.campaign.id), beforeEvents);
    }
    const result = await budgetCli(f, [...ids, ...flags]);
    assert.equal(result.exitCode, 0, result.stderr);
    const variant = f.database.getVariant(f.variant.id);
    const grant = variant.investigation!.tokenGrants![0]!;
    assert.deepEqual(JSON.parse(result.stdout), { variantId: variant.id, status: 'mutating', grant });
    assert.equal(grant.effectiveLimit, 8_092_956);
    assert.deepEqual(variant.investigation, { ...prior.investigation, tokenGrants: [grant], status: 'stopped',
      updatedAt: grant.grantedAt, reason: `Operator token extension: ${tokenExtension.reason}` });
    assert.equal(variant.error, null);
    assert.equal(f.database.getCampaign(f.campaign.id).status, 'ready');
    assert.equal(f.database.database.prepare('SELECT config_json FROM campaigns WHERE id = ?').get(f.campaign.id)?.config_json, configBytes);
    assert.equal(f.database.listVariants(f.campaign.id).length, 2);
    const events = f.database.listEvents(f.campaign.id);
    assert.deepEqual(events.slice(beforeEvents.length).map(({ type }) => type),
      ['variant.updated', 'campaign.updated', 'investigator.tokens_extended']);
    const repeated = await budgetCli(f, [...ids, ...flags]);
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    assert.equal(repeated.stdout, result.stdout);
    assert.deepEqual(f.database.getVariant(f.variant.id), variant);
    assert.deepEqual(f.database.listEvents(f.campaign.id), events);
    assert.deepEqual(await readFile(configPath), frozenConfig);
  } finally { await f.close(); }
});

test('token grant CLI rejects a reason flag without its own value before granting tokens', async () => {
  const f = await exhaustedFixture();
  try {
    const before = f.database.getVariant(f.variant.id);
    const campaign = f.database.getCampaign(f.campaign.id);
    const result = await budgetCli(f, [f.campaign.id, f.variant.id, '--tokens', '4000000', '--reason', '--request-id', 'missing-reason']);
    assert.notEqual(result.exitCode, 0, 'A following option name must not be accepted as the authorization reason');
    assert.equal(result.stdout, '');
    assert.deepEqual(f.database.getVariant(f.variant.id), before);
    assert.deepEqual(f.database.getCampaign(f.campaign.id), campaign);
  } finally { await f.close(); }
});

test('operator token grant preserves session history and resumes the existing variant past maxVariants', async (t) => {
  const f = await exhaustedFixture();
  try {
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    f.database.updateVariant(f.variant.id, { startedAt, completedAt: new Date().toISOString(), elapsedMs: 90_000 });
    const frozen = f.database.getCampaign(f.campaign.id).config;
    const prior = f.database.getVariant(f.variant.id).investigation!;
    const patch = (await runCommand('git', ['diff', 'HEAD'], { cwd: f.worktree })).stdout;
    const index = (await runCommand('git', ['ls-files', '--stage', '-v'], { cwd: f.worktree })).stdout;
    const granted = await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension);
    assert.deepEqual(granted.grant, { id: tokenExtension.requestId, grantedAt: granted.grant.grantedAt,
      additionalTokens: 4_000_000, tokensAtGrant: 4_092_956, previousLimit: 2_000_000,
      effectiveLimit: 8_092_956, reason: tokenExtension.reason });
    const next = granted.variant.investigation!;
    for (const key of ['sessionId', 'agentTokens', 'agentCostUsd', 'turnCount', 'startedAt', 'actions', 'harnessPins'] as const) {
      assert.deepEqual(next[key], prior[key], key);
    }
    assert.equal(next.status, 'stopped');
    assert.equal(granted.variant.status, 'mutating');
    assert.equal(granted.variant.error, null);
    assert.equal(f.database.getCampaign(f.campaign.id).status, 'ready');
    assert.deepEqual(f.database.getCampaign(f.campaign.id).config, frozen);
    assert.equal((await runCommand('git', ['diff', 'HEAD'], { cwd: f.worktree })).stdout, patch);
    assert.equal((await runCommand('git', ['ls-files', '--stage', '-v'], { cwd: f.worktree })).stdout, index);
    const receiptPath = path.join(f.artifacts, 'investigation/budget-grants/operator-4m.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.priorStateHash, canonicalHash(prior));
    assert.deepEqual(receipt.priorState, prior);
    assert.equal(receipt.patchHash, f.patchHash);
    assert.deepEqual(receipt.oldLimits, frozen.investigator);
    assert.deepEqual(receipt.newLimits, { ...frozen.investigator, maxAgentTokens: 8_092_956 });
    const events = f.database.listEvents(f.campaign.id);
    assert.deepEqual(await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension), granted);
    assert.deepEqual(f.database.listEvents(f.campaign.id), events);
    for (const changes of [{ additionalTokens: 1 }, { reason: 'Different authorization' }]) {
      await assert.rejects(f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id,
        { ...tokenExtension, ...changes }), /request.*different|changed.*request/i);
    }
    const agent = t.mock.method(AgentRunner.prototype, 'investigate', async function (
      this: AgentRunner, _variant: VariantRecord, _worktree: string, _artifacts: string, _context: string,
      current: InvestigationState, feedback: unknown,
    ) {
      const runtime = (this as unknown as { campaign: CampaignRecord }).campaign;
      assert.equal(runtime.config.investigator!.maxAgentTokens - current.agentTokens!, 4_000_000);
      assert.deepEqual(runtime.config, { ...frozen, investigator: { ...frozen.investigator, maxAgentTokens: 8_092_956 } });
      assert.equal(current.sessionId, prior.sessionId);
      assert.equal(current.turnCount, 2);
      assert.equal(current.agentCostUsd, 12.34);
      assert.deepEqual(feedback, prior.actions[0]);
      return { sessionId: current.sessionId!, usage: { tokens: 10, costUsd: 0.5 },
        action: { action: 'abandon' as const, rationale: 'Counterevidence refutes the mechanism', hypothesis } };
    });
    await f.orchestrator.runAutomatic(f.campaign.id);
    const result = f.database.getVariant(f.variant.id);
    assert.equal(agent.mock.callCount(), 1);
    assert.equal(f.database.listVariants(f.campaign.id).length, 2);
    assert.equal(result.investigation!.agentTokens, 4_092_966);
    assert.equal(result.investigation!.agentCostUsd, 12.84);
    assert.equal(result.investigation!.turnCount, 3);
    assert.equal(result.investigation!.startedAt, prior.startedAt);
    assert.equal(result.startedAt, startedAt);
    assert.ok(result.elapsedMs! >= 90_000);
    assert.deepEqual(result.investigation!.actions[0], prior.actions[0]);
    assert.deepEqual(result.investigation!.actions.map(({ id }) => id), ['action-001', 'action-003']);
    assert.deepEqual(f.database.getCampaign(f.campaign.id).config, frozen);
    assert.deepEqual(await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension),
      { variant: result, grant: granted.grant });
  } finally { await f.close(); }
});

test('token grants reject non-token exhaustion, unsafe sessions, altered patches, and invalid inputs without state changes', async (t) => {
  for (const invalid of ['wall-time', 'invalid-time', 'turn-cap', 'trial-cap', 'unknown-usage', 'unsafe-usage',
    'not-exhausted', 'not-terminal', 'no-session', 'no-worktree', 'no-baseline', 'other-parent', 'other-campaign',
    'disabled', 'running-action', 'interrupted-action', 'changed-patch', 'changed-archive', 'changed-index',
    'active-lease', 'bad-request', 'fractional-grant', 'overflow', 'empty-reason'] as const) {
    await t.test(invalid, async () => {
      const f = await exhaustedFixture();
      try {
        const state = structuredClone(f.state);
        let input = { ...tokenExtension };
        if (invalid === 'wall-time') state.startedAt = new Date(Date.now() - f.campaign.config.investigator!.maxWallTimeMs).toISOString();
        if (invalid === 'invalid-time') state.startedAt = 'unknown';
        if (invalid === 'turn-cap') state.turnCount = f.campaign.config.investigator!.maxTurns;
        if (invalid === 'trial-cap') state.actions = Array.from({ length: f.campaign.config.investigator!.maxPrimaryEvaluations },
          () => record(state, 'evaluate_primary', 'failed', f.patchHash));
        if (invalid === 'unknown-usage') state.agentTokens = null;
        if (invalid === 'unsafe-usage') state.agentTokens = 4_092_956.5;
        if (invalid === 'not-exhausted') state.agentTokens = 1_999_999;
        if (invalid === 'not-terminal') state.status = 'running';
        if (invalid === 'no-session') state.sessionId = null;
        if (invalid === 'no-baseline') state.harnessPins = {};
        if (invalid === 'running-action' || invalid === 'interrupted-action') state.actions[0]!.status = invalid === 'running-action' ? 'running' : 'interrupted';
        f.database.updateVariant(f.variant.id, { investigation: state });
        if (invalid === 'no-worktree') f.database.updateVariant(f.variant.id, { worktreePath: path.join(f.root, 'missing') });
        if (invalid === 'other-parent') f.database.updateCampaign(f.campaign.id, { currentParentVariantId: f.variant.id });
        if (invalid === 'other-campaign') {
          f.database.createCampaign({ ...f.campaign.config, id: 'other' }, f.campaign.seedSha, f.campaign.workflowsSha, f.campaign.environmentSha, 'fixture');
          f.database.database.prepare('UPDATE variants SET campaign_id = ? WHERE id = ?').run('other', f.variant.id);
        }
        if (invalid === 'disabled') f.database.database.prepare('UPDATE campaigns SET config_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...f.campaign.config, investigator: { ...f.campaign.config.investigator, enabled: false } }), f.campaign.id);
        if (invalid === 'changed-patch') await writeFile(path.join(f.worktree, 'server/src/evidence.ts'), 'export const evidence = 42;\n');
        if (invalid === 'changed-archive') await writeFile(path.join(f.artifacts, 'variant.patch'), 'changed');
        if (invalid === 'changed-index') await runCommand('git', ['add', 'server/src/evidence.ts'], { cwd: f.worktree });
        if (invalid === 'active-lease') f.database.acquireLease(f.campaign.id, 'other-coordinator', 60_000);
        if (invalid === 'bad-request') input.requestId = '../escape';
        if (invalid === 'fractional-grant') input.additionalTokens = 1.5;
        if (invalid === 'overflow') input.additionalTokens = Number.MAX_SAFE_INTEGER;
        if (invalid === 'empty-reason') input.reason = '   ';
        const beforeVariant = f.database.getVariant(f.variant.id);
        const beforeCampaign = f.database.getCampaign(f.campaign.id);
        await assert.rejects(f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, input));
        assert.deepEqual(f.database.getVariant(f.variant.id), beforeVariant);
        assert.deepEqual(f.database.getCampaign(f.campaign.id), beforeCampaign);
      } finally { await f.close(); }
    });
  }
});

test('grant transaction rolls back all database changes and leaves an orphan receipt that fails closed', async (t) => {
  const f = await exhaustedFixture();
  try {
    const variant = f.database.getVariant(f.variant.id);
    const campaign = f.database.getCampaign(f.campaign.id);
    const events = f.database.listEvents(f.campaign.id);
    const update = t.mock.method(f.database, 'updateCampaign', () => { throw new Error('injected transaction failure'); });
    await assert.rejects(f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension), /injected/);
    update.mock.restore();
    assert.deepEqual(f.database.getVariant(f.variant.id), variant);
    assert.deepEqual(f.database.getCampaign(f.campaign.id), campaign);
    assert.deepEqual(f.database.listEvents(f.campaign.id), events);
    const receiptPath = path.join(f.artifacts, 'investigation/budget-grants/operator-4m.json');
    const receipt = await readFile(receiptPath, 'utf8');
    await assert.rejects(f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension), /orphan|exist/i);
    assert.equal(await readFile(receiptPath, 'utf8'), receipt);
  } finally { await f.close(); }
});

test('grant archival cannot overwrite a replacement lease or a concurrent operator stop', async (t) => {
  for (const change of ['lease', 'stop'] as const) {
    const f = await exhaustedFixture();
    try {
      const before = f.database.getVariant(f.variant.id);
      const list = f.database.listVariants.bind(f.database);
      t.mock.method(f.database, 'listVariants', (campaignId: string) => {
        const variants = list(campaignId);
        if (change === 'lease') f.database.database.prepare('UPDATE campaigns SET lease_owner = ?, lease_expires_at = ? WHERE id = ?')
          .run('replacement', Date.now() + 60_000, campaignId);
        else f.orchestrator.stop(campaignId);
        return variants;
      });
      await assert.rejects(f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension), /lease or state changed/i);
      assert.deepEqual(f.database.getVariant(f.variant.id), before);
      if (change === 'lease') assert.equal(f.database.database.prepare('SELECT lease_owner FROM campaigns WHERE id = ?')
        .get(f.campaign.id)?.lease_owner, 'replacement');
      else assert.equal(f.database.getCampaign(f.campaign.id).status, 'stopped_by_user');
      assert.equal(f.database.listEvents(f.campaign.id).some((event) => event.type === 'investigator.tokens_extended'), false);
    } finally { await f.close(); }
  }
});

test('missing or altered grant receipts block duplicate requests and investigator dispatch', async (t) => {
  for (const invalid of ['missing', 'altered', 'snapshot', 'binding'] as const) {
    const f = await exhaustedFixture();
    try {
      await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension);
      const receiptPath = path.join(f.artifacts, 'investigation/budget-grants/operator-4m.json');
      if (invalid === 'missing') await rm(receiptPath);
      else if (invalid === 'snapshot') await writeFile(path.join(f.artifacts, 'investigation/budget-grants/operator-4m/variant.patch'), 'changed');
      else if (invalid === 'binding') f.database.database.prepare('DELETE FROM events WHERE type = ?').run('investigator.tokens_extended');
      else {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
        receipt.priorState.agentTokens = 0;
        await writeFile(receiptPath, JSON.stringify(receipt));
      }
      const agent = t.mock.method(AgentRunner.prototype, 'investigate', async () => { throw new Error('must not dispatch'); });
      await assert.rejects(f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension));
      await assert.rejects(f.internal.runInvestigatorCandidate(f.campaign, f.database.getVariant(f.variant.id), f.worktree, f.artifacts, f.baseline));
      assert.equal(agent.mock.callCount(), 0);
      agent.mock.restore();
    } finally { await f.close(); }
  }
});

test('a second token grant uses the prior effective limit and never replays a request blocked by the first cap', async (t) => {
  const f = await exhaustedFixture();
  try {
    const first = await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension);
    const agent = t.mock.method(AgentRunner.prototype, 'investigate', async () => ({
      sessionId: f.state.sessionId!, usage: { tokens: 4_000_010, costUsd: 0.5 },
      action: { action: 'test' as const, rationale: 'Request is blocked by token exhaustion', hypothesis },
    }));
    const exhausted = await f.internal.runInvestigatorCandidate(f.campaign, first.variant, f.worktree, f.artifacts, f.baseline);
    assert.equal(agent.mock.callCount(), 1);
    assert.equal(exhausted.investigation!.status, 'budget_exhausted');
    assert.equal(exhausted.investigation!.agentTokens, 8_092_966);
    assert.equal(exhausted.investigation!.turnCount, 3);
    assert.deepEqual(exhausted.investigation!.actions, f.state.actions);
    const second = await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id,
      { ...tokenExtension, requestId: 'operator-second', additionalTokens: 25 });
    assert.equal(second.grant.previousLimit, 8_092_956);
    assert.equal(second.grant.effectiveLimit, 8_092_991);
    assert.deepEqual(second.variant.investigation!.tokenGrants, [first.grant, second.grant]);
    assert.equal(second.variant.investigation!.agentCostUsd, 12.84);
    assert.equal(second.variant.investigation!.startedAt, f.state.startedAt);
    assert.deepEqual(await f.orchestrator.extendInvestigatorTokens(f.campaign.id, f.variant.id, tokenExtension),
      { variant: second.variant, grant: first.grant });
  } finally { await f.close(); }
});

test('primary retries use action-specific stacks even when collection preserves the previous volumes', async (t) => {
  const f = await fixture();
  try {
    f.campaign.config.evaluation.replicates = 2;
    const calls = await fakeDocker(t, f);
    let collections = 0;
    t.mock.method(S3Client.prototype, 'send', async () => {
      if (++collections === 1) throw new Error('fixture collection failed');
      return { Contents: [] };
    });
    f.database.createTargetExcludedConfig(f.campaign.id, {
      protocol: 'standard-primary-v2', normalArmSource: 'standard_primary',
      targetImplementationWorkflow: 'fixture/workflow', baselineVariantId: f.variant.parentVariantId!,
      primaryResolvedArtifactSha: `sha256:${'b'.repeat(64)}`, comparatorImage: `sha256:${'a'.repeat(64)}`,
      configuredAt: f.state.startedAt,
    });
    t.mock.method(f.internal, 'resolveV2PrimaryBenchmark', async (_campaign: CampaignRecord, benchmark: Benchmark) => ({ benchmark }));
    const stacks: StackHandle[] = [];
    const evaluation = t.mock.method(f.internal, 'runBenchmarkReplicates', async (_campaign: CampaignRecord, _variant: VariantRecord, stack: StackHandle) => {
      stacks.push(stack);
      const parent = f.database.getVariant(f.variant.parentVariantId!);
      return { facts: parent.facts!, replicates: parent.replicateFacts!, questions: [] };
    });
    f.state.actions.push(record(f.state, 'test', 'completed', f.patchHash));
    f.state.turnCount = 1;
    f.database.updateVariant(f.variant.id, { investigation: f.state });
    let turns = 0;
    t.mock.method(AgentRunner.prototype, 'investigate', async () => ({
      sessionId: f.state.sessionId!, usage: { tokens: 1, costUsd: 0 },
      action: { action: ++turns <= 2 ? 'evaluate_primary' as const : 'abandon' as const,
        rationale: 'Retry after the archived collection failure', hypothesis },
    }));
    const result = await f.internal.runInvestigatorCandidate(f.campaign, f.database.getVariant(f.variant.id), f.worktree, f.artifacts, f.baseline);
    assert.deepEqual(result.investigation?.actions.map(({ status }) => status), ['completed', 'failed', 'completed', 'completed']);
    assert.equal(stacks.length, 2);
    assert.ok(evaluation.mock.calls.every((call) => call.arguments[5]?.replicateCount === 1));
    assert.equal(f.campaign.config.evaluation.replicates, 2, 'screening must not change final repetition policy');
    for (const key of ['PLANNER_DDB_VOLUME', 'PLANNER_DDB_TABLE', 'PLANNER_KB_VOLUME', 'PLANNER_MINIO_VOLUME', 'PLANNER_S3_BUCKET']) {
      assert.notEqual(stacks[0]!.environment[key], stacks[1]!.environment[key], key);
    }
    assert.notEqual(stacks[0]!.composeProject, stacks[1]!.composeProject);
    assert.deepEqual(stacks.map((stack) => stack.environment.PLANNER_S3_KEY_PREFIX), [
      `${f.variant.id}/investigation-action-002`, `${f.variant.id}/investigation-action-003`,
    ]);
    const teardown = (await calls()).filter((args) => args.includes('down'));
    assert.equal(teardown.length, 2);
    assert.equal(teardown[0]!.includes('--volumes'), false);
    assert.equal(teardown[1]!.includes('--volumes'), true);
    const receipt = JSON.parse(await readFile(path.join(f.artifacts, 'investigation/action-003/receipt.json'), 'utf8'));
    assert.equal(receipt.patchHash, f.patchHash);
    assert.equal(result.facts, null, 'trial facts must not become final evaluation facts');
  } finally { await f.close(); }
});

test('finalizing a restored patch binds compliance to the last matching trial, not a later different treatment', async (t) => {
  const f = await fixture();
  try {
    await fakeDocker(t, f);
    for (const changes of [
      {}, {}, { patchHash: `sha256:${'b'.repeat(64)}` },
      { hypothesis: { ...hypothesis, title: 'Different preregistration on the same patch' } },
      { status: 'failed' as const },
    ]) f.state.actions.push({ ...record(f.state, 'evaluate_primary', 'completed', f.patchHash), ...changes });
    const matchedTrial = structuredClone(f.state.actions[1]!);
    const prior = structuredClone(f.state.actions);
    f.state.turnCount = prior.length;
    f.campaign.config.investigator!.maxTurns = prior.length + 1;
    f.database.updateVariant(f.variant.id, { investigation: f.state });
    t.mock.method(AgentRunner.prototype, 'investigate', async () => ({
      sessionId: f.state.sessionId!, usage: { tokens: 1, costUsd: 0 },
      action: { action: 'finalize' as const, rationale: 'Restore the earlier supported treatment', hypothesis },
    }));
    const assess = t.mock.method(AgentRunner.prototype, 'assessHypothesisCompliance', async (
      variant: VariantRecord, patchPath: string, contextPath: string, artifacts: string,
    ) => {
      const context = JSON.parse(await readFile(contextPath, 'utf8'));
      assert.deepEqual(context.evaluatedTrial, matchedTrial);
      assert.deepEqual(context.hypothesis, hypothesis);
      assert.equal(context.trustedTestResult.passed, true);
      const result = HypothesisComplianceOutputV2Schema.parse({
        kind: 'ainative-planner-eval/hypothesis-compliance', schemaVersion: 2,
        interpretationStatus: 'unverified_model_judgment', variantId: variant.id,
        patchSha256: await sha256File(patchPath), mutationContextSha256: await sha256File(contextPath),
        status: 'passed', summary: 'Fixture static review of the restored treatment',
        intervention: { status: 'satisfied', rationale: 'Fixture mechanism', evidence: ['server/src/evidence.ts:1'] },
        codeRegression: { status: 'satisfied', rationale: 'Fixture regression', evidence: ['fixture tests'] },
        falsificationTest: { status: 'not_applicable', rationale: 'No selected finding', evidence: ['mutation-context.json selectedFindings is empty'] },
        limitations: ['Unverified fixture judgment, not measured correctness.'],
      });
      const resultPath = hypothesisComplianceResultPath(artifacts, result.patchSha256, result.mutationContextSha256);
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, JSON.stringify(result), { flag: 'wx' });
      return { result, resultPath };
    });
    const result = await f.internal.runInvestigatorCandidate(f.campaign, f.database.getVariant(f.variant.id), f.worktree, f.artifacts, f.baseline);
    assert.equal(result.investigation?.status, 'finalized', result.investigation?.reason ?? undefined);
    assert.equal(assess.mock.callCount(), 1);
    assert.deepEqual(result.investigation.actions.slice(0, -1), prior);
    assert.equal(result.patchHash, f.patchHash);
    assert.equal(result.hypothesisComplianceCandidatePatchHash, f.patchHash);
    await f.internal.verifyVariantHypothesisCompliance(f.campaign, result);
    const receipt = JSON.parse(await readFile(path.join(f.artifacts, 'investigation/action-006/receipt.json'), 'utf8'));
    assert.equal(receipt.patchHash, f.patchHash);
    assert.deepEqual(receipt.result.compliance, result.hypothesisCompliance);
  } finally { await f.close(); }
});

test('investigator rounds skip higher-scoring candidates that fail existing promotion prerequisites', async (t) => {
  for (const invalid of ['diagnosis', 'diagnosis-hash', 'cohort', 'target-excluded'] as const) {
    await t.test(invalid, async (t) => {
      const f = await fixture('automatic');
      try {
        f.database.updateVariant(f.variant.id, { investigation: null, status: 'rejected' });
        f.campaign.config.limits = { ...f.campaign.config.limits, concurrency: 2, maxVariants: 3 };
        f.campaign.config.goal = 'A detailed campaign objective. '.repeat(180);
        f.database.acquireLease(f.campaign.id, 'fixture-coordinator', 60_000);
        if (invalid === 'target-excluded') {
          f.database.createTargetExcludedConfig(f.campaign.id, {
            targetImplementationWorkflow: 'fixture/workflow', baselineVariantId: f.variant.parentVariantId!,
            comparatorImage: `sha256:${'a'.repeat(64)}`, configuredAt: f.state.startedAt,
          });
        }
        const ready = t.mock.method(f.internal, 'targetExcludedEvaluationReady', (
          _campaign: CampaignRecord, _config: TargetExcludedConfig, evaluation: TargetExcludedEvaluationRecord | null,
        ) => evaluation?.gate?.status === 'passed');
        t.mock.method(f.internal, 'runVariant', async (_campaign: CampaignRecord, variant: VariantRecord) => {
          assert.ok(variant.hypothesis.rationale.length <= 4_000);
          const best = variant.ordinal === 2;
          if (invalid === 'target-excluded') {
            f.database.createTargetExcludedEvaluation(f.campaign.id, variant.id);
            f.database.updateTargetExcludedEvaluation(variant.id, { gate: {
              status: best ? 'blocked' : 'passed', baselineMeanBuildRate: 1, candidateMeanBuildRate: best ? 0 : 1,
              buildDropRatio: best ? 1 : 0, reasons: [],
            } });
          }
          return f.database.updateVariant(variant.id, {
            status: 'review', artifactCollectionComplete: true, hypothesisComplianceStatus: 'passed',
            investigation: { ...f.state, status: 'finalized' },
            diagnosisStatus: best && invalid === 'diagnosis' ? 'failed' : 'completed',
            diagnosisInputHash: best && invalid === 'diagnosis-hash' ? null : `sha256:${'a'.repeat(64)}`,
            score: {
              cohortMismatches: best && invalid === 'cohort' ? ['requirement units'] : [],
              verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
              provisional: { labeled: 2, correct: best ? 2 : 1, errors: best ? 0 : 1, accuracy: best ? 1 : 0.5 },
              decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
            },
          });
        });
        const attempted: string[] = [];
        t.mock.method(f.internal, 'promoteUnlocked', async (_campaignId: string, variantId: string) => {
          attempted.push(variantId);
          const variant = f.database.getVariant(variantId);
          if (variant.ordinal === 2) throw new Error('ineligible candidate must never reach promotion');
          return f.database.updateVariant(variantId, { status: 'completed' });
        });
        const results = await f.internal.runInvestigatorRound(f.campaign);
        assert.deepEqual(attempted, [results[1]!.id]);
        assert.equal(f.database.getVariant(results[1]!.id).status, 'completed');
        assert.equal(ready.mock.callCount(), invalid === 'target-excluded' ? 2 : 0);
      } finally { await f.close(); }
    });
  }
});

test('resume recovers the saved session, does not replay completed/interrupted actions, and preserves the patch and index', async (t) => {
  const f = await fixture();
  try {
    f.state.actions.push(record(f.state, 'test', 'completed', f.patchHash));
    f.state.actions.push(record(f.state, 'test', 'running', f.patchHash));
    f.state.turnCount = 2;
    f.database.updateVariant(f.variant.id, { investigation: f.state });
    f.database.updateCampaign(f.campaign.id, { status: 'running_round_1' });
    const indexPath = path.resolve(f.worktree, (await runCommand('git', ['rev-parse', '--git-path', 'index'], { cwd: f.worktree })).stdout.trim());
    const index = await readFile(indexPath);
    const patch = (await runCommand('git', ['diff', 'HEAD'], { cwd: f.worktree })).stdout;
    assert.equal(f.orchestrator.resume(f.campaign.id).status, 'ready');
    const resumed = f.database.getVariant(f.variant.id).investigation!;
    assert.deepEqual(resumed.actions.map((item) => item.status), ['completed', 'interrupted']);
    const agent = t.mock.method(AgentRunner.prototype, 'investigate', async (
      _variant: VariantRecord, _worktree: string, _artifacts: string, _context: string,
      state: InvestigationState, feedback: unknown,
    ) => {
      assert.equal(state.sessionId, 'ses-durable');
      assert.equal(state.turnCount, 2);
      assert.match(JSON.stringify(feedback), /not replayed/i);
      return { sessionId: 'ses-durable', usage: { tokens: 1, costUsd: 0 },
        action: { action: 'abandon' as const, rationale: 'Counterevidence refutes the mechanism', hypothesis } };
    });
    await f.orchestrator.runRound(f.campaign.id);
    const result = f.database.getVariant(f.variant.id);
    assert.equal(agent.mock.callCount(), 1);
    assert.equal(result.investigation?.status, 'abandoned');
    const abandonment = result.investigation!.actions.at(-1)!;
    const receipt = JSON.parse(await readFile(path.join(f.artifacts, abandonment.artifactDirectory!, 'receipt.json'), 'utf8'));
    assert.equal(receipt.result.reason, abandonment.rationale);
    assert.deepEqual(result.investigation?.actions.map((item) => item.status), ['completed', 'interrupted', 'completed']);
    assert.equal(f.database.listVariants(f.campaign.id).length, 2);
    assert.equal((await runCommand('git', ['diff', 'HEAD'], { cwd: f.worktree })).stdout, patch);
    assert.deepEqual(await readFile(indexPath), index);
  } finally { await f.close(); }
});

test('resume refuses unfinished primary stacks and incomplete persisted worktree provenance without mutation', async () => {
  const f = await fixture();
  try {
    for (const unsafe of ['primary', 'worktree', 'baseline', 'session'] as const) {
      const state = structuredClone(f.state);
      state.turnCount = 1;
      if (unsafe === 'primary') state.actions.push(record(state, 'evaluate_primary', 'running', f.patchHash));
      if (unsafe === 'baseline') state.harnessPins = {};
      if (unsafe === 'session') state.sessionId = null;
      f.database.updateVariant(f.variant.id, { investigation: state, worktreePath: unsafe === 'worktree' ? null : f.worktree });
      f.database.updateCampaign(f.campaign.id, { status: 'stopped_by_user' });
      assert.throws(() => f.orchestrator.resume(f.campaign.id), unsafe === 'primary' ? /archive.*primary|primary.*archive/i : /resume|session|worktree|baseline/i);
      assert.deepEqual(f.database.getVariant(f.variant.id).investigation, state);
      assert.equal(f.database.getCampaign(f.campaign.id).status, 'stopped_by_user');
    }
  } finally { await f.close(); }
});

test('resume refuses a live lease owned by a different coordinator', async () => {
  const f = await fixture();
  try {
    f.database.updateVariant(f.variant.id, { status: 'stopped', investigation: { ...f.state, status: 'stopped' } });
    f.database.acquireLease(f.campaign.id, 'other-coordinator', 60_000);
    assert.throws(() => f.orchestrator.resume(f.campaign.id), /lease|coordinator/i);
  } finally { await f.close(); }
});

test('round refuses missing worktrees and changed indexes before invoking the agent or recreating anything', async (t) => {
  const f = await fixture();
  try {
    const agent = t.mock.method(AgentRunner.prototype, 'investigate', async () => { throw new Error('must not invoke agent'); });
    f.database.updateVariant(f.variant.id, { worktreePath: path.join(f.root, 'missing-worktree') });
    await assert.rejects(f.orchestrator.runRound(f.campaign.id), /no worktree was recreated/);
    f.database.updateCampaign(f.campaign.id, { status: 'ready' });
    f.database.updateVariant(f.variant.id, { worktreePath: f.worktree });
    await runCommand('git', ['add', 'server/src/evidence.ts'], { cwd: f.worktree });
    const index = (await runCommand('git', ['ls-files', '--stage', '-v'], { cwd: f.worktree })).stdout;
    await assert.rejects(f.orchestrator.runRound(f.campaign.id), /altered the staged parent baseline/);
    assert.equal(agent.mock.callCount(), 0);
    assert.equal((await runCommand('git', ['ls-files', '--stage', '-v'], { cwd: f.worktree })).stdout, index);
  } finally { await f.close(); }
});

test('automatic round does not dispatch or overwrite the replacement coordinator after losing its lease', async () => {
  const f = await fixture('automatic');
  try {
    let dispatched = false;
    f.orchestrator.refreshReports = async () => {
      f.database.database.prepare('UPDATE campaigns SET lease_owner = ?, lease_expires_at = ?, status = ? WHERE id = ?')
        .run('replacement', Date.now() + 60_000, 'replacement_running', f.campaign.id);
    };
    f.internal.runVariant = async () => { dispatched = true; return f.database.getVariant(f.variant.id); };
    await assert.rejects(f.orchestrator.runAutomatic(f.campaign.id), /lease lost/i);
    assert.equal(dispatched, false);
    assert.equal(f.database.getCampaign(f.campaign.id).status, 'replacement_running');
  } finally { await f.close(); }
});

test('stop during round preparation is preserved and prevents candidate dispatch', async () => {
  const f = await fixture('automatic');
  try {
    let dispatched = false;
    f.orchestrator.refreshReports = async () => { f.orchestrator.stop(f.campaign.id); };
    f.internal.runVariant = async () => { dispatched = true; return f.database.getVariant(f.variant.id); };
    await f.orchestrator.runAutomatic(f.campaign.id);
    assert.equal(dispatched, false);
    assert.equal(f.database.getCampaign(f.campaign.id).status, 'stopped_by_user');
  } finally { await f.close(); }
});

test('automatic mode stops instead of repeatedly retrying a failed investigator candidate', async () => {
  const f = await fixture('automatic');
  try {
    let calls = 0;
    f.internal.runVariant = async () => {
      calls += 1;
      if (calls > 1) f.orchestrator.stop(f.campaign.id);
      return f.database.updateVariant(f.variant.id, { status: 'failed', error: 'integrity check failed' });
    };
    await f.orchestrator.runAutomatic(f.campaign.id);
    assert.equal(calls, 1);
    assert.equal(f.database.getCampaign(f.campaign.id).status, 'stopped_investigator_failed');
  } finally { await f.close(); }
});

test('primary evaluation requires a completed test on the exact current patch and finalization freezes its measured hypothesis', async (t) => {
  const f = await fixture();
  try {
    const revised = { ...hypothesis, title: 'Revised after inspecting source' };
    const cases: Array<{ kind: InvestigatorAction['action']; prior: InvestigationActionRecord[]; expected: RegExp }> = [
      { kind: 'evaluate_primary', prior: [], expected: /trusted tests.*exact patch/i },
      { kind: 'evaluate_primary', prior: [record(f.state, 'test', 'failed', f.patchHash)], expected: /trusted tests.*exact patch/i },
      { kind: 'evaluate_primary', prior: [record(f.state, 'test', 'completed', 'sha256:other')], expected: /trusted tests.*exact patch/i },
      { kind: 'evaluate_primary', prior: [record(f.state, 'test', 'completed', f.patchHash)], expected: /frozen environment hash changed/i },
      { kind: 'finalize', prior: [record(f.state, 'evaluate_primary', 'completed', f.patchHash)], expected: /preregistered hypothesis/i },
      { kind: 'finalize', prior: [{ ...record(f.state, 'evaluate_primary', 'completed', f.patchHash), hypothesis: revised }], expected: /frozen environment hash changed/i },
    ];
    let turnCount = 0;
    for (const scenario of cases) {
      const state = { ...structuredClone(f.state), turnCount, actions: scenario.prior };
      const config = { ...f.campaign.config, investigator: { ...f.campaign.config.investigator!, maxTurns: turnCount + 1 } };
      f.database.updateVariant(f.variant.id, { investigation: state });
      const agent = t.mock.method(AgentRunner.prototype, 'investigate', async () => ({
        sessionId: 'ses-durable', usage: { tokens: 1, costUsd: 0 },
        action: { action: scenario.kind, rationale: 'Revised preregistration', hypothesis: revised },
      }));
      const result = await f.internal.runInvestigatorCandidate({ ...f.campaign, config }, f.database.getVariant(f.variant.id), f.worktree, f.artifacts, f.baseline);
      assert.match(result.investigation!.actions.at(-1)!.error!, scenario.expected);
      assert.equal(result.hypothesis.title, revised.title);
      assert.equal(result.investigation!.actions.at(-1)!.patchHash, f.patchHash);
      assert.ok(result.investigation!.actions.at(-1)!.artifactDirectory);
      if (scenario.kind === 'finalize') assert.deepEqual(result.investigation!.actions[0]?.hypothesis, scenario.prior[0]?.hypothesis);
      agent.mock.restore();
      turnCount += 1;
    }
  } finally { await f.close(); }
});

test('persisted failed-test feedback returns to the same session and lease loss fences action dispatch', async () => {
  const f = await fixture();
  try {
    f.database.acquireLease(f.campaign.id, 'owner', 60_000);
    let turns = 0;
    let executed = 0;
    const assertActive = () => {
      const lease = f.database.database.prepare('SELECT lease_owner FROM campaigns WHERE id = ?').get(f.campaign.id);
      if (lease?.lease_owner !== 'owner') throw new Error('investigator campaign lease lost');
    };
    await assert.rejects(runInvestigatorLoop(f.state, f.campaign.config.investigator!, {
      save: (state) => { f.database.updateVariant(f.variant.id, { investigation: state }); },
      stopped: () => false, assertActive,
      turn: async (state, feedback) => {
        turns += 1;
        assert.equal(state.sessionId, 'ses-durable');
        if (turns === 2) {
          assert.match(JSON.stringify(feedback), /regression failed/);
          f.database.releaseLease(f.campaign.id, 'owner');
          f.database.acquireLease(f.campaign.id, 'replacement', 60_000);
        }
        return { sessionId: 'ses-durable', usage: { tokens: 1, costUsd: 0 },
          action: { action: 'test', rationale: 'Run the regression', hypothesis } };
      },
      execute: async () => { executed += 1; throw new Error('regression failed'); },
    }), /lease lost/);
    assert.equal(turns, 2);
    assert.equal(executed, 1);
    assert.equal(f.database.getVariant(f.variant.id).investigation?.actions.length, 1);
  } finally { await f.close(); }
});
