import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import type { HarnessPaths } from '../src/paths.js';
import { runCommand } from '../src/process.js';
import {
  CampaignConfigSchema,
  type Benchmark,
  type CampaignRecord,
  type VariantRecord,
} from '../src/types.js';

async function gitFixture(directory: string, withRemote = false): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'README.md'), 'fixture\n');
  await runCommand('git', ['init'], { cwd: directory });
  await runCommand('git', ['add', '.'], { cwd: directory });
  await runCommand(
    'git',
    [
      '-c',
      'user.name=Harness Test',
      '-c',
      'user.email=harness@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: directory },
  );
  if (withRemote) {
    await runCommand(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:Saris-AI/workflows.git'],
      { cwd: directory },
    );
  }
  return (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
}

test('campaign initialization freezes environment and pack bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-init-'));
  const plannerRepo = path.join(root, 'planner');
  const workflowsRepo = path.join(root, 'workflows');
  const [seedSha, workflowsSha] = await Promise.all([
    gitFixture(plannerRepo),
    gitFixture(workflowsRepo, true),
  ]);
  const environmentFile = path.join(root, 'planner.env');
  const primary = path.join(root, 'primary.zip');
  const holdout = path.join(root, 'holdout.zip');
  await Promise.all([
    writeFile(environmentFile, 'OPENAI_MODEL=gpt-5.6-sol\n'),
    writeFile(primary, 'primary bytes'),
    writeFile(holdout, 'holdout bytes'),
  ]);
  const configPath = path.join(root, 'campaign.json');
  await writeFile(
    configPath,
    JSON.stringify({
      id: 'freeze-test',
      goal: 'Freeze all mutable campaign inputs before running any experiment.',
      plannerRepo,
      workflowsRepo,
      environmentFile,
      seedRevision: seedSha,
      workflowsRevision: workflowsSha,
      benchmarks: [
        { name: 'primary', role: 'primary', zipPath: primary },
        { name: 'holdout', role: 'holdout', zipPath: holdout },
      ],
    }),
  );
  const data = path.join(root, 'data');
  const paths: HarnessPaths = {
    root: data,
    database: path.join(data, 'harness.sqlite'),
    campaigns: path.join(data, 'campaigns'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    reports: path.join(root, 'experiments'),
  };
  await mkdir(data);
  const database = new HarnessDatabase(paths.database);
  try {
    const campaign = await new CampaignOrchestrator(paths, database).initialize(configPath);
    assert.match(campaign.environmentSha, /^sha256:[a-f0-9]{64}$/);
    assert.equal(campaign.workflowsRemoteUrl, 'https://github.com/Saris-AI/workflows.git');
    assert.equal(campaign.config.environmentFile, path.join(data, 'campaigns/freeze-test/environment.env'));
    assert.equal(
      await readFile(campaign.config.benchmarks[0]!.zipPath, 'utf8'),
      'primary bytes',
    );
    await writeFile(primary, 'mutated');
    assert.equal(
      await readFile(campaign.config.benchmarks[0]!.zipPath, 'utf8'),
      'primary bytes',
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('replicate wall-clock timing is initialized before health and finalized on failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-replicate-timing-'));
  const data = path.join(root, 'data');
  const artifacts = path.join(root, 'artifacts');
  await Promise.all([mkdir(data), mkdir(artifacts)]);
  const paths: HarnessPaths = {
    root: data,
    database: path.join(data, 'harness.sqlite'),
    campaigns: path.join(data, 'campaigns'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    reports: path.join(root, 'experiments'),
  };
  const database = new HarnessDatabase(paths.database);
  const server = createServer((_request, response) => {
    const state = database.getVariant('timing-test-v000').executionState?.executions[0];
    assert.ok(state?.startedAt);
    assert.equal(state.completedAt, null);
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end('{"status":"not-ready"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  try {
    const config = CampaignConfigSchema.parse({
      id: 'timing-test',
      goal: 'Measure failed replicate lifecycle timing around planner health.',
      plannerRepo: root,
      workflowsRepo: root,
      environmentFile: path.join(root, 'environment.env'),
      seedRevision: 'seed',
      workflowsRevision: 'workflows',
      benchmarks: [
        { name: 'primary-pack', role: 'primary', zipPath: path.join(root, 'primary.zip') },
        { name: 'holdout-pack', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
      ],
    });
    const campaign = database.createCampaign(
      config,
      'a'.repeat(40),
      'b'.repeat(40),
      `sha256:${'c'.repeat(64)}`,
      'https://github.com/Saris-AI/workflows.git',
    );
    const variant = database.createVariant({
      id: 'timing-test-v000',
      campaignId: campaign.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: {
        title: 'Timing',
        rationale: 'Exercise replicate timing.',
        instructions: 'Do not modify the planner.',
        expectedImpact: 'Persist timing on failure.',
        risk: 'Fixture only.',
      },
    });
    const benchmark = campaign.config.benchmarks[0]!;
    const orchestrator = new CampaignOrchestrator(paths, database);
    const runBenchmark = (orchestrator as unknown as {
      runBenchmark(
        campaign: CampaignRecord,
        variant: VariantRecord,
        stack: {
          artifactDirectory: string;
          baseUrl: string;
        },
        benchmark: Benchmark,
        token: string | undefined,
        replicate: number,
        workflowsSource: string,
        answerCache: Map<string, unknown>,
      ): Promise<unknown>;
    }).runBenchmark.bind(orchestrator);

    await assert.rejects(
      runBenchmark(
        campaign,
        variant,
        { artifactDirectory: artifacts, baseUrl: `http://127.0.0.1:${address.port}` },
        benchmark,
        undefined,
        1,
        root,
        new Map(),
      ),
      /GET \/readyz failed \(503\)/,
    );
    const execution = database.getVariant(variant.id).executionState?.executions[0];
    assert.equal(execution?.status, 'failed');
    assert.ok(execution?.startedAt);
    assert.ok(execution?.completedAt);
    assert.equal(
      execution?.elapsedMs,
      Date.parse(execution!.completedAt!) - Date.parse(execution!.startedAt!),
    );
    assert.equal(execution?.usage, null);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
