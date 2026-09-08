import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runLive } from '../scripts/live.js';
import { HarnessDatabase } from '../src/db.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import { CampaignConfigSchema, type CampaignConfig } from '../src/types.js';

const source = CampaignConfigSchema.parse({
  id: 'source-campaign',
  goal: 'Exercise the live coordinator without starting external services. PRIVATE_SENTINEL',
  plannerRepo: '/unused/planner', workflowsRepo: '/unused/workflows',
  environmentFile: '/unused/environment.env', seedRevision: 'a'.repeat(40),
  workflowsRevision: 'b'.repeat(40),
  benchmarks: [
    { name: 'primary', role: 'primary', zipPath: '/unused/primary.zip', sha256: `sha256:${'c'.repeat(64)}` },
    { name: 'holdout', role: 'holdout', zipPath: '/unused/holdout.zip', sha256: `sha256:${'d'.repeat(64)}` },
  ],
  targetExcluded: { protocol: 'standard-primary-v2', targetImplementationWorkflow: 'fixture/workflow' },
  evaluation: { replicates: 2, replicateConcurrency: 2, analysisMaxCostUsd: 42 },
  agent: { autoApprove: false, model: 'fixture/model', variant: 'high' },
});

test('live execution requires explicit opt-in before any filesystem or coordinator work', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'harness-live-opt-in-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  t.mock.method(process.stdout, 'write', () => true);
  const initialize = t.mock.method(CampaignOrchestrator.prototype, 'initialize', () => {
    throw new Error('must not initialize');
  });
  for (const args of [[], ['--help'], ['--source-config', 'missing', '--id', 'new-campaign'],
    ['--live', '--source-config', 'missing', '--id', '../escape'], ['--live', '--unknown']]) {
    assert.notEqual(await runLive(args, cwd), 1);
  }
  assert.deepEqual(await readdir(cwd), []);
  assert.equal(initialize.mock.callCount(), 0);
});

test('live runner sequences one coordinator, preserves inputs, and reports incomplete outcomes', async (t) => {
  for (const scenario of ['completed', 'baseline-failed', 'automatic-error', 'budget-exhausted', 'duplicate', 'invalid-source', 'same-id', 'auto-approve'] as const) {
    await t.test(scenario, async (t) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'harness-live-'));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      const sourcePath = path.join(cwd, 'source.json');
      const input = structuredClone(source);
      if (scenario === 'invalid-source') delete input.targetExcluded;
      if (scenario === 'same-id') input.id = 'new-campaign';
      if (scenario === 'auto-approve') input.agent.autoApprove = true;
      const original = JSON.stringify(input);
      await writeFile(sourcePath, original);
      const output: string[] = [];
      t.mock.method(process.stdout, 'write', (chunk: string) => { output.push(chunk); return true; });
      t.mock.method(process.stderr, 'write', (chunk: string) => { output.push(chunk); return true; });
      // Never let these tests reach Docker, Git worktrees, packs, or an agent.
      const calls: string[] = [];
      let config: CampaignConfig | undefined;
      let campaignStatus = 'initialized';
      const baseline = { id: 'new-campaign-v000', round: 0, status: 'completed', artifactCollectionComplete: true };
      const candidate = {
        id: 'new-campaign-v001', round: 1, status: 'rejected', artifactCollectionComplete: true,
        investigation: { status: scenario === 'budget-exhausted' ? 'budget_exhausted' : 'finalized', turnCount: 4 },
      };
      let automaticCompleted = false;
      t.mock.method(HarnessDatabase.prototype, 'getCampaign', () => ({
        status: campaignStatus, currentParentVariantId: baseline.id,
      }));
      t.mock.method(HarnessDatabase.prototype, 'listVariants', () => automaticCompleted ? [baseline, candidate] : [baseline]);
      t.mock.method(CampaignOrchestrator.prototype, 'initialize', async function (this: CampaignOrchestrator, file: string) {
        calls.push('initialize');
        config = CampaignConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')));
        const root = path.join(cwd, '.data', 'live', 'new-campaign');
        assert.equal(this.paths.root, root);
        for (const destination of [this.paths.database, this.paths.campaigns, this.paths.artifacts, this.paths.worktrees, this.paths.reports]) {
          assert.ok(destination.startsWith(`${root}${path.sep}`));
        }
      });
      t.mock.method(CampaignOrchestrator.prototype, 'runBaseline', async (id: string) => {
        assert.equal(id, 'new-campaign');
        calls.push('baseline-start');
        await new Promise((resolve) => setImmediate(resolve));
        calls.push('baseline-end');
        campaignStatus = scenario === 'baseline-failed' ? 'baseline_target_failed' : 'ready';
        return baseline;
      });
      t.mock.method(CampaignOrchestrator.prototype, 'runAutomatic', async (id: string) => {
        assert.equal(id, 'new-campaign');
        assert.equal(calls.at(-1), 'baseline-end');
        calls.push('automatic');
        if (scenario === 'automatic-error') throw new Error('PRIVATE_SENTINEL');
        campaignStatus = 'stopped_max_variants';
        automaticCompleted = true;
      });
      t.mock.method(CampaignOrchestrator.prototype, 'refreshReports', async () => { calls.push('reports'); });
      const args = ['--live', '--source-config', sourcePath, '--id', 'new-campaign'];
      const result = await runLive(args, cwd);
      const root = path.join(cwd, '.data', 'live', 'new-campaign');
      const reportPath = path.join(root, 'live-report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(await readFile(sourcePath, 'utf8'), original);
      assert.ok(!output.join('').includes('PRIVATE_SENTINEL'));
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      if (['invalid-source', 'same-id', 'auto-approve'].includes(scenario)) {
        assert.equal(result, 1);
        assert.equal(report.status, 'failed');
        assert.deepEqual(calls, []);
        return;
      }
      assert.deepEqual(config, {
        ...source, id: 'new-campaign', mode: 'automatic',
        investigator: { enabled: true, primaryReplicates: 2, maxTurns: 12, maxPrimaryEvaluations: 3, maxWallTimeMs: 14_400_000, maxAgentTokens: 2_000_000 },
        evaluation: { ...source.evaluation, replicateConcurrency: 2 },
        limits: { ...source.limits, concurrency: 1, maxVariants: 1 },
      });
      const phases = (await readFile(path.join(root, 'live-phases.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(phases[0].phase, 'prepare');
      if (scenario === 'baseline-failed') {
        assert.equal(result, 1);
        assert.equal(report.phase, 'baseline');
        assert.deepEqual(calls, ['initialize', 'baseline-start', 'baseline-end']);
      } else if (scenario === 'automatic-error') {
        assert.equal(result, 1);
        assert.equal(report.phase, 'automatic');
        assert.match(await readFile(path.join(root, 'live-error.txt'), 'utf8'), /PRIVATE_SENTINEL/);
      } else {
        assert.equal(result, scenario === 'budget-exhausted' ? 2 : 0);
        assert.equal(report.status, scenario === 'budget-exhausted' ? 'blocked' : 'completed');
        assert.equal(report.campaignStatus, 'stopped_max_variants');
        assert.deepEqual(calls, ['initialize', 'baseline-start', 'baseline-end', 'automatic', 'reports']);
      }
      if (scenario === 'duplicate') {
        const firstReport = await readFile(reportPath, 'utf8');
        const callCount = calls.length;
        assert.equal(await runLive(args, cwd), 1);
        assert.equal(calls.length, callCount);
        assert.equal(await readFile(reportPath, 'utf8'), firstReport);
      }
    });
  }
});
