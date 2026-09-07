import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { HarnessDatabase } from '../src/db.js';
import { computeScore, consensusRunFacts, extractRunFacts } from '../src/metrics.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import type { HarnessPaths } from '../src/paths.js';
import { runCommand } from '../src/process.js';
import { startDashboard } from '../src/server.js';
import type { JudgeOutput, PlannerUsage, RunFacts, VariantExecution } from '../src/types.js';

test.describe.configure({ mode: 'serial' });

let root: string;
let plannerRepo: string;
let workflowsRepo: string;
let environmentFile: string;
let primaryZip: string;
let holdoutZip: string;
let seedSha: string;
let workflowsSha: string;
let paths: HarnessPaths;
let database: HarnessDatabase;
let orchestrator: CampaignOrchestrator;
let server: Server;
let baseUrl: string;

const campaignId = 'ui-e2e';
const baselineId = 'ui-e2e-v000';
const liveId = 'ui-e2e-v001';
const reviewId = 'ui-e2e-v002';
const legacyCampaignId = 'legacy-ui-e2e';
const legacyLiveId = 'legacy-ui-e2e-v001';
const resolvedArtifactSha = `sha256:${'d'.repeat(64)}`;

async function gitFixture(directory: string, remote = false): Promise<string> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'README.md'), 'fixture\n');
  if (remote) {
    await mkdir(path.join(directory, 'src/shared'), { recursive: true });
    await mkdir(path.join(directory, 'src/customers/trumark/deceased-accounts'), { recursive: true });
    await writeFile(
      path.join(directory, 'src/shared/account.ts'),
      [
        'export interface Account {',
        '  accountId: string;',
        '  verified: boolean;',
        '}',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(directory, 'src/customers/trumark/deceased-accounts/index.ts'),
      'export const workflow = "deceased-accounts";\n',
    );
  }
  await runCommand('git', ['init'], { cwd: directory });
  await runCommand('git', ['add', '.'], { cwd: directory });
  await runCommand(
    'git',
    ['-c', 'user.name=Harness E2E', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'fixture'],
    { cwd: directory },
  );
  if (remote) {
    await runCommand('git', ['remote', 'add', 'origin', 'git@github.com:Saris-AI/workflows.git'], {
      cwd: directory,
    });
  }
  return (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
}

function runFacts(usage: PlannerUsage, decision: 'build' | 'reuse' = 'build'): RunFacts {
  const sourceRefs = decision === 'reuse' ? [{ path: 'src/shared/account.ts:2-3', symbol: 'accountId' }] : [];
  return extractRunFacts(
    {
      analysis: {
        requirementUnits: [
          {
            id: 'unit-a',
            ref: { entity: 'workflow', anchor: 'capture-a' },
            kind: 'field',
            semantics: JSON.stringify({
              kind: 'field',
              payload: { required: true, source: 'account record' },
              summary: 'Capture the verified account identifier.',
              title: 'Account identifier',
            }),
          },
        ],
        adjudications: [
          {
            requirementUnitId: 'unit-a',
            result: decision,
            confidence: 'high',
            rationale:
              decision === 'build'
                ? 'Frozen source contains no eligible implementation.'
                : 'Frozen source exposes the canonical identifier.',
            selectedCandidateIds: decision === 'reuse' ? ['account-id'] : [],
            sourceRefs,
            discoveredEvidence: sourceRefs,
            uncoveredSemantics: decision === 'build' ? ['Capture account identifier'] : [],
            shortlist: { candidates: decision === 'reuse' ? [{ id: 'account-id' }] : [] },
          },
        ],
      },
    },
    { runtime: { status: 'completed', pins: { sourceCommit: workflowsSha }, aggregateUsage: usage } },
  );
}

const primaryUsage = (): PlannerUsage => ({
  calls: 1,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  costUsd: 0.25,
  durationMs: 1_500,
});

const holdoutUsage = (): PlannerUsage => ({
  calls: 1,
  inputTokens: 80,
  outputTokens: 20,
  totalTokens: 100,
  costUsd: 0.2,
  durationMs: 1_000,
});

function execution(input: {
  benchmark: string;
  role: 'primary' | 'holdout';
  replicate: number;
  replicateCount?: number;
  status?: string;
  stage?: string;
  elapsedMs?: number;
  usage?: PlannerUsage;
  questions?: VariantExecution['questions'];
  completedUnits?: number;
  totalUnits?: number;
  decisions?: VariantExecution['decisions'];
}): VariantExecution {
  const completed = (input.status ?? 'completed') === 'completed';
  const elapsedMs = input.elapsedMs ?? 2_000;
  return {
    benchmark: input.benchmark,
    role: input.role,
    replicate: input.replicate,
    replicateCount: input.replicateCount ?? 2,
    caseId: `case-${input.benchmark}-${input.replicate}`,
    runId: `run-${input.benchmark}-${input.replicate}`,
    status: input.status ?? 'completed',
    stage: input.stage ?? (completed ? 'completed' : 'adjudicating'),
    progress: {
      completedUnits: input.completedUnits ?? (completed ? 1 : 0),
      totalUnits: input.totalUnits ?? 1,
    },
    decisions: input.decisions ?? { build: completed ? 1 : 0, reuse: 0, extend: 0, defer: 0, question: 0 },
    questions: input.questions ?? [],
    startedAt: completed
      ? '2026-09-06T05:00:00.000Z'
      : new Date(Date.now() - elapsedMs).toISOString(),
    completedAt: completed ? '2026-09-06T05:00:02.000Z' : null,
    elapsedMs,
    usage: input.usage ?? (input.role === 'primary' ? primaryUsage() : holdoutUsage()),
    updatedAt: completed ? '2026-09-06T05:00:02.000Z' : '2026-09-06T05:01:00.000Z',
  };
}

async function seedCampaign(): Promise<void> {
  const campaign = await orchestrator.initializeFromInput({
    id: campaignId,
    goal: 'Validate source-backed Phase 2 experiment results through a routed research console.',
    plannerRepo,
    workflowsRepo,
    environmentFile,
    seedRevision: seedSha,
    workflowsRevision: workflowsSha,
    benchmarks: [
      { name: 'primary-pack', role: 'primary', zipPath: primaryZip },
      { name: 'holdout-pack', role: 'holdout', zipPath: holdoutZip },
    ],
    targetExcluded: {
      protocol: 'standard-primary-v2',
      targetImplementationWorkflow: 'trumark/deceased-accounts',
    },
    mode: 'supervised',
    evaluation: { replicates: 2, replicateConcurrency: 2 },
    limits: { concurrency: 3, maxVariants: 9 },
  });
  const judgment: JudgeOutput = {
    summary: 'The source inspection supports a genuine build gap.',
    verdicts: [
      {
        unitKey: 'unit-a',
        expectedDecision: 'build',
        classification: 'real_gap',
        confidence: 'high',
        rationale: 'No existing source behavior captures this identifier.',
        evidence: ['src/shared/account.ts:2-3 defines the verified account identifier.'],
      },
    ],
  };
  database.upsertLabel({
    campaignId,
    benchmark: 'primary-pack',
    unitKey: 'unit-a',
    expectedDecision: 'build',
    classification: 'real_gap',
    rationale: judgment.verdicts[0]!.rationale,
    status: 'suggested',
  });

  const primaryReplicates = [runFacts(primaryUsage()), runFacts(primaryUsage())];
  const holdoutReplicates = [runFacts(holdoutUsage(), 'reuse'), runFacts(holdoutUsage(), 'reuse')];
  const baselineFacts = consensusRunFacts(primaryReplicates);
  const baselineHoldout = consensusRunFacts(holdoutReplicates);
  const baseline = database.createVariant({
    id: baselineId,
    campaignId,
    parentVariantId: null,
    round: 0,
    ordinal: 0,
    hypothesis: {
      title: 'Seed observation',
      rationale: 'Establish a factual baseline.',
      instructions: 'No changes.',
      expectedImpact: 'One reviewed source gap.',
      risk: 'Provider variance.',
      findingIds: [],
    },
  });
  database.updateVariant(baseline.id, {
    status: 'completed',
    artifactCollectionComplete: true,
    facts: baselineFacts,
    replicateFacts: primaryReplicates,
    holdoutFacts: { 'holdout-pack': baselineHoldout },
    holdoutReplicateFacts: { 'holdout-pack': holdoutReplicates },
    judgment,
    holdoutJudgments: { 'holdout-pack': judgment },
    score: computeScore(baselineFacts, database.listLabels(campaignId, 'primary-pack'), judgment),
    holdoutScores: {
      'holdout-pack': computeScore(baselineHoldout, [], judgment),
    },
    questionResolutions: {
      'primary-pack': {
        derivationVersion: 2,
        benchmark: 'primary-pack',
        originalArtifactSha: `sha256:${'c'.repeat(64)}`,
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
        entries: [],
      },
    },
    startedAt: '2026-09-06T05:00:00.000Z',
    completedAt: '2026-09-06T05:00:20.000Z',
    elapsedMs: 20_000,
    phase2StartedAt: '2026-09-06T05:00:03.000Z',
    phase2CompletedAt: '2026-09-06T05:00:18.000Z',
    phase2ElapsedMs: 15_000,
    executionState: {
      executions: [
        execution({
          benchmark: 'primary-pack',
          role: 'primary',
          replicate: 1,
          questions: [
            {
              id: 'duplicate-question',
              type: 'target_scope',
              ownerRole: 'product',
              priority: 'blocking',
              prompt: 'Which primary account identifier format should be used?',
              rationale: 'The primary pack does not define presentation.',
              status: 'answered',
              answer: 'Use the canonical source-backed identifier.',
              resolution: 'source_fallback',
              evidence: ['src/shared/account.ts:12'],
              createdAt: '2026-09-06T04:58:00.000Z',
              updatedAt: '2026-09-06T04:59:00.000Z',
            },
          ],
        }),
        execution({ benchmark: 'primary-pack', role: 'primary', replicate: 2 }),
        execution({
          benchmark: 'holdout-pack',
          role: 'holdout',
          replicate: 1,
          questions: [
            {
              id: 'duplicate-question',
              type: 'target_scope',
              ownerRole: 'product',
              priority: 'blocking',
              prompt: 'Which holdout identifier format should be used?',
              rationale: 'The holdout pack uses an independent source.',
              status: 'answered',
              answer: 'Use the holdout canonical identifier.',
              resolution: 'requirements_agent',
              evidence: ['src/holdout/id.ts:8'],
              createdAt: '2026-09-06T04:58:30.000Z',
              updatedAt: '2026-09-06T04:59:30.000Z',
            },
          ],
        }),
        execution({ benchmark: 'holdout-pack', role: 'holdout', replicate: 2 }),
      ],
    },
  });

  const livePrimary = runFacts(primaryUsage());
  const liveHoldout = runFacts(holdoutUsage(), 'reuse');
  const live = database.createVariant({
    id: liveId,
    campaignId,
    parentVariantId: baselineId,
    round: 1,
    ordinal: 1,
    hypothesis: {
      title: 'Live source policy',
      rationale: 'Exercise stable checkpoint projection.',
      instructions: 'Prefer source-backed reuse.',
      expectedImpact: 'More source-backed decisions.',
      risk: 'Partial output may change.',
      findingIds: [],
    },
  });
  database.updateVariant(live.id, {
    status: 'running',
    replicateFacts: [livePrimary],
    holdoutReplicateFacts: { 'holdout-pack': [liveHoldout] },
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    phase2StartedAt: new Date(Date.now() - 8_000).toISOString(),
    executionState: {
      executions: [
        execution({ benchmark: 'primary-pack', role: 'primary', replicate: 1, elapsedMs: 2_500 }),
        execution({
          benchmark: 'primary-pack',
          role: 'primary',
          replicate: 2,
          status: 'running',
          stage: 'adjudicating',
          elapsedMs: 4_000,
          completedUnits: 2,
          totalUnits: 5,
          decisions: { build: 1, reuse: 1, extend: 0, defer: 0, question: 0 },
          questions: [
            {
              id: 'shared-target-question',
              type: 'target_scope',
              ownerRole: 'product',
              priority: 'blocking',
              prompt: 'Which policy applies to the standard primary run?',
              rationale: 'The normal arm requires a scoped product answer.',
              status: 'open',
              answer: null,
              resolution: null,
              evidence: [],
              createdAt: '2026-09-06T05:01:00.000Z',
              updatedAt: '2026-09-06T05:01:00.000Z',
            },
          ],
          usage: {
            calls: 2,
            inputTokens: 500,
            outputTokens: 100,
            totalTokens: 600,
            costUsd: 0.5,
            durationMs: 3_000,
          },
        }),
        execution({ benchmark: 'holdout-pack', role: 'holdout', replicate: 1, elapsedMs: 1_800 }),
      ],
    },
  });

  const review = database.createVariant({
    id: reviewId,
    campaignId,
    parentVariantId: baselineId,
    round: 1,
    ordinal: 2,
    hypothesis: {
      title: 'Candidate source guard',
      rationale: 'Keep generic source eligibility explicit.',
      instructions: 'Add a bounded source guard.',
      expectedImpact: 'Reduce unsupported reuse.',
      risk: 'May reject a valid candidate.',
      findingIds: [],
    },
  });
  database.updateVariant(review.id, {
    status: 'review',
    artifactCollectionComplete: true,
    facts: baselineFacts,
    replicateFacts: primaryReplicates,
    holdoutFacts: { 'holdout-pack': baselineHoldout },
    holdoutReplicateFacts: { 'holdout-pack': holdoutReplicates },
    holdoutJudgments: { 'holdout-pack': judgment },
    holdoutScores: {
      'holdout-pack': computeScore(baselineHoldout, [], judgment),
    },
    judgment,
    score: computeScore(baselineFacts, database.listLabels(campaignId, 'primary-pack'), judgment),
    questionResolutions: {
      'primary-pack': {
        derivationVersion: 2,
        benchmark: 'primary-pack',
        originalArtifactSha: `sha256:${'c'.repeat(64)}`,
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
        entries: [],
      },
    },
    elapsedMs: 18_000,
    phase2ElapsedMs: 13_000,
    executionState: database.getVariant(baseline.id).executionState,
  });

  database.createTargetExcludedConfig(campaignId, {
    protocol: 'standard-primary-v2',
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: baseline.id,
    comparatorImage: `sha256:${'a'.repeat(64)}`,
    configuredAt: '2026-09-06T05:00:00.000Z',
    normalArmSource: 'standard_primary',
    primaryResolvedArtifactSha: resolvedArtifactSha,
  });
  const excludedReplicates = [runFacts(primaryUsage()), runFacts(primaryUsage())];
  const excludedFacts = consensusRunFacts(excludedReplicates);
  database.createTargetExcludedEvaluation(campaignId, baseline.id);
  database.updateTargetExcludedEvaluation(baseline.id, {
    status: 'completed',
    excludedFacts,
    excludedReplicateFacts: excludedReplicates,
    judgment,
    score: computeScore(excludedFacts, [], judgment),
    comparisons: [
      {
        replicate: 1,
        normalCaseId: 'case-primary-pack-1',
        excludedCaseId: 'case-primary-pack:excluded-1',
        normalRunId: 'run-primary-pack-1',
        excludedRunId: 'run-primary-pack:excluded-1',
        valid: true,
        mismatches: [],
        leakagePaths: [],
        reportHash: `sha256:${'b'.repeat(64)}`,
      },
      {
        replicate: 2,
        normalCaseId: 'case-primary-pack-2',
        excludedCaseId: 'case-primary-pack:excluded-2',
        normalRunId: 'run-primary-pack-2',
        excludedRunId: 'run-primary-pack:excluded-2',
        valid: true,
        mismatches: [],
        leakagePaths: [],
        reportHash: `sha256:${'c'.repeat(64)}`,
      },
    ],
    gate: {
      status: 'passed',
      baselineMeanBuildRate: 1,
      candidateMeanBuildRate: 1,
      buildDropRatio: 0,
      reasons: [],
    },
    artifactCollectionComplete: true,
    normalArmBinding: {
      source: 'standard_primary',
      benchmark: 'primary-pack',
      resolvedArtifactSha,
      replicates: [
        { replicate: 1, caseId: 'case-primary-pack-1', runId: 'run-primary-pack-1' },
        { replicate: 2, caseId: 'case-primary-pack-2', runId: 'run-primary-pack-2' },
      ],
    },
    executionState: {
      executions: [
        execution({ benchmark: 'primary-pack:excluded', role: 'primary', replicate: 1 }),
        execution({ benchmark: 'primary-pack:excluded', role: 'primary', replicate: 2 }),
      ],
    },
    startedAt: '2026-09-06T05:00:00.000Z',
    completedAt: '2026-09-06T05:00:10.000Z',
  });
  database.createTargetExcludedEvaluation(campaignId, live.id);
  database.updateTargetExcludedEvaluation(live.id, {
    status: 'running',
    executionState: {
      executions: [
        execution({
          benchmark: 'primary-pack:excluded',
          role: 'primary',
          replicate: 1,
          replicateCount: 2,
          status: 'running',
          stage: 'adjudicating',
          elapsedMs: 3_500,
          completedUnits: 1,
          totalUnits: 5,
          decisions: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
          questions: [
            {
              id: 'shared-target-question',
              type: 'target_scope',
              ownerRole: 'product',
              priority: 'blocking',
              prompt: 'Which policy applies to the target-excluded run?',
              rationale: 'The excluded arm requires an independently scoped answer.',
              status: 'open',
              answer: null,
              resolution: null,
              evidence: [],
              createdAt: '2026-09-06T05:01:00.000Z',
              updatedAt: '2026-09-06T05:01:00.000Z',
            },
          ],
        }),
      ],
    },
    startedAt: new Date(Date.now() - 5_000).toISOString(),
  });
  database.createTargetExcludedEvaluation(campaignId, review.id);
  database.updateTargetExcludedEvaluation(review.id, {
    status: 'completed',
    excludedFacts,
    excludedReplicateFacts: excludedReplicates,
    judgment,
    score: computeScore(excludedFacts, [], judgment),
    questionResolution: {
      derivationVersion: 2,
      benchmark: 'primary-pack',
      originalArtifactSha: `sha256:${'c'.repeat(64)}`,
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
      entries: [],
    },
    comparisons: [
      {
        replicate: 1,
        normalCaseId: 'case-primary-pack-1',
        excludedCaseId: 'case-primary-pack:excluded-1',
        normalRunId: 'run-primary-pack-1',
        excludedRunId: 'run-primary-pack:excluded-1',
        valid: true,
        mismatches: [],
        leakagePaths: [],
        reportHash: `sha256:${'4'.repeat(64)}`,
      },
      {
        replicate: 2,
        normalCaseId: 'case-primary-pack-2',
        excludedCaseId: 'case-primary-pack:excluded-2',
        normalRunId: 'run-primary-pack-2',
        excludedRunId: 'run-primary-pack:excluded-2',
        valid: true,
        mismatches: [],
        leakagePaths: [],
        reportHash: `sha256:${'5'.repeat(64)}`,
      },
    ],
    gate: {
      status: 'passed',
      baselineMeanBuildRate: 1,
      candidateMeanBuildRate: 1,
      buildDropRatio: 0,
      reasons: [],
    },
    normalArmBinding: {
      source: 'standard_primary',
      benchmark: 'primary-pack',
      resolvedArtifactSha,
      replicates: [
        { replicate: 1, caseId: 'case-primary-pack-1', runId: 'run-primary-pack-1' },
        { replicate: 2, caseId: 'case-primary-pack-2', runId: 'run-primary-pack-2' },
      ],
    },
    executionState: {
      executions: [
        execution({ benchmark: 'primary-pack:excluded', role: 'primary', replicate: 1 }),
        execution({ benchmark: 'primary-pack:excluded', role: 'primary', replicate: 2 }),
      ],
    },
    artifactCollectionComplete: true,
  });
  database.updateVariant(review.id, {
    diagnosisStatus: 'completed',
    diagnosisInputHash: `sha256:${'8'.repeat(64)}`,
    diagnosisResultHash: `sha256:${'9'.repeat(64)}`,
  });
  database.updateCampaign(campaign.id, {
    status: 'running_round',
    currentParentVariantId: baseline.id,
  });
  const artifactRoot = path.join(paths.artifacts, campaignId, baselineId);
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(path.join(artifactRoot, 'planner-output.json'), '{"status":"completed"}\n');
  await orchestrator.refreshReports(campaignId);
}

async function seedLegacyCampaign(): Promise<void> {
  const campaign = await orchestrator.initializeFromInput({
    id: legacyCampaignId,
    goal: 'Preserve the dedicated-control V1 target-excluded campaign display for historical records.',
    plannerRepo,
    workflowsRepo,
    environmentFile,
    seedRevision: seedSha,
    workflowsRevision: workflowsSha,
    benchmarks: [
      { name: 'legacy-primary', role: 'primary', zipPath: primaryZip },
      { name: 'legacy-holdout', role: 'holdout', zipPath: holdoutZip },
    ],
    mode: 'supervised',
    evaluation: { replicates: 3, replicateConcurrency: 2 },
    limits: { concurrency: 3, maxVariants: 9 },
  });
  const live = database.createVariant({
    id: legacyLiveId,
    campaignId: campaign.id,
    parentVariantId: null,
    round: 1,
    ordinal: 1,
    hypothesis: {
      title: 'Legacy target guard',
      rationale: 'Exercise the archived dedicated-control display.',
      instructions: 'No changes.',
      expectedImpact: 'Historical telemetry remains legible.',
      risk: 'None.',
      findingIds: [],
    },
  });
  database.updateVariant(live.id, { status: 'running' });
  database.createTargetExcludedConfig(campaign.id, {
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: live.id,
    comparatorImage: `sha256:${'e'.repeat(64)}`,
    configuredAt: '2026-09-06T05:00:00.000Z',
  });
  database.createTargetExcludedEvaluation(campaign.id, live.id);
  database.updateTargetExcludedEvaluation(live.id, {
    status: 'running',
    executionState: {
      executions: [
        execution({
          benchmark: 'legacy-primary:control',
          role: 'primary',
          replicate: 1,
          status: 'running',
        }),
      ],
    },
  });
  database.updateCampaign(campaign.id, { status: 'running_round' });
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-ui-'));
  plannerRepo = path.join(root, 'planner');
  workflowsRepo = path.join(root, 'workflows');
  [seedSha, workflowsSha] = await Promise.all([
    gitFixture(plannerRepo),
    gitFixture(workflowsRepo, true),
  ]);
  environmentFile = path.join(root, 'planner.env');
  primaryZip = path.join(root, 'primary.zip');
  holdoutZip = path.join(root, 'holdout.zip');
  await Promise.all([
    writeFile(environmentFile, 'OPENAI_MODEL=gpt-5.6-sol\n'),
    writeFile(primaryZip, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('primary requirements')])),
    writeFile(holdoutZip, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('holdout requirements')])),
  ]);
  const data = path.join(root, 'data');
  paths = {
    root: data,
    database: path.join(data, 'harness.sqlite'),
    campaigns: path.join(data, 'campaigns'),
    worktrees: path.join(data, 'worktrees'),
    artifacts: path.join(data, 'artifacts'),
    reports: path.join(root, 'docs/experiments'),
  };
  await mkdir(data);
  database = new HarnessDatabase(paths.database);
  orchestrator = new CampaignOrchestrator(paths, database);
  await seedCampaign();
  await seedLegacyCampaign();
  const frozenWorkflows = path.join(paths.worktrees, campaignId, 'frozen-workflows');
  await mkdir(path.dirname(frozenWorkflows), { recursive: true });
  await runCommand('git', ['worktree', 'add', '--detach', frozenWorkflows, workflowsSha], {
    cwd: workflowsRepo,
  });
  server = startDashboard({
    port: 0,
    publicDirectory: path.resolve(process.cwd(), 'public'),
    database,
    orchestrator,
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('dashboard did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  database.close();
  await rm(root, { recursive: true, force: true });
});

test('serves valid HTML deep links and never falls back for APIs or extensions', async ({ request }) => {
  const deepLink = await request.get(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=runs`);
  expect(deepLink.status()).toBe(200);
  expect(deepLink.headers()['content-type']).toContain('text/html');
  expect(await deepLink.text()).toContain('<div id="app">');

  const head = await request.fetch(`${baseUrl}/campaigns/${campaignId}/review/${baselineId}`, { method: 'HEAD' });
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);

  const invalidFile = await request.get(`${baseUrl}/campaigns/${campaignId}/overview.js`);
  expect(invalidFile.status()).toBe(404);
  expect(invalidFile.headers()['content-type']).toContain('application/json');
  const invalidApi = await request.get(`${baseUrl}/api/not-a-route`);
  expect(invalidApi.status()).toBe(404);
  const nonHtmlDeepLink = await request.get(`${baseUrl}/campaigns/${campaignId}/overview`, {
    headers: { Accept: 'application/json' },
  });
  expect(nonHtmlDeepLink.status()).toBe(404);
});

test('opens review evidence at the cited lines in the frozen workflows source', async ({ page, request }) => {
  const unsafe = await request.get(
    `${baseUrl}/campaigns/${campaignId}/source?path=${encodeURIComponent('../planner/README.md')}&lines=1`,
  );
  expect(unsafe.status()).toBe(400);

  await page.goto(
    `${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=primary-pack&filter=all&unit=unit-a`,
  );
  const judgeEvidence = page.locator('.evidence-block.suggestion');
  const judgeLink = judgeEvidence.getByRole('link', { name: 'src/shared/account.ts:2-3' });
  await expect(judgeLink).toHaveAttribute('target', '_blank');

  const popupPromise = page.waitForEvent('popup');
  await judgeLink.click();
  const sourcePage = await popupPromise;
  await expect(sourcePage).toHaveURL(/\/campaigns\/ui-e2e\/source\?.*#L2$/);
  await expect(sourcePage.getByRole('heading', { name: 'src/shared/account.ts' })).toBeVisible();
  await expect(sourcePage.locator('#L2')).toHaveClass(/source-line-selected/);
  await expect(sourcePage.locator('#L3')).toHaveClass(/source-line-selected/);
  await expect(sourcePage.locator('#L2')).toBeInViewport();
  await sourcePage.close();

  await page.goto(
    `${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=holdout-pack&filter=all&unit=unit-a`,
  );
  const plannerEvidence = page.locator('.evidence-block').first();
  await expect(plannerEvidence.getByRole('link', { name: 'src/shared/account.ts:2-3' })).toBeVisible();
});

test('hides V2 promotion while its runtime target config is absent', async ({ page }) => {
  const response = await page.request.get(`${baseUrl}/api/campaigns/${campaignId}`);
  const details = await response.json();
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${reviewId}`);
  await expect(page.getByRole('button', { name: 'Promote experiment' })).toBeVisible();
  const eligibleWithoutConfig = await page.evaluate(async ({ details, reviewId }) => {
    const modelsPath = '/models.js';
    const { isPromotionEligible } = await import(modelsPath);
    const campaign = {
      ...details.campaign,
      variants: details.variants,
      targetExcludedConfig: null,
      targetExcludedEvaluations: details.targetExcludedEvaluations,
    };
    const variant = details.variants.find(
      (candidate: { id: string }) => candidate.id === reviewId,
    );
    return isPromotionEligible(campaign, details.variants, variant);
  }, { details, reviewId });
  expect(eligibleWithoutConfig).toBe(false);

  await page.route(`${baseUrl}/api/campaigns/${campaignId}`, async (route) => {
    await route.fulfill({
      json: { ...details, targetExcludedConfig: null },
    });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Promote experiment' })).toHaveCount(0);
});

test('hides V2 promotion when execution metadata or case lineage does not match', async ({ page }) => {
  const standardExecutionState = database.getVariant(reviewId).executionState;
  const evaluation = database.getTargetExcludedEvaluation(reviewId);
  if (!standardExecutionState || !evaluation?.executionState || !evaluation.comparisons) {
    throw new Error('eligible V2 fixture is incomplete');
  }
  const expectPromotion = async (visible: boolean): Promise<void> => {
    await page.reload();
    const promotion = page.getByRole('button', { name: 'Promote experiment' });
    if (visible) await expect(promotion).toBeVisible();
    else await expect(promotion).toHaveCount(0);
  };

  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${reviewId}`);
  await expect(page.getByRole('button', { name: 'Promote experiment' })).toBeVisible();

  database.updateVariant(reviewId, {
    executionState: { executions: [...standardExecutionState.executions].reverse() },
  });
  await expectPromotion(false);
  database.updateVariant(reviewId, { executionState: standardExecutionState });
  await expectPromotion(true);

  database.updateVariant(reviewId, {
    executionState: {
      executions: standardExecutionState.executions.map((execution) =>
        execution.benchmark === 'primary-pack' && execution.replicate === 1
          ? { ...execution, replicateCount: 3, status: 'running' }
          : execution,
      ),
    },
  });
  await expectPromotion(false);
  database.updateVariant(reviewId, { executionState: standardExecutionState });
  await expectPromotion(true);

  database.updateTargetExcludedEvaluation(reviewId, {
    executionState: { executions: [...evaluation.executionState.executions].reverse() },
  });
  await expectPromotion(false);
  database.updateTargetExcludedEvaluation(reviewId, {
    executionState: evaluation.executionState,
  });
  await expectPromotion(true);

  database.updateTargetExcludedEvaluation(reviewId, {
    executionState: {
      executions: evaluation.executionState.executions.map((execution) =>
        execution.replicate === 1 ? { ...execution, replicateCount: 3 } : execution,
      ),
    },
  });
  await expectPromotion(false);
  database.updateTargetExcludedEvaluation(reviewId, {
    executionState: evaluation.executionState,
  });
  await expectPromotion(true);

  database.updateTargetExcludedEvaluation(reviewId, {
    comparisons: [
      { ...evaluation.comparisons[0]!, reportHash: 'invalid-report-hash' },
      evaluation.comparisons[1]!,
    ],
  });
  await expectPromotion(false);
  database.updateTargetExcludedEvaluation(reviewId, { comparisons: evaluation.comparisons });
  await expectPromotion(true);

  database.updateTargetExcludedEvaluation(reviewId, {
    comparisons: [
      { ...evaluation.comparisons[0]!, normalRunId: 'mismatched-normal-run' },
      evaluation.comparisons[1]!,
    ],
  });
  await expectPromotion(false);
  database.updateTargetExcludedEvaluation(reviewId, { comparisons: evaluation.comparisons });
  await expectPromotion(true);

  database.updateTargetExcludedEvaluation(reviewId, {
    comparisons: [
      { ...evaluation.comparisons[0]!, excludedRunId: 'mismatched-excluded-run' },
      evaluation.comparisons[1]!,
    ],
  });
  await expectPromotion(false);
  database.updateTargetExcludedEvaluation(reviewId, { comparisons: evaluation.comparisons });
  await expectPromotion(true);

  database.updateTargetExcludedEvaluation(reviewId, {
    normalArmBinding: {
      source: 'standard_primary',
      benchmark: 'primary-pack',
      resolvedArtifactSha,
      replicates: [
        { replicate: 1, caseId: 'mismatched-normal-case', runId: 'run-primary-pack-1' },
        { replicate: 2, caseId: 'case-primary-pack-2', runId: 'run-primary-pack-2' },
      ],
    },
  });
  await expectPromotion(false);
});

test('shows the immutable two-run target-excluded guard and separate review truth', async ({ page }) => {
  database.updateTargetExcludedEvaluation(baselineId, { status: 'failed' });
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=target-excluded`);
  await expect(page.getByText('trumark/deceased-accounts')).toBeVisible();
  await expect(page.getByText('2 excluded replicates · concurrency 2')).toBeVisible();
  await expect(page.getByText(/standard primary is the comparison control/i)).toBeVisible();
  const targetRuns = page.getByRole('table', { name: 'Target-excluded guard execution runs' });
  await expect(targetRuns.getByRole('columnheader')).toHaveCount(5);
  await expect(targetRuns.getByRole('rowheader')).toHaveCount(2);
  await expect(page.getByText('Disposition profile')).toBeVisible();
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  for (const decision of ['Build', 'Reuse', 'Extend', 'Defer', 'Question']) {
    await expect(
      page.locator(`.counterfactual-decisions .decision-code-${decision.toLowerCase()}`).first(),
    ).toHaveText(decision);
  }
  const retry = page.getByRole('button', { name: 'Retry complete evaluation' });
  await expect(retry).toBeVisible();
  await expect(retry).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  database.updateTargetExcludedEvaluation(baselineId, { status: 'completed' });

  await page.getByRole('link', { name: 'Review excluded requirements' }).click();
  await expect(page).toHaveURL(/scope=target-excluded/);
  await expect(page.getByLabel('Select benchmark')).toHaveValue('target-excluded');
  await page.getByRole('button', { name: /field · capture-a/ }).click();
  await page.getByLabel('Human rationale').fill('Verified only against the filtered source snapshot.');
  await page.getByRole('button', { name: 'Save verified truth' }).click();
  await expect(page.getByText('verified', { exact: true })).toBeVisible();
});

test('keeps V2 target answers distinct across standard and excluded execution scopes', async ({ page }) => {
  const payloads: unknown[] = [];
  await page.route(
    `**/api/campaigns/${campaignId}/variants/${liveId}/target-excluded/questions/shared-target-question/answer`,
    async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"saved":true}',
      });
    },
  );
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${liveId}?tab=target-excluded`);

  const normal = page.locator(
    '.counterfactual-question[data-question-benchmark="primary-pack"][data-question-replicate="2"]',
  );
  const excluded = page.locator(
    '.counterfactual-question[data-question-benchmark="primary-pack:excluded"][data-question-replicate="1"]',
  );
  await expect(normal).toContainText('primary-pack · replicate 2 · shared-target-question');
  await expect(excluded).toContainText('primary-pack:excluded · replicate 1 · shared-target-question');
  await expect(page.locator('.counterfactual-question')).toHaveCount(2);
  const controlIds = await page.locator('.counterfactual-question textarea').evaluateAll(
    (controls) => controls.map((control) => control.id),
  );
  expect(new Set(controlIds).size).toBe(2);

  await normal.getByLabel('Answer and rationale').fill('Use the standard primary policy.');
  await normal.getByRole('button', { name: 'Resume analysis' }).click();
  await expect.poll(() => payloads.length).toBe(1);
  await expect(excluded.getByRole('button', { name: 'Resume analysis' })).toBeEnabled();
  await excluded.getByLabel('Answer and rationale').fill('Use the target-excluded policy.');
  await excluded.getByRole('button', { name: 'Resume analysis' }).click();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads).toEqual([
    {
      answer: 'Use the standard primary policy.',
      benchmark: 'primary-pack',
      replicate: 2,
    },
    {
      answer: 'Use the target-excluded policy.',
      benchmark: 'primary-pack:excluded',
      replicate: 1,
    },
  ]);
});

test('refreshes a deep-linked overview with completed, live, and pending replicate telemetry', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
  await page.reload();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/overview`);
  await expect(page.getByRole('heading', { name: 'ui e2e' })).toBeVisible();

  const active = page.getByTestId(`active-variant-${liveId}`);
  await expect(active).toBeVisible();
  await expect(active.locator('[data-replicate-group="standard"][data-replicate-state="completed"]')).toHaveCount(2);
  await expect(active.locator('[data-replicate-group="standard"][data-replicate-state="current"]')).toHaveCount(1);
  await expect(active.locator('[data-replicate-group="standard"][data-replicate-state="pending"]')).toHaveCount(1);
  await expect(active.getByTestId(`replicate-${liveId}-primary-pack-1`)).toContainText('comparison control');

  const targetGroup = active.getByTestId(`replicate-group-${liveId}-target-excluded`);
  await expect(targetGroup).toContainText('Target-excluded guard');
  await expect(targetGroup).toContainText('Standard primary runs are the control');
  await expect(targetGroup).toContainText('target-excluded planner usage is excluded from standard totals');
  await expect(targetGroup).toContainText('running');
  const targetRows = active.locator('[data-replicate-group="target-excluded"]');
  await expect(targetRows).toHaveCount(2);
  await expect(active.locator('[data-replicate-group="target-excluded"][data-replicate-state="current"]')).toHaveCount(1);
  await expect(active.locator('[data-replicate-group="target-excluded"][data-replicate-state="pending"]')).toHaveCount(1);
  await expect(active.locator('[data-testid*="primary-pack:control"]')).toHaveCount(0);
  await expect(active.getByTestId(`replicate-${liveId}-primary-pack:excluded-1`)).toContainText('1 / 5');
  await expect(active.getByTestId(`replicate-${liveId}-primary-pack:excluded-2`)).toContainText('—');

  const running = page.getByTestId(`replicate-${liveId}-primary-pack-2`);
  await expect(active.locator('th').first()).toHaveCSS('position', 'sticky');
  await expect(running.locator('td').first()).toHaveCSS('position', 'sticky');
  const replicateScroll = active.locator('.replicate-table-wrap');
  await replicateScroll.evaluate((element) => { element.scrollLeft = 500; });
  const [scrollBox, firstCellBox] = await Promise.all([
    replicateScroll.boundingBox(),
    running.locator('td').first().boundingBox(),
  ]);
  expect(Math.abs((firstCellBox?.x ?? 0) - (scrollBox?.x ?? 0))).toBeLessThan(2);
  await expect(running.getByRole('progressbar')).toHaveAttribute('value', '2');
  await expect(running).toContainText('2 / 5');
  await expect(running).toContainText('B 1 · R 1 · E 0');
  await expect(running.locator('.decision-code-build')).toHaveText('B 1');
  await expect(running.locator('.decision-code-reuse')).toHaveText('R 1');
  await expect(running.locator('.decision-code-extend')).toHaveText('E 0');
  await expect(running.locator('.decision-code-defer')).toHaveText('D 0');
  await expect(running.locator('.decision-code-question')).toHaveText('Q 0');
  const decisionColors = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="replicate-${liveId}-primary-pack-2"] .decision-code')].map((element) => getComputedStyle(element).color)`);
  expect(new Set(decisionColors).size).toBe(5);
  await expect(running).toContainText(/(?:[4-9](?:\.\d)?|[1-9]\d+) s/);
  await expect(running).toContainText('3.0 s');
  await expect(running).toContainText('500');
  await expect(running).toContainText('100');
  await expect(running).toContainText('600');
  await expect(running).toContainText('$0.50');

  const pending = page.getByTestId(`replicate-${liveId}-holdout-pack-2`);
  await expect(pending).toContainText('—');
  await expect(pending).not.toContainText('$0.00');
  await expect(active.getByLabel('Experiment timing and planner usage')).toContainText('820 incl. reasoning');
  await expect(active.getByLabel('Experiment timing and planner usage')).toContainText('$0.95');
  await expect(active.locator('dt', { hasText: 'End-to-end' }).locator('..').locator('dd')).toContainText('s');

  const navigationLabels = page.locator('.sidebar-nav .nav-label');
  await expect(navigationLabels.first()).toHaveCSS('margin-bottom', '8px');
  await expect(navigationLabels.nth(1)).toHaveCSS('border-top-style', 'solid');
  await expect(navigationLabels.nth(1)).toHaveCSS('padding-top', '14px');
  await expect(active.locator('dt', { hasText: 'Phase 2' }).locator('..').locator('dd')).toContainText('s');
  const trace = running.getByRole('link', { name: 'Trace' });
  expect(new URL((await trace.getAttribute('href'))!).searchParams.get('filter')).toBe(
    'traceTags;arrayOptions;;any of;case%3Acase-primary-pack-2',
  );
});

test('keeps dedicated-control V1 target rows and historical protocol copy', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${legacyCampaignId}/overview`);
  const active = page.getByTestId(`active-variant-${legacyLiveId}`);
  await expect(active.locator('[data-replicate-group="target-excluded"]')).toHaveCount(4);
  await expect(active.locator('[data-testid*="legacy-primary:control"]')).toHaveCount(2);
  await expect(active.locator('[data-testid*="legacy-primary:excluded"]')).toHaveCount(2);

  await page.goto(
    `${baseUrl}/campaigns/${legacyCampaignId}/experiments/${legacyLiveId}?tab=target-excluded`,
  );
  await expect(page.getByText('2 paired replicates per arm · concurrency 2')).toBeVisible();
  await expect(page.getByText(/dedicated control is compared with the target-excluded arm/i)).toBeVisible();
});

test('uses History API navigation and URL-synchronized experiment filters', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
  await page.getByRole('link', { name: 'Experiments' }).click();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/experiments`);
  await page.getByRole('link', { name: 'Lineage' }).click();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/lineage`);
  await page.goBack();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/experiments`);
  await page.goForward();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/lineage`);

  await page.getByRole('link', { name: 'Experiments' }).click();
  await page.getByLabel('Search experiments', { exact: true }).fill('Live source policy');
  await expect(page).toHaveURL(/q=Live\+source\+policy/);
  await page.locator('#filter-status').selectOption('active');
  await expect(page).toHaveURL(/status=active/);
  await expect(page.locator('.filter-rail .filter-count')).toHaveText('2');
  await expect(page.getByTestId(`experiment-row-${liveId}`)).toBeVisible();
  await expect(page.getByTestId(`experiment-row-${baselineId}`)).toHaveCount(0);
  await page.locator('.filter-rail').getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/experiments`);
  await expect(page.locator('[data-testid^="experiment-row-"]')).toHaveCount(3);

  await page.locator('#filter-sort').selectOption('tokens');
  await expect(page.locator('.filter-rail .filter-count')).toHaveText('1');
  await expect(page.locator('.filter-rail').getByRole('button', { name: 'Clear filters' })).toBeEnabled();
  await page.locator('.filter-rail').getByRole('button', { name: 'Clear filters' }).click();

  await page.locator('#filter-lineage').selectOption('current-candidates');
  await expect(page).toHaveURL(/lineage=current-candidates/);
  await expect(page.getByTestId(`experiment-row-${liveId}`)).toBeVisible();
  await expect(page.getByTestId(`experiment-row-${reviewId}`)).toBeVisible();
  await expect(page.getByTestId(`experiment-row-${baselineId}`)).toHaveCount(0);
});

test('shows dependency connectors, truthful lineage cards, and an equivalent list', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/lineage`);
  const graph = page.getByTestId('lineage-graph');
  await expect(graph).toBeVisible();
  await expect(graph.locator('.lineage-card')).toHaveCount(3);
  await expect(graph.locator('.connector')).toHaveCount(2);
  await expect(graph.locator('.connector').first()).toHaveAttribute('d', /M [1-9]/);
  await expect(graph.locator('.current-path')).toHaveCount(1);
  await expect(graph).toContainText('Sibling rank');
  await expect(graph).toContainText('Verified');
  await expect(graph).toContainText('Provisional');
  await expect(graph).toContainText('Agreement');
  await expect(graph).not.toContainText('Composite');

  await page.getByRole('button', { name: 'List' }).click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.getByTestId('lineage-list').locator('.lineage-card')).toHaveCount(3);
});

test('isolates duplicate question IDs by benchmark and replicate and serves artifacts', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}`);
  await expect(page.getByRole('link', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Markdown' }).click();
  await expect(page.getByRole('heading', { name: 'Experiment Markdown' })).toBeVisible();
  const markdownViewer = page.getByTestId('experiment-markdown');
  await expect(markdownViewer.getByRole('heading', { name: 'Base Assumptions' })).toBeVisible();
  await expect(markdownViewer.getByRole('heading', { name: 'Conclusion' })).toBeVisible();
  await expect(markdownViewer.getByRole('table').first()).toBeVisible();
  const onThisPage = page.getByRole('navigation', { name: 'On this page' });
  await expect(onThisPage.getByRole('link', { name: 'Base Assumptions' })).toBeVisible();
  await expect(onThisPage.getByRole('link', { name: /^question\./ })).toHaveCount(0);
  const conclusionLink = onThisPage.getByRole('link', { name: 'Conclusion' });
  await conclusionLink.click();
  await expect.poll(() => markdownViewer.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await expect(conclusionLink).toHaveAttribute('aria-current', 'location');
  await expect(page).toHaveURL(/#conclusion$/);
  await expect(markdownViewer.getByRole('heading', { name: 'Conclusion' })).toBeFocused();
  await page.reload();
  await expect.poll(() => markdownViewer.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await expect(conclusionLink).toHaveAttribute('aria-current', 'location');
  await expect(page.getByRole('link', { name: 'Open raw Markdown' })).toBeVisible();
  await markdownViewer.focus();
  await markdownViewer.evaluate((element) => {
    element.scrollTop = 120;
  });
  const humanNotesDirectory = path.join(paths.reports, campaignId, 'human');
  await mkdir(humanNotesDirectory, { recursive: true });
  await writeFile(
    path.join(humanNotesDirectory, `${baselineId}.md`),
    'Reviewer refresh marker.\n<img src=x onerror="window.__markdownExecuted=true">\n',
  );
  const refreshed = page.waitForResponse(
    (response) => response.url() === `${baseUrl}/api/campaigns/${campaignId}`,
  );
  await orchestrator.refreshReports(campaignId);
  await refreshed;
  await expect(markdownViewer).toContainText('Reviewer refresh marker.');
  await expect(page.locator('.markdown-panel img')).toHaveCount(0);
  expect(await page.evaluate('window.__markdownExecuted')).toBeUndefined();
  await expect(markdownViewer).toBeFocused();
  await expect.poll(() => markdownViewer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Runs' }).click();
  await page.getByRole('link', { name: 'Markdown' }).click();
  await expect(markdownViewer).not.toBeFocused();

  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=runs`);
  await expect(page.getByRole('heading', { name: 'Seed observation' })).toBeVisible();
  await expect(page.getByLabel('Experiment timing and planner usage').first()).toContainText('20 s');
  await expect(page.getByLabel('Experiment timing and planner usage').first()).toContainText('15 s');
  await expect(page.getByLabel('Experiment timing and planner usage').first()).toContainText('440 incl. reasoning');
  await expect(page.getByText(/target-excluded guard runs are excluded from totals/i)).toBeVisible();

  await page.getByRole('link', { name: /Questions/ }).click();
  await expect(page.locator('[data-question-scope$=":duplicate-question"]')).toHaveCount(2);
  await expect(page.getByText('Which primary account identifier format should be used?')).toBeVisible();
  await expect(page.getByText('Which holdout identifier format should be used?')).toBeVisible();

  await page.getByRole('link', { name: 'Artifacts' }).click();
  const reportLink = page.getByRole('link', { name: 'Open experiment Markdown' });
  await expect(reportLink).toBeVisible();
  await expect(page.getByRole('link', { name: /planner-output.json/ })).toBeVisible();
  const report = await page.request.get(`${baseUrl}${await reportLink.getAttribute('href')}`);
  expect(report.ok()).toBe(true);
  expect(report.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect(await report.text()).toContain('## Actual Facts');

  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${reviewId}`);
  await expect(page.getByRole('button', { name: 'Promote experiment' })).toHaveCount(0);
});

test('retains a central dirty review draft across SSE and guards navigation before save', async ({ page }) => {
  await page.goto(
    `${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=primary-pack&filter=all`,
  );
  const unitRow = page.getByRole('row', { name: /Capture the verified account identifier/ });
  await unitRow.getByRole('button').click();
  await expect(page).toHaveURL(/benchmark=primary-pack&filter=all&unit=unit-a/);
  await expect(page.getByText('No existing source behavior captures this identifier.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'capture-a' })).toHaveCSS('overflow-wrap', 'anywhere');
  await page.getByRole('button', { name: 'Copy unit anchor' }).click();
  await expect(page.getByText('Unit anchor copied')).toBeVisible();
  const requirementJson = page.getByRole('figure', { name: 'Requirement JSON' });
  await expect(requirementJson).toBeVisible();
  await expect(requirementJson.getByText('"kind"')).toBeVisible();
  await expect(requirementJson.getByText('"field"')).toBeVisible();
  await expect(requirementJson).not.toContainText('{null');
  const payloadToggle = requirementJson.getByLabel('Toggle payload');
  await expect(payloadToggle.locator('..')).toHaveAttribute('open', '');
  await payloadToggle.click();
  await expect(payloadToggle.locator('..')).not.toHaveAttribute('open');
  const reviewLayout = await page.evaluate<{
    detailHeight: number;
    detailOverflow: string;
    listHeight: number;
    listOverflow: string;
    pageClientHeight: number;
    pageScrollHeight: number;
  }>(`(() => {
    const detail = document.querySelector('.review-detail');
    const list = document.querySelector('.review-unit-list');
    return {
      detailHeight: detail.clientHeight,
      detailOverflow: getComputedStyle(detail).overflowY,
      listHeight: list.clientHeight,
      listOverflow: getComputedStyle(list).overflowY,
      pageClientHeight: document.documentElement.clientHeight,
      pageScrollHeight: document.documentElement.scrollHeight,
    };
  })()`);
  expect(reviewLayout.pageScrollHeight).toBe(reviewLayout.pageClientHeight);
  expect(reviewLayout.detailOverflow).toBe('auto');
  expect(reviewLayout.listOverflow).toBe('auto');
  expect(Math.abs(reviewLayout.detailHeight - reviewLayout.listHeight)).toBeLessThanOrEqual(1);
  const rationale = page.getByLabel('Human rationale');
  await rationale.fill('Reviewed source confirms this remains a real implementation gap.');

  database.updateVariant(liveId, { elapsedMs: 5_000 });
  await expect(rationale).toHaveValue(
    'Reviewed source confirms this remains a real implementation gap.',
    { timeout: 5_000 },
  );
  await expect(rationale).toBeFocused();

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/\/review\//);
  await expect(rationale).toHaveValue('Reviewed source confirms this remains a real implementation gap.');

  await page.getByRole('button', { name: 'Save verified truth' }).click();
  await expect(page.getByText('Verified label saved')).toBeVisible();
  expect(database.listLabels(campaignId, 'primary-pack')[0]?.status).toBe('verified');
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/overview`);
});

test('provides a mobile drawer, defaults lineage to list, and preserves campaign creation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=markdown`);
  await expect(
    page.getByTestId('experiment-markdown').getByRole('heading', { name: 'Conclusion' }),
  ).toBeVisible();
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(390);

  await page.goto(
    `${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=primary-pack&filter=all&unit=unit-a`,
  );
  await expect(page.getByRole('figure', { name: 'Requirement JSON' })).toBeVisible();
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(390);

  await page.goto(`${baseUrl}/campaigns/${campaignId}/lineage`);
  await expect(page.getByTestId('lineage-list')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Campaign navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Experiments' }).click();
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/experiments`);
  await page.locator('details.mobile-filters summary').click();
  await expect(page.getByLabel('Mobile Search experiments')).toBeVisible();

  await page.goto(`${baseUrl}/campaigns/new`);
  await page.getByLabel('Campaign ID').fill('created-in-ui');
  await page
    .getByLabel('Research goal')
    .fill('Validate that routed campaign creation still freezes every required local input.');
  await page.getByLabel('Planner repository').fill(plannerRepo);
  await page.getByLabel('Workflows repository').fill(workflowsRepo);
  await page.getByLabel('Planner environment file').fill(environmentFile);
  await page.getByLabel('Planner seed revision').fill(seedSha);
  await page.getByLabel('Workflows revision').fill(workflowsSha);
  await page.getByLabel('Primary requirements ZIP').setInputFiles(primaryZip);
  await page.getByLabel('Holdout requirements ZIP').setInputFiles(holdoutZip);
  const replicates = page.getByLabel('Replicates per benchmark');
  const targetWorkflow = page.getByLabel('Target-excluded guard workflow (optional)');
  await replicates.fill('4');
  await targetWorkflow.fill('trumark/deceased-accounts');
  await expect(replicates).toHaveValue('2');
  await expect(replicates).toHaveAttribute('readonly', '');
  await targetWorkflow.fill('');
  await expect(replicates).toHaveValue('4');
  await expect(replicates).not.toHaveAttribute('readonly');
  await targetWorkflow.fill('trumark/deceased-accounts');
  const creationRequestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url() === `${baseUrl}/api/campaigns`,
  );
  await page.getByRole('button', { name: 'Create frozen campaign' }).click();
  const creationRequest = await creationRequestPromise;
  expect(creationRequest.postDataJSON()).toMatchObject({
    evaluation: { replicates: 2 },
    targetExcluded: {
      protocol: 'standard-primary-v2',
      targetImplementationWorkflow: 'trumark/deceased-accounts',
    },
  });
  await expect(page).toHaveURL(`${baseUrl}/campaigns/created-in-ui/overview`);
  await expect(page.getByRole('heading', { name: 'created in ui' })).toBeVisible();
  expect(database.getCampaign('created-in-ui').config.evaluation.replicates).toBe(2);
  expect(database.getCampaign('created-in-ui').config.targetExcluded).toEqual({
    protocol: 'standard-primary-v2',
    targetImplementationWorkflow: 'trumark/deceased-accounts',
  });
  expect(
    (await readFile(database.getCampaign('created-in-ui').config.benchmarks[0]!.zipPath))
      .subarray(4)
      .toString('utf8'),
  ).toBe('primary requirements');

  const rejected = await page.request.post(`${baseUrl}/api/campaigns/${campaignId}/stop`, {
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    data: {},
  });
  expect(rejected.status()).toBe(400);
});
