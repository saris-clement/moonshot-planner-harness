import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { AgentRunner } from '../src/agents.js';
import { sha256File } from '../src/config.js';
import { HarnessDatabase } from '../src/db.js';
import { hypothesisComplianceResultPath } from '../src/hypothesisCompliance.js';
import { runInvestigatorLoop } from '../src/investigatorLoop.js';
import type { InvestigationActionRecord, InvestigationState, InvestigatorAction } from '../src/investigator.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import { ensureHarnessPaths, harnessPaths, variantArtifactDirectory } from '../src/paths.js';
import { runCommand } from '../src/process.js';
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
