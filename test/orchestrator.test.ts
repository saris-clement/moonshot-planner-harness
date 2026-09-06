import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  type RunFacts,
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
    assert.match(
      await readFile(campaign.config.environmentFile, 'utf8'),
      /PLANNER_ANALYSIS_TIMEOUT_MS=36000000/,
    );
    assert.match(
      await readFile(campaign.config.environmentFile, 'utf8'),
      /PLANNER_ANALYSIS_MAX_COST_USD=2000/,
    );
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

test('diagnosis failure preserves measured facts, score, artifact completeness, and review state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-diagnosis-failure-'));
  const data = path.join(root, 'data');
  const artifacts = path.join(data, 'artifacts', 'diagnosis-failure', 'diagnosis-failure-v000');
  const replicate = path.join(artifacts, 'primary-pack', 'replicate-1');
  const environmentFile = path.join(root, 'environment.env');
  await Promise.all([mkdir(data, { recursive: true }), mkdir(replicate, { recursive: true })]);
  await writeFile(environmentFile, '');
  const environmentSha = `sha256:${createHash('sha256').update('').digest('hex')}`;
  const paths: HarnessPaths = {
    root: data,
    database: path.join(data, 'harness.sqlite'),
    campaigns: path.join(data, 'campaigns'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    reports: path.join(root, 'reports'),
  };
  const database = new HarnessDatabase(paths.database);
  try {
    const config = CampaignConfigSchema.parse({
      id: 'diagnosis-failure',
      goal: 'Preserve measured evaluation state when a post-teardown diagnosis agent fails.',
      plannerRepo: root,
      workflowsRepo: root,
      environmentFile,
      seedRevision: 'seed',
      workflowsRevision: 'workflows',
      evaluation: { replicates: 1, replicateConcurrency: 1 },
      agent: { command: 'false', model: 'test-model', autoApprove: false },
      benchmarks: [
        { name: 'primary-pack', role: 'primary', zipPath: path.join(root, 'primary.zip') },
        { name: 'holdout-pack', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
      ],
    });
    const campaign = database.createCampaign(
      config,
      'a'.repeat(40),
      'b'.repeat(40),
      environmentSha,
      'https://example.invalid/workflows.git',
    );
    const facts: RunFacts = {
      status: 'completed',
      sampleSize: 1,
      decisionAgreement: 1,
      unitCount: 1,
      decisions: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
      shortlist: { empty: 1, nonempty: 0, candidates: 0 },
      evidence: { discovered: 0, selectedSourceRefs: 0 },
      usage: {
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUsd: 0,
        durationMs: 1,
      },
      pins: {},
      units: [
        {
          id: 'unit-a',
          key: 'unit-a',
          ref: { entity: 'solution/main', anchor: 'unit-a' },
          kind: 'field',
          semantics: 'A field.',
          decision: 'build',
          confidence: 'high',
          rationale: 'No evidence.',
          selectedCandidateIds: [],
          sourceRefs: [],
          discoveredEvidenceCount: 0,
          shortlistCandidateCount: 0,
          uncoveredSemantics: ['field'],
        },
      ],
    };
    const judgment = {
      summary: 'Model suggestion only.',
      verdicts: [
        {
          unitKey: 'unit-a',
          expectedDecision: 'build' as const,
          classification: 'real_gap' as const,
          confidence: 'low' as const,
          rationale: 'No source was cited.',
          evidence: ['not captured'],
        },
      ],
    };
    const score = {
      cohortMismatches: [],
      verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
      provisional: { labeled: 1, correct: 1, errors: 0, accuracy: 1 },
      decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
    };
    const created = database.createVariant({
      id: 'diagnosis-failure-v000',
      campaignId: campaign.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: {
        title: 'Seed',
        rationale: 'Observe.',
        instructions: 'Do not edit.',
        expectedImpact: 'Facts.',
        risk: 'Variance.',
        findingIds: [],
      },
    });
    const variant = database.updateVariant(created.id, {
      status: 'review',
      artifactCollectionComplete: true,
      facts,
      replicateFacts: [facts],
      judgment,
      score,
    });
    await Promise.all([
      writeFile(path.join(replicate, 'facts.json'), `${JSON.stringify(facts)}\n`),
      writeFile(
        path.join(replicate, 'result.json'),
        `${JSON.stringify({ caseId: 'case-a', runId: 'run-a', status: 'completed', facts })}\n`,
      ),
      writeFile(
        path.join(replicate, 'analysis.json'),
        `${JSON.stringify({
          metadata: { caseId: 'case-a', runId: 'run-a' },
          analysis: { requirementUnits: [], adjudications: [], resolvedInputs: {} },
        })}\n`,
      ),
    ]);
    const orchestrator = new CampaignOrchestrator(paths, database);
    const internal = orchestrator as unknown as {
      ensureFrozenPlannerSource: (campaign: CampaignRecord) => Promise<string>;
      ensureFrozenWorkflowsSource: (campaign: CampaignRecord) => Promise<string>;
      runDiagnosis: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        artifactDirectory: string,
      ) => Promise<void>;
      requireCurrentParentDiagnosis: (campaign: CampaignRecord) => Promise<boolean>;
    };
    internal.ensureFrozenPlannerSource = async () => root;
    internal.ensureFrozenWorkflowsSource = async () => root;
    await internal.runDiagnosis(campaign, variant, artifacts);

    const persisted = database.getVariant(variant.id);
    assert.equal(persisted.status, 'review');
    assert.equal(persisted.artifactCollectionComplete, true);
    assert.deepEqual(persisted.facts, facts);
    assert.deepEqual(persisted.score, score);
    assert.equal(persisted.diagnosisStatus, 'failed');
    assert.ok(persisted.diagnosisInputHash);
    assert.match(persisted.diagnosisError ?? '', /false/);
    const events = database.listEvents(campaign.id);
    assert.ok(events.some((event) => event.type === 'diagnosis.assembling'));
    assert.ok(events.some((event) => event.type === 'diagnosis.running'));
    assert.ok(events.some((event) => event.type === 'diagnosis.failed'));
    const parentCampaign = database.updateCampaign(campaign.id, {
      currentParentVariantId: variant.id,
    });
    await assert.rejects(
      internal.requireCurrentParentDiagnosis(parentCampaign),
      /current parent diagnosis is failed.*explicit opt-out/,
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
        findingIds: [],
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
