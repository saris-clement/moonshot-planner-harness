import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import { AgentRunner } from '../src/agents.js';
import {
  CampaignOrchestrator,
  complianceBatchExhausted,
  targetExcludedControlHoldoutDirectory,
  targetExcludedComparisonDirectories,
  targetExcludedLiveStackDirectory,
  targetExcludedProtocolPlan,
  targetSafeJudgeOutput,
  withRuntimeQuestions,
} from '../src/orchestrator.js';
import { variantArtifactDirectory, type HarnessPaths } from '../src/paths.js';
import { resolveCampaignConfig } from '../src/config.js';
import { runtimeQuestionCacheKey } from '../src/runtimeAnswerLedger.js';
import { runCommand } from '../src/process.js';
import { PlannerClient, type PlannerQuestionRecord } from '../src/plannerClient.js';
import { canonicalHash, computeTargetExcludedGate } from '../src/metrics.js';
import { summarizeTargetExcludedComparisonReport } from '../src/targetExcludedComparison.js';
import { hypothesisComplianceResultPath } from '../src/hypothesisCompliance.js';
import {
  CampaignConfigSchema,
  TargetExcludedAnswerInputSchema,
  TargetExcludedConfigSchema,
  type Benchmark,
  type BenchmarkQuestionResolution,
  type CampaignRecord,
  type JudgeOutput,
  type Phase2RunSnapshot,
  type RunFacts,
  type TargetExcludedConfig,
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

function completedFacts(key = 'unit-a'): RunFacts {
  return {
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
    pins: { model: 'test-model' },
    units: [
      {
        id: key,
        key,
        ref: { entity: 'solution/main', anchor: key },
        kind: 'field',
        semantics: 'A field.',
        decision: 'build',
        confidence: 'high',
        rationale: 'No reusable source evidence.',
        selectedCandidateIds: [],
        sourceRefs: [],
        discoveredEvidenceCount: 0,
        shortlistCandidateCount: 0,
        uncoveredSemantics: ['field'],
      },
    ],
  };
}

function completedSnapshot(caseId: string, runId: string): Phase2RunSnapshot {
  return {
    caseId,
    runId,
    status: 'completed',
    stage: 'completed',
    progress: { completedUnits: 1, totalUnits: 1 },
    decisions: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
    questions: [],
    completedAt: '2026-09-06T00:00:00.000Z',
    elapsedMs: 1,
    usage: completedFacts().usage,
    updatedAt: '2026-09-06T00:00:00.000Z',
  };
}

function resolution(benchmark: string, resolvedArtifactSha: string): BenchmarkQuestionResolution {
  return {
    derivationVersion: 2,
    benchmark,
    originalArtifactSha: `sha256:${'d'.repeat(64)}`,
    resolvedArtifactSha,
    blockingQuestions: 0,
    requirementsAgentRequests: 0,
    requirementsAgentAnswers: 0,
    sourceFallbackAnswers: 0,
    reusedAnswers: 0,
    plannerQuestions: 0,
    plannerRequirementsAgentRequests: 0,
    plannerRequirementsAgentAnswers: 0,
    plannerSourceFallbackAnswers: 0,
    plannerReusedAnswers: 0,
    plannerHumanAnswers: 0,
    entries: [],
  };
}

function validComparisonReport(
  normalCaseId: string,
  excludedCaseId: string,
  normalRunId: string,
  excludedRunId: string,
): Record<string, unknown> {
  const report = {
    kind: 'ainative-planner/evidence-visibility-comparison',
    schemaVersion: 1,
    inputs: { normalCaseId, excludedCaseId },
    arms: {
      normal: { analysis: { runId: normalRunId } },
      excluded: { analysis: { runId: excludedRunId } },
    },
    validity: {
      valid: true,
      arms: {
        normal: { valid: true, errors: [] },
        excluded: { valid: true, errors: [] },
      },
      pair: { valid: true, mismatches: [] },
    },
    leakage: { detected: false, count: 0, paths: [] },
  };
  return { ...report, hash: canonicalHash(report) };
}

function imageInspectCommand(imageId: string): typeof runCommand {
  return async (command, args) => ({
    command,
    args: [...args],
    exitCode: 0,
    stdout: `${imageId}\n`,
    stderr: '',
    durationMs: 0,
  });
}

async function v2LifecycleFixture(id: string, investigator = false): Promise<{
  root: string;
  paths: HarnessPaths;
  database: HarnessDatabase;
  campaign: CampaignRecord;
  variant: VariantRecord;
  targetConfig: TargetExcludedConfig;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `planner-eval-${id}-`));
  const data = path.join(root, 'data');
  const campaignRoot = path.join(data, 'campaigns', id);
  const artifactRoot = path.join(data, 'artifacts', id, `${id}-v000`);
  await Promise.all([
    mkdir(data, { recursive: true }),
    mkdir(path.join(campaignRoot, 'resolved-packs'), { recursive: true }),
    mkdir(path.join(artifactRoot, 'primary'), { recursive: true }),
    mkdir(path.join(artifactRoot, 'holdout'), { recursive: true }),
  ]);
  const paths: HarnessPaths = {
    root: data,
    database: path.join(data, 'harness.sqlite'),
    campaigns: path.join(data, 'campaigns'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    reports: path.join(root, 'reports'),
  };
  const database = new HarnessDatabase(paths.database);
  const resolvedBytes = Buffer.from('canonical resolved primary');
  const resolvedArtifactSha = `sha256:${createHash('sha256').update(resolvedBytes).digest('hex')}`;
  const config = CampaignConfigSchema.parse({
    id,
    goal: 'Exercise target-excluded V2 baseline lifecycle recovery boundaries.',
    plannerRepo: root,
    workflowsRepo: root,
    environmentFile: path.join(root, 'environment.env'),
    seedRevision: 'seed',
    workflowsRevision: 'workflows',
    evaluation: { replicates: 2, replicateConcurrency: 2 },
    ...(investigator ? { investigator: { enabled: true } } : {}),
    targetExcluded: {
      protocol: 'standard-primary-v2',
      targetImplementationWorkflow: 'trumark/deceased-accounts',
    },
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath: path.join(campaignRoot, 'packs/primary.zip') },
      { name: 'holdout', role: 'holdout', zipPath: path.join(campaignRoot, 'packs/holdout.zip') },
    ],
  });
  const campaign = database.createCampaign(
    config,
    'a'.repeat(40),
    'b'.repeat(40),
    `sha256:${'c'.repeat(64)}`,
    'https://github.com/Saris-AI/workflows.git',
  );
  const created = database.createVariant({
    id: `${id}-v000`,
    campaignId: id,
    parentVariantId: null,
    round: 0,
    ordinal: 0,
    hypothesis: baselineHypothesisForTest,
  });
  const facts = completedFacts();
  const variant = database.updateVariant(created.id, {
    status: 'review',
    worktreePath: root,
    imageTag: `planner-test:${id}`,
    artifactCollectionComplete: true,
    facts,
    replicateFacts: [facts, facts],
    holdoutFacts: { holdout: facts },
    holdoutReplicateFacts: { holdout: [facts, facts] },
    questionResolutions: {
      primary: resolution('primary', resolvedArtifactSha),
      holdout: resolution('holdout', `sha256:${'d'.repeat(64)}`),
    },
    executionState: {
      executions: [1, 2].map((replicate) => ({
        benchmark: 'primary',
        role: 'primary' as const,
        replicate,
        replicateCount: 2,
        ...completedSnapshot(`normal-case-${replicate}`, `normal-run-${replicate}`),
      })),
    },
  });
  await Promise.all([
    writeFile(path.join(campaignRoot, 'resolved-packs/primary.zip'), resolvedBytes),
    ...['primary', 'holdout'].flatMap((benchmark) => [
      writeFile(path.join(artifactRoot, benchmark, 'facts.json'), `${JSON.stringify(facts)}\n`),
      writeFile(
        path.join(artifactRoot, benchmark, 'replicates.json'),
        `${JSON.stringify([facts, facts])}\n`,
      ),
    ]),
  ]);
  const targetConfig = TargetExcludedConfigSchema.parse({
    protocol: 'standard-primary-v2',
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: variant.id,
    comparatorImage: `sha256:${'f'.repeat(64)}`,
    configuredAt: '2026-09-06T00:00:00.000Z',
    normalArmSource: 'standard_primary',
    primaryResolvedArtifactSha: resolvedArtifactSha,
  });
  return { root, paths, database, campaign, variant, targetConfig };
}

type ScoringInternals = {
  judgeBenchmark: (
    campaign: CampaignRecord, variant: VariantRecord, benchmark: Benchmark, facts: RunFacts,
    workflowsSource: string, directory: string, replicates?: readonly RunFacts[] | null,
  ) => Promise<{ judgment: JudgeOutput; score: NonNullable<VariantRecord['score']> }>;
  judgeTargetExcluded: (
    campaign: CampaignRecord, variant: VariantRecord, benchmark: Benchmark, facts: RunFacts,
    config: TargetExcludedConfig, directory: string, replicates?: readonly RunFacts[] | null,
  ) => Promise<{ judgment: JudgeOutput; score: NonNullable<VariantRecord['score']> }>;
  ensureTargetExcludedWorkflowsSource: () => Promise<string>;
  ensureFrozenWorkflowsSource: () => Promise<string>;
  recoverEvaluation: (campaign: CampaignRecord, variant: VariantRecord) => Promise<VariantRecord>;
  runDiagnosis: () => Promise<void>;
  refreshReports: () => Promise<void>;
};

function scoringJudgment(expectedDecision: 'build' | 'reuse'): JudgeOutput {
  return {
    summary: 'Unverified fixture reference',
    verdicts: [{
      unitKey: 'unit-a', expectedDecision, classification: 'uncertain', confidence: 'medium',
      rationale: 'Fixture expectation', evidence: ['fixture evidence'],
    }],
  };
}

test('investigator judging scores raw replicates with stable labels and archives the score basis', async (t) => {
  const fixture = await v2LifecycleFixture('investigator-score-basis', true);
  try {
    const { database, campaign, variant, paths } = fixture;
    const source = path.join(fixture.root, 'source');
    campaign.workflowsSha = await gitFixture(source);
    const first = completedFacts();
    first.pins = { inputSetHash: 'same-input', decisionSetHash: 'answer-a' };
    const second = structuredClone(first);
    second.units[0]!.decision = 'reuse';
    second.decisions = { build: 0, reuse: 1, extend: 0, defer: 0, question: 0 };
    second.pins.decisionSetHash = 'answer-b';
    database.upsertLabel({
      campaignId: campaign.id, benchmark: 'primary', unitKey: 'unit-a', expectedDecision: 'reuse',
      status: 'suggested', classification: 'uncertain', rationale: 'Persisted reference',
    });
    t.mock.method(AgentRunner.prototype, 'judge', async () => scoringJudgment('build'));
    const internal = new CampaignOrchestrator(paths, database) as unknown as ScoringInternals;
    const directory = path.join(paths.artifacts, campaign.id, variant.id, 'primary');
    const result = await internal.judgeBenchmark(
      campaign, variant, campaign.config.benchmarks[0]!, first, source, directory, [first, second],
    );
    assert.deepEqual(result.score.provisional, { labeled: 1, correct: 0.5, errors: 0.5, accuracy: 0.5 });
    assert.equal(result.judgment.verdicts[0]!.expectedDecision, 'build');
    const basis = JSON.parse(await readFile(path.join(directory, 'score-basis.json'), 'utf8'));
    assert.equal(basis.schemaVersion, 1);
    assert.equal(basis.metricMode, 'replicate-mean');
    assert.equal(basis.labelHash, canonicalHash(database.listLabels(campaign.id, 'primary')));
    assert.deepEqual(basis.score, result.score);
    assert.equal(basis.replicateCount, 2);
    const comparison = JSON.parse(await readFile(path.join(directory, 'cohort-comparison.json'), 'utf8'));
    assert.equal(comparison.decisionSetHashVariation, true);
    assert.match(comparison.notes.join(' '), /not globally frozen/);
    assert.match(comparison.notes.join(' '), /hashes vary/i);

    second.units[0]!.semantics = 'Drift within replicates';
    const baselineFacts = structuredClone(first);
    baselineFacts.pins.inputSetHash = 'other-input';
    database.updateVariant(variant.id, { facts: baselineFacts });
    const candidate = { ...variant, id: `${campaign.id}-v001`, round: 1 };
    const drifted = await internal.judgeBenchmark(
      campaign, candidate, campaign.config.benchmarks[0]!, first, source, directory, [first, second],
    );
    assert.deepEqual(new Set(drifted.score.cohortMismatches), new Set(['requirement units', 'analysis pins']));

    const legacy = { ...campaign, config: { ...campaign.config, investigator: { ...campaign.config.investigator!, enabled: false } } };
    const oldScore = await internal.judgeBenchmark(
      legacy, variant, campaign.config.benchmarks[0]!, first, source, directory,
    );
    assert.equal(oldScore.score.provisional.accuracy, 0);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'score-basis.json'), 'utf8')).metricMode, 'consensus');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('investigator excluded scoring freezes the baseline judgment rather than the candidate oracle', async (t) => {
  const fixture = await v2LifecycleFixture('investigator-excluded-reference', true);
  try {
    const { database, campaign, variant, paths, targetConfig } = fixture;
    const facts = completedFacts();
    const second = structuredClone(facts);
    second.units[0]!.decision = 'reuse';
    second.decisions = { build: 0, reuse: 1, extend: 0, defer: 0, question: 0 };
    const baselineJudgment = scoringJudgment('reuse');
    database.createTargetExcludedConfig(campaign.id, targetConfig);
    database.createTargetExcludedEvaluation(campaign.id, variant.id);
    database.updateTargetExcludedEvaluation(variant.id, {
      excludedFacts: facts, excludedReplicateFacts: [facts, facts], judgment: baselineJudgment,
    });
    const candidate = { ...variant, id: `${campaign.id}-v001`, round: 1 };
    const internal = new CampaignOrchestrator(paths, database) as unknown as ScoringInternals;
    internal.ensureTargetExcludedWorkflowsSource = async () => fixture.root;
    const judge = t.mock.method(AgentRunner.prototype, 'judge', async () => scoringJudgment('build'));
    const directory = path.join(paths.artifacts, campaign.id, variant.id, 'primary');
    const result = await internal.judgeTargetExcluded(
      campaign, candidate, campaign.config.benchmarks[0]!, facts, targetConfig, directory, [facts, second],
    );
    assert.equal(result.judgment.verdicts[0]!.expectedDecision, 'build');
    assert.equal(result.score.provisional.accuracy, 0.5);
    const basis = JSON.parse(await readFile(path.join(directory, 'score-basis.json'), 'utf8'));
    assert.equal(basis.referenceJudgmentVariantId, variant.id);
    assert.equal(basis.referenceJudgmentHash, canonicalHash(baselineJudgment));
    assert.deepEqual(basis.referenceJudgment, baselineJudgment);
    judge.mock.mockImplementation(async () => scoringJudgment('reuse'));
    const changedOracle = await internal.judgeTargetExcluded(
      campaign, candidate, campaign.config.benchmarks[0]!, facts, targetConfig, directory, [facts, second],
    );
    assert.deepEqual(changedOracle.score, result.score);

    database.updateTargetExcludedEvaluation(variant.id, { judgment: null });
    await assert.rejects(
      internal.judgeTargetExcluded(campaign, candidate, campaign.config.benchmarks[0]!, facts, targetConfig, directory, [facts, second]),
      /baseline.*judgment/i,
    );
    const baseline = await internal.judgeTargetExcluded(
      campaign, variant, campaign.config.benchmarks[0]!, facts, targetConfig, directory, [facts, second],
    );
    assert.equal(baseline.score.provisional.accuracy, 0.5);

    const legacy = { ...campaign, config: { ...campaign.config, investigator: { ...campaign.config.investigator!, enabled: false } } };
    judge.mock.mockImplementation(async () => scoringJudgment('build'));
    const legacyResult = await internal.judgeTargetExcluded(
      legacy, candidate, campaign.config.benchmarks[0]!, facts, targetConfig, directory,
    );
    assert.equal(legacyResult.score.provisional.accuracy, 1);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('investigator judging fails closed on missing or incomplete raw replicate arrays before invoking agents', async (t) => {
  const fixture = await v2LifecycleFixture('investigator-missing-replicates', true);
  try {
    const internal = new CampaignOrchestrator(fixture.paths, fixture.database) as unknown as ScoringInternals;
    const judge = t.mock.method(AgentRunner.prototype, 'judge', async () => { throw new Error('agent must not run'); });
    const { campaign, variant, targetConfig } = fixture;
    const facts = completedFacts();
    for (const replicates of [undefined, null, [], [facts]]) {
      await assert.rejects(
        internal.judgeBenchmark(campaign, variant, campaign.config.benchmarks[0]!, facts, fixture.root, fixture.root, replicates),
        /raw replicate facts/i,
      );
      await assert.rejects(
        internal.judgeTargetExcluded(campaign, variant, campaign.config.benchmarks[0]!, facts, targetConfig, fixture.root, replicates),
        /raw replicate facts/i,
      );
    }
    assert.equal(judge.mock.callCount(), 0);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('investigator recovery forwards archived primary and holdout replicate arrays to judging', async (t) => {
  const fixture = await v2LifecycleFixture('investigator-recovery-replicates', true);
  try {
    const internal = new CampaignOrchestrator(fixture.paths, fixture.database) as unknown as ScoringInternals;
    internal.ensureFrozenWorkflowsSource = async () => fixture.root;
    internal.runDiagnosis = async () => undefined;
    const judgeBenchmark = internal.judgeBenchmark.bind(internal);
    const observed: string[] = [];
    internal.judgeBenchmark = async (_campaign, _variant, benchmark, facts, _source, _directory, replicates) => {
      assert.deepEqual(replicates, [facts, facts]);
      observed.push(benchmark.name);
      return { judgment: scoringJudgment('build'), score: {
        cohortMismatches: [], verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
        provisional: { labeled: 1, correct: 1, errors: 0, accuracy: 1 },
        decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
      } };
    };
    const recovered = await internal.recoverEvaluation(fixture.campaign, fixture.variant);
    assert.equal(recovered.status, 'review', recovered.error ?? undefined);
    assert.deepEqual(observed, ['primary', 'holdout']);
    internal.judgeBenchmark = judgeBenchmark;
    const judge = t.mock.method(AgentRunner.prototype, 'judge', async () => { throw new Error('agent must not run'); });
    await writeFile(path.join(fixture.paths.artifacts, fixture.campaign.id, fixture.variant.id, 'primary/replicates.json'), 'null');
    const failed = await internal.recoverEvaluation(fixture.campaign, recovered);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /raw replicate facts/i);
    assert.equal(judge.mock.callCount(), 0);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('investigator verified-label rescores use raw facts and retain mismatch evidence', async () => {
  const fixture = await v2LifecycleFixture('investigator-label-rescore', true);
  try {
    const { database, campaign, variant } = fixture;
    const first = completedFacts();
    const second = structuredClone(first);
    second.units[0]!.decision = 'reuse';
    second.units[0]!.semantics = 'Replicate drift';
    const score = {
      cohortMismatches: ['analysis pins'], verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
      provisional: { labeled: 1, correct: 1, errors: 0, accuracy: 1 },
      decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
    };
    database.updateVariant(variant.id, {
      replicateFacts: [first, second], judgment: scoringJudgment('build'), score,
      holdoutReplicateFacts: { holdout: [first, second] },
      holdoutJudgments: { holdout: scoringJudgment('build') }, holdoutScores: { holdout: score },
    });
    const orchestrator = new CampaignOrchestrator(fixture.paths, database);
    (orchestrator as unknown as ScoringInternals).refreshReports = async () => undefined;
    for (const benchmark of ['primary', 'holdout']) {
      await orchestrator.saveVerifiedLabel({
        campaignId: campaign.id, benchmark, unitKey: 'unit-a', expectedDecision: 'reuse',
        classification: 'uncertain', rationale: 'Human reference',
      });
      const saved = database.getVariant(variant.id);
      const rescored = benchmark === 'primary' ? saved.score! : saved.holdoutScores!.holdout!;
      assert.equal(rescored.verified.accuracy, 0.5);
      assert.deepEqual(new Set(rescored.cohortMismatches), new Set(['analysis pins', 'requirement units']));
    }
    database.updateVariant(variant.id, { replicateFacts: null, holdoutReplicateFacts: null });
    for (const benchmark of ['primary', 'holdout']) {
      await assert.rejects(orchestrator.saveVerifiedLabel({
        campaignId: campaign.id, benchmark, unitKey: 'unit-a', expectedDecision: 'build',
        classification: 'uncertain', rationale: 'Cannot rescore without raw facts',
      }), /raw replicate facts/i);
      assert.equal(database.listLabels(campaign.id, benchmark)[0]!.expectedDecision, 'reuse');
    }
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('investigator excluded label rescores retain the baseline oracle and fail closed without raw facts', async () => {
  const fixture = await v2LifecycleFixture('investigator-excluded-rescore', true);
  try {
    const { database, campaign, variant, targetConfig } = fixture;
    const facts = completedFacts();
    database.createTargetExcludedConfig(campaign.id, targetConfig);
    database.createTargetExcludedEvaluation(campaign.id, variant.id);
    database.updateTargetExcludedEvaluation(variant.id, {
      excludedFacts: facts, excludedReplicateFacts: [facts, facts], judgment: scoringJudgment('reuse'),
    });
    const candidate = database.createVariant({
      id: `${campaign.id}-v001`, campaignId: campaign.id, parentVariantId: variant.id,
      round: 1, ordinal: 1, hypothesis: baselineHypothesisForTest,
    });
    database.createTargetExcludedEvaluation(campaign.id, candidate.id);
    database.updateTargetExcludedEvaluation(candidate.id, {
      excludedFacts: facts, excludedReplicateFacts: [facts, facts], judgment: scoringJudgment('build'),
    });
    const orchestrator = new CampaignOrchestrator(fixture.paths, database);
    (orchestrator as unknown as ScoringInternals).refreshReports = async () => undefined;
    await orchestrator.saveTargetExcludedVerifiedLabel({
      campaignId: campaign.id, unitKey: 'other-unit', expectedDecision: 'build',
      classification: 'uncertain', rationale: 'Independent human reference',
    });
    assert.equal(database.getTargetExcludedEvaluation(candidate.id)!.score!.provisional.accuracy, 0);
    assert.equal(database.getTargetExcludedEvaluation(candidate.id)!.score!.verified.errors, 1);
    await orchestrator.saveTargetExcludedVerifiedLabel({
      campaignId: campaign.id, unitKey: 'unit-a', expectedDecision: 'build',
      classification: 'uncertain', rationale: 'Verified labels override baseline judge suggestions',
    });
    assert.equal(database.getTargetExcludedEvaluation(candidate.id)!.score!.verified.correct, 1);
    database.updateTargetExcludedEvaluation(candidate.id, { excludedReplicateFacts: null });
    await assert.rejects(orchestrator.saveTargetExcludedVerifiedLabel({
      campaignId: campaign.id, unitKey: 'unit-a', expectedDecision: 'reuse',
      classification: 'uncertain', rationale: 'Cannot rescore without raw facts',
    }), /raw replicate facts/i);
    assert.equal(database.listTargetExcludedLabels(campaign.id).find(({ unitKey }) => unitKey === 'unit-a')!.expectedDecision, 'build');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function targetSnapshotFixture(id: string): Promise<{
  fixture: Awaited<ReturnType<typeof v2LifecycleFixture>>;
  sourceRoot: string;
  destination: string;
  manifestPath: string;
  ensure: () => Promise<string>;
}> {
  const fixture = await v2LifecycleFixture(id);
  const sourceRoot = path.join(fixture.root, 'frozen-workflows');
  await mkdir(path.join(sourceRoot, 'src/customers/trumark/deceased-accounts'), {
    recursive: true,
  });
  await Promise.all([
    writeFile(path.join(sourceRoot, 'README.md'), 'shared source\n'),
    writeFile(
      path.join(sourceRoot, 'src/customers/trumark/deceased-accounts/index.ts'),
      'export const target = true;\n',
    ),
  ]);
  const internal = new CampaignOrchestrator(
    fixture.paths,
    fixture.database,
  ) as unknown as {
    ensureFrozenWorkflowsSource: () => Promise<string>;
    ensureTargetExcludedWorkflowsSource: (
      campaign: CampaignRecord,
      targetWorkflow: string,
    ) => Promise<string>;
  };
  internal.ensureFrozenWorkflowsSource = async () => sourceRoot;
  return {
    fixture,
    sourceRoot,
    destination: path.join(
      fixture.paths.worktrees,
      fixture.campaign.id,
      'target-excluded-workflows',
    ),
    manifestPath: path.join(
      fixture.paths.campaigns,
      fixture.campaign.id,
      'target-excluded-source-manifest.json',
    ),
    ensure: async () =>
      await internal.ensureTargetExcludedWorkflowsSource(
        fixture.campaign,
        fixture.targetConfig.targetImplementationWorkflow,
      ),
  };
}

async function legacyTargetSnapshotFixture(id: string): Promise<{
  root: string;
  paths: HarnessPaths;
  database: HarnessDatabase;
  campaign: CampaignRecord;
  targetConfig: TargetExcludedConfig;
  destination: string;
  manifestPath: string;
  ensure: () => Promise<string>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `planner-eval-${id}-`));
  const data = path.join(root, 'data');
  const campaignRoot = path.join(data, 'campaigns', id);
  const sourceRoot = path.join(root, 'frozen-workflows');
  await Promise.all([
    mkdir(campaignRoot, { recursive: true }),
    mkdir(path.join(sourceRoot, 'src/customers/trumark/deceased-accounts'), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(path.join(sourceRoot, 'README.md'), 'shared source\n'),
    writeFile(
      path.join(sourceRoot, 'src/customers/trumark/deceased-accounts/index.ts'),
      'export const target = true;\n',
    ),
  ]);
  const paths: HarnessPaths = {
    root: data,
    database: path.join(data, 'harness.sqlite'),
    campaigns: path.join(data, 'campaigns'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    reports: path.join(root, 'reports'),
  };
  const database = new HarnessDatabase(paths.database);
  const config = CampaignConfigSchema.parse({
    id,
    goal: 'Verify legacy target-excluded source policy compatibility.',
    plannerRepo: root,
    workflowsRepo: root,
    environmentFile: path.join(root, 'environment.env'),
    seedRevision: 'seed',
    workflowsRevision: 'workflows',
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath: path.join(root, 'primary.zip') },
      { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
    ],
  });
  const campaign = database.createCampaign(
    config,
    'a'.repeat(40),
    'b'.repeat(40),
    `sha256:${'c'.repeat(64)}`,
    'https://github.com/Saris-AI/workflows.git',
  );
  const targetConfig = database.createTargetExcludedConfig(campaign.id, {
    protocol: 'dedicated-control-v1',
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: `${id}-v000`,
    comparatorImage: `sha256:${'f'.repeat(64)}`,
    configuredAt: '2026-09-06T00:00:00.000Z',
  });
  const internal = new CampaignOrchestrator(paths, database) as unknown as {
    ensureFrozenWorkflowsSource: () => Promise<string>;
    ensureTargetExcludedWorkflowsSource: (
      campaign: CampaignRecord,
      targetWorkflow: string,
    ) => Promise<string>;
  };
  internal.ensureFrozenWorkflowsSource = async () => sourceRoot;
  const destination = path.join(paths.worktrees, campaign.id, 'target-excluded-workflows');
  const manifestPath = path.join(campaignRoot, 'target-excluded-source-manifest.json');
  return {
    root,
    paths,
    database,
    campaign,
    targetConfig,
    destination,
    manifestPath,
    ensure: async () =>
      await internal.ensureTargetExcludedWorkflowsSource(
        campaign,
        'trumark/deceased-accounts',
      ),
  };
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
  const research = path.join(root, 'investigation.md');
  await Promise.all([
    writeFile(environmentFile, 'OPENAI_MODEL=gpt-5.6-sol\n'),
    writeFile(primary, 'primary bytes'),
    writeFile(holdout, 'holdout bytes'),
    writeFile(research, '# Prior investigation\n\nHistorical hypothesis only.\n'),
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
      researchPaths: [research],
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
    const defaults = await resolveCampaignConfig({ ...campaign.config, investigator: { enabled: true } });
    assert.equal(defaults.config.investigator?.primaryReplicates, 2);
    assert.equal(defaults.config.investigator?.maxWallTimeMs, 14_400_000);
    assert.equal(defaults.config.evaluation.replicateConcurrency, 2);
    const custom = await resolveCampaignConfig({ ...campaign.config, investigator: {
      enabled: true, primaryReplicates: 1, maxWallTimeMs: 3_600_000,
    } });
    assert.equal(custom.config.investigator?.primaryReplicates, 1);
    assert.equal(custom.config.investigator?.maxWallTimeMs, 3_600_000);
    const historical = database.createCampaign({ ...defaults.config, id: 'historical-limits', investigator: {
      ...defaults.config.investigator!, primaryReplicates: undefined, maxWallTimeMs: 7_200_000,
    } }, seedSha, workflowsSha, campaign.environmentSha, campaign.workflowsRemoteUrl);
    assert.equal(database.getCampaign(historical.id).config.investigator?.primaryReplicates, undefined);
    assert.equal(database.getCampaign(historical.id).config.investigator?.maxWallTimeMs, 7_200_000);
    assert.equal(campaign.config.environmentFile, path.join(data, 'campaigns/freeze-test/environment.env'));
    assert.match(
      await readFile(campaign.config.environmentFile, 'utf8'),
      /PLANNER_ANALYSIS_TIMEOUT_MS=43200000/,
    );
    assert.match(
      await readFile(campaign.config.environmentFile, 'utf8'),
      /PLANNER_ANALYSIS_MAX_COST_USD=2000/,
    );
    assert.equal(
      await readFile(campaign.config.benchmarks[0]!.zipPath, 'utf8'),
      'primary bytes',
    );
    assert.deepEqual(campaign.config.researchPaths, [
      path.join(data, 'campaigns/freeze-test/research/001-investigation.md'),
    ]);
    assert.deepEqual(campaign.config.researchSha256, [
      `sha256:${createHash('sha256')
        .update('# Prior investigation\n\nHistorical hypothesis only.\n')
        .digest('hex')}`,
    ]);
    assert.equal(
      await readFile(campaign.config.researchPaths[0]!, 'utf8'),
      '# Prior investigation\n\nHistorical hypothesis only.\n',
    );
    const researchManifest = JSON.parse(
      await readFile(path.join(data, 'campaigns/freeze-test/research/manifest.json'), 'utf8'),
    ) as {
      kind: string;
      materials: Array<{ path: string; sha256: string; bytes: number }>;
    };
    assert.equal(researchManifest.kind, 'ainative-planner-eval/frozen-research-manifest');
    assert.deepEqual(researchManifest.materials, [
      {
        name: 'investigation.md',
        path: '001-investigation.md',
        sha256: `sha256:${createHash('sha256')
          .update('# Prior investigation\n\nHistorical hypothesis only.\n')
          .digest('hex')}`,
        bytes: Buffer.byteLength('# Prior investigation\n\nHistorical hypothesis only.\n'),
      },
    ]);
    await writeFile(primary, 'mutated');
    await writeFile(research, 'mutated research');
    assert.equal(
      await readFile(campaign.config.benchmarks[0]!.zipPath, 'utf8'),
      'primary bytes',
    );
    assert.equal(
      await readFile(campaign.config.researchPaths[0]!, 'utf8'),
      '# Prior investigation\n\nHistorical hypothesis only.\n',
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('campaign initialization rejects research mutation after configuration resolution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-research-race-'));
  const plannerRepo = path.join(root, 'planner');
  const workflowsRepo = path.join(root, 'workflows');
  const [seedSha, workflowsSha] = await Promise.all([
    gitFixture(plannerRepo),
    gitFixture(workflowsRepo, true),
  ]);
  const environmentFile = path.join(root, 'planner.env');
  const primary = path.join(root, 'primary.zip');
  const holdout = path.join(root, 'holdout.zip');
  const research = path.join(root, 'research.md');
  await Promise.all([
    writeFile(environmentFile, ''),
    writeFile(primary, 'primary bytes'),
    writeFile(holdout, 'holdout bytes'),
    writeFile(research, 'original research bytes'),
  ]);
  const resolved = await resolveCampaignConfig({
    id: 'research-race-test',
    goal: 'Reject mutable research bytes after campaign configuration resolution.',
    plannerRepo,
    workflowsRepo,
    environmentFile,
    seedRevision: seedSha,
    workflowsRevision: workflowsSha,
    researchPaths: [research],
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath: primary },
      { name: 'holdout', role: 'holdout', zipPath: holdout },
    ],
  });
  await writeFile(research, 'mutated research bytes');
  const data = path.join(root, 'data');
  await mkdir(data);
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
    const internal = new CampaignOrchestrator(paths, database) as unknown as {
      initializeResolved: (input: typeof resolved) => Promise<CampaignRecord>;
    };
    await assert.rejects(
      internal.initializeResolved(resolved),
      /research input SHA mismatch during frozen copy/,
    );
    assert.deepEqual(database.listCampaigns(), []);
    assert.equal(await stat(path.join(paths.campaigns, resolved.config.id)).catch(() => null), null);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('campaign initialization rejects benchmark mutation before creating campaign state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-init-race-'));
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
    writeFile(environmentFile, ''),
    writeFile(primary, 'resolved primary bytes'),
    writeFile(holdout, 'resolved holdout bytes'),
  ]);
  const resolved = await resolveCampaignConfig({
    id: 'init-race-test',
    goal: 'Reject mutable benchmark bytes after campaign configuration resolution.',
    plannerRepo,
    workflowsRepo,
    environmentFile,
    seedRevision: seedSha,
    workflowsRevision: workflowsSha,
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath: primary },
      { name: 'holdout', role: 'holdout', zipPath: holdout },
    ],
  });
  await writeFile(primary, 'mutated after resolution');
  const data = path.join(root, 'data');
  await mkdir(data);
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
    const internal = new CampaignOrchestrator(paths, database) as unknown as {
      initializeResolved: (input: typeof resolved) => Promise<CampaignRecord>;
    };
    await assert.rejects(
      internal.initializeResolved(resolved),
      /primary SHA mismatch during frozen copy/,
    );
    assert.deepEqual(database.listCampaigns(), []);
    assert.equal(
      await stat(path.join(paths.campaigns, resolved.config.id)).catch(() => null),
      null,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 campaign initialization checks the target index at the pinned workflows commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-target-pin-'));
  const plannerRepo = path.join(root, 'planner');
  const workflowsRepo = path.join(root, 'workflows');
  const targetIndex = path.join(
    workflowsRepo,
    'src/customers/trumark/deceased-accounts/index.ts',
  );
  const [seedSha, workflowsSha] = await Promise.all([
    gitFixture(plannerRepo),
    gitFixture(workflowsRepo, true),
  ]);
  const environmentFile = path.join(root, 'planner.env');
  const primary = path.join(root, 'primary.zip');
  const holdout = path.join(root, 'holdout.zip');
  const data = path.join(root, 'data');
  await Promise.all([
    mkdir(path.dirname(targetIndex), { recursive: true }),
    mkdir(data),
    writeFile(environmentFile, ''),
    writeFile(primary, 'primary bytes'),
    writeFile(holdout, 'holdout bytes'),
  ]);
  await writeFile(targetIndex, 'export const workingTreeOnly = true;\n');
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
    await assert.rejects(
      new CampaignOrchestrator(paths, database).initializeFromInput({
        id: 'target-pin-test',
        goal: 'Reject a target that is visible only in mutable working tree bytes.',
        plannerRepo,
        workflowsRepo,
        environmentFile,
        seedRevision: seedSha,
        workflowsRevision: workflowsSha,
        evaluation: { replicates: 2, replicateConcurrency: 2 },
        targetExcluded: {
          protocol: 'standard-primary-v2',
          targetImplementationWorkflow: 'trumark/deceased-accounts',
        },
        benchmarks: [
          { name: 'primary', role: 'primary', zipPath: primary },
          { name: 'holdout', role: 'holdout', zipPath: holdout },
        ],
      }),
      /target implementation is not present at the pinned workflows revision/,
    );
    assert.deepEqual(database.listCampaigns(), []);
    assert.equal(await stat(path.join(paths.campaigns, 'target-pin-test')).catch(() => null), null);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 campaign initialization accepts a pinned target after its working-tree file is removed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-target-pin-present-'));
  const plannerRepo = path.join(root, 'planner');
  const workflowsRepo = path.join(root, 'workflows');
  const targetIndex = path.join(workflowsRepo, 'src/customers/trumark/deceased-accounts/index.ts');
  const seedSha = await gitFixture(plannerRepo);
  await gitFixture(workflowsRepo, true);
  await mkdir(path.dirname(targetIndex), { recursive: true });
  await writeFile(targetIndex, 'export const pinned = true;\n');
  await runCommand('git', ['add', '.'], { cwd: workflowsRepo });
  await runCommand(
    'git',
    [
      '-c',
      'user.name=Harness Test',
      '-c',
      'user.email=harness@example.invalid',
      'commit',
      '-m',
      'add target',
    ],
    { cwd: workflowsRepo },
  );
  const workflowsSha = (
    await runCommand('git', ['rev-parse', 'HEAD'], { cwd: workflowsRepo })
  ).stdout.trim();
  await rm(targetIndex);
  const environmentFile = path.join(root, 'planner.env');
  const primary = path.join(root, 'primary.zip');
  const holdout = path.join(root, 'holdout.zip');
  const data = path.join(root, 'data');
  await Promise.all([
    mkdir(data),
    writeFile(environmentFile, ''),
    writeFile(primary, 'primary bytes'),
    writeFile(holdout, 'holdout bytes'),
  ]);
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
    const campaign = await new CampaignOrchestrator(paths, database).initializeFromInput({
      id: 'target-pin-present',
      goal: 'Accept target identity frozen in the pinned workflows commit only.',
      plannerRepo,
      workflowsRepo,
      environmentFile,
      seedRevision: seedSha,
      workflowsRevision: workflowsSha,
      evaluation: { replicates: 2, replicateConcurrency: 2 },
      targetExcluded: {
        protocol: 'standard-primary-v2',
        targetImplementationWorkflow: 'trumark/deceased-accounts',
      },
      benchmarks: [
        { name: 'primary', role: 'primary', zipPath: primary },
        { name: 'holdout', role: 'holdout', zipPath: holdout },
      ],
    });
    assert.equal(campaign.workflowsSha, workflowsSha);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('target-excluded protocol planning preserves V1 paths and selects canonical standard V2 paths', () => {
  const v1 = TargetExcludedConfigSchema.parse({
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: 'campaign-v000',
    comparatorImage: `sha256:${'a'.repeat(64)}`,
    configuredAt: '2026-09-06T00:00:00.000Z',
  });
  assert.equal(v1.protocol, 'dedicated-control-v1');
  assert.deepEqual(
    targetExcludedComparisonDirectories('/artifacts/variant', 'primary', 2, v1.protocol),
    {
      normalArtifactDirectory: '/artifacts/variant/target-excluded/control/primary/replicate-2',
      excludedArtifactDirectory: '/artifacts/variant/target-excluded/excluded/primary/replicate-2',
    },
  );

  const campaign = {
    config: {
      targetExcluded: {
        protocol: 'standard-primary-v2' as const,
        targetImplementationWorkflow: 'trumark/deceased-accounts',
      },
    },
  } as CampaignRecord;
  const plan = targetExcludedProtocolPlan(campaign, null);
  assert.deepEqual(plan, {
    protocol: 'standard-primary-v2',
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    targetSafePrimary: true,
    integrated: true,
  });
  assert.deepEqual(
    targetExcludedComparisonDirectories('/artifacts/variant', 'primary', 2, plan!.protocol),
    {
      normalArtifactDirectory: '/artifacts/variant/primary/replicate-2',
      excludedArtifactDirectory: '/artifacts/variant/target-excluded/excluded/primary/replicate-2',
    },
  );
});

test('automatic replenishment accepts only fully exhausted semantic compliance batches', () => {
  const campaign = {
    config: { limits: { hypothesisComplianceRepairAttempts: 1 } },
  } as CampaignRecord;
  const variant = {
    status: 'failed',
    facts: null,
    hypothesisComplianceAttempts: [
      { outcome: 'semantic_failed' },
      { outcome: 'no_op' },
    ],
  } as VariantRecord;
  assert.equal(complianceBatchExhausted(campaign, [variant]), true);
  assert.equal(
    complianceBatchExhausted(campaign, [
      {
        ...variant,
        hypothesisComplianceAttempts: [
          { outcome: 'semantic_failed' },
          { outcome: 'operational_failed' },
        ],
      } as VariantRecord,
    ]),
    false,
  );
  assert.equal(
    complianceBatchExhausted(campaign, [
      { ...variant, hypothesisComplianceAttempts: [{ outcome: 'semantic_failed' }] } as VariantRecord,
    ]),
    false,
  );
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

test('hypothesis compliance preflight persists its patch-bound verdict and fails closed on rejection', async () => {
  const fixture = await v2LifecycleFixture('hypothesis-compliance-preflight');
  try {
    const artifactDirectory = path.join(fixture.root, 'compliance-artifacts');
    const treatmentPatchPath = path.join(artifactDirectory, 'mutation.patch');
    const patchPath = path.join(artifactDirectory, 'variant.patch');
    const mutationContextPath = path.join(artifactDirectory, 'mutation-context.json');
    const patch = 'diff --git a/server/src/policy.ts b/server/src/policy.ts\n+export const policy = true;\n';
    const mutationContext = '{"selectedFindings":[]}\n';
    await mkdir(artifactDirectory, { recursive: true });
    await Promise.all([
      writeFile(treatmentPatchPath, patch),
      writeFile(patchPath, patch),
      writeFile(mutationContextPath, mutationContext),
    ]);
    const patchSha256 = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
    const mutationContextSha256 = `sha256:${createHash('sha256')
      .update(mutationContext)
      .digest('hex')}`;
    const createCandidate = (suffix: string) =>
      fixture.database.createVariant({
        id: `${fixture.campaign.id}-${suffix}`,
        campaignId: fixture.campaign.id,
        parentVariantId: fixture.variant.id,
        round: 1,
        ordinal: Number.parseInt(suffix.slice(1), 10),
        hypothesis: {
          title: 'Bounded policy change',
          rationale: 'Exercise semantic compliance before expensive execution.',
          instructions: 'Change the runtime policy and add its falsification regression.',
          expectedImpact: 'Reject mutations that do not test their stated mechanism.',
          risk: 'The semantic reviewer remains model-generated.',
          findingIds: [],
          assumptions: ['The patch is the complete mutation.'],
        },
      });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      runHypothesisCompliance: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        worktree: string,
        artifactDirectory: string,
        mutationContextPath: string,
        treatmentPatchPath: string,
        cumulativePatchPath: string,
        expectedMutationContextSha256: string,
        expectedIndexTree: string,
        dependencies: {
          assess: (
            variant: VariantRecord,
            patchPath: string,
            mutationContextPath: string,
            artifactDirectory: string,
            contextDirectory: string,
          ) => Promise<{ result: Record<string, unknown>; resultPath: string }>;
          captureMutation: typeof import('../src/stack.js').captureMutationDiff;
          captureDiff: typeof import('../src/stack.js').captureAndGateDiff;
        },
      ) => Promise<VariantRecord>;
      verifyVariantHypothesisCompliance: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        allowLegacyParent?: boolean,
      ) => Promise<void>;
    };
    const captureDiff: typeof import('../src/stack.js').captureAndGateDiff = async () => ({
      patchPath,
      result: { changedFiles: ['server/src/policy.ts'], addedLines: 1, removedLines: 0, forbiddenAdditions: [] },
    });
    const captureMutation: typeof import('../src/stack.js').captureMutationDiff = async () => ({
      patchPath: treatmentPatchPath,
      patch,
      result: { changedFiles: ['server/src/policy.ts'], addedLines: 1, removedLines: 0 },
    });
    const assessment = async (variant: VariantRecord, status: 'passed' | 'failed') => {
      const result = {
        kind: 'ainative-planner-eval/hypothesis-compliance',
        schemaVersion: 2,
        interpretationStatus: 'unverified_model_judgment',
        variantId: variant.id,
        patchSha256,
        mutationContextSha256,
        status,
        summary: status === 'passed' ? 'The mutation is aligned.' : 'The mutation misses its test.',
        intervention: {
          status: 'satisfied',
          rationale: 'Runtime code changes the intended policy.',
          evidence: ['server/src/policy.ts:1'],
        },
        codeRegression: {
          status: 'satisfied',
          rationale: 'The patch covers its deterministic boundary.',
          evidence: ['server/test/policy.test.ts:1'],
        },
        falsificationTest: {
          status: status === 'passed' ? 'not_applicable' : 'not_satisfied',
          rationale: status === 'passed' ? 'No finding supplied a test.' : 'No regression was added.',
          evidence: ['mutation-context.json:selectedFindings'],
        },
        limitations: ['This is an unverified model judgment.'],
      };
      const resultPath = hypothesisComplianceResultPath(
        artifactDirectory,
        patchSha256,
        mutationContextSha256,
      );
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      return { result, resultPath };
    };

    const passing = createCandidate('v001');
    const persisted = await internal.runHypothesisCompliance(
      fixture.campaign,
      passing,
      fixture.root,
      artifactDirectory,
      mutationContextPath,
      treatmentPatchPath,
      patchPath,
      mutationContextSha256,
      'baseline-tree',
      {
        assess: async (variant) => await assessment(variant, 'passed'),
        captureMutation,
        captureDiff,
      },
    );
    assert.equal(persisted.hypothesisComplianceStatus, 'passed');
    assert.equal(persisted.hypothesisCompliance?.status, 'passed');
    assert.equal(persisted.hypothesisCompliancePatchHash, patchSha256);
    assert.equal(persisted.hypothesisComplianceCandidatePatchHash, patchSha256);
    assert.ok(persisted.hypothesisComplianceResultHash);
    const persistedWithPatch = fixture.database.updateVariant(persisted.id, {
      patchPath,
      patchHash: patchSha256,
    });
    const canonicalArtifacts = variantArtifactDirectory(
      fixture.paths,
      fixture.campaign.id,
      persisted.id,
    );
    const canonicalResultPath = hypothesisComplianceResultPath(
      canonicalArtifacts,
      patchSha256,
      mutationContextSha256,
    );
    await mkdir(path.dirname(canonicalResultPath), { recursive: true });
    await Promise.all([
      writeFile(path.join(canonicalArtifacts, 'mutation.patch'), patch),
      writeFile(path.join(canonicalArtifacts, 'mutation-context.json'), mutationContext),
      writeFile(
        canonicalResultPath,
        await readFile(
          hypothesisComplianceResultPath(
            artifactDirectory,
            patchSha256,
            mutationContextSha256,
          ),
        ),
      ),
    ]);
    await internal.verifyVariantHypothesisCompliance(fixture.campaign, persistedWithPatch);
    await writeFile(path.join(canonicalArtifacts, 'mutation.patch'), 'tampered treatment');
    await assert.rejects(
      internal.verifyVariantHypothesisCompliance(fixture.campaign, persistedWithPatch),
      /inputs are missing or stale/,
    );
    await writeFile(path.join(canonicalArtifacts, 'mutation.patch'), patch);
    await writeFile(canonicalResultPath, '{"tampered":true}\n');
    await assert.rejects(
      internal.verifyVariantHypothesisCompliance(fixture.campaign, persistedWithPatch),
      /result hash does not match/,
    );

    const failing = createCandidate('v002');
    await assert.rejects(
      internal.runHypothesisCompliance(
        fixture.campaign,
        failing,
        fixture.root,
        artifactDirectory,
        mutationContextPath,
        treatmentPatchPath,
        patchPath,
        mutationContextSha256,
        'baseline-tree',
        {
          assess: async (variant) => await assessment(variant, 'failed'),
          captureMutation,
          captureDiff,
        },
      ),
      /hypothesis compliance failed: The mutation misses its test/,
    );
    const rejected = fixture.database.getVariant(failing.id);
    assert.equal(rejected.hypothesisComplianceStatus, 'failed');
    assert.equal(rejected.hypothesisCompliance?.falsificationTest.status, 'not_satisfied');
    assert.equal(rejected.imageTag, null);
    assert.equal(rejected.facts, null);

    const tampered = createCandidate('v003');
    await writeFile(patchPath, patch);
    await assert.rejects(
      internal.runHypothesisCompliance(
        fixture.campaign,
        tampered,
        fixture.root,
        artifactDirectory,
        mutationContextPath,
        treatmentPatchPath,
        patchPath,
        mutationContextSha256,
        'baseline-tree',
        {
          assess: async (variant) => {
            const result = await assessment(variant, 'passed');
            await writeFile(patchPath, `${patch} reviewer mutation\n`);
            return result;
          },
          captureMutation,
          captureDiff,
        },
      ),
      /reviewer modified its immutable inputs/,
    );
    assert.equal(
      fixture.database.getVariant(tampered.id).hypothesisComplianceStatus,
      'failed',
    );

    const noOp = createCandidate('v004');
    const noOpPatchPath = path.join(artifactDirectory, 'empty-mutation.patch');
    await Promise.all([writeFile(noOpPatchPath, ''), writeFile(patchPath, patch)]);
    let assessedNoOp = false;
    await assert.rejects(
      internal.runHypothesisCompliance(
        fixture.campaign,
        noOp,
        fixture.root,
        artifactDirectory,
        mutationContextPath,
        noOpPatchPath,
        patchPath,
        mutationContextSha256,
        'baseline-tree',
        {
          assess: async (variant) => {
            assessedNoOp = true;
            return await assessment(variant, 'failed');
          },
          captureMutation,
          captureDiff,
        },
      ),
      /mutator produced no changes beyond the inherited parent/,
    );
    assert.equal(assessedNoOp, false);
    const noOpPersisted = fixture.database.getVariant(noOp.id);
    assert.equal(noOpPersisted.hypothesisComplianceStatus, 'failed');
    assert.match(noOpPersisted.hypothesisComplianceError ?? '', /no changes beyond/);
    assert.match(noOpPersisted.hypothesisCompliancePatchHash ?? '', /^sha256:/);

    const contextTampered = createCandidate('v005');
    await Promise.all([
      writeFile(treatmentPatchPath, patch),
      writeFile(patchPath, patch),
      writeFile(mutationContextPath, '{"selectedFindings":[{"id":"removed"}]}\n'),
    ]);
    let assessedTamperedContext = false;
    await assert.rejects(
      internal.runHypothesisCompliance(
        fixture.campaign,
        contextTampered,
        fixture.root,
        artifactDirectory,
        mutationContextPath,
        treatmentPatchPath,
        patchPath,
        mutationContextSha256,
        'baseline-tree',
        {
          assess: async (variant) => {
            assessedTamperedContext = true;
            return await assessment(variant, 'failed');
          },
          captureMutation,
          captureDiff,
        },
      ),
      /mutator modified the immutable mutation context/,
    );
    assert.equal(assessedTamperedContext, false);
    const legacyReviewed = fixture.database.updateVariant(createCandidate('v006').id, {
      status: 'review',
      hypothesisComplianceStatus: 'not_required',
    });
    await internal.verifyVariantHypothesisCompliance(
      fixture.campaign,
      legacyReviewed,
      true,
    );
    await assert.rejects(
      internal.verifyVariantHypothesisCompliance(fixture.campaign, legacyReviewed),
      /no completed hypothesis compliance preflight/,
    );
    const events = fixture.database.listEvents(fixture.campaign.id);
    assert.ok(events.some(({ type, variantId }) => type === 'hypothesis_compliance.passed' && variantId === passing.id));
    assert.ok(events.some(({ type, variantId }) => type === 'hypothesis_compliance.failed' && variantId === failing.id));
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('compliance loop repairs one semantic failure on the same variant and preserves both attempts', async () => {
  const fixture = await v2LifecycleFixture('hypothesis-compliance-repair-loop');
  try {
    const candidate = fixture.database.createVariant({
      id: 'hypothesis-compliance-repair-loop-v001',
      campaignId: fixture.campaign.id,
      parentVariantId: fixture.variant.id,
      round: 1,
      ordinal: 1,
      hypothesis: {
        title: 'Repairable policy',
        rationale: 'Exercise one bounded compliance repair.',
        instructions: 'Implement the complete runtime policy and regression.',
        expectedImpact: 'Pass after structured repair feedback.',
        risk: 'The repair may remain incomplete.',
        findingIds: [],
        assumptions: ['The failed review identifies a repairable semantic omission.'],
      },
    });
    const artifactDirectory = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      candidate.id,
    );
    const contextPath = path.join(artifactDirectory, 'mutation-context.json');
    const context = '{"selectedFindings":[]}\n';
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(contextPath, context);
    const contextSha256 = `sha256:${createHash('sha256').update(context).digest('hex')}`;
    let treatment = 'initial treatment';
    let reviewCalls = 0;
    let repairCalls = 0;
    let passingReviewCall = 2;
    let expectedCandidateId = candidate.id;
    const captureMutation: typeof import('../src/stack.js').captureMutationDiff = async (
      _campaign,
      _variant,
      _worktree,
      directory,
    ) => {
      const patchPath = path.join(directory, 'mutation.patch');
      await writeFile(patchPath, treatment);
      return {
        patchPath,
        patch: treatment,
        result: { changedFiles: ['server/src/policy.ts'], addedLines: 1, removedLines: 0 },
      };
    };
    const captureDiff: typeof import('../src/stack.js').captureAndGateDiff = async (
      _campaign,
      _variant,
      _worktree,
      directory,
    ) => {
      const patchPath = path.join(directory, 'variant.patch');
      await writeFile(patchPath, treatment);
      return {
        patchPath,
        result: {
          changedFiles: ['server/src/policy.ts'],
          addedLines: 1,
          removedLines: 0,
          forbiddenAdditions: [],
        },
      };
    };
    const assess: import('../src/agents.js').AgentRunner['assessHypothesisCompliance'] = async (
      variant,
      patchPath,
      mutationContextPath,
      directory,
    ) => {
      reviewCalls += 1;
      const patchSha256 = `sha256:${createHash('sha256')
        .update(await readFile(patchPath))
        .digest('hex')}`;
      const mutationContextSha256 = `sha256:${createHash('sha256')
        .update(await readFile(mutationContextPath))
        .digest('hex')}`;
      const passed = reviewCalls === passingReviewCall;
      const result = {
        kind: 'ainative-planner-eval/hypothesis-compliance' as const,
        schemaVersion: 2 as const,
        interpretationStatus: 'unverified_model_judgment' as const,
        variantId: variant.id,
        patchSha256,
        mutationContextSha256,
        status: passed ? ('passed' as const) : ('failed' as const),
        summary: passed ? 'Repaired mutation is complete.' : 'Runtime clause is incomplete.',
        intervention: {
          status: passed ? ('satisfied' as const) : ('not_satisfied' as const),
          rationale: passed ? 'Complete runtime behavior.' : 'Missing runtime behavior.',
          evidence: ['server/src/policy.ts:1'],
        },
        codeRegression: {
          status: 'satisfied' as const,
          rationale: 'Regression exists.',
          evidence: ['server/test/policy.test.ts:1'],
        },
        falsificationTest: {
          status: 'deferred_to_evaluation' as const,
          rationale: 'Coordinator-owned replay.',
          evidence: ['campaign replay'],
        },
        limitations: ['Unverified model judgment.'],
      };
      const resultPath = hypothesisComplianceResultPath(
        directory,
        patchSha256,
        mutationContextSha256,
      );
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      return { result, resultPath };
    };
    const repair: import('../src/agents.js').AgentRunner['repairHypothesisCompliance'] = async (
      variant,
      worktree,
      _artifactDirectory,
      _mutationContextPath,
      _treatmentPatchPath,
      _failedResultPath,
      attempt,
    ) => {
      repairCalls += 1;
      assert.equal(variant.id, expectedCandidateId);
      assert.equal(worktree, fixture.root);
      assert.equal(attempt, 2);
      treatment = 'repaired treatment';
    };
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      runMutationComplianceAttempts: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        worktree: string,
        artifactDirectory: string,
        mutationContextPath: string,
        mutationContextSha256: string,
        mutationBaselineTree: string,
        dependencies: {
          assess: typeof assess;
          repair: typeof repair;
          captureMutation: typeof captureMutation;
          captureDiff: typeof captureDiff;
        },
      ) => Promise<VariantRecord>;
    };

    const result = await internal.runMutationComplianceAttempts(
      fixture.campaign,
      candidate,
      fixture.root,
      artifactDirectory,
      contextPath,
      contextSha256,
      'baseline-tree',
      { assess, repair, captureMutation, captureDiff },
    );
    assert.equal(result.id, candidate.id);
    assert.equal(result.hypothesisComplianceStatus, 'passed');
    assert.equal(reviewCalls, 2);
    assert.equal(repairCalls, 1);
    assert.deepEqual(
      result.hypothesisComplianceAttempts.map(({ attempt, phase, outcome }) => ({
        attempt,
        phase,
        outcome,
      })),
      [
        { attempt: 1, phase: 'initial', outcome: 'semantic_failed' },
        { attempt: 2, phase: 'repair', outcome: 'passed' },
      ],
    );
    assert.equal(
      await readFile(
        path.join(artifactDirectory, 'hypothesis-compliance/attempt-01/mutation.patch'),
        'utf8',
      ),
      'initial treatment',
    );
    assert.equal(
      await readFile(
        path.join(artifactDirectory, 'hypothesis-compliance/attempt-02/mutation.patch'),
        'utf8',
      ),
      'repaired treatment',
    );

    const exhausted = fixture.database.createVariant({
      id: 'hypothesis-compliance-repair-loop-v002',
      campaignId: fixture.campaign.id,
      parentVariantId: fixture.variant.id,
      round: 1,
      ordinal: 2,
      hypothesis: candidate.hypothesis,
    });
    const exhaustedDirectory = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      exhausted.id,
    );
    const exhaustedContextPath = path.join(exhaustedDirectory, 'mutation-context.json');
    await mkdir(exhaustedDirectory, { recursive: true });
    await writeFile(exhaustedContextPath, context);
    treatment = 'exhausted initial treatment';
    reviewCalls = 0;
    repairCalls = 0;
    passingReviewCall = Number.POSITIVE_INFINITY;
    expectedCandidateId = exhausted.id;
    await assert.rejects(
      internal.runMutationComplianceAttempts(
        fixture.campaign,
        exhausted,
        fixture.root,
        exhaustedDirectory,
        exhaustedContextPath,
        contextSha256,
        'baseline-tree',
        { assess, repair, captureMutation, captureDiff },
      ),
      /failed after repair exhaustion/,
    );
    const exhaustedResult = fixture.database.getVariant(exhausted.id);
    assert.equal(repairCalls, 1);
    assert.deepEqual(
      exhaustedResult.hypothesisComplianceAttempts.map(({ outcome }) => outcome),
      ['semantic_failed', 'semantic_failed'],
    );
    assert.equal(exhaustedResult.hypothesisComplianceStatus, 'failed');

    const tampered = fixture.database.createVariant({
      id: 'hypothesis-compliance-repair-loop-v003',
      campaignId: fixture.campaign.id,
      parentVariantId: fixture.variant.id,
      round: 1,
      ordinal: 3,
      hypothesis: candidate.hypothesis,
    });
    const tamperedDirectory = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      tampered.id,
    );
    const tamperedContextPath = path.join(tamperedDirectory, 'mutation-context.json');
    await mkdir(tamperedDirectory, { recursive: true });
    await writeFile(tamperedContextPath, '{"selectedFindings":[{"id":"tampered"}]}\n');
    treatment = '';
    repairCalls = 0;
    expectedCandidateId = tampered.id;
    await assert.rejects(
      internal.runMutationComplianceAttempts(
        fixture.campaign,
        tampered,
        fixture.root,
        tamperedDirectory,
        tamperedContextPath,
        contextSha256,
        'baseline-tree',
        { assess, repair, captureMutation, captureDiff },
      ),
      /mutator modified the immutable mutation context/,
    );
    const tamperedResult = fixture.database.getVariant(tampered.id);
    assert.equal(repairCalls, 0);
    assert.deepEqual(
      tamperedResult.hypothesisComplianceAttempts.map(({ outcome }) => outcome),
      ['operational_failed'],
    );

    const repairFailed = fixture.database.createVariant({
      id: 'hypothesis-compliance-repair-loop-v004',
      campaignId: fixture.campaign.id,
      parentVariantId: fixture.variant.id,
      round: 1,
      ordinal: 4,
      hypothesis: candidate.hypothesis,
    });
    const repairFailedDirectory = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      repairFailed.id,
    );
    const repairFailedContextPath = path.join(repairFailedDirectory, 'mutation-context.json');
    await mkdir(repairFailedDirectory, { recursive: true });
    await writeFile(repairFailedContextPath, context);
    treatment = 'repair failure treatment';
    reviewCalls = 0;
    passingReviewCall = Number.POSITIVE_INFINITY;
    await assert.rejects(
      internal.runMutationComplianceAttempts(
        fixture.campaign,
        repairFailed,
        fixture.root,
        repairFailedDirectory,
        repairFailedContextPath,
        contextSha256,
        'baseline-tree',
        {
          assess,
          repair: async () => {
            throw new Error('repair command failed');
          },
          captureMutation,
          captureDiff,
        },
      ),
      /repair command failed/,
    );
    const repairFailure = fixture.database.getVariant(repairFailed.id);
    assert.deepEqual(
      repairFailure.hypothesisComplianceAttempts.map(({ outcome }) => outcome),
      ['semantic_failed', 'operational_failed'],
    );
    assert.equal(repairFailure.hypothesisComplianceStatus, 'failed');
    assert.equal(repairFailure.hypothesisCompliance, null);
    assert.equal(repairFailure.hypothesisCompliancePatchHash, null);
    assert.equal(repairFailure.hypothesisComplianceResultHash, null);
    assert.ok(repairFailure.hypothesisComplianceAttempts[1]?.treatmentPatchSha256);
    assert.equal(
      await stat(
        path.join(
          repairFailedDirectory,
          'hypothesis-compliance/attempt-02/mutation.patch',
        ),
      ).then((value) => value.isFile()),
      true,
    );

    const staticFailed = fixture.database.createVariant({
      id: 'hypothesis-compliance-repair-loop-v005',
      campaignId: fixture.campaign.id,
      parentVariantId: fixture.variant.id,
      round: 1,
      ordinal: 5,
      hypothesis: candidate.hypothesis,
    });
    const staticFailedDirectory = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      staticFailed.id,
    );
    const staticFailedContextPath = path.join(staticFailedDirectory, 'mutation-context.json');
    await mkdir(staticFailedDirectory, { recursive: true });
    await writeFile(staticFailedContextPath, context);
    treatment = 'statically rejected treatment';
    await assert.rejects(
      internal.runMutationComplianceAttempts(
        fixture.campaign,
        staticFailed,
        fixture.root,
        staticFailedDirectory,
        staticFailedContextPath,
        contextSha256,
        'baseline-tree',
        {
          assess,
          repair,
          captureMutation,
          captureDiff: async (_campaign, _variant, _worktree, directory) => {
            await writeFile(path.join(directory, 'variant.patch'), treatment);
            throw new Error('static diff gate rejected candidate');
          },
        },
      ),
      /static diff gate rejected candidate/,
    );
    const staticFailure = fixture.database.getVariant(staticFailed.id);
    assert.ok(staticFailure.hypothesisComplianceAttempts[0]?.treatmentPatchSha256);
    assert.ok(staticFailure.hypothesisComplianceAttempts[0]?.candidatePatchSha256);
    assert.equal(staticFailure.patchHash, staticFailure.hypothesisComplianceAttempts[0]?.candidatePatchSha256);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('campaign resume fails closed when a generated variant was interrupted', async () => {
  const fixture = await v2LifecycleFixture('interrupted-generated-repair');
  try {
    fixture.database.createVariant({
      id: 'interrupted-generated-repair-v001',
      campaignId: fixture.campaign.id,
      parentVariantId: fixture.variant.id,
      round: 1,
      ordinal: 1,
      hypothesis: baselineHypothesisForTest,
    });
    fixture.database.updateVariant('interrupted-generated-repair-v001', {
      status: 'mutating',
    });
    fixture.database.updateCampaign(fixture.campaign.id, {
      status: 'stopped_round_failed',
      currentParentVariantId: fixture.variant.id,
    });
    assert.throws(
      () => new CampaignOrchestrator(fixture.paths, fixture.database).resume(fixture.campaign.id),
      /cannot resume with interrupted generated variants/,
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
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
      /planner HTTP request failed; diagnostic details are unavailable/,
    );
    const execution = database.getVariant(variant.id).executionState?.executions[0];
    assert.equal(execution?.status, 'failed');
    assert.equal(execution?.failure?.origin, 'http');
    assert.equal(execution?.failure?.httpStatus, 503);
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

test('replicate preserves wrapped HTTP failure before case creation', async (t) => {
  const fixture = await v2LifecycleFixture('wrapped-http-before-case');
  try {
    const { campaign, variant, paths, database, root } = fixture;
    const message = 'The planner HTTP request failed; diagnostic details are unavailable.';
    const original = Object.assign(new Error(message, { cause: new Error('SECRET source response body') }), {
      failure: { origin: 'http' as const, code: null, message, httpStatus: 503 },
    });
    assert.equal('status' in original, false);
    const health = t.mock.method(PlannerClient.prototype, 'health', async () => ({ status: 'ready' }));
    const runPhase2 = t.mock.method(PlannerClient.prototype, 'runPhase2', async () => {
      const execution = database.getVariant(variant.id).executionState?.executions[0];
      assert.equal(execution?.status, 'starting');
      assert.equal(execution?.caseId, null);
      assert.equal(execution?.runId, null);
      throw original;
    });
    const internal = new CampaignOrchestrator(paths, database) as unknown as {
      runBenchmark(
        campaign: CampaignRecord, variant: VariantRecord,
        stack: { artifactDirectory: string; baseUrl: string }, benchmark: Benchmark,
        token: string | undefined, replicate: number, workflowsSource: string, answerCache: Map<string, unknown>,
      ): Promise<unknown>;
    };
    await assert.rejects(internal.runBenchmark(
      campaign, variant, { artifactDirectory: variantArtifactDirectory(paths, campaign.id, variant.id), baseUrl: 'http://planner.invalid' },
      campaign.config.benchmarks[0]!, undefined, 1, root, new Map(),
    ), (error) => {
      assert.equal(error, original);
      assert.equal(original.message, message);
      return true;
    });
    assert.equal(health.mock.callCount(), 1);
    assert.equal(runPhase2.mock.callCount(), 1);
    const execution = database.getVariant(variant.id).executionState?.executions[0];
    assert.equal(execution?.status, 'failed');
    assert.equal(execution?.caseId, null);
    assert.equal(execution?.runId, null);
    assert.equal(execution?.failure?.origin, 'http');
    assert.equal(execution?.failure?.httpStatus, 503);
    assert.equal(execution?.failure?.code, null);
    assert.equal(execution?.failure?.message, message);
    assert.equal(JSON.stringify(execution).includes('SECRET'), false);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('V2 replicate options share target-safe answers without applying exclusion to standard primary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-v2-options-'));
  const data = path.join(root, 'data');
  const artifacts = path.join(root, 'artifacts');
  await Promise.all([
    mkdir(data),
    mkdir(path.join(artifacts, 'primary'), { recursive: true }),
    mkdir(path.join(artifacts, 'target-excluded/excluded/primary'), { recursive: true }),
  ]);
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
      id: 'v2-option-test',
      goal: 'Keep target-filtered answer sourcing independent from planner case exclusion.',
      plannerRepo: root,
      workflowsRepo: root,
      environmentFile: path.join(root, 'environment.env'),
      seedRevision: 'seed',
      workflowsRevision: 'workflows',
      evaluation: { replicates: 2, replicateConcurrency: 2 },
      targetExcluded: {
        protocol: 'standard-primary-v2',
        targetImplementationWorkflow: 'trumark/deceased-accounts',
      },
      benchmarks: [
        { name: 'primary', role: 'primary', zipPath: path.join(root, 'primary.zip') },
        { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
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
      id: 'v2-option-test-v000',
      campaignId: campaign.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: baselineHypothesisForTest,
    });
    const orchestrator = new CampaignOrchestrator(paths, database);
    const observed: Array<{ source: string; cache: Map<string, unknown>; excluded?: string }> = [];
    const internal = orchestrator as unknown as {
      ensureTargetExcludedWorkflowsSource: () => Promise<string>;
      runBenchmark: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        stack: { artifactDirectory: string },
        benchmark: Benchmark,
        token: string | undefined,
        replicate: number,
        workflowsSource: string,
        answerCache: Map<string, unknown>,
        options: { excludedTargetWorkflow?: string },
      ) => Promise<{ caseId: string; runId: string; status: string; facts: RunFacts; questions: [] }>;
      runBenchmarkReplicates: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        stack: { artifactDirectory: string },
        benchmark: Benchmark,
        token: string | undefined,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    internal.ensureTargetExcludedWorkflowsSource = async () => '/target-filtered-source';
    internal.runBenchmark = async (
      _campaign,
      _variant,
      _stack,
      _benchmark,
      _token,
      replicate,
      workflowsSource,
      answerCache,
      options,
    ) => {
      observed.push({
        source: workflowsSource,
        cache: answerCache,
        ...(options.excludedTargetWorkflow
          ? { excluded: options.excludedTargetWorkflow }
          : {}),
      });
      return {
        caseId: `case-${replicate}`,
        runId: `run-${replicate}`,
        status: 'completed',
        facts: completedFacts(),
        questions: [],
      };
    };
    const answerCache = new Map<string, unknown>();
    await Promise.all([
      internal.runBenchmarkReplicates(
        campaign,
        variant,
        { artifactDirectory: artifacts },
        config.benchmarks[0]!,
        undefined,
        {
          replicateCount: 2,
          answerSourceTargetWorkflow: 'trumark/deceased-accounts',
          answerCache,
        },
      ),
      internal.runBenchmarkReplicates(
        campaign,
        variant,
        { artifactDirectory: artifacts },
        config.benchmarks[0]!,
        undefined,
        {
          replicateCount: 2,
          scope: 'target-excluded/excluded',
          answerSourceTargetWorkflow: 'trumark/deceased-accounts',
          excludedTargetWorkflow: 'trumark/deceased-accounts',
          answerCache,
        },
      ),
    ]);

    assert.equal(observed.length, 4);
    assert.ok(observed.every(({ source, cache }) => source === '/target-filtered-source' && cache === answerCache));
    assert.equal(observed.filter(({ excluded }) => excluded).length, 2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 primary resolution uses full-source PM simulation while preserving excluded snapshot isolation', async () => {
  const fixture = await v2LifecycleFixture('v2-pm-primary-resolution');
  try {
    const primary = fixture.campaign.config.benchmarks[0]!;
    const fullSource = path.join(fixture.root, 'full-frozen-workflows');
    const excludedSource = path.join(fixture.root, 'target-excluded-workflows');
    await Promise.all([mkdir(fullSource), mkdir(excludedSource)]);
    let snapshotEnsured = 0;
    let resolverSource: string | null = null;
    let resolverMode: string | null = null;
    const summary: BenchmarkQuestionResolution = {
      ...resolution('primary', `sha256:${'9'.repeat(64)}`),
      sourceFallbackAnswers: 0,
      pmSimulationAnswers: 1,
      entries: [
        {
          id: 'pm-question',
          question: 'Which behavior should requirements specify?',
          resolution: 'pm_simulation',
          answer: 'Specify the observed account workflow behavior without naming its implementation.',
          evidence: ['src/customers/trumark/deceased-accounts/index.ts:42'],
        },
      ],
    };
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      ensureTargetExcludedWorkflowsSource: () => Promise<string>;
      ensureFrozenWorkflowsSource: () => Promise<string>;
      resolveV2PrimaryBenchmark: (
        campaign: CampaignRecord,
        benchmark: Benchmark,
        targetWorkflow: string,
        artifactDirectory: string,
        dependencies: {
          resolveBenchmarkQuestions: (input: {
            benchmark: Benchmark;
            workflowsSource: string;
            sourceAnswerMode?: string;
            answerAllowed?: (candidate: {
              answer: string;
              evidence: string[];
              resolution: 'pm_simulation';
            }) => boolean;
          }) => Promise<{ benchmark: Benchmark; summary: BenchmarkQuestionResolution }>;
        },
      ) => Promise<{ benchmark: Benchmark; summary: BenchmarkQuestionResolution }>;
      runBaseline: (campaignId: string) => Promise<VariantRecord>;
      hasCompleteEvaluationArtifacts: () => Promise<boolean>;
      recoverEvaluation: (campaign: CampaignRecord, variant: VariantRecord) => Promise<VariantRecord>;
      prepareAutomaticV2Config: () => Promise<TargetExcludedConfig>;
      persistAutomaticV2Config: (
        campaign: CampaignRecord,
        config: TargetExcludedConfig,
      ) => Promise<TargetExcludedConfig>;
      targetExcludedEvaluationReady: () => boolean;
      finalizeBaseline: (campaignId: string, variant: VariantRecord) => Promise<VariantRecord>;
      runVariant: () => Promise<VariantRecord>;
      refreshReports: () => Promise<void>;
    };
    internal.ensureTargetExcludedWorkflowsSource = async () => {
      snapshotEnsured += 1;
      return excludedSource;
    };
    internal.ensureFrozenWorkflowsSource = async () => fullSource;
    const resolved = await internal.resolveV2PrimaryBenchmark(
      fixture.campaign,
      primary,
      fixture.targetConfig.targetImplementationWorkflow,
      path.join(fixture.root, 'pack-questions'),
      {
        resolveBenchmarkQuestions: async (input) => {
          resolverSource = input.workflowsSource;
          resolverMode = input.sourceAnswerMode ?? null;
          assert.equal(
            input.answerAllowed?.({
              answer: 'Specify the observed behavior.',
              evidence: ['src/customers/trumark/deceased-accounts/index.ts:42'],
              resolution: 'pm_simulation',
            }),
            true,
          );
          assert.equal(
            input.answerAllowed?.({
              answer: 'Use src/customers/trumark/deceased-accounts/index.ts directly.',
              evidence: ['harness-only PM rationale'],
              resolution: 'pm_simulation',
            }),
            false,
          );
          return {
            benchmark: {
              ...input.benchmark,
              zipPath: path.join(fixture.root, 'resolved-primary.zip'),
              sha256: summary.resolvedArtifactSha,
            },
            summary,
          };
        },
      },
    );

    assert.equal(snapshotEnsured, 1);
    assert.equal(resolverSource, fullSource);
    assert.equal(resolverMode, 'pm-simulation');
    assert.deepEqual(resolved.summary.entries[0]?.evidence, [
      'src/customers/trumark/deceased-accounts/index.ts:42',
    ]);
    assert.equal(resolved.benchmark.zipPath, path.join(fixture.root, 'resolved-primary.zip'));

    fixture.database.updateVariant(fixture.variant.id, {
      status: 'failed',
      questionResolutions: {
        ...fixture.variant.questionResolutions,
        primary: resolved.summary,
      },
    });
    internal.hasCompleteEvaluationArtifacts = async () => true;
    internal.recoverEvaluation = async (_campaign, variant) =>
      fixture.database.updateVariant(variant.id, { status: 'review', error: null });
    internal.prepareAutomaticV2Config = async () => fixture.targetConfig;
    internal.persistAutomaticV2Config = async (_campaign, config) => {
      if (!fixture.database.getTargetExcludedConfig(fixture.campaign.id)) {
        fixture.database.createTargetExcludedConfig(fixture.campaign.id, config);
      }
      return config;
    };
    internal.targetExcludedEvaluationReady = () => true;
    internal.finalizeBaseline = async (_campaignId, variant) =>
      fixture.database.updateVariant(variant.id, { status: 'completed' });
    internal.runVariant = async () => {
      throw new Error('created a replacement after successful PM resolution');
    };
    internal.refreshReports = async () => undefined;

    const recovered = await internal.runBaseline(fixture.campaign.id);
    assert.equal(recovered.id, fixture.variant.id);
    assert.equal(fixture.database.listVariants(fixture.campaign.id).length, 1);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('target-bound runtime questions use full-source PM simulation without exposing evidence', async () => {
  const fixture = await v2LifecycleFixture('v2-runtime-pm-answer');
  try {
    const fullSource = path.join(fixture.root, 'full-frozen-workflows');
    let observedSource: string | null = null;
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      ensureFrozenWorkflowsSource: () => Promise<string>;
      answerRuntimeQuestionFromImplementation: (
        campaign: CampaignRecord,
        question: PlannerQuestionRecord,
        workflowsSource: string,
        artifactDirectory: string,
      ) => Promise<{
        resolution: 'answered';
        answer: string;
        evidence: string[];
      }>;
      answerRuntimeQuestion: (
        campaign: CampaignRecord,
        question: PlannerQuestionRecord,
        consultations: unknown[],
        workflowsSource: string,
        artifactDirectory: string,
        answerCache: Map<string, unknown>,
        targetContext: {
          targetWorkflow: string;
          variantId: string;
          benchmark: string;
          replicate: number;
        },
      ) => Promise<{
        answer: string;
        resolution: string;
        evidence: string[];
        requirementsAgentRequests: number;
      }>;
    };
    internal.ensureFrozenWorkflowsSource = async () => fullSource;
    internal.answerRuntimeQuestionFromImplementation = async (
      _campaign,
      _question,
      workflowsSource,
    ) => {
      observedSource = workflowsSource;
      return {
        resolution: 'answered',
        answer: 'Use the implementation-backed keyable row format.',
        evidence: ['src/customers/trumark/deceased-accounts/summary-block.ts:197-204'],
      };
    };
    const question: PlannerQuestionRecord = {
      id: 'runtime-pm-question',
      createdByRunId: 'runtime-pm-run',
      responseKind: 'free_text',
      prompt: 'Which keyable row format should be used?',
      rationale: 'The reviewed text leaves the exact format unresolved.',
      context: {},
      status: 'open',
    };

    const answer = await internal.answerRuntimeQuestion(
      fixture.campaign,
      question,
      [],
      path.join(fixture.root, 'target-safe-source'),
      path.join(fixture.root, 'runtime-question'),
      new Map(),
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary:excluded',
        replicate: 1,
      },
    );

    assert.equal(observedSource, fullSource);
    assert.equal(answer.resolution, 'pm_simulation');
    assert.deepEqual(answer.evidence, [
      'PM simulation evidence is retained in the immutable harness agent transcript.',
    ]);
    assert.equal(answer.requirementsAgentRequests, 0);
    const summary = withRuntimeQuestions(resolution('primary', `sha256:${'8'.repeat(64)}`), [
      {
        questionId: question.id,
        prompt: question.prompt,
        answer: answer.answer,
        resolution: 'pm_simulation',
        evidence: answer.evidence,
        requirementsAgentRequests: answer.requirementsAgentRequests,
      },
    ]);
    assert.equal(summary.plannerPmSimulationAnswers, 1);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('target-blind judgment persists generic evidence instead of an excluded source path', () => {
  const judgment = targetSafeJudgeOutput(
    {
      summary: 'The target implementation is absent.',
      verdicts: [
        {
          unitKey: 'unit-a',
          expectedDecision: 'build',
          classification: 'real_gap',
          confidence: 'high',
          rationale: 'No eligible source was present.',
          evidence: [
            'No src/customers/trumark/deceased-accounts implementation exists in the frozen checkout',
            'Shared search returned no eligible declaration.',
          ],
        },
      ],
    },
    'trumark/deceased-accounts',
  );

  assert.deepEqual(judgment.verdicts[0]?.evidence, [
    'Target implementation is absent from the target-excluded source snapshot.',
    'Shared search returned no eligible declaration.',
  ]);
});

test('automatic promotion skips candidates rejected by holdout validation', async () => {
  const fixture = await v2LifecycleFixture('automatic-holdout-rejection');
  try {
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      promoteUnlocked: (campaignId: string, variantId: string) => Promise<VariantRecord>;
      promoteFirstEligibleAutomaticCandidate: (
        campaignId: string,
        eligible: readonly VariantRecord[],
      ) => Promise<boolean>;
    };
    internal.promoteUnlocked = async (_campaignId, variantId) => {
      fixture.database.updateVariant(variantId, {
        status: 'rejected',
        error: 'holdout regression: holdout',
      });
      throw new Error('variant regressed holdout benchmarks: holdout');
    };

    assert.equal(
      await internal.promoteFirstEligibleAutomaticCandidate(fixture.campaign.id, [fixture.variant]),
      false,
    );
    assert.equal(fixture.database.getVariant(fixture.variant.id).status, 'rejected');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

const baselineHypothesisForTest = {
  title: 'Seed',
  rationale: 'Observe the seed.',
  instructions: 'Do not modify the planner.',
  expectedImpact: 'Produce reference facts.',
  risk: 'Fixture only.',
  findingIds: [],
};

test('V2 readiness requires a valid binding to standard primary execution and artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-v2-ready-'));
  const data = path.join(root, 'data');
  await mkdir(data);
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
    const resolvedArtifactSha = `sha256:${'e'.repeat(64)}`;
    const campaignConfig = CampaignConfigSchema.parse({
      id: 'v2-ready-test',
      goal: 'Require exact standard execution lineage before target promotion.',
      plannerRepo: root,
      workflowsRepo: root,
      environmentFile: path.join(root, 'environment.env'),
      seedRevision: 'seed',
      workflowsRevision: 'workflows',
      evaluation: { replicates: 2, replicateConcurrency: 2 },
      targetExcluded: {
        protocol: 'standard-primary-v2',
        targetImplementationWorkflow: 'trumark/deceased-accounts',
      },
      benchmarks: [
        { name: 'primary', role: 'primary', zipPath: path.join(root, 'primary.zip') },
        { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
      ],
    });
    const campaign = database.createCampaign(
      campaignConfig,
      'a'.repeat(40),
      'b'.repeat(40),
      `sha256:${'c'.repeat(64)}`,
      'https://github.com/Saris-AI/workflows.git',
    );
    const created = database.createVariant({
      id: 'v2-ready-test-v000',
      campaignId: campaign.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: baselineHypothesisForTest,
    });
    const facts = completedFacts();
    database.updateVariant(created.id, {
      status: 'completed',
      artifactCollectionComplete: true,
      facts,
      replicateFacts: [facts, facts],
      holdoutFacts: { holdout: facts },
      holdoutReplicateFacts: { holdout: [facts, facts] },
      questionResolutions: { primary: resolution('primary', resolvedArtifactSha) },
      executionState: {
        executions: [1, 2].map((replicate) => ({
          benchmark: 'primary',
          role: 'primary' as const,
          replicate,
          replicateCount: 2,
          ...completedSnapshot(`normal-case-${replicate}`, `normal-run-${replicate}`),
        })),
      },
    });
    const targetConfig = database.createTargetExcludedConfig(campaign.id, {
      protocol: 'standard-primary-v2',
      targetImplementationWorkflow: 'trumark/deceased-accounts',
      baselineVariantId: created.id,
      comparatorImage: `sha256:${'f'.repeat(64)}`,
      configuredAt: '2026-09-06T00:00:00.000Z',
      normalArmSource: 'standard_primary',
      primaryResolvedArtifactSha: resolvedArtifactSha,
    });
    database.createTargetExcludedEvaluation(campaign.id, created.id);
    const judgment = {
      summary: 'The target-blind result is internally consistent.',
      verdicts: [
        {
          unitKey: 'unit-a',
          expectedDecision: 'build' as const,
          classification: 'real_gap' as const,
          confidence: 'high' as const,
          rationale: 'No reusable source evidence was visible.',
          evidence: ['target-filtered source snapshot'],
        },
      ],
    };
    const score = {
      cohortMismatches: [],
      verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
      provisional: { labeled: 1, correct: 1, errors: 0, accuracy: 1 },
      decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
    };
    const comparisonReports = [1, 2].map((replicate) =>
      validComparisonReport(
        `normal-case-${replicate}`,
        `excluded-case-${replicate}`,
        `normal-run-${replicate}`,
        `excluded-run-${replicate}`,
      ),
    );
    const comparisons = comparisonReports.map((report, index) =>
      summarizeTargetExcludedComparisonReport(index + 1, report),
    );
    const comparisonDirectory = path.join(
      paths.artifacts,
      campaign.id,
      created.id,
      'target-excluded/comparisons',
    );
    await mkdir(comparisonDirectory, { recursive: true });
    await Promise.all(
      comparisonReports.map((report, index) =>
        writeFile(
          path.join(comparisonDirectory, `replicate-${index + 1}.json`),
          `${JSON.stringify(report)}\n`,
        ),
      ),
    );
    const gate = computeTargetExcludedGate([facts, facts], [facts, facts], true, false);
    database.updateTargetExcludedEvaluation(created.id, {
      status: 'completed',
      excludedFacts: facts,
      excludedReplicateFacts: [facts, facts],
      judgment,
      score,
      questionResolution: resolution('primary', resolvedArtifactSha),
      executionState: {
        executions: [1, 2].map((replicate) => ({
          benchmark: 'primary:excluded',
          role: 'primary' as const,
          replicate,
          replicateCount: 2,
          ...completedSnapshot(`excluded-case-${replicate}`, `excluded-run-${replicate}`),
        })),
      },
      comparisons,
      gate,
      normalArmBinding: {
        source: 'standard_primary',
        benchmark: 'primary',
        resolvedArtifactSha,
        replicates: [
          { replicate: 1, caseId: 'normal-case-1', runId: 'normal-run-1' },
          { replicate: 2, caseId: 'normal-case-2', runId: 'normal-run-2' },
        ],
      },
      artifactCollectionComplete: true,
    });
    const orchestrator = new CampaignOrchestrator(paths, database) as unknown as {
      targetExcludedEvaluationReady: (
        campaign: CampaignRecord,
        config: TargetExcludedConfig,
        evaluation: ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>,
        baseline: boolean,
      ) => boolean;
      reconcileTargetSafeQuestionResolution: (
        campaign: CampaignRecord,
        config: TargetExcludedConfig,
        evaluation: ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>,
      ) => ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>;
      verifyArchivedTargetExcludedComparisons: (
        campaign: CampaignRecord,
        variantId: string,
        config: TargetExcludedConfig,
        evaluation: NonNullable<ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>>,
      ) => Promise<void>;
    };
    assert.equal(
      orchestrator.targetExcludedEvaluationReady(
        campaign,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id),
        true,
      ),
      true,
    );
    const leakyResolution: BenchmarkQuestionResolution = {
      ...resolution('primary', resolvedArtifactSha),
      pmSimulationAnswers: 1,
      entries: [
        {
          id: 'pm-question',
          question: 'Which product behavior is intended?',
          resolution: 'pm_simulation',
          answer: 'Use the implementation-backed behavior.',
          evidence: ['src/customers/trumark/deceased-accounts/index.ts:42'],
        },
      ],
    };
    const blocked = database.updateTargetExcludedEvaluation(created.id, {
      questionResolution: leakyResolution,
      gate: computeTargetExcludedGate([facts, facts], [facts, facts], true, true),
    });
    assert.equal(
      orchestrator.targetExcludedEvaluationReady(campaign, targetConfig, blocked, true),
      false,
    );
    const reconciled = orchestrator.reconcileTargetSafeQuestionResolution(
      campaign,
      targetConfig,
      blocked,
    );
    assert.ok(reconciled);
    assert.equal(
      orchestrator.targetExcludedEvaluationReady(campaign, targetConfig, reconciled, true),
      true,
    );
    assert.deepEqual(reconciled.questionResolution?.entries[0]?.evidence, [
      'PM simulation evidence is retained in the immutable harness agent transcript.',
    ]);
    await orchestrator.verifyArchivedTargetExcludedComparisons(
      campaign,
      created.id,
      targetConfig,
      database.getTargetExcludedEvaluation(created.id)!,
    );

    await writeFile(
      path.join(comparisonDirectory, 'replicate-1.json'),
      `${JSON.stringify({ ...comparisonReports[0], hash: `sha256:${'0'.repeat(64)}` })}\n`,
    );
    await assert.rejects(
      orchestrator.verifyArchivedTargetExcludedComparisons(
        campaign,
        created.id,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id)!,
      ),
      /comparison report hash does not bind its canonical content/,
    );
    await writeFile(
      path.join(comparisonDirectory, 'replicate-1.json'),
      `${JSON.stringify(comparisonReports[1])}\n`,
    );
    await assert.rejects(
      orchestrator.verifyArchivedTargetExcludedComparisons(
        campaign,
        created.id,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id)!,
      ),
      /archived target-excluded comparison differs from persisted summary/,
    );
    await writeFile(
      path.join(comparisonDirectory, 'replicate-1.json'),
      `${JSON.stringify(comparisonReports[0])}\n`,
    );
    await rm(path.join(comparisonDirectory, 'replicate-2.json'));
    await assert.rejects(
      orchestrator.verifyArchivedTargetExcludedComparisons(
        campaign,
        created.id,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id)!,
      ),
      /ENOENT/,
    );
    await writeFile(
      path.join(comparisonDirectory, 'replicate-2.json'),
      `${JSON.stringify(comparisonReports[1])}\n`,
    );

    database.updateTargetExcludedEvaluation(created.id, {
      normalArmBinding: {
        source: 'standard_primary',
        benchmark: 'primary',
        resolvedArtifactSha,
        replicates: [
          { replicate: 1, caseId: 'wrong-case', runId: 'normal-run-1' },
          { replicate: 2, caseId: 'normal-case-2', runId: 'normal-run-2' },
        ],
      },
    });
    assert.equal(
      orchestrator.targetExcludedEvaluationReady(
        campaign,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id),
        true,
      ),
      false,
    );

    database.updateTargetExcludedEvaluation(created.id, {
      normalArmBinding: {
        source: 'standard_primary',
        benchmark: 'primary',
        resolvedArtifactSha,
        replicates: [
          { replicate: 1, caseId: 'normal-case-1', runId: 'normal-run-1' },
          { replicate: 2, caseId: 'normal-case-2', runId: 'normal-run-2' },
        ],
      },
      comparisons: [
        { ...comparisons[0]!, normalCaseId: 'normal-case-2' },
        { ...comparisons[1]!, excludedCaseId: 'wrong-excluded-case' },
      ],
    });
    assert.equal(
      orchestrator.targetExcludedEvaluationReady(
        campaign,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id),
        true,
      ),
      false,
    );

    database.updateTargetExcludedEvaluation(created.id, {
      comparisons: [
        {
          ...comparisons[0]!,
          normalRunId: 'normal-run-2',
        },
        {
          ...comparisons[1]!,
          excludedRunId: 'wrong-excluded-run',
        },
      ],
    });
    assert.equal(
      orchestrator.targetExcludedEvaluationReady(
        campaign,
        targetConfig,
        database.getTargetExcludedEvaluation(created.id),
        true,
      ),
      false,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('V2 baseline finalization fails explicitly until target evaluation is ready', async () => {
  const fixture = await v2LifecycleFixture('v2-finalize-boundary');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, {
      status: 'failed',
      error: 'excluded arm failed',
    });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      targetExcludedEvaluationReady: () => boolean;
      finalizeBaseline: (campaignId: string, variant: VariantRecord) => Promise<VariantRecord>;
      refreshReports: () => Promise<void>;
    };
    internal.targetExcludedEvaluationReady = () => false;
    internal.refreshReports = async () => undefined;

    const result = await internal.finalizeBaseline(fixture.campaign.id, fixture.variant);

    assert.equal(result.status, 'review');
    assert.equal(fixture.database.getCampaign(fixture.campaign.id).status, 'baseline_target_failed');
    assert.equal(fixture.database.getCampaign(fixture.campaign.id).currentParentVariantId, null);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runBaseline retries only the excluded arm for its config-bound standard baseline', async () => {
  const fixture = await v2LifecycleFixture('v2-baseline-retry');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, {
      status: 'failed',
      error: 'excluded arm failed',
      artifactCollectionComplete: true,
    });
    fixture.database.updateCampaign(fixture.campaign.id, { status: 'baseline_target_failed' });
    let backfills = 0;
    const orchestrator = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      targetExcludedEvaluationReady: () => boolean;
      runTargetExcludedBackfill: () => Promise<ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>>;
      hasCompleteEvaluationArtifacts: () => Promise<boolean>;
      runVariant: () => Promise<VariantRecord>;
      refreshReports: () => Promise<void>;
      runBaseline: (campaignId: string) => Promise<VariantRecord>;
      verifyAutomaticV2ComparatorImage: () => Promise<void>;
    };
    orchestrator.verifyAutomaticV2ComparatorImage = async () => undefined;
    orchestrator.targetExcludedEvaluationReady = () => backfills === 1;
    orchestrator.hasCompleteEvaluationArtifacts = async () => true;
    orchestrator.runTargetExcludedBackfill = async () => {
      backfills += 1;
      const reports = [1, 2].map((replicate) =>
        validComparisonReport(
          `normal-case-${replicate}`,
          `excluded-case-${replicate}`,
          `normal-run-${replicate}`,
          `excluded-run-${replicate}`,
        ),
      );
      const comparisonDirectory = path.join(
        fixture.paths.artifacts,
        fixture.campaign.id,
        fixture.variant.id,
        'target-excluded/comparisons',
      );
      await mkdir(comparisonDirectory, { recursive: true });
      await Promise.all(
        reports.map((report, index) =>
          writeFile(
            path.join(comparisonDirectory, `replicate-${index + 1}.json`),
            `${JSON.stringify(report)}\n`,
          ),
        ),
      );
      return fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, {
        status: 'completed',
        artifactCollectionComplete: true,
        comparisons: reports.map((report, index) =>
          summarizeTargetExcludedComparisonReport(index + 1, report),
        ),
        error: null,
      });
    };
    orchestrator.runVariant = async () => {
      throw new Error('runBaseline created a replacement baseline');
    };
    orchestrator.refreshReports = async () => undefined;

    const result = await orchestrator.runBaseline(fixture.campaign.id);

    assert.equal(backfills, 1);
    assert.equal(result.id, fixture.variant.id);
    assert.equal(result.status, 'completed');
    assert.equal(fixture.database.listVariants(fixture.campaign.id).length, 1);
    assert.equal(fixture.database.getCampaign(fixture.campaign.id).status, 'ready');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('backfill archives an invalid complete target attempt and regenerates instead of blocking', async () => {
  const fixture = await v2LifecycleFixture('v2-invalid-complete-retry');
  try {
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, {
      status: 'completed',
      artifactCollectionComplete: true,
    });
    const targetDirectory = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      fixture.variant.id,
      'target-excluded',
    );
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(path.join(targetDirectory, 'old-attempt.txt'), 'invalid archived attempt\n');
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      targetExcludedEvaluationReady: () => boolean;
      verifyArchivedTargetExcludedComparisons: () => Promise<void>;
      runTargetExcludedBackfill: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        config: TargetExcludedConfig,
      ) => Promise<NonNullable<ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>>>;
      refreshReports: () => Promise<void>;
    };
    internal.targetExcludedEvaluationReady = () => true;
    internal.verifyArchivedTargetExcludedComparisons = async () => {
      throw new Error('invalid archived comparison bytes');
    };
    internal.refreshReports = async () => undefined;

    const result = await internal.runTargetExcludedBackfill(
      fixture.campaign,
      fixture.variant,
      fixture.targetConfig,
    );

    assert.equal(result.status, 'failed');
    assert.equal(
      await readFile(
        path.join(
          fixture.paths.artifacts,
          fixture.campaign.id,
          fixture.variant.id,
          'target-excluded-attempts/attempt-001/old-attempt.txt',
        ),
        'utf8',
      ),
      'invalid archived attempt\n',
    );
    assert.ok(
      fixture.database
        .listEvents(fixture.campaign.id)
        .some(({ type }) => type === 'target_excluded.invalid_attempt'),
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runBaseline reconciles a config-less integrated stack and reuses its complete baseline', async () => {
  const fixture = await v2LifecycleFixture('v2-interrupted-reuse');
  try {
    const artifactRoot = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      fixture.variant.id,
    );
    await writeFile(path.join(artifactRoot, 'stack.env'), 'PLANNER_DDB_TABLE=interrupted\n');
    fixture.database.updateVariant(fixture.variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
    });
    let archives = 0;
    let boundBaselineId: string | null = null;
    const orchestrator = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      runBaseline: (campaignId: string) => Promise<VariantRecord>;
      archiveInterruptedIntegratedStack: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        options?: { allowIncomplete?: boolean },
      ) => Promise<VariantRecord>;
      hasCompleteEvaluationArtifacts: () => Promise<boolean>;
      recoverEvaluation: (campaign: CampaignRecord, variant: VariantRecord) => Promise<VariantRecord>;
      prepareAutomaticV2Config: (
        campaign: CampaignRecord,
        variant: VariantRecord,
      ) => Promise<TargetExcludedConfig>;
      persistAutomaticV2Config: (
        campaign: CampaignRecord,
        config: TargetExcludedConfig,
      ) => Promise<TargetExcludedConfig>;
      targetExcludedEvaluationReady: () => boolean;
      finalizeBaseline: (campaignId: string, variant: VariantRecord) => Promise<VariantRecord>;
      runVariant: () => Promise<VariantRecord>;
      refreshReports: () => Promise<void>;
    };
    orchestrator.archiveInterruptedIntegratedStack = async (_campaign, variant) => {
      archives += 1;
      return fixture.database.updateVariant(variant.id, { artifactCollectionComplete: true });
    };
    orchestrator.hasCompleteEvaluationArtifacts = async () => true;
    orchestrator.recoverEvaluation = async (_campaign, variant) =>
      fixture.database.updateVariant(variant.id, { status: 'review', error: null });
    orchestrator.prepareAutomaticV2Config = async (_campaign, variant) => {
      boundBaselineId = variant.id;
      return fixture.targetConfig;
    };
    orchestrator.persistAutomaticV2Config = async (_campaign, config) => {
      if (!fixture.database.getTargetExcludedConfig(fixture.campaign.id)) {
        fixture.database.createTargetExcludedConfig(fixture.campaign.id, config);
      }
      return config;
    };
    orchestrator.targetExcludedEvaluationReady = () => true;
    orchestrator.finalizeBaseline = async (_campaignId, variant) =>
      fixture.database.updateVariant(variant.id, { status: 'completed' });
    orchestrator.runVariant = async () => {
      throw new Error('created a replacement before reconciling the interrupted stack');
    };
    orchestrator.refreshReports = async () => undefined;

    const result = await orchestrator.runBaseline(fixture.campaign.id);

    assert.equal(archives, 1);
    assert.equal(boundBaselineId, fixture.variant.id);
    assert.equal(result.id, fixture.variant.id);
    assert.equal(fixture.database.listVariants(fixture.campaign.id).length, 1);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runBaseline archives an unrecoverable config-less stack before creating a replacement', async () => {
  const fixture = await v2LifecycleFixture('v2-interrupted-replace');
  try {
    const artifactRoot = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      fixture.variant.id,
    );
    await writeFile(path.join(artifactRoot, 'stack.env'), 'PLANNER_DDB_TABLE=interrupted\n');
    fixture.database.updateVariant(fixture.variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
      facts: null,
      replicateFacts: null,
      holdoutFacts: null,
      holdoutReplicateFacts: null,
    });
    let archived = false;
    const orchestrator = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      runBaseline: (campaignId: string) => Promise<VariantRecord>;
      archiveInterruptedIntegratedStack: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        options?: { allowIncomplete?: boolean },
      ) => Promise<VariantRecord>;
      hasCompleteEvaluationArtifacts: () => Promise<boolean>;
      runVariant: (
        campaign: CampaignRecord,
        variant: VariantRecord,
      ) => Promise<VariantRecord>;
      finalizeBaseline: (campaignId: string, variant: VariantRecord) => Promise<VariantRecord>;
      refreshReports: () => Promise<void>;
    };
    orchestrator.archiveInterruptedIntegratedStack = async (_campaign, variant, options) => {
      assert.equal(options?.allowIncomplete, true);
      archived = true;
      return fixture.database.updateVariant(variant.id, { artifactCollectionComplete: true });
    };
    orchestrator.hasCompleteEvaluationArtifacts = async () => false;
    orchestrator.runVariant = async (_campaign, variant) => {
      assert.equal(archived, true);
      return fixture.database.updateVariant(variant.id, { status: 'failed' });
    };
    orchestrator.finalizeBaseline = async (_campaignId, variant) => variant;
    orchestrator.refreshReports = async () => undefined;

    const result = await orchestrator.runBaseline(fixture.campaign.id);

    assert.equal(archived, true);
    assert.equal(result.id, `${fixture.campaign.id}-v001`);
    assert.equal(fixture.database.getVariant(fixture.variant.id).status, 'failed');
    assert.equal(fixture.database.listVariants(fixture.campaign.id).length, 2);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete archive mode abandons after collection failure when reattach and stop succeed', async () => {
  const fixture = await v2LifecycleFixture('v2-archive-collection-failure');
  try {
    const marker = path.join(
      fixture.paths.artifacts,
      fixture.campaign.id,
      fixture.variant.id,
      'partial-artifact.txt',
    );
    await writeFile(marker, 'partial archive\n');
    const variant = fixture.database.updateVariant(fixture.variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
    });
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, variant.id);
    fixture.database.updateTargetExcludedEvaluation(variant.id, { status: 'running' });
    let stopped = false;
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      ensureFrozenPlannerSource: () => Promise<string>;
      archiveInterruptedIntegratedStack: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        options: {
          allowIncomplete: boolean;
          reattach: () => Promise<unknown>;
          collect: () => Promise<void>;
          stop: () => Promise<void>;
        },
      ) => Promise<VariantRecord>;
    };
    internal.ensureFrozenPlannerSource = async () => fixture.root;

    const archived = await internal.archiveInterruptedIntegratedStack(
      fixture.campaign,
      variant,
      {
        allowIncomplete: true,
        reattach: async () => ({}),
        collect: async () => {
          throw new Error('collection failed');
        },
        stop: async () => {
          stopped = true;
        },
      },
    );

    assert.equal(stopped, true);
    assert.equal(archived.status, 'failed');
    assert.equal(archived.artifactCollectionComplete, false);
    assert.match(archived.error ?? '', /collection failed/);
    const target = fixture.database.getTargetExcludedEvaluation(variant.id);
    assert.equal(target?.status, 'failed');
    assert.match(target?.error ?? '', /archived before target evaluation completed/);
    assert.equal(await readFile(marker, 'utf8'), 'partial archive\n');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete archive mode remains fail-closed when stack reattach fails', async () => {
  const fixture = await v2LifecycleFixture('v2-archive-reattach-failure');
  try {
    const variant = fixture.database.updateVariant(fixture.variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
    });
    let stopped = false;
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      ensureFrozenPlannerSource: () => Promise<string>;
      archiveInterruptedIntegratedStack: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        options: {
          allowIncomplete: boolean;
          reattach: () => Promise<unknown>;
          collect: () => Promise<void>;
          stop: () => Promise<void>;
        },
      ) => Promise<VariantRecord>;
    };
    internal.ensureFrozenPlannerSource = async () => fixture.root;

    await assert.rejects(
      internal.archiveInterruptedIntegratedStack(fixture.campaign, variant, {
        allowIncomplete: true,
        reattach: async () => {
          throw new Error('reattach failed');
        },
        collect: async () => undefined,
        stop: async () => {
          stopped = true;
        },
      }),
      /reattach failed/,
    );
    assert.equal(stopped, false);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete archive mode remains fail-closed when stack stop fails', async () => {
  const fixture = await v2LifecycleFixture('v2-archive-stop-failure');
  try {
    const variant = fixture.database.updateVariant(fixture.variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
    });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      ensureFrozenPlannerSource: () => Promise<string>;
      archiveInterruptedIntegratedStack: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        options: {
          allowIncomplete: boolean;
          reattach: () => Promise<unknown>;
          collect: () => Promise<void>;
          stop: () => Promise<void>;
        },
      ) => Promise<VariantRecord>;
    };
    internal.ensureFrozenPlannerSource = async () => fixture.root;

    await assert.rejects(
      internal.archiveInterruptedIntegratedStack(fixture.campaign, variant, {
        allowIncomplete: true,
        reattach: async () => ({}),
        collect: async () => undefined,
        stop: async () => {
          throw new Error('stop failed');
        },
      }),
      /stop failed/,
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fulfilled V2 standard cohorts are persisted before a sibling cohort failure is raised', async () => {
  const fixture = await v2LifecycleFixture('v2-cohort-boundary');
  try {
    if (fixture.targetConfig.protocol !== 'standard-primary-v2') {
      throw new Error('fixture target config is not V2');
    }
    fixture.database.updateVariant(fixture.variant.id, {
      facts: null,
      replicateFacts: null,
      holdoutFacts: null,
      holdoutReplicateFacts: null,
    });
    const primarySummary = resolution('primary', fixture.targetConfig.primaryResolvedArtifactSha);
    const holdoutSummary = resolution('holdout', `sha256:${'d'.repeat(64)}`);
    const result = {
      facts: completedFacts(),
      replicates: [completedFacts(), completedFacts()],
      questions: [
        {
          questionId: 'runtime-question',
          prompt: 'Which shared boundary applies?',
          answer: 'Use the shared boundary.',
          resolution: 'source_fallback' as const,
          evidence: ['shared/source.ts:1'],
          requirementsAgentRequests: 0,
        },
      ],
    };
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      persistV2StandardOutcomes: (
        variantId: string,
        primary: Benchmark,
        holdouts: Benchmark[],
        summaries: Record<string, BenchmarkQuestionResolution>,
        outcomes: PromiseSettledResult<typeof result>[],
      ) => { failures: unknown[] };
    };

    const persisted = internal.persistV2StandardOutcomes(
      fixture.variant.id,
      fixture.campaign.config.benchmarks[0]!,
      [fixture.campaign.config.benchmarks[1]!],
      { primary: primarySummary, holdout: holdoutSummary },
      [
        { status: 'fulfilled', value: result },
        { status: 'rejected', reason: new Error('holdout failed') },
      ],
    );

    const variant = fixture.database.getVariant(fixture.variant.id);
    assert.equal(persisted.failures.length, 1);
    assert.deepEqual(variant.facts, result.facts);
    assert.deepEqual(variant.replicateFacts, result.replicates);
    assert.equal(variant.questionResolutions?.primary?.plannerQuestions, 1);
    assert.equal(variant.holdoutFacts, null);

    fixture.database.updateVariant(fixture.variant.id, {
      facts: null,
      replicateFacts: null,
      holdoutFacts: null,
      holdoutReplicateFacts: null,
    });
    internal.persistV2StandardOutcomes(
      fixture.variant.id,
      fixture.campaign.config.benchmarks[0]!,
      [fixture.campaign.config.benchmarks[1]!],
      {
        primary: resolution('primary', fixture.targetConfig.primaryResolvedArtifactSha),
        holdout: resolution('holdout', `sha256:${'d'.repeat(64)}`),
      },
      [
        { status: 'rejected', reason: new Error('primary failed') },
        { status: 'fulfilled', value: result },
      ],
    );
    const holdoutOnly = fixture.database.getVariant(fixture.variant.id);
    assert.equal(holdoutOnly.facts, null);
    assert.deepEqual(holdoutOnly.holdoutFacts?.holdout, result.facts);
    assert.deepEqual(holdoutOnly.holdoutReplicateFacts?.holdout, result.replicates);
    assert.equal(holdoutOnly.questionResolutions?.holdout?.plannerQuestions, 1);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('automatic V2 config persistence waits for standard cohorts and is atomic before teardown', async () => {
  const fixture = await v2LifecycleFixture('v2-config-boundary');
  try {
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      persistAutomaticV2Config: (
        campaign: CampaignRecord,
        config: TargetExcludedConfig,
      ) => Promise<TargetExcludedConfig>;
    };
    fixture.database.updateVariant(fixture.variant.id, {
      facts: null,
      replicateFacts: null,
      artifactCollectionComplete: false,
    });
    await assert.rejects(
      internal.persistAutomaticV2Config(fixture.campaign, fixture.targetConfig),
      /standard baseline facts and artifacts are not durable/,
    );
    assert.equal(fixture.database.getTargetExcludedConfig(fixture.campaign.id), null);
    assert.equal(
      await stat(path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json')).catch(
        () => null,
      ),
      null,
    );

    const facts = completedFacts();
    fixture.database.updateVariant(fixture.variant.id, {
      facts,
      replicateFacts: [facts, facts],
    });
    const persisted = await internal.persistAutomaticV2Config(
      fixture.campaign,
      fixture.targetConfig,
    );
    assert.deepEqual(persisted, fixture.targetConfig);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json'),
          'utf8',
        ),
      ),
      fixture.targetConfig,
    );
    assert.ok(
      (await readdir(path.join(fixture.paths.campaigns, fixture.campaign.id))).every(
        (name) => !name.includes('.tmp-'),
      ),
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('automatic V2 config recovers a sidecar-only durable baseline idempotently', async () => {
  const fixture = await v2LifecycleFixture('v2-sidecar-recovery');
  try {
    const sidecar = path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json');
    await writeFile(sidecar, `${JSON.stringify(fixture.targetConfig, null, 2)}\n`, { mode: 0o600 });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      recoverAutomaticV2Config: (
        campaign: CampaignRecord,
        dependencies: { runCommand: typeof runCommand },
      ) => Promise<TargetExcludedConfig | null>;
    };
    const dependencies = { runCommand: imageInspectCommand(fixture.targetConfig.comparatorImage) };

    const first = await internal.recoverAutomaticV2Config(fixture.campaign, dependencies);
    const second = await internal.recoverAutomaticV2Config(fixture.campaign, dependencies);

    assert.deepEqual(first, fixture.targetConfig);
    assert.deepEqual(second, fixture.targetConfig);
    assert.deepEqual(
      fixture.database.getTargetExcludedConfig(fixture.campaign.id),
      fixture.targetConfig,
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('automatic V2 config recovers a DB-only copy after comparator inspection', async () => {
  const fixture = await v2LifecycleFixture('v2-db-config-recovery');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      recoverAutomaticV2Config: (
        campaign: CampaignRecord,
        dependencies: { runCommand: typeof runCommand },
      ) => Promise<TargetExcludedConfig | null>;
    };

    const recovered = await internal.recoverAutomaticV2Config(fixture.campaign, {
      runCommand: imageInspectCommand(fixture.targetConfig.comparatorImage),
    });

    assert.deepEqual(recovered, fixture.targetConfig);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json'),
          'utf8',
        ),
      ),
      fixture.targetConfig,
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('DB-only V2 config fails closed on comparator digest mismatch without writing sidecar', async () => {
  const fixture = await v2LifecycleFixture('v2-db-config-mismatch');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      recoverAutomaticV2Config: (
        campaign: CampaignRecord,
        dependencies: { runCommand: typeof runCommand },
      ) => Promise<TargetExcludedConfig | null>;
    };

    await assert.rejects(
      internal.recoverAutomaticV2Config(fixture.campaign, {
        runCommand: imageInspectCommand(`sha256:${'0'.repeat(64)}`),
      }),
      /comparator image differs from the bound baseline test image/,
    );
    assert.equal(
      await stat(
        path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json'),
      ).catch(() => null),
      null,
    );
    assert.deepEqual(
      fixture.database.getTargetExcludedConfig(fixture.campaign.id),
      fixture.targetConfig,
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('sidecar-only V2 config fails closed on comparator mismatch without restoring DB copy', async () => {
  const fixture = await v2LifecycleFixture('v2-sidecar-config-mismatch');
  try {
    const sidecar = path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json');
    await writeFile(sidecar, `${JSON.stringify(fixture.targetConfig, null, 2)}\n`, { mode: 0o600 });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      recoverAutomaticV2Config: (
        campaign: CampaignRecord,
        dependencies: { runCommand: typeof runCommand },
      ) => Promise<TargetExcludedConfig | null>;
    };

    await assert.rejects(
      internal.recoverAutomaticV2Config(fixture.campaign, {
        runCommand: imageInspectCommand(`sha256:${'0'.repeat(64)}`),
      }),
      /comparator image differs from the bound baseline test image/,
    );
    assert.equal(fixture.database.getTargetExcludedConfig(fixture.campaign.id), null);
    assert.deepEqual(JSON.parse(await readFile(sidecar, 'utf8')), fixture.targetConfig);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('live target finalization selects integrated and standalone stack roots', () => {
  assert.equal(
    targetExcludedLiveStackDirectory('/artifacts/variant', 'running'),
    '/artifacts/variant',
  );
  assert.equal(
    targetExcludedLiveStackDirectory('/artifacts/variant', 'review'),
    '/artifacts/variant/target-excluded',
  );
  assert.equal(
    targetExcludedLiveStackDirectory('/artifacts/variant', 'completed'),
    '/artifacts/variant/target-excluded',
  );
});

test('integrated V1 finalization reads holdouts from the standard variant root', () => {
  assert.equal(
    targetExcludedControlHoldoutDirectory('/artifacts/variant', 'holdout', true),
    '/artifacts/variant/holdout',
  );
});

test('standalone V1 finalization reads holdouts from target-excluded control', () => {
  assert.equal(
    targetExcludedControlHoldoutDirectory('/artifacts/variant', 'holdout', false),
    '/artifacts/variant/target-excluded/control/holdout',
  );
});

test('target-excluded answer input accepts legacy and scoped requests', () => {
  assert.deepEqual(TargetExcludedAnswerInputSchema.parse({ answer: 'legacy answer' }), {
    answer: 'legacy answer',
  });
  assert.deepEqual(
    TargetExcludedAnswerInputSchema.parse({
      answer: 'scoped answer',
      benchmark: 'primary:excluded',
      replicate: 2,
    }),
    { answer: 'scoped answer', benchmark: 'primary:excluded', replicate: 2 },
  );
});

test('direct scoped waits with the same question ID resolve independently for distinct contexts', async () => {
  const fixture = await v2LifecycleFixture('v2-question-scope');
  try {
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    const orchestrator = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      waitForTargetExcludedAnswer: (
        variantId: string,
        targetWorkflow: string,
        benchmark: string,
        replicate: number,
        question: PlannerQuestionRecord,
      ) => Promise<{ answer: string }>;
      answerTargetExcludedQuestion: (
        campaignId: string,
        variantId: string,
        questionId: string,
        answer: string,
        selectedOptionId?: string,
        benchmark?: string,
        replicate?: number,
      ) => void;
      stop: (campaignId: string) => CampaignRecord;
    };
    const question: PlannerQuestionRecord = {
      id: 'same-question-id',
      createdByRunId: 'run-a',
      responseKind: 'free_text',
      prompt: 'Which shared boundary applies?',
      rationale: 'The source answer was unavailable.',
      context: {},
      status: 'open',
    };
    const normal = orchestrator.waitForTargetExcludedAnswer(
      fixture.variant.id,
      fixture.targetConfig.targetImplementationWorkflow,
      'primary',
      1,
      question,
    );
    const excluded = orchestrator.waitForTargetExcludedAnswer(
      fixture.variant.id,
      fixture.targetConfig.targetImplementationWorkflow,
      'primary:excluded',
      2,
      question,
    );

    assert.throws(
      () =>
        orchestrator.answerTargetExcludedQuestion(
          fixture.campaign.id,
          fixture.variant.id,
          question.id,
          'ambiguous legacy answer',
        ),
      /ambiguous target-excluded question.*benchmark and replicate/i,
    );
    orchestrator.answerTargetExcludedQuestion(
      fixture.campaign.id,
      fixture.variant.id,
      question.id,
      'normal answer',
      undefined,
      'primary',
      1,
    );
    assert.equal(
      fixture.database.getTargetExcludedEvaluation(fixture.variant.id)?.status,
      'waiting_for_input',
    );
    orchestrator.answerTargetExcludedQuestion(
      fixture.campaign.id,
      fixture.variant.id,
      question.id,
      'excluded answer',
      undefined,
      'primary:excluded',
      2,
    );
    assert.deepEqual(await Promise.all([normal, excluded]), [
      { answer: 'normal answer', resolution: 'human_answer', evidence: ['human operator answer'], requirementsAgentRequests: 0 },
      { answer: 'excluded answer', resolution: 'human_answer', evidence: ['human operator answer'], requirementsAgentRequests: 0 },
    ]);
    const waitingEvents = fixture.database
      .listEvents(fixture.campaign.id)
      .filter(({ type }) => type === 'target_excluded.question_waiting')
      .map(({ payload }) => payload as { benchmark: string; replicate: number });
    assert.deepEqual(
      waitingEvents.map(({ benchmark, replicate }) => ({ benchmark, replicate })),
      [
        { benchmark: 'primary', replicate: 1 },
        { benchmark: 'primary:excluded', replicate: 2 },
      ],
    );

    const stoppedNormal = orchestrator.waitForTargetExcludedAnswer(
      fixture.variant.id,
      fixture.targetConfig.targetImplementationWorkflow,
      'primary',
      2,
      { ...question, id: 'stop-question-id' },
    );
    const stoppedExcluded = orchestrator.waitForTargetExcludedAnswer(
      fixture.variant.id,
      fixture.targetConfig.targetImplementationWorkflow,
      'primary:excluded',
      1,
      { ...question, id: 'stop-question-id' },
    );
    orchestrator.stop(fixture.campaign.id);
    const stopped = await Promise.allSettled([stoppedNormal, stoppedExcluded]);
    assert.ok(stopped.every(({ status }) => status === 'rejected'));
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('paired semantic runtime questions share one scoped human fallback answer', async () => {
  const fixture = await v2LifecycleFixture('v2-question-parity');
  try {
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    const orchestrator = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      answerRuntimeQuestion: (
        campaign: CampaignRecord,
        question: PlannerQuestionRecord,
        consultations: unknown[],
        workflowsSource: string,
        artifactDirectory: string,
        answerCache: Map<string, unknown>,
        targetContext: {
          targetWorkflow: string;
          variantId: string;
          benchmark: string;
          replicate: number;
        },
      ) => Promise<{
        answer: string;
        selectedOptionId?: string;
        evidence: string[];
      }>;
      answerTargetExcludedQuestion: (
        campaignId: string,
        variantId: string,
        questionId: string,
        answer: string,
        selectedOptionId?: string,
        benchmark?: string,
        replicate?: number,
      ) => void;
    };
    const normalQuestion: PlannerQuestionRecord = {
      id: 'paired-question-id',
      createdByRunId: 'run-a',
      responseKind: 'single_select',
      prompt: 'Which shared boundary applies?',
      rationale: 'The source answer was disallowed.',
      context: {},
      options: [
        { id: 'normal-read', label: 'Shared boundary', description: 'Read-only boundary' },
        { id: 'normal-write', label: 'Shared boundary', description: 'Reviewed write boundary' },
      ],
      status: 'open',
    };
    const excludedQuestion: PlannerQuestionRecord = {
      ...normalQuestion,
      options: [
        { id: 'excluded-read', label: 'Shared boundary', description: 'Read-only boundary' },
        { id: 'excluded-write', label: 'Shared boundary', description: 'Reviewed write boundary' },
      ],
    };
    const cacheKey = runtimeQuestionCacheKey(normalQuestion);
    const legacyCacheKey = JSON.stringify({
      responseKind: normalQuestion.responseKind,
      prompt: normalQuestion.prompt,
      type: normalQuestion.type,
      ownerRole: normalQuestion.ownerRole,
      coverageIds: normalQuestion.coverageIds,
      options: normalQuestion.options?.map(({ label, description, consequences }) => ({
        label,
        description: description ?? consequences ?? '',
      })),
    });
    let resolveAutomated!: (answer: null) => void;
    const automated = new Promise<null>((resolve) => {
      resolveAutomated = resolve;
    });
    const answerCache = new Map<string, unknown>([
      [cacheKey, automated],
      [legacyCacheKey, automated],
    ]);
    const normal = orchestrator.answerRuntimeQuestion(
      fixture.campaign,
      normalQuestion,
      [],
      fixture.root,
      path.join(fixture.root, 'normal-questions'),
      answerCache,
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary',
        replicate: 1,
      },
    );
    const excluded = orchestrator.answerRuntimeQuestion(
      fixture.campaign,
      excludedQuestion,
      [],
      fixture.root,
      path.join(fixture.root, 'excluded-questions'),
      answerCache,
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary:excluded',
        replicate: 1,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolveAutomated(null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waitingEvents = fixture.database
      .listEvents(fixture.campaign.id)
      .filter(({ type }) => type === 'target_excluded.question_waiting');
    assert.equal(waitingEvents.length, 1);
    const owner = waitingEvents[0]!.payload as { benchmark: string; replicate: number };
    const ownerOption = owner.benchmark === 'primary' ? 'normal-write' : 'excluded-write';
    orchestrator.answerTargetExcludedQuestion(
      fixture.campaign.id,
      fixture.variant.id,
      normalQuestion.id,
      'This boundary is required by the reviewed operating model.',
      ownerOption,
      owner.benchmark,
      owner.replicate,
    );

    const answers = await Promise.all([normal, excluded]);
    assert.deepEqual(
      answers.map(({ answer, selectedOptionId, evidence }) => ({
        answer,
        selectedOptionId,
        evidence,
      })),
      [
        {
          answer: 'This boundary is required by the reviewed operating model.',
          selectedOptionId: 'normal-write',
          evidence: ['human operator answer'],
        },
        {
          answer: 'This boundary is required by the reviewed operating model.',
          selectedOptionId: 'excluded-write',
          evidence: ['human operator answer'],
        },
      ],
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached requirements-agent selection remaps semantic labels without exposing cache metadata', async () => {
  const fixture = await v2LifecycleFixture('v2-consultation-option-remap');
  try {
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      answerRuntimeQuestion: (
        campaign: CampaignRecord,
        question: PlannerQuestionRecord,
        consultations: unknown[],
        workflowsSource: string,
        artifactDirectory: string,
        answerCache: Map<string, unknown>,
        targetContext: {
          targetWorkflow: string;
          variantId: string;
          benchmark: string;
          replicate: number;
        },
      ) => Promise<Record<string, unknown>>;
    };
    const normalQuestion: PlannerQuestionRecord = {
      id: 'consultation-question',
      createdByRunId: 'consultation-run',
      responseKind: 'single_select',
      prompt: 'Choose the reviewed operating boundary.',
      rationale: 'A reviewed answer is required.',
      context: {},
      options: [{ id: 'normal-generated-id', label: 'Shared boundary' }],
      status: 'open',
    };
    const excludedQuestion: PlannerQuestionRecord = {
      ...normalQuestion,
      options: [{ id: 'excluded-generated-id', label: 'Shared boundary' }],
    };
    const answerCache = new Map<string, unknown>();
    const normal = await internal.answerRuntimeQuestion(
      fixture.campaign,
      normalQuestion,
      [
        {
          intent: {
            origin: { runId: normalQuestion.createdByRunId },
            request: { ask: normalQuestion.prompt },
          },
          outcome: {
            resolution: 'answered',
            answer: 'This option follows the reviewed operating model.',
            selectedOptionId: 'normal-generated-id',
            citations: [{ entity: 'solution/main', anchor: 'operating-boundary' }],
          },
        },
      ],
      fixture.root,
      path.join(fixture.root, 'consultation-normal'),
      answerCache,
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary',
        replicate: 1,
      },
    );
    const excluded = await internal.answerRuntimeQuestion(
      fixture.campaign,
      excludedQuestion,
      [],
      fixture.root,
      path.join(fixture.root, 'consultation-excluded'),
      answerCache,
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary:excluded',
        replicate: 1,
      },
    );

    assert.equal(normal.selectedOptionId, 'normal-generated-id');
    assert.equal(excluded.selectedOptionId, 'excluded-generated-id');
    assert.equal(normal.answer, excluded.answer);
    assert.deepEqual(normal.evidence, excluded.evidence);
    assert.equal('selectedOptionLabel' in normal, false);
    assert.equal('selectedOptionLabel' in excluded, false);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('runtime questions differing only in option consequences do not share cache entries', async () => {
  const fixture = await v2LifecycleFixture('v2-question-consequences');
  try {
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      answerRuntimeQuestion: (
        campaign: CampaignRecord,
        question: PlannerQuestionRecord,
        consultations: unknown[],
        workflowsSource: string,
        artifactDirectory: string,
        answerCache: Map<string, unknown>,
        targetContext: {
          targetWorkflow: string;
          variantId: string;
          benchmark: string;
          replicate: number;
        },
      ) => Promise<unknown>;
      answerTargetExcludedQuestion: (
        campaignId: string,
        variantId: string,
        questionId: string,
        answer: string,
        selectedOptionId?: string,
        benchmark?: string,
        replicate?: number,
      ) => void;
    };
    const normalQuestion: PlannerQuestionRecord = {
      id: 'consequence-question',
      createdByRunId: 'run-a',
      responseKind: 'free_text',
      prompt: 'Explain the selected boundary.',
      rationale: 'The consequences differ by arm.',
      context: {},
      options: [
        {
          id: 'normal-option',
          label: 'Shared boundary',
          description: 'Same description',
          consequences: 'Normal consequence',
        },
      ],
      status: 'open',
    };
    const excludedQuestion: PlannerQuestionRecord = {
      ...normalQuestion,
      options: [
        {
          id: 'excluded-option',
          label: 'Shared boundary',
          description: 'Same description',
          consequences: 'Excluded consequence',
        },
      ],
    };
    class NullSeedCache extends Map<string, unknown> {
      override get(key: string): unknown {
        if (!super.has(key)) super.set(key, Promise.resolve(null));
        return super.get(key);
      }
    }
    const answerCache = new NullSeedCache();
    const normal = internal.answerRuntimeQuestion(
      fixture.campaign,
      normalQuestion,
      [],
      fixture.root,
      path.join(fixture.root, 'consequence-normal'),
      answerCache,
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary',
        replicate: 1,
      },
    );
    const excluded = internal.answerRuntimeQuestion(
      fixture.campaign,
      excludedQuestion,
      [],
      fixture.root,
      path.join(fixture.root, 'consequence-excluded'),
      answerCache,
      {
        targetWorkflow: fixture.targetConfig.targetImplementationWorkflow,
        variantId: fixture.variant.id,
        benchmark: 'primary:excluded',
        replicate: 1,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = fixture.database
      .listEvents(fixture.campaign.id)
      .filter(({ type }) => type === 'target_excluded.question_waiting')
      .map(({ payload }) => payload as { benchmark: string; replicate: number });
    assert.equal(waiting.length, 2);
    for (const scope of waiting) {
      internal.answerTargetExcludedQuestion(
        fixture.campaign.id,
        fixture.variant.id,
        normalQuestion.id,
        `${scope.benchmark} rationale`,
        undefined,
        scope.benchmark,
        scope.replicate,
      );
    }
    await Promise.all([normal, excluded]);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('target-safe source rebuilds a snapshot left without its manifest', async () => {
  const value = await targetSnapshotFixture('v2-snapshot-only');
  try {
    await value.ensure();
    await rm(value.manifestPath);

    assert.equal(await value.ensure(), value.destination);
    assert.equal(await readFile(path.join(value.destination, 'README.md'), 'utf8'), 'shared source\n');
    assert.ok((await stat(value.manifestPath)).isFile());
    assert.equal(
      (JSON.parse(await readFile(value.manifestPath, 'utf8')) as { policyVersion?: number })
        .policyVersion,
      2,
    );
  } finally {
    value.fixture.database.close();
    await rm(value.fixture.root, { recursive: true, force: true });
  }
});

test('target-safe source rebuilds a manifest left without its snapshot', async () => {
  const value = await targetSnapshotFixture('v2-manifest-only');
  try {
    await value.ensure();
    await rm(value.destination, { recursive: true, force: true });

    assert.equal(await value.ensure(), value.destination);
    assert.equal(await readFile(path.join(value.destination, 'README.md'), 'utf8'), 'shared source\n');
    assert.ok((await stat(value.manifestPath)).isFile());
  } finally {
    value.fixture.database.close();
    await rm(value.fixture.root, { recursive: true, force: true });
  }
});

test('target-safe source rejects tampering when snapshot and manifest are complete', async () => {
  const value = await targetSnapshotFixture('v2-snapshot-tamper');
  try {
    await value.ensure();
    const sharedFile = path.join(value.destination, 'README.md');
    await rm(sharedFile);
    await writeFile(sharedFile, 'tampered source\n');

    await assert.rejects(value.ensure(), /snapshot failed manifest verification/);
    assert.equal(await readFile(sharedFile, 'utf8'), 'tampered source\n');
    assert.ok((await stat(value.manifestPath)).isFile());
  } finally {
    value.fixture.database.close();
    await rm(value.fixture.root, { recursive: true, force: true });
  }
});

test('target-safe source verifies a complete pair against the frozen source root', async () => {
  const value = await targetSnapshotFixture('v2-snapshot-source-drift');
  try {
    await value.ensure();
    await writeFile(path.join(value.sourceRoot, 'README.md'), 'changed frozen source\n');

    await assert.rejects(value.ensure(), /manifest differs from frozen source manifest/);
    assert.equal(
      await readFile(path.join(value.destination, 'README.md'), 'utf8'),
      'shared source\n',
    );
  } finally {
    value.fixture.database.close();
    await rm(value.fixture.root, { recursive: true, force: true });
  }
});

test('legacy target-safe source creates and reuses an unversioned V1 manifest', async () => {
  const value = await legacyTargetSnapshotFixture('v1-snapshot-policy');
  try {
    assert.equal(await value.ensure(), value.destination);
    const manifest = JSON.parse(await readFile(value.manifestPath, 'utf8')) as {
      policyVersion?: number;
    };
    assert.equal(manifest.policyVersion, undefined);

    assert.equal(await value.ensure(), value.destination);
    assert.equal(
      (JSON.parse(await readFile(value.manifestPath, 'utf8')) as { policyVersion?: number })
        .policyVersion,
      undefined,
    );
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('legacy archived comparisons tolerate only missing persisted lineage IDs', async () => {
  const value = await legacyTargetSnapshotFixture('v1-comparison-compatibility');
  try {
    const variant = value.database.createVariant({
      id: value.targetConfig.baselineVariantId,
      campaignId: value.campaign.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: baselineHypothesisForTest,
    });
    value.database.createTargetExcludedEvaluation(value.campaign.id, variant.id);
    const reports = [1, 2].map((replicate) =>
      validComparisonReport(
        `legacy-normal-${replicate}`,
        `legacy-excluded-${replicate}`,
        `legacy-normal-run-${replicate}`,
        `legacy-excluded-run-${replicate}`,
      ),
    );
    const archivedSummaries = reports.map((report, index) =>
      summarizeTargetExcludedComparisonReport(index + 1, report),
    );
    const persistedSummaries = archivedSummaries.map((summary) => ({
      ...summary,
      normalCaseId: null,
      excludedCaseId: null,
      normalRunId: null,
      excludedRunId: null,
    }));
    value.database.updateTargetExcludedEvaluation(variant.id, {
      comparisons: persistedSummaries,
    });
    const comparisonDirectory = path.join(
      value.paths.artifacts,
      value.campaign.id,
      variant.id,
      'target-excluded/comparisons',
    );
    await mkdir(comparisonDirectory, { recursive: true });
    await Promise.all(
      reports.map((report, index) =>
        writeFile(
          path.join(comparisonDirectory, `replicate-${index + 1}.json`),
          `${JSON.stringify(report)}\n`,
        ),
      ),
    );
    const internal = new CampaignOrchestrator(
      value.paths,
      value.database,
    ) as unknown as {
      verifyArchivedTargetExcludedComparisons: (
        campaign: CampaignRecord,
        variantId: string,
        config: TargetExcludedConfig,
        evaluation: NonNullable<ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>>,
      ) => Promise<void>;
    };

    await internal.verifyArchivedTargetExcludedComparisons(
      value.campaign,
      variant.id,
      value.targetConfig,
      value.database.getTargetExcludedEvaluation(variant.id)!,
    );

    value.database.updateTargetExcludedEvaluation(variant.id, {
      comparisons: [
        { ...persistedSummaries[0]!, mismatches: ['unexpected persisted mismatch'] },
        persistedSummaries[1]!,
      ],
    });
    await assert.rejects(
      internal.verifyArchivedTargetExcludedComparisons(
        value.campaign,
        variant.id,
        value.targetConfig,
        value.database.getTargetExcludedEvaluation(variant.id)!,
      ),
      /archived target-excluded comparison differs from persisted summary/,
    );

    value.database.updateTargetExcludedEvaluation(variant.id, {
      comparisons: persistedSummaries,
    });
    await writeFile(
      path.join(comparisonDirectory, 'replicate-1.json'),
      `${JSON.stringify({ ...reports[0], hash: `sha256:${'0'.repeat(64)}` })}\n`,
    );
    await assert.rejects(
      internal.verifyArchivedTargetExcludedComparisons(
        value.campaign,
        variant.id,
        value.targetConfig,
        value.database.getTargetExcludedEvaluation(variant.id)!,
      ),
      /comparison report hash does not bind its canonical content/,
    );
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('campaign-declared V2 blocks rounds when runtime config is missing', async () => {
  const fixture = await v2LifecycleFixture('v2-round-config-missing');
  try {
    const campaign = fixture.database.updateCampaign(fixture.campaign.id, {
      status: 'ready',
      currentParentVariantId: fixture.variant.id,
    });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      runRoundUnlocked: (campaignId: string) => Promise<VariantRecord[]>;
    };

    await assert.rejects(
      internal.runRoundUnlocked(campaign.id),
      /campaign-declared V2 runtime config is missing/,
    );
    assert.equal(fixture.database.getTargetExcludedConfig(campaign.id), null);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('campaign-declared V2 blocks promotion when runtime config is missing', async () => {
  const fixture = await v2LifecycleFixture('v2-promote-config-missing');
  try {
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      promoteUnlocked: (campaignId: string, variantId: string) => Promise<VariantRecord>;
    };

    await assert.rejects(
      internal.promoteUnlocked(fixture.campaign.id, fixture.variant.id),
      /campaign-declared V2 runtime config is missing/,
    );
    assert.equal(fixture.database.getTargetExcludedConfig(fixture.campaign.id), null);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('round restores sidecar-only V2 config before enforcing baseline readiness', async () => {
  const fixture = await v2LifecycleFixture('v2-round-sidecar-config');
  try {
    await writeFile(
      path.join(fixture.paths.campaigns, fixture.campaign.id, 'target-excluded.json'),
      `${JSON.stringify(fixture.targetConfig, null, 2)}\n`,
      { mode: 0o600 },
    );
    fixture.database.updateCampaign(fixture.campaign.id, {
      status: 'ready',
      currentParentVariantId: fixture.variant.id,
    });
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      runRoundUnlocked: (campaignId: string) => Promise<VariantRecord[]>;
      verifyAutomaticV2ComparatorImage: () => Promise<void>;
    };
    internal.verifyAutomaticV2ComparatorImage = async () => undefined;

    await assert.rejects(
      internal.runRoundUnlocked(fixture.campaign.id),
      /run a valid target-excluded baseline calibration before starting a round/,
    );
    assert.deepEqual(
      fixture.database.getTargetExcludedConfig(fixture.campaign.id),
      fixture.targetConfig,
    );
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('constructing another orchestrator does not mutate leased nonterminal evaluation state', async () => {
  const fixture = await v2LifecycleFixture('v2-constructor-lease');
  const leaseOwner = 'active-coordinator';
  try {
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, {
      status: 'running',
      startedAt: '2026-09-06T00:00:00.000Z',
      error: null,
    });
    assert.equal(
      fixture.database.acquireLease(fixture.campaign.id, leaseOwner, 90_000),
      true,
    );
    const before = JSON.stringify({
      campaign: fixture.database.getCampaign(fixture.campaign.id),
      variant: fixture.database.getVariant(fixture.variant.id),
      target: fixture.database.getTargetExcludedEvaluation(fixture.variant.id),
    });

    new CampaignOrchestrator(fixture.paths, fixture.database);

    const after = JSON.stringify({
      campaign: fixture.database.getCampaign(fixture.campaign.id),
      variant: fixture.database.getVariant(fixture.variant.id),
      target: fixture.database.getTargetExcludedEvaluation(fixture.variant.id),
    });
    assert.equal(after, before);
  } finally {
    fixture.database.releaseLease(fixture.campaign.id, leaseOwner);
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('baseline archived comparison failure marks its completed target evaluation retryable', async () => {
  const fixture = await v2LifecycleFixture('v2-baseline-integrity-failure');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, {
      status: 'completed',
      artifactCollectionComplete: true,
    });
    const integrityError = new Error('baseline archived comparison bytes are corrupt');
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      targetExcludedEvaluationReady: () => boolean;
      verifyArchivedTargetExcludedComparisons: () => Promise<void>;
      finalizeBaseline: (campaignId: string, variant: VariantRecord) => Promise<VariantRecord>;
      runTargetExcludedBackfill: (
        campaign: CampaignRecord,
        variant: VariantRecord,
        config: TargetExcludedConfig,
      ) => Promise<NonNullable<ReturnType<HarnessDatabase['getTargetExcludedEvaluation']>>>;
      refreshReports: () => Promise<void>;
    };
    internal.targetExcludedEvaluationReady = () => true;
    internal.verifyArchivedTargetExcludedComparisons = async () => {
      throw integrityError;
    };

    await assert.rejects(
      internal.finalizeBaseline(fixture.campaign.id, fixture.variant),
      (error) => error === integrityError,
    );
    const evaluation = fixture.database.getTargetExcludedEvaluation(fixture.variant.id);
    assert.equal(evaluation?.status, 'failed');
    assert.match(evaluation?.error ?? '', /comparison integrity failure.*bytes are corrupt/);
    internal.targetExcludedEvaluationReady = () => false;
    internal.refreshReports = async () => undefined;
    const retry = await internal.runTargetExcludedBackfill(
      fixture.campaign,
      fixture.variant,
      fixture.targetConfig,
    );
    assert.equal(retry.status, 'failed');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('round archived comparison failure marks the baseline target evaluation failed', async () => {
  const fixture = await v2LifecycleFixture('v2-round-integrity-failure');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, { status: 'completed' });
    fixture.database.updateCampaign(fixture.campaign.id, {
      status: 'ready',
      currentParentVariantId: fixture.variant.id,
    });
    const integrityError = new Error('round archived comparison bytes are missing');
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      recoverAutomaticV2Config: () => Promise<TargetExcludedConfig>;
      targetExcludedEvaluationReady: () => boolean;
      verifyArchivedTargetExcludedComparisons: () => Promise<void>;
      runRoundUnlocked: (campaignId: string) => Promise<VariantRecord[]>;
    };
    internal.recoverAutomaticV2Config = async () => fixture.targetConfig;
    internal.targetExcludedEvaluationReady = () => true;
    internal.verifyArchivedTargetExcludedComparisons = async () => {
      throw integrityError;
    };

    await assert.rejects(
      internal.runRoundUnlocked(fixture.campaign.id),
      (error) => error === integrityError,
    );
    const evaluation = fixture.database.getTargetExcludedEvaluation(fixture.variant.id);
    assert.equal(evaluation?.status, 'failed');
    assert.match(evaluation?.error ?? '', /comparison integrity failure.*bytes are missing/);
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('promotion archived comparison failure marks only the candidate target evaluation failed', async () => {
  const fixture = await v2LifecycleFixture('v2-promotion-integrity-failure');
  try {
    fixture.database.createTargetExcludedConfig(fixture.campaign.id, fixture.targetConfig);
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, fixture.variant.id);
    fixture.database.updateTargetExcludedEvaluation(fixture.variant.id, { status: 'completed' });
    const other = fixture.database.createVariant({
      id: `${fixture.campaign.id}-v001`,
      campaignId: fixture.campaign.id,
      parentVariantId: null,
      round: 1,
      ordinal: 1,
      hypothesis: baselineHypothesisForTest,
    });
    fixture.database.createTargetExcludedEvaluation(fixture.campaign.id, other.id);
    fixture.database.updateTargetExcludedEvaluation(other.id, { status: 'completed' });
    const integrityError = new Error('promotion archived comparison bytes were swapped');
    const internal = new CampaignOrchestrator(
      fixture.paths,
      fixture.database,
    ) as unknown as {
      recoverAutomaticV2Config: () => Promise<TargetExcludedConfig>;
      targetExcludedEvaluationReady: () => boolean;
      verifyArchivedTargetExcludedComparisons: () => Promise<void>;
      promoteUnlocked: (campaignId: string, variantId: string) => Promise<VariantRecord>;
    };
    internal.recoverAutomaticV2Config = async () => fixture.targetConfig;
    internal.targetExcludedEvaluationReady = () => true;
    internal.verifyArchivedTargetExcludedComparisons = async () => {
      throw integrityError;
    };

    await assert.rejects(
      internal.promoteUnlocked(fixture.campaign.id, fixture.variant.id),
      (error) => error === integrityError,
    );
    assert.equal(
      fixture.database.getTargetExcludedEvaluation(fixture.variant.id)?.status,
      'failed',
    );
    assert.equal(fixture.database.getTargetExcludedEvaluation(other.id)?.status, 'completed');
  } finally {
    fixture.database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
