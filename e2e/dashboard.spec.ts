import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { HarnessDatabase } from '../src/db.js';
import { readVariantDiagnostics } from '../src/failures.js';
import { computeReplicateMeanScore, computeScore, consensusRunFacts, extractRunFacts } from '../src/metrics.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import type { InvestigationState } from '../src/investigator.js';
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
const investigatorCampaignId = 'investigator-ui-e2e';
const investigatorId = `${investigatorCampaignId}-v001`;
const zeroInvestigatorId = `${investigatorCampaignId}-v002`;
const unknownInvestigatorId = `${investigatorCampaignId}-v003`;
const longInvestigationText = 'Source eligibility remains an unverified hypothesis. '.repeat(24) + 'unbroken-source-reference-'.repeat(24);

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

async function seedInvestigatorCampaign(): Promise<void> {
  await orchestrator.initializeFromInput({
    id: investigatorCampaignId,
    goal: 'Inspect autonomous investigator evidence without conflating test success with planner correctness.',
    plannerRepo, workflowsRepo, environmentFile,
    seedRevision: seedSha, workflowsRevision: workflowsSha,
    benchmarks: [
      { name: 'primary-pack', role: 'primary', zipPath: primaryZip },
      { name: 'holdout-pack', role: 'holdout', zipPath: holdoutZip },
    ],
    investigator: { enabled: true, primaryReplicates: 1 },
    evaluation: { replicates: 2, replicateConcurrency: 2 },
  });
  const hypothesis = {
    title: 'Source evidence revision',
    rationale: longInvestigationText,
    instructions: 'Inspect generic eligibility without customer-specific production rules.',
    expectedImpact: 'Potentially fewer unsupported decisions; not verified.',
    risk: 'May reject a valid source.',
    assumptions: ['The source inventory is complete.'],
    findingIds: [],
  };
  const facts = consensusRunFacts([runFacts(primaryUsage()), runFacts(primaryUsage())]);
  const score = {
    ...computeScore(facts, [], null),
    verified: { labeled: 1, correct: 0, errors: 1, accuracy: 0 },
  };
  const actionBase = {
    hypothesis, rationale: 'Check this revision before spending a primary trial.',
    startedAt: '2026-09-06T05:00:00.000Z', completedAt: '2026-09-06T05:01:00.000Z',
    patchHash: `sha256:${'f'.repeat(64)}`, artifactDirectory: null, error: null,
  };
  const investigation: InvestigationState = {
    schemaVersion: 1, sessionId: `session-${'a'.repeat(100)}`, status: 'running',
    startedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(),
    turnCount: 4, agentTokens: null, agentCostUsd: null, reason: null,
    actions: [
      { ...actionBase, id: 'test-failed', kind: 'test', status: 'failed', result: { passed: false, testFiles: ['test/source.test.ts'], logPaths: ['investigation/test-failed/test.log'] }, artifactDirectory: 'investigation/test-failed', error: 'Source assertion failed.' },
      { ...actionBase, id: 'test-passed', kind: 'test', status: 'completed', result: { passed: true, testFiles: ['test/source.test.ts'], logPaths: ['investigation/test-passed/test.log'] }, artifactDirectory: 'investigation/test-passed' },
      { ...actionBase, id: 'primary-trial', kind: 'evaluate_primary', status: 'completed', result: {
        score, baselineScore: { ...score, verified: { labeled: 1, correct: 1, errors: 0, accuracy: 1 } },
        facts, replicateFacts: [runFacts(primaryUsage()), runFacts(primaryUsage())], labelSetHash: `sha256:${'1'.repeat(64)}`,
        comparisonNotes: ['The result needs human interpretation.'],
        transitions: [{ key: 'unit-a', before: 'reuse', after: 'build', expected: 'build', rationale: 'Planner interpretation, not verified causality.', sourceRefs: [] }],
      } },
      { ...actionBase, id: 'test-running', kind: 'test', status: 'running', completedAt: null, result: null },
    ],
  };
  for (const [index, id] of [investigatorId, zeroInvestigatorId, unknownInvestigatorId].entries()) {
    database.createVariant({ id, campaignId: investigatorCampaignId, parentVariantId: null, round: 1, ordinal: index + 1, hypothesis });
    database.updateVariant(id, {
      status: 'completed', facts, score,
      investigation: index === 0 ? investigation : {
        ...investigation,
        sessionId: index === 1 ? null : 'unknown-result-session',
        status: index === 1 ? 'budget_exhausted' : 'abandoned',
        turnCount: index === 1 ? 0 : 1,
        agentTokens: index === 1 ? 0 : null,
        agentCostUsd: index === 1 ? 0 : null,
        reason: longInvestigationText,
        actions: index === 1 ? [] : [{
          ...actionBase, id: 'unknown-result', kind: 'evaluate_primary', status: 'completed',
          hypothesis: { ...hypothesis, title: longInvestigationText },
          result: { futureResult: 'MODEL_OUTPUT_ONLY_MARKER', passed: true, unsupportedClaim: '<img src=x onerror="window.__investigationExecuted=true">' },
        }],
      },
    });
  }
  for (const outcome of ['failed', 'passed']) {
    const directory = path.join(paths.artifacts, investigatorCampaignId, investigatorId, `investigation/test-${outcome}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'test.log'), `Seeded test ${outcome}. This is execution evidence only.\n`);
  }
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
  await seedInvestigatorCampaign();
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

async function blockedBaselineFixture(page: Page, legacy = false) {
  const details = await (await page.request.get(`${baseUrl}/api/campaigns/${campaignId}`)).json();
  const variant = details.variants.find((item: { id: string }) => item.id === baselineId);
  const target = details.targetExcludedEvaluations.find((item: { variantId: string }) => item.variantId === baselineId);
  const failure = {
    origin: 'planner', code: 'model_boundary_violation_candidate_outside_shortlist',
    message: 'Unit 83 rejected. Authorization: Bearer fixture-secret-value; api_key=fixture-key-value',
    occurredAt: '2026-09-06T05:00:10.000Z', failedRequirementUnitIds: ['unit-83'],
    lastCheckpointStage: 'adjudicating', providerRetryBudgetAvailable: false, httpStatus: 429,
    details: { kind: 'candidate_outside_shortlist', version: 1, requirementUnitId: 'unit-83', disposition: 'reuse',
      selected: [{ index: 0, id: 'capability:outside', allowed: false, origin: 'discovered' }],
      allowedIds: ['capability:allowed'], counts: { selected: 1, allowed: 1, shortlist: 1, discovered: 1, supporting: 0 }, truncated: false,
      password: 'fixture-password-value', nested: { token: 'fixture-token-value' } },
    provenance: { source: 'archive', artifactPath: 'target-excluded/excluded/primary-pack/replicate-2/events.json' },
  };
  Object.assign(details.campaign, { status: 'baseline_target_failed', currentParentVariantId: null });
  Object.assign(variant, { status: 'review', error: null });
  Object.assign(target, { status: 'failed', error: null, gate: null, comparisons: [], excludedFacts: null,
    excludedReplicateFacts: [target.excludedReplicateFacts[0]],
    executionState: { executions: [target.executionState.executions[0], {
      ...target.executionState.executions[1], status: 'failed', stage: 'failed',
      progress: { completedUnits: 83, totalUnits: 125 },
      ...(legacy ? {} : { failure }),
    }] },
  });
  const diagnostic = {
    status: 'blocked', counts: { completed: 5, failed: 1, pending: 0, total: 6 }, standardAvailable: true,
    failures: [{ scope: 'excluded', benchmark: 'primary-pack', replicate: 2,
      caseId: 'case-primary-pack:excluded-2', runId: 'run-primary-pack:excluded-2',
      progress: { completedUnits: 83, totalUnits: 125 }, failure }],
    environment: { password: 'DO_NOT_COPY_UNKNOWN_FIELDS' },
  };
  await page.route(`${baseUrl}/api/campaigns/${campaignId}`, (route) => route.fulfill({ json: details }));
  return { details, variant, target, diagnostic };
}

async function fixtureScreenshot(page: Page, name: string) {
  const directory = path.resolve('.data/screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: 'disabled' });
}

test('blocked baseline retains five completed results and lazy sanitized exact failure diagnostics', async ({ page }) => {
  const { details, variant, diagnostic } = await blockedBaselineFixture(page);
  let reads = 0;
  const posts: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.route(`**/variants/${baselineId}/diagnostics`, (route) => { reads++; return route.fulfill({ json: diagnostic }); });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (value: string) => { (globalThis as unknown as { copied: string }).copied = value; } },
  }));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
    const banner = page.getByTestId(`failure-banner-${baselineId}`);
    await expect(banner).toContainText('Baseline blocked');
    await expect(banner).toContainText('Guard failed');
    await expect(banner).toContainText('5 completed / 6 total');
    const matrix = page.getByTestId(`active-variant-${baselineId}`);
    await expect(matrix.locator('[data-replicate-state="completed"]')).toHaveCount(5);
    const failed = matrix.getByTestId(`replicate-${baselineId}-primary-pack:excluded-2`);
    await expect(failed).toContainText('83 / 125');
    await expect(failed.getByRole('progressbar')).toHaveAttribute('value', '83');
    await expect(failed).toContainText('Last accepted');
    await expect(matrix.getByTestId(`replicate-${baselineId}-primary-pack:excluded-1`).getByRole('link', { name: 'Trace' })).toBeVisible();
    const before = reads;
    await banner.getByText('Failure diagnostics', { exact: true }).click();
    await expect.poll(() => reads).toBe(before + 1);
    await expect(banner).toContainText('model_boundary_violation_candidate_outside_shortlist');
    await expect(banner).toContainText('unit-83');
    await expect(banner).toContainText('excluded / primary-pack / replicate 2');
    await expect(banner).toContainText('HTTP status: 429');
    await expect(banner.getByRole('link', { name: 'Failed run trace' })).toHaveAttribute('href', /case-primary-pack/);
    await banner.getByRole('button', { name: 'Copy diagnostics JSON' }).click();
    const copied = await page.evaluate<string>('window.copied');
    expect(JSON.parse(copied).failures[0].failure.failedRequirementUnitIds).toEqual(['unit-83']);
    for (const secret of ['fixture-secret-value', 'fixture-key-value', 'fixture-password-value', 'fixture-token-value', 'DO_NOT_COPY_UNKNOWN_FIELDS']) {
      expect(copied).not.toContain(secret);
      await expect(banner).not.toContainText(secret);
    }
    const disclosure = banner.locator('details').first();
    const node = await disclosure.elementHandle();
    await banner.getByText('Exact details and provenance (sanitized)', { exact: true }).click();
    const exact = banner.locator('.diagnostic-failure details');
    const exactNode = await exact.elementHandle();
    details.campaign.config.goal = `Refreshed at ${width}`;
    variant.updatedAt = new Date(1_800_000_000_000 + width).toISOString();
    const diagnosticRefresh = page.waitForResponse(`**/variants/${baselineId}/diagnostics`);
    const refreshed = page.waitForResponse(`${baseUrl}/api/campaigns/${campaignId}`);
    database.addEvent(campaignId, baselineId, 'variant.updated', {});
    await refreshed;
    await diagnosticRefresh;
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(exact).toHaveAttribute('open', '');
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await exactNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
    await banner.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await fixtureScreenshot(page, `failure-banner-${width}`);
    await exact.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await fixtureScreenshot(page, `failure-details-${width}`);
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=target-excluded`);
    await expect(page.locator('.counterfactual-strip')).toContainText('Not assessed');
    await expect(page.locator('dt', { hasText: /^Leakage paths$/ }).locator('..')).toContainText('Not assessed');
    await expect(page.getByRole('button', { name: 'Retry complete evaluation' })).toHaveCount(0);
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}`);
    await expect(page.getByTestId(`failure-banner-${baselineId}`)).toContainText('Standard results remain available');
    await page.goto(`${baseUrl}/campaigns/${campaignId}/lineage?view=list`);
    await expect(page.locator(`[data-lineage-id="${baselineId}"]`)).toContainText('Baseline blocked');
    await page.goto(`${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=primary-pack&filter=all&unit=unit-a`);
    await expect(page.getByTestId(`failure-banner-${baselineId}`)).toBeVisible();
  }
  expect(posts).toEqual([]);
});

test('legacy V1 control failure retains seven completed runs and its actual diagnostic scope', async ({ page }) => {
  const details = await (await page.request.get(`${baseUrl}/api/campaigns/${campaignId}`)).json();
  const variant = details.variants.find((item: { id: string }) => item.id === reviewId);
  const target = details.targetExcludedEvaluations.find((item: { variantId: string }) => item.variantId === reviewId);
  delete details.campaign.config.targetExcluded;
  Object.assign(details.targetExcludedConfig, { protocol: 'dedicated-control-v1', replicates: 2 });
  const control = { ...execution({ benchmark: 'primary-pack:target-excluded/control', role: 'primary', replicate: 1, status: 'failed', stage: 'failed', completedUnits: 83, totalUnits: 125 }),
    failure: { origin: 'planner', code: 'model_timeout', message: 'The model provider request timed out.', occurredAt: '2026-09-08T10:00:00Z',
      failedRequirementUnitIds: ['unit-83'], lastCheckpointStage: 'adjudicating', providerRetryBudgetAvailable: false, httpStatus: null } };
  Object.assign(target, { status: 'failed', error: null, gate: null, normalArmBinding: null, executionState: { executions: [
    control, execution({ benchmark: 'primary-pack:target-excluded/control', role: 'primary', replicate: 2 }),
    execution({ benchmark: 'primary-pack:excluded', role: 'primary', replicate: 1 }), execution({ benchmark: 'primary-pack:excluded', role: 'primary', replicate: 2 }),
  ] } });
  Object.assign(variant, { error: null, status: 'review' });
  const projection = await readVariantDiagnostics(paths, details.campaign, variant, target);
  expect(projection.counts).toEqual({ completed: 7, failed: 1, pending: 0, total: 8 });
  expect(projection.failures[0]?.scope).toBe('control');
  await page.route(`${baseUrl}/api/campaigns/${campaignId}`, (route) => route.fulfill({ json: details }));
  let archiveAvailable = false;
  await page.route(`**/variants/${reviewId}/diagnostics`, (route) => route.fulfill(archiveAvailable
    ? { json: projection } : { status: 503, json: { error: 'Unavailable' } }));
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${reviewId}?tab=runs`);
  const banner = page.getByTestId(`failure-banner-${reviewId}`);
  await expect(banner).toContainText('7 completed / 8 total; 1 failed');
  await expect(page.locator('[data-replicate-state="completed"]')).toHaveCount(7);
  const failed = page.locator('[data-replicate-state="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText('target control');
  await expect(failed).toContainText('83 / 125');
  await banner.getByText('Failure diagnostics', { exact: true }).click();
  await expect(banner).toContainText('control / primary-pack / replicate 1');
  await expect(banner).not.toContainText('excluded / primary-pack / replicate 1');
  archiveAvailable = true;
  await banner.getByRole('button', { name: 'Reload diagnostics' }).click();
  await expect(banner).toContainText('control / primary-pack / replicate 1');
  await expect(banner).toContainText('model_timeout');
  database.addEvent(campaignId, reviewId, 'variant.updated', {});
  await expect(failed).toContainText('failed');
  await expect(banner).toContainText('7 completed / 8 total; 1 failed');
  await expect(page.getByRole('button', { name: 'Retry excluded baseline (2 runs)' })).toHaveCount(0);
});

test('legacy missing failure details stay unknown and excluded baseline retry is narrowly confirmed', async ({ page }) => {
  const { details, diagnostic } = await blockedBaselineFixture(page, true);
  const posts: string[] = [];
  let archiveAvailable = false;
  await page.route(`**/variants/${baselineId}/diagnostics`, (route) => route.fulfill(archiveAvailable
    ? { json: { ...diagnostic, failures: diagnostic.failures.map((item) => ({ ...item, failure: { ...item.failure, details: null, provenance: null } })) } }
    : { status: 404, json: { error: 'Unavailable Bearer do-not-render-this-secret' } }));
  await page.route(`${baseUrl}/api/campaigns/${campaignId}/baseline`, (route) => {
    posts.push(route.request().method());
    return route.fulfill({ json: { admitted: true } });
  });
  await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
  const banner = page.getByTestId(`failure-banner-${baselineId}`);
  await banner.getByText('Failure diagnostics', { exact: true }).click();
  await expect(banner).toContainText('Exact failure details were not recorded');
  await expect(banner).toContainText('Diagnostics unavailable');
  await expect(banner).not.toContainText('do-not-render-this-secret');
  await expect(banner).not.toContainText('model_boundary_violation_candidate_outside_shortlist');
  archiveAvailable = true;
  await banner.getByRole('button', { name: 'Reload diagnostics' }).click();
  await expect(banner).toContainText('model_boundary_violation_candidate_outside_shortlist');
  await expect(banner).toContainText('Exact details and provenance were not captured in this record.');
  const retry = page.getByRole('button', { name: 'Retry excluded baseline (2 runs)', exact: true });
  await expect(retry).toBeVisible();
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('two excluded runs');
    expect(dialog.message()).toContain('preserves completed standard');
    await dialog.dismiss();
  });
  await retry.click();
  expect(posts).toEqual([]);
  page.once('dialog', (dialog) => dialog.accept());
  await retry.click();
  await expect.poll(() => posts).toEqual(['POST']);
  for (const mismatch of ['target', 'baseline', 'status', 'running']) {
    const original = structuredClone(details);
    if (mismatch === 'target') details.targetExcludedConfig.targetImplementationWorkflow = 'other/workflow';
    if (mismatch === 'baseline') details.targetExcludedConfig.baselineVariantId = reviewId;
    if (mismatch === 'status') details.campaign.status = 'ready';
    if (mismatch === 'running') details.targetExcludedEvaluations.find((item: { variantId: string }) => item.variantId === baselineId).executionState.executions[1].status = 'running';
    await page.reload();
    await expect(retry).toHaveCount(0);
    Object.assign(details, original);
  }
});

test('explores bounded observations, frozen-parent comparisons, units and evidence access without raw chat', async ({ page }) => {
  const requests: { tool: string; query: Record<string, unknown> }[] = [];
  let auditReads = 0;
  const envelope = (items: unknown[], extra = {}) => ({ schemaVersion: 1, snapshotRef: 'snapshot_trial',
    items, returnedCount: items.length, totalMatched: items.length, nextCursor: null, availability: 'available', omissions: [], ...extra });
  await page.route(`**/variants/${investigatorId}/evidence?*`, (route) => {
    const url = new URL(route.request().url());
    const tool = url.searchParams.get('tool')!;
    const query = JSON.parse(url.searchParams.get('query')!);
    requests.push({ tool, query });
    if (tool === 'list_observations') return route.fulfill({ json: envelope(query.cursor ? [
      { kind: 'observation', actionId: 'action-003', snapshotRef: 'snapshot_second', benchmark: 'primary-pack', arm: 'standard', role: 'trial', replicateCount: 2, unitCount: 125, sourceAvailability: 'not_captured' },
    ] : [{ kind: 'observation', actionId: 'primary-trial', snapshotRef: 'snapshot_trial', benchmark: 'primary-pack', arm: 'standard', role: 'trial', replicateCount: 2, unitCount: 125, sourceAvailability: 'available_on_request' },
      { kind: 'evidence', evidenceKind: 'test_log', evidenceRef: 'ev_log', name: 'investigation/test.log', bytes: 250 }],
    { nextCursor: query.cursor ? null : 'observations-page-2', totalMatched: 3 }) });
    if (tool === 'compare_trial') return route.fulfill({ json: envelope(query.cursor ? [
      { unitRef: 'unit_second', baselineUnitRef: 'unit_baseline_second', unitKey: 'unit-b', before: { build: 1 }, after: { reuse: 0.5, build: 0.5 }, changed: true, expectedDecision: null, labelStatus: null, baselineAgreement: null, trialAgreement: null },
    ] : [{ unitRef: 'unit_first', baselineUnitRef: 'unit_baseline_first', unitKey: 'unit-a', before: { reuse: 0.5, build: 0.5 }, after: { build: 1 }, changed: true, expectedDecision: 'build', labelStatus: 'suggested', baselineAgreement: 0.5, trialAgreement: 1 }],
    { nextCursor: query.cursor ? null : 'units-page-2', totalMatched: 2, baselineSnapshotRef: 'snapshot_parent',
      summary: { unitCount: 2, changedUnitCount: 2, sameAggregateHistogram: true, baselineMeanAgreement: 0.5, trialMeanAgreement: 1 },
      labelBasis: { source: 'investigator_reference', labelSetHash: 'frozen-labels', interpretation: 'Fixed-label agreement is diagnostic, not a new promotion score. Suggested labels are unverified judgments.' } }) });
    if (tool === 'inspect_unit') return route.fulfill({ json: envelope([{ replicate: 1, decision: 'build', confidence: 'high', shortlistCandidateCount: 3, discoveredEvidenceCount: 0, selectedCandidateIds: [],
      evidenceRef: 'ev_unit', rawAnalysis: { availability: 'not_captured', evidenceRef: null }, sourceRefs: [{ path: 'src/shared/account.ts', symbol: 'accountId', evidenceRef: 'ev_source', availability: 'available' }] },
      { replicate: 2, availability: 'not_captured', evidenceRef: 'ev_missing' }], { unitRef: query.unitRef, unitKey: 'unit-b', availability: 'partial', omissions: [{ reason: 'unit_not_captured_in_replicate', count: 1 }] }) });
    if (tool === 'read_evidence') return route.fulfill({ json: envelope([{ text: query.offset ? 'second evidence chunk' : 'first evidence chunk <img src=x onerror=alert(1)>' }],
      { nextOffset: query.offset ? null : 20, totalMatched: 40, offsetUnit: 'utf8_bytes', omissions: [{ reason: 'continued_at_nextOffset' }] }) });
    if (tool === 'search_source') return route.fulfill({ json: envelope([{ evidenceRef: 'ev_source', path: 'src/shared/account.ts', line: 2 }], { sourcePolicy: 'normal_frozen_source' }) });
    return route.fulfill({ status: 400, json: { error: 'Unexpected tool' } });
  });
  await page.route(`**/variants/${investigatorId}/evidence-reads*`, (route) => {
    auditReads++;
    const second = new URL(route.request().url()).searchParams.has('cursor');
    return route.fulfill({ json: { items: [{ id: second ? 'audit-2' : 'audit-1', tool: second ? 'read_evidence' : 'inspect_unit',
      scope: { campaignId: investigatorCampaignId, variantId: investigatorId, turn: 2 }, createdAt: '2026-09-08T10:00:00Z', bytes: 1024, status: 'ok', requestRef: 'ev_request', responseRef: 'ev_response' }],
    nextCursor: second ? null : 'audit-next', rawChat: 'RAW_CHAT_MUST_NOT_RENDER' } });
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const before = requests.length;
    const auditBefore = auditReads;
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
    expect(requests.length).toBe(before);
    expect(auditReads).toBe(auditBefore);
    const explorer = page.getByTestId('evidence-explorer');
    await explorer.getByText('Explore evidence', { exact: true }).click();
    await expect(explorer).toContainText('primary-trial');
    await explorer.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(explorer).toContainText('action-003');
    await explorer.getByLabel('Evidence tool').selectOption('compare_trial');
    await explorer.getByLabel('Observation').selectOption('snapshot_trial');
    await explorer.getByRole('button', { name: 'Load evidence', exact: true }).click();
    await expect(explorer).toContainText('unit-a');
    expect(requests.at(-1)).toEqual({ tool: 'compare_trial', query: { snapshotRef: 'snapshot_trial' } });
    await expect(explorer).toContainText('frozen parent');
    await expect(explorer).toContainText('Reuse 50%');
    await expect(explorer).toContainText('Build 100%');
    await expect(explorer).toContainText('LLM suggestion / unverified');
    await expect(explorer).toContainText('Fixed-label agreement');
    await expect(explorer.locator('.evidence-item pre')).not.toBeVisible();
    await explorer.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await fixtureScreenshot(page, `evidence-comparison-${width}`);
    await explorer.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(explorer).toContainText('unit-b');
    await explorer.getByRole('button', { name: 'Inspect unit', exact: true }).click();
    await expect(explorer).toContainText('Shortlist candidates');
    await expect(explorer).toContainText('Replicate 2');
    await expect(explorer).toContainText('Not captured');
    await expect(explorer.locator('dt', { hasText: /^Discovered evidence$/ }).first().locator('..')).toContainText('0');
    expect(requests.at(-1)?.query).toEqual({ unitRef: 'unit_second' });
    await explorer.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await fixtureScreenshot(page, `evidence-unit-${width}`);
    await explorer.getByRole('button', { name: 'Read evidence', exact: true }).first().click();
    await expect(explorer).toContainText('first evidence chunk');
    await expect(explorer.locator('img')).toHaveCount(0);
    await expect(explorer).toContainText('continued at nextOffset');
    await explorer.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(explorer).toContainText('second evidence chunk');
    expect(requests.at(-1)?.query).toEqual({ evidenceRef: 'ev_unit', offset: 20 });
    await explorer.getByLabel('Evidence tool').selectOption('search_source');
    await explorer.getByLabel('Source search').fill('accountId');
    await explorer.getByRole('button', { name: 'Load evidence', exact: true }).click();
    await expect(explorer).toContainText('normal_frozen_source');
    await expect(explorer).toContainText('src/shared/account.ts');
    const disclosureNode = await explorer.elementHandle();
    const toolNode = await explorer.getByLabel('Evidence tool').elementHandle();
    const audit = page.getByTestId('evidence-access');
    await audit.getByText('Evidence access', { exact: true }).click();
    await expect(audit).toContainText('audit-1');
    await expect(audit).toContainText('1024');
    await audit.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(audit).toContainText('audit-2');
    await expect(audit).toContainText('ev_request');
    await expect(page.locator('body')).not.toContainText('RAW_CHAT_MUST_NOT_RENDER');
    const refreshed = page.waitForResponse(`${baseUrl}/api/campaigns/${investigatorCampaignId}`);
    database.addEvent(investigatorCampaignId, investigatorId, 'investigator.updated', {});
    await refreshed;
    await expect(explorer).toHaveAttribute('open', '');
    await expect(audit).toHaveAttribute('open', '');
    expect(await disclosureNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await toolNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(explorer.getByLabel('Source search')).toHaveValue('accountId');
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
  }
});

test('evidence errors are explicit and retryable without replacing the recorded action summary', async ({ page }) => {
  const details = await (await page.request.get(`${baseUrl}/api/campaigns/${investigatorCampaignId}`)).json();
  const variant = details.variants.find((item: { id: string }) => item.id === investigatorId);
  const trial = variant.investigation.actions.find((action: { id: string }) => action.id === 'primary-trial');
  delete trial.result.facts;
  delete trial.result.replicateFacts;
  Object.assign(variant, { facts: null, score: null });
  await page.route(`${baseUrl}/api/campaigns/${investigatorCampaignId}`, (route) => route.fulfill({ json: details }));
  let reads = 0;
  await page.route(`**/variants/${investigatorId}/evidence?*`, (route) => route.fulfill(++reads === 1
    ? { status: 503, json: { error: 'raw secret should not display' } }
    : { json: { schemaVersion: 1, snapshotRef: null, items: [], returnedCount: 0, totalMatched: 0, nextCursor: null, availability: 'not_captured', omissions: ['Historical receipt was not captured.'] } }));
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
  const explorer = page.getByTestId('evidence-explorer');
  await explorer.getByText('Explore evidence', { exact: true }).click();
  await expect(explorer).toContainText('Evidence unavailable');
  await expect(explorer).not.toContainText('raw secret');
  await explorer.getByRole('button', { name: 'Load evidence' }).click();
  await expect(explorer).toContainText('not_captured');
  await expect(explorer).toContainText('Historical receipt was not captured.');
  await expect(page.getByTestId('investigation-action-primary-trial')).toContainText('Primary score recorded');
  await expect(page.locator('.investigation-comparison')).toContainText('Trial 0.0% / Frozen reference 100.0%');
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/lineage?view=list`);
  const card = page.locator(`[data-lineage-id="${investigatorId}"]`);
  await expect(card).toContainText('Latest screening: primary-trial');
  await expect(card.locator('dt', { hasText: /^Agreement$/ }).locator('..')).toContainText('—');
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
  await expect(page.locator('dt', { hasText: /^Pair validity$/ }).locator('..')).toContainText('Not assessed');
  for (const decision of ['Build', 'Reuse', 'Extend', 'Defer', 'Question']) {
    await expect(
      page.locator(`.counterfactual-decisions .decision-code-${decision.toLowerCase()}`).first(),
    ).toHaveText(decision);
  }
  await expect(page.getByRole('button', { name: 'Retry complete evaluation' })).toHaveCount(0);
  await expect(page.getByTestId(`failure-banner-${baselineId}`)).toContainText('Guard failed');
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
  await markdownViewer.evaluate((element) => new Promise<void>((resolve) => {
    if (element.scrollTop === 120) return resolve();
    element.addEventListener('scroll', () => resolve(), { once: true });
    element.scrollTo({ top: 120, behavior: 'instant' });
  }));
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

  const review = database.getVariant(reviewId);
  database.updateVariant(reviewId, { artifactCollectionComplete: false });
  try {
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${reviewId}`);
    await expect(page.getByRole('button', { name: 'Promote experiment' })).toHaveCount(0);
  } finally {
    database.updateVariant(reviewId, { artifactCollectionComplete: review.artifactCollectionComplete });
  }
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

test('keeps investigator budgets separate from planner usage and links compact trial summaries', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/overview`);
  const investigator = page.getByTestId(`investigator-${investigatorId}`);
  await expect(investigator.getByLabel('Investigator session and budgets')).toBeVisible();
  await expect(investigator).toContainText('1 primary trial / 3 tests; latest: Test running');
  await expect(investigator.locator('dt', { hasText: /^Agent tokens$/ }).locator('..')).toContainText('Unknown / 2,000,000');
  await expect(investigator.locator('dt', { hasText: /^Agent cost$/ }).locator('..')).toContainText('Unknown');
  await expect(investigator.locator('dt', { hasText: /^Current action$/ }).locator('..')).toContainText('test-running / Test');
  await expect(page.getByText('No active evaluations. Completed experiments remain in the ledger.')).toBeVisible();
  await expect(page.getByLabel('Experiment timing and planner usage')).toHaveCount(0);
  const zero = page.getByTestId(`investigator-${zeroInvestigatorId}`);
  await expect(zero.locator('dt', { hasText: /^Agent tokens$/ }).locator('..')).toContainText('0 / 2,000,000');
  await expect(zero.locator('dt', { hasText: /^Agent cost$/ }).locator('..')).toContainText('$0.00');
  await expect(zero.locator('dt', { hasText: /^Session$/ }).locator('..')).toContainText('Not assigned');

  await page.getByRole('link', { name: 'Experiments', exact: true }).click();
  const row = page.getByTestId(`experiment-row-${investigatorId}`);
  await expect(row).toContainText('Consensus decisions');
  await expect(row).toContainText('Score: replicate mean');
  await row.getByRole('link', { name: /1 primary trial/ }).click();
  await expect(page).toHaveURL(/tab=investigation$/);
  await page.getByRole('link', { name: 'Summary', exact: true }).click();
  await expect(page.getByLabel('Truthful score dimensions')).toContainText('Verified (replicate mean)');
  await expect(page.getByLabel('Truthful score dimensions')).toContainText('Consensus agreement');
  await expect(page.getByRole('link', { name: /1 primary trial/ })).toBeVisible();
});

test('uses one full-primary screening slot and restores repeated final cohorts without stale trial runs', async ({ page }) => {
  const original = database.getVariant(investigatorId);
  const investigation = original.investigation!;
  const trial = { ...investigation.actions[2]!, status: 'running' as const, result: null, startedAt: '2026-09-06T05:02:00.000Z', completedAt: null };
  try {
    database.updateVariant(investigatorId, {
      status: 'running', facts: null, replicateFacts: null, executionState: null,
      investigation: { ...investigation, actions: [trial] },
    });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/overview`);
    const status = page.getByTestId(`investigator-${investigatorId}`);
    await expect(status.locator('dt', { hasText: /^Primary screening$/ }).locator('..')).toContainText('1 configured / trial');
    await expect(status.locator('dt', { hasText: /^Baseline and final$/ }).locator('..')).toContainText('2 / benchmark');
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=runs`);
    await expect(page.getByRole('heading', { name: 'Full-primary screening' })).toBeVisible();
    await expect(page.locator('[data-replicate-group="standard"]')).toHaveCount(1);
    await expect(page.getByTestId(`replicate-${investigatorId}-primary-pack-1`)).toContainText('1 / 1');
    await expect(page.locator('[data-testid*="holdout-pack-"]')).toHaveCount(0);

    const snapshot = { ...execution({ benchmark: 'primary-pack', role: 'primary', replicate: 1, replicateCount: 1, status: 'running' }), startedAt: '2026-09-06T05:02:10.000Z', updatedAt: '2026-09-06T05:02:20.000Z' };
    database.updateVariant(investigatorId, { executionState: { executions: [
      execution({ benchmark: 'primary-pack', role: 'primary', replicate: 2, replicateCount: 2 }), snapshot,
    ] } });
    await page.reload();
    await expect(page.locator('[data-replicate-group="standard"]')).toHaveCount(1);
    await expect(page.getByTestId(`replicate-${investigatorId}-primary-pack-1`)).toContainText('1 / 1');

    const single = runFacts(primaryUsage());
    database.updateVariant(investigatorId, { investigation: { ...investigation, actions: [{
      ...trial, status: 'completed', completedAt: '2026-09-06T05:03:00.000Z',
      result: { score: original.score, facts: single, replicateFacts: [single] },
    }] } });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
    await page.getByTestId('investigation-action-primary-trial').getByText('Hypothesis, result and logs', { exact: true }).click();
    await expect(page.locator('.investigation-evaluation')).toContainText('Consensus agreement: Not measured (n=1)');
    await expect(page.locator('.investigation-evaluation')).not.toContainText('Consensus agreement: 100.0%');

    database.updateVariant(investigatorId, { investigation: { ...investigation, status: 'finalized', actions: [
      { ...trial, status: 'completed', completedAt: '2026-09-06T05:03:00.000Z' },
      { ...trial, id: 'finalize-screening', kind: 'finalize', status: 'completed', completedAt: '2026-09-06T05:04:00.000Z' },
    ] } });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=runs`);
    await expect(page.getByRole('heading', { name: 'Configured run matrix' })).toBeVisible();
    await expect(page.locator('[data-replicate-group="standard"]')).toHaveCount(4);
    await expect(page.locator('[data-replicate-state="pending"]')).toHaveCount(4);
    await expect(page.getByTestId(`replicate-${investigatorId}-primary-pack-2`)).toContainText('2 / 2');
    database.updateVariant(investigatorId, { executionState: { executions: [{
      ...snapshot, replicateCount: 2, startedAt: '2026-09-06T05:05:00.000Z', updatedAt: '2026-09-06T05:05:01.000Z',
    }] } });
    await page.reload();
    await expect(page.locator('[data-replicate-state="current"]')).toHaveCount(1);
    await expect(page.locator('[data-replicate-state="pending"]')).toHaveCount(3);
  } finally {
    database.updateVariant(investigatorId, { status: original.status, facts: original.facts, replicateFacts: original.replicateFacts, executionState: original.executionState, investigation });
  }
});

test('preserves two recorded screening replicates in legacy campaigns and trusts live snapshot counts', async ({ page }) => {
  const original = database.getVariant(investigatorId);
  const investigation = original.investigation!;
  const trial = investigation.actions[2]!;
  await page.route(`**/api/campaigns/${investigatorCampaignId}`, async (route) => {
    const response = await route.fetch();
    const details = await response.json();
    delete details.campaign.config.investigator.primaryReplicates;
    await route.fulfill({ json: details });
  });
  try {
    database.updateVariant(investigatorId, {
      status: 'rejected', facts: null, replicateFacts: null,
      investigation: { ...investigation, status: 'abandoned', actions: [trial] },
      executionState: { executions: [execution({ benchmark: 'primary-pack', role: 'primary', replicate: 1, replicateCount: 1 })] },
    });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/overview`);
    await expect(page.getByTestId(`investigator-${investigatorId}`)).toContainText('2 recorded / trial');
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=runs`);
    await page.reload();
    await expect(page.locator('[data-replicate-group="standard"]')).toHaveCount(2);
    await expect(page.locator('[data-replicate-state="completed"]')).toHaveCount(2);
    await expect(page.getByTestId(`replicate-${investigatorId}-primary-pack-2`)).toContainText('2 / 2');
    await expect(page).toHaveURL(/tab=runs$/);

    database.updateVariant(investigatorId, { status: 'running', investigation: { ...investigation, actions: [{ ...trial, status: 'running', result: null, completedAt: null }] },
      executionState: { executions: [{ ...execution({ benchmark: 'primary-pack', role: 'primary', replicate: 1, replicateCount: 2, status: 'running' }), startedAt: trial.startedAt, updatedAt: trial.startedAt }] },
    });
    await page.reload();
    await expect(page.locator('[data-replicate-group="standard"]')).toHaveCount(2);
    await expect(page.locator('[data-replicate-state="pending"]')).toHaveCount(1);
    await expect(page.locator('[data-replicate-state="current"]')).toHaveCount(1);
  } finally {
    database.updateVariant(investigatorId, { status: original.status, facts: original.facts, replicateFacts: original.replicateFacts, executionState: original.executionState, investigation });
  }
});

test('shows fractional mean correct counts without rounding or clipping in ledger and lineage', async ({ page }) => {
  const original = database.getVariant(investigatorId);
  const base = runFacts(primaryUsage());
  const reuse = runFacts(primaryUsage(), 'reuse');
  const replicates: RunFacts[] = [32, 33].map((correct) => ({
    ...base, unitCount: 65,
    decisions: { ...base.decisions, build: correct, reuse: 65 - correct },
    units: Array.from({ length: 65 }, (_, index) => ({
      ...(index < correct ? base : reuse).units[0]!, id: `mean-${index}`, key: `mean-${index}`,
      ref: { entity: 'workflow', anchor: `mean-${index}` },
      decision: index < correct ? 'build' : 'reuse',
    })),
  }));
  const label = database.listLabels(campaignId, 'primary-pack')[0]!;
  const score = computeReplicateMeanScore(replicates, replicates[0]!.units.map((unit) => ({
    ...label, unitKey: unit.key, status: 'suggested', expectedDecision: 'build',
  })), null);
  expect(score.provisional.correct).toBe(32.5);
  try {
    database.updateVariant(investigatorId, { score, facts: consensusRunFacts(replicates), replicateFacts: replicates });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments`);
      await expect(page.getByTestId(`experiment-row-${investigatorId}`)).toContainText('50.0% · 32.5/65 mean correct');
      await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/lineage?view=${width === 1440 ? 'graph' : 'list'}`);
      const count = page.locator(`[data-lineage-id="${investigatorId}"] .mean-score`).nth(1);
      await expect(count).toHaveText('50.0% · 32.5/65 mean correct');
      expect(await count.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
    }
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}`);
    await expect(page.getByLabel('Truthful score dimensions')).toContainText('50.0% · 32.5/65 mean correct');
  } finally {
    database.updateVariant(investigatorId, { score: original.score, facts: original.facts, replicateFacts: original.replicateFacts });
  }
});

test('live polling preserves run controls, disclosures and scroll while measurements advance', async ({ page }) => {
  const original = database.getVariant(liveId);
  try {
    for (const route of [`/campaigns/${campaignId}/overview`, `/campaigns/${campaignId}/experiments/${liveId}?tab=runs`]) {
      await page.goto(`${baseUrl}${route}`);
      const description = page.locator('.description-details');
      await description.locator('summary').click();
      const table = page.locator(`[data-live-key="${liveId}:replicates"]`);
      await table.evaluate((node) => { node.scrollLeft = 120; });
      const tableNode = await table.elementHandle();
      const descriptionNode = await description.elementHandle();
      const select = page.getByRole('combobox', { name: 'Campaign', exact: true });
      const selectNode = await select.elementHandle();
      await select.focus();
      await page.evaluate('window.scrollTo(0, 100)');
      const scroll = await page.evaluate<number>('window.scrollY');
      const marker = route.endsWith('overview') ? 171 : 172;
      database.updateVariant(liveId, { executionState: { ...original.executionState!, executions: original.executionState!.executions.map((entry) => ({
        ...entry, usage: { ...primaryUsage(), calls: marker },
      })) } });
      // No event: exercise the fallback poll, not only SSE.
      await expect(table).toContainText(String(marker), { timeout: 8_000 });
      expect(await tableNode!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await descriptionNode!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await selectNode!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(description).toHaveAttribute('open', '');
      await expect(select).toBeFocused();
      expect(await table.evaluate((node) => node.scrollLeft)).toBe(120);
      expect(await page.evaluate<number>('window.scrollY')).toBe(scroll);
    }
  } finally {
    database.updateVariant(liveId, { executionState: original.executionState });
  }
});

test('live events preserve ledger controls and allow a pending click to complete', async ({ page }) => {
  const original = database.getVariant(liveId);
  try {
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments`);
    const select = page.locator('#filter-status');
    await select.focus();
    const selectNode = await select.elementHandle();
    const link = page.getByTestId(`experiment-row-${liveId}`).locator('.ledger-title');
    const linkNode = await link.elementHandle();
    const bounds = (await link.boundingBox())!;
    await page.mouse.move(bounds.x + 5, bounds.y + 5);
    await page.mouse.down();
    database.updateVariant(liveId, { status: 'judging' });
    database.addEvent(campaignId, liveId, 'variant.updated', {});
    await expect(page.getByTestId(`experiment-row-${liveId}`).locator('.status')).toHaveText('judging');
    expect(await selectNode!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await linkNode!.evaluate((node) => node.isConnected)).toBe(true);
    await page.mouse.up();
    await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/experiments/${liveId}`);
  } finally {
    database.updateVariant(liveId, { status: original.status });
  }
});

test('live events preserve clean review controls and expanded JSON without freezing other content', async ({ page }) => {
  const original = database.getVariant(baselineId);
  try {
    await page.goto(`${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=primary-pack&filter=all&unit=unit-a`);
    const rootToggle = page.getByRole('button', { name: 'Copy unit anchor' });
    const node = await rootToggle.elementHandle();
    const json = page.locator('.json-viewer-node').first();
    await json.locator('summary').first().click();
    const select = page.getByLabel('Expected disposition');
    await select.focus();
    const selectNode = await select.elementHandle();
    database.updateVariant(baselineId, { hypothesis: { ...original.hypothesis, title: 'Updated review heading' } });
    database.addEvent(campaignId, baselineId, 'variant.updated', {});
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Updated review heading');
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await selectNode!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(select).toBeFocused();
    await expect(json).not.toHaveAttribute('open');
  } finally {
    database.updateVariant(baselineId, { hypothesis: original.hypothesis });
  }
});

test('live target questions keep native options open when an earlier question disappears and retain failed answers', async ({ page, headless }) => {
  const original = database.getVariant(liveId);
  const target = database.getTargetExcludedEvaluation(liveId)!;
  try {
    database.updateTargetExcludedEvaluation(liveId, { executionState: {
      executions: target.executionState!.executions.map((entry) => ({ ...entry, questions: entry.questions.map((question) => ({
        ...question, responseKind: 'single_select' as const, options: [{ id: 'a', label: 'Policy A' }, { id: 'b', label: 'Policy B' }],
      })) })),
    } });
    await page.route(`**/variants/${liveId}/target-excluded/questions/*/answer`, (route) => route.fulfill({ status: 503, json: { error: 'Temporary answer failure' } }));
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${liveId}?tab=target-excluded`);
    const form = page.locator('.counterfactual-question[data-question-benchmark="primary-pack:excluded"]');
    const answer = form.getByLabel('Answer and rationale');
    await answer.fill('Keep my answer through updates.');
    const select = form.getByLabel('Select an answer');
    await select.selectOption('b');
    const node = await select.elementHandle();
    await select.click();
    // macOS headless Chrome dismisses native menus itself; also run this test with --headed.
    if (!headless) await expect.poll(() => select.evaluate((node) => node.matches(':open'))).toBe(true);
    database.updateVariant(liveId, {
      executionState: { executions: original.executionState!.executions.map((entry) => ({ ...entry, questions: [] })) },
    });
    database.addEvent(campaignId, liveId, 'variant.updated', {});
    await expect.poll(() => page.evaluate(`import('/state.js').then(({ state }) => state.campaign.variants.find(v => v.id === '${liveId}').executionState.executions.flatMap(e => e.questions).length)`)).toBe(0);
    if (!headless) {
      await expect(page.locator('.counterfactual-question')).toHaveCount(2);
      expect(await node!.evaluate((node) => node.matches(':open'))).toBe(true);
    }
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(select).toBeFocused();
    await select.blur();
    await expect(page.locator('.counterfactual-question')).toHaveCount(1);
    await expect(select).toHaveValue('b');
    await form.getByRole('button', { name: 'Resume analysis' }).click();
    await expect(page.locator('#notice')).toContainText('Temporary answer failure');
    await expect(form.getByRole('button', { name: 'Resume analysis' })).toBeEnabled();
    await expect(answer).toHaveValue('Keep my answer through updates.');
    await expect(select).toHaveValue('b');
  } finally {
    database.updateVariant(liveId, { executionState: original.executionState, hypothesis: original.hypothesis });
    database.updateTargetExcludedEvaluation(liveId, { executionState: target.executionState });
  }
});

test('live review applies pristine labels but preserves drafts and cancels rejected filter changes', async ({ page }) => {
  const response = await page.request.get(`${baseUrl}/api/campaigns/${campaignId}`);
  const details = await response.json();
  await page.route(`${baseUrl}/api/campaigns/${campaignId}`, (route) => route.fulfill({ json: details }));
  await page.goto(`${baseUrl}/campaigns/${campaignId}/review/${baselineId}?benchmark=primary-pack&filter=all&unit=unit-a`);
  const answer = page.getByLabel('Human rationale');
  await expect(answer).toBeVisible();
  const label = details.labels.find((label: { benchmark: string; unitKey: string }) => label.benchmark === 'primary-pack' && label.unitKey === 'unit-a');
  Object.assign(label, { status: 'verified', expectedDecision: 'reuse', rationale: 'New human label from another tab.' });
  database.addEvent(campaignId, baselineId, 'label.updated', {});
  await expect(answer).toHaveValue('New human label from another tab.');
  await expect(page.getByLabel('Expected disposition')).toHaveValue('reuse');
  await answer.fill('My unsaved local reasoning.');
  await page.evaluate('document.querySelector("#review-rationale").setSelectionRange(3, 9)');
  Object.assign(label, { expectedDecision: 'extend', rationale: 'A newer external label.' });
  const title = details.variants.find((variant: { id: string }) => variant.id === baselineId).hypothesis;
  title.title = 'Updated while draft stays open';
  database.addEvent(campaignId, baselineId, 'label.updated', {});
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title.title);
  await expect(answer).toHaveValue('My unsaved local reasoning.');
  expect(await page.evaluate('[document.querySelector("#review-rationale").selectionStart, document.querySelector("#review-rationale").selectionEnd]')).toEqual([3, 9]);
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByLabel('Select benchmark').selectOption('holdout-pack');
  await expect(page.getByLabel('Select benchmark')).toHaveValue('primary-pack');
  await page.getByLabel('Filter requirement units').selectOption('errors');
  await expect(page.getByLabel('Filter requirement units')).toHaveValue('all');
  await expect(page).toHaveURL(/benchmark=primary-pack&filter=all&unit=unit-a$/);
  await expect(answer).toHaveValue('My unsaved local reasoning.');
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Planner harness help' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(answer).toHaveValue('My unsaved local reasoning.');
});

test('live mobile refresh keeps the drawer and filter disclosure open', async ({ page }) => {
  const original = database.getVariant(liveId);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments`);
    await page.locator('.mobile-filters summary').click();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const menu = page.getByRole('button', { name: 'Open navigation' });
    const node = await menu.elementHandle();
    database.updateVariant(liveId, { status: 'judging' });
    database.addEvent(campaignId, liveId, 'variant.updated', {});
    await expect(page.getByTestId(`experiment-row-${liveId}`).locator('.status')).toHaveText('judging');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.mobile-filters')).toHaveAttribute('open', '');
    await expect(menu).toBeFocused();
  } finally {
    database.updateVariant(liveId, { status: original.status });
  }
});

test('live navigation ignores an older campaign response and reconnects to the returned campaign', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
  await expect(page.getByRole('heading', { name: 'ui e2e' })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${baseUrl}/api/campaigns/${investigatorCampaignId}`, async (route) => {
    await held;
    await route.continue();
  });
  const requested = page.waitForRequest(`${baseUrl}/api/campaigns/${investigatorCampaignId}`);
  await page.getByRole('combobox', { name: 'Campaign', exact: true }).selectOption(investigatorCampaignId);
  await requested;
  await page.getByRole('combobox', { name: 'Campaign', exact: true }).selectOption(campaignId);
  await expect(page).toHaveURL(`${baseUrl}/campaigns/${campaignId}/overview`);
  const completed = page.waitForResponse(`${baseUrl}/api/campaigns/${investigatorCampaignId}`);
  release();
  await completed;
  const refresh = page.waitForResponse(`${baseUrl}/api/campaigns/${campaignId}`);
  database.addEvent(campaignId, liveId, 'variant.updated', {});
  await refresh;
  await expect(page.getByRole('heading', { name: 'ui e2e' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Campaign', exact: true })).toHaveValue(campaignId);
});

test('investigation archive can retry a transient failure without closing details', async ({ page }) => {
  let requests = 0;
  await page.route(`**/api/campaigns/${investigatorCampaignId}/variants/${investigatorId}/artifacts`, async (route) => {
    if (++requests === 1) await route.fulfill({ status: 503, json: { error: 'Temporary archive failure' } });
    else await route.continue();
  });
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
  const action = page.getByTestId('investigation-action-test-failed');
  await action.getByText('Hypothesis, result and logs', { exact: true }).click();
  await action.getByText('Artifact paths and logs', { exact: true }).click();
  await expect(action.getByText('Archive unavailable: Temporary archive failure')).toBeVisible();
  await action.getByRole('button', { name: 'Retry archive' }).click();
  await expect(action.getByRole('link', { name: 'investigation/test-failed/test.log', exact: true })).toBeVisible();
  expect(requests).toBe(2);
});

test('live Markdown preserves selection and last-good content and ignores older report responses', async ({ page }) => {
  const reportUrl = `${baseUrl}/api/campaigns/${campaignId}/variants/${baselineId}/report?format=html`;
  let html = `<h2 id="evidence" data-markdown-level="1">Evidence</h2><p>Keep this selection.</p><pre>${'Recorded evidence\n'.repeat(150)}</pre>`;
  let requests = 0;
  let hold = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(reportUrl, async (route) => {
    const body = html;
    requests++;
    if (hold) await held;
    await route.fulfill({ contentType: 'text/html', body });
  });
  try {
    await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=markdown`);
    const article = page.getByTestId('experiment-markdown');
    await expect(article).toContainText('Keep this selection.');
    const node = await article.elementHandle();
    await article.evaluate((node) => {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node.querySelector('p')!);
      node.ownerDocument.getSelection()!.removeAllRanges();
      node.ownerDocument.getSelection()!.addRange(range);
      node.scrollTo({ top: 100, behavior: 'instant' });
    });
    const refreshed = page.waitForResponse(reportUrl);
    database.addEvent(campaignId, baselineId, 'reports.refreshed', {});
    await refreshed;
    await expect.poll(() => requests).toBe(2);
    expect(await page.evaluate('document.getSelection().toString()')).toBe('Keep this selection.');
    expect(await article.evaluate((node) => node.scrollTop)).toBe(100);
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
    hold = true;
    html = '<h2 id="evidence" data-markdown-level="1">Stale report</h2>';
    database.addEvent(campaignId, baselineId, 'reports.refreshed', {});
    await expect.poll(() => requests).toBe(3);
    await expect(article).toContainText('Keep this selection.');
    hold = false;
    html = '<h2 id="evidence" data-markdown-level="1">Newest report</h2>';
    database.addEvent(campaignId, baselineId, 'reports.refreshed', {});
    await expect(article).toContainText('Newest report');
    const completed = page.waitForResponse(reportUrl);
    release();
    await completed;
    await expect(article).toContainText('Newest report');
    await expect(article).not.toContainText('Stale report');
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    release();
  }
});

test('explains Investigation and Markdown in a compact keyboard-accessible help dialog on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [tab, label] of [['investigation', 'Investigation'], ['markdown', 'Markdown']]) {
      await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=${tab}`);
      const trigger = page.locator('.section-heading').getByRole('button', { name: `Help with ${label}` });
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await trigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'One experiment, two views' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Investigation: follow the attempts');
      await expect(dialog).toContainText('Markdown: read the summary');
      await expect(dialog).toContainText('Try A. Results get worse. Adjust it to B and test again.');
      await expect(dialog).toContainText('B is the latest revision, but has no score yet.');
      await expect(dialog).toContainText('Later revisions do not rewrite earlier results.');
      await expect(dialog.getByRole('button', { name: 'Close help' })).toBeFocused();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
      expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await dialog.getByRole('button', { name: 'Close help' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.mouse.click(5, 5);
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
});

test('help remains open during live refresh, restores focus, and closes on history navigation', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=markdown`);
  await page.getByRole('link', { name: 'Investigation', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Help with Investigation' });
  const previousTrigger = await trigger.elementHandle();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'One experiment, two views' });
  const refreshed = page.waitForResponse((response) => response.url() === `${baseUrl}/api/campaigns/${investigatorCampaignId}`);
  database.addEvent(investigatorCampaignId, investigatorId, 'investigator.updated', { helpRefreshTest: true });
  await refreshed;
  await page.waitForTimeout(100);
  expect(await previousTrigger!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close help' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.goBack();
  await expect(page).toHaveURL(/tab=markdown$/);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Help with Markdown' })).toBeVisible();
});

test('lineage attributes abandoned screening metrics to the measured trial, not the unevaluated revision', async ({ page }) => {
  const original = database.getVariant(investigatorId);
  const investigation = original.investigation!;
  const score = {
    ...original.score!,
    verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
    provisional: { labeled: 125, correct: 41.5, errors: 83.5, accuracy: 0.332 },
  };
  const trial = {
    ...investigation.actions[2]!, id: 'action-005',
    hypothesis: { ...original.hypothesis, title: 'Measured earlier treatment' },
    result: { score, baselineScore: { ...score, provisional: { ...score.provisional, correct: 44, accuracy: 0.352 } },
      facts: { ...original.facts!, sampleSize: 2, decisionAgreement: 0.8 },
      replicateFacts: [runFacts(primaryUsage()), runFacts(primaryUsage())],
    },
  };
  try {
    database.updateVariant(investigatorId, {
      status: 'rejected', facts: null, score: null, patchHash: `sha256:${'b'.repeat(64)}`,
      hypothesis: { ...original.hypothesis, title: 'Unevaluated latest revision' },
      investigation: { ...investigation, status: 'abandoned', reason: 'Remaining budget could not cover another evaluation.', actions: [trial, {
        ...investigation.actions[3]!, kind: 'test', status: 'completed', result: { passed: true },
      }] },
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/lineage?view=${width === 1440 ? 'graph' : 'list'}`);
      const card = page.locator(`[data-lineage-id="${investigatorId}"]`);
      await expect(card).toContainText('Latest screening: action-005');
      await expect(card).toContainText('Measured earlier treatment');
      await expect(card).toContainText('Latest revision not evaluated');
      await expect(card.locator('dt', { hasText: /^Verified$/ }).locator('..')).toContainText('No reviewed labels');
      await expect(card.locator('dt', { hasText: /^Provisional$/ }).locator('..')).toContainText('33.2% · 41.5/125 mean correct');
      await expect(card.locator('dt', { hasText: /^Agreement$/ }).locator('..')).toContainText('80.0%');
      await expect(card).toContainText('Baseline 35.2% · -2.0 pp');
      await expect(card).toContainText('Abandoned before final evaluation');
      await expect(card).toContainText('Remaining budget could not cover another evaluation.');
      await expect(card.locator('dt', { hasText: /^Sibling rank$/ }).locator('..')).toContainText('Unranked');
      expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
    }
    await page.locator(`[data-lineage-id="${investigatorId}"]`).getByRole('link', { name: 'View investigation' }).click();
    await expect(page).toHaveURL(/tab=investigation$/);
    await expect(page.locator('.investigation-panel')).toContainText('Each trial freezes its hypothesis and patch before evaluation');
    await orchestrator.refreshReports(investigatorCampaignId);
    await page.getByRole('link', { name: 'Markdown', exact: true }).click();
    await expect(page.locator('.markdown-panel')).toContainText('Living experiment report');
    await expect(page.locator('.markdown-panel')).toContainText('not a finalized plan');

    database.updateVariant(investigatorId, { facts: original.facts, score: original.score });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/lineage`);
    const finalCard = page.locator(`[data-lineage-id="${investigatorId}"]`);
    await expect(finalCard).toContainText('Final evaluation');
    await expect(finalCard).not.toContainText('Latest screening: action-005');
    await expect(finalCard).not.toContainText('33.2%');

    database.updateVariant(investigatorId, { facts: null, score: null, investigation: {
      ...investigation, status: 'abandoned', actions: [{ ...trial, result: { ...trial.result,
        facts: { ...trial.result.facts, sampleSize: 1, decisionAgreement: 1 }, replicateFacts: [runFacts(primaryUsage())],
      } }],
    } });
    await page.reload();
    await expect(finalCard.locator('dt', { hasText: /^Agreement$/ }).locator('..')).toContainText('Not measured (n=1)');
    database.updateVariant(investigatorId, { investigation: {
      ...investigation, status: 'abandoned', reason: 'No testable treatment was produced.', actions: [investigation.actions[0]!],
    } });
    await page.reload();
    await expect(finalCard).toContainText('No evaluation recorded');
    await expect(finalCard.locator('dt', { hasText: /^Provisional$/ }).locator('..')).toContainText('Not measured');
    await expect(finalCard).toContainText('No testable treatment was produced.');
  } finally {
    database.updateVariant(investigatorId, { status: original.status, hypothesis: original.hypothesis,
      facts: original.facts, score: original.score, patchHash: original.patchHash, investigation });
  }
});

test('renders failed then passing tests and primary evaluation with lazy archive links and reloadable tab', async ({ page }) => {
  const artifactRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/artifacts')) artifactRequests.push(request.url()); });
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Investigation', exact: true })).toHaveAttribute('aria-current', 'page');
  const timeline = page.getByRole('table', { name: 'Investigation action timeline', exact: true });
  await expect(timeline.getByRole('rowheader')).toHaveText([
    '1. Testtest-failed', '2. Testtest-passed', '3. Primary evaluationprimary-trial', '4. Testtest-running',
  ]);
  const failed = page.getByTestId('investigation-action-test-failed');
  const passed = page.getByTestId('investigation-action-test-passed');
  const trial = page.getByTestId('investigation-action-primary-trial');
  await expect(failed).toContainText('Test failed');
  await expect(passed).toContainText('Tests passed (not correctness)');
  await expect(trial).toContainText('Primary score recorded');
  await expect(page.locator('.investigation-raw')).toHaveCount(0);
  expect(artifactRequests).toEqual([]);
  await failed.getByText('Hypothesis, result and logs', { exact: true }).click();
  await expect(failed.getByText('Source assertion failed.', { exact: true })).toBeVisible();
  await expect(failed.getByText('Agent interpretation / unverified')).toBeVisible();
  await trial.getByText('Hypothesis, result and logs', { exact: true }).click();
  const scores = trial.getByRole('table', { name: 'Primary trial score comparison' });
  await expect(scores.getByRole('row', { name: /Verified accuracy/ })).toContainText('0.0%');
  await expect(scores.getByRole('row', { name: /Verified accuracy/ })).toContainText('100.0%');
  await expect(scores.getByRole('row', { name: /Provisional accuracy/ })).toContainText('Unknown');
  await expect(trial).toContainText('Score basis: replicate mean. Consensus decisions are separate.');
  await expect(trial).toContainText('Recorded decision transitions: 1.');
  await expect(trial).toContainText('The runtime answer ledger freezes repeated semantic answers within a pinned context.');
  await expect(page.locator('.investigation-raw')).toHaveCount(0);
  expect(artifactRequests).toEqual([]);
  await failed.getByText('Artifact paths and logs', { exact: true }).click();
  const log = failed.getByRole('link', { name: 'investigation/test-failed/test.log', exact: true });
  await expect(log).toHaveAttribute('target', '_blank');
  const response = await page.request.get(`${baseUrl}${await log.getAttribute('href')}`);
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain('Seeded test failed. This is execution evidence only.');
  expect(artifactRequests.some((url) => url.includes('?path='))).toBe(false);
});

test('reads integrated failed-action archives and nested finalization test results', async ({ page }) => {
  const original = database.getVariant(zeroInvestigatorId).investigation!;
  const source = database.getVariant(investigatorId).investigation!;
  const directory = path.join(paths.artifacts, investigatorCampaignId, zeroInvestigatorId, 'investigation/action-001');
  const finalDirectory = path.join(paths.artifacts, investigatorCampaignId, zeroInvestigatorId, 'investigation/action-002');
  await mkdir(directory, { recursive: true });
  await mkdir(finalDirectory, { recursive: true });
  await writeFile(path.join(directory, 'gate-1.log'), 'Trusted gate output, not correctness evidence.\n');
  await writeFile(path.join(finalDirectory, 'gate-1.log'), 'Final configured gate passed.\n');
  try {
    database.updateVariant(zeroInvestigatorId, { investigation: {
      ...original, status: 'finalized', turnCount: 2,
      actions: [
        { ...source.actions[0]!, id: 'action-001', artifactDirectory: 'investigation/action-001', result: null, error: 'Trusted test failed.\nArtifacts: investigation/action-001' },
        { ...source.actions[1]!, id: 'action-002', kind: 'finalize', artifactDirectory: 'investigation/action-002', result: {
          passed: true, tests: { passed: true, testFiles: [], logPaths: [path.join(finalDirectory, 'gate-1.log')] }, compliance: { status: 'passed' },
        } },
      ],
    } });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${zeroInvestigatorId}?tab=investigation`);
    const failed = page.getByTestId('investigation-action-action-001');
    await failed.getByText('Hypothesis, result and logs', { exact: true }).click();
    await expect(failed).toContainText(`Patch: ${source.actions[0]!.patchHash}`);
    await failed.getByText('Artifact paths and logs', { exact: true }).click();
    await expect(failed.getByRole('link', { name: 'investigation/action-001/gate-1.log', exact: true })).toBeVisible();
    const finalized = page.getByTestId('investigation-action-action-002');
    await finalized.getByText('Hypothesis, result and logs', { exact: true }).click();
    await expect(finalized).toContainText('Full configured tests: Passed. Semantic review: passed (unverified model judgment).');
    await expect(finalized).toContainText('Finalization is not promotion.');
    await finalized.getByText('Artifact paths and logs', { exact: true }).click();
    await expect(finalized.getByRole('link', { name: 'investigation/action-002/gate-1.log', exact: true })).toBeVisible();
  } finally {
    database.updateVariant(zeroInvestigatorId, { investigation: original });
  }
});

test('polls running investigations with finished variant lifecycles without losing open details or focus', async ({ page }) => {
  await page.route('**/events?*', (route) => route.abort());
  const original = database.getVariant(investigatorId).investigation!;
  try {
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
    const details = page.getByTestId('investigation-action-test-failed').locator('details').first();
    await details.locator('summary').first().click();
    const rationale = details.getByText(longInvestigationText, { exact: true });
    await expect(rationale).toBeVisible();
    await details.locator('summary').first().focus();
    await page.evaluate('window.scrollTo(0, 250)');
    const scrollY = await page.evaluate<number>('window.scrollY');
    database.updateVariant(investigatorId, { investigation: { ...original, turnCount: 5, agentTokens: 0, agentCostUsd: 0 } });
    const status = page.getByTestId(`investigator-${investigatorId}`);
    await expect(status.locator('dt', { hasText: /^Turns$/ }).locator('..')).toContainText('5 / 12', { timeout: 8_000 });
    await expect(status.locator('dt', { hasText: /^Agent cost$/ }).locator('..')).toContainText('$0.00');
    await expect(details).toHaveAttribute('open', '');
    await expect(details.locator('summary').first()).toBeFocused();
    expect(Math.abs(await page.evaluate<number>('window.scrollY') - scrollY)).toBeLessThan(2);
  } finally {
    database.updateVariant(investigatorId, { investigation: original });
  }
});

test('refreshes on investigator-specific SSE events', async ({ page }) => {
  // Isolate the new event from the existing variant.updated listener and polling fallback.
  await page.addInitScript({ content: `
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      addEventListener(...args) {
        if (args[0] === 'investigator.updated') super.addEventListener(...args);
      }
    };
    window.setInterval = () => 0;
  ` });
  const original = database.getVariant(zeroInvestigatorId).investigation!;
  try {
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${zeroInvestigatorId}?tab=investigation`);
    await expect(page.getByRole('heading', { name: 'Investigation', exact: true })).toBeVisible();
    database.updateVariant(zeroInvestigatorId, { investigation: { ...original, reason: 'Investigator-specific live update.' } });
    database.addEvent(investigatorCampaignId, zeroInvestigatorId, 'investigator.updated', {});
    await page.getByText('Recorded reason (unverified interpretation)', { exact: true }).click();
    await expect(page.getByText('Investigator-specific live update.', { exact: true })).toBeVisible({ timeout: 8_000 });
  } finally {
    database.updateVariant(zeroInvestigatorId, { investigation: original });
  }
});

test('keeps unknown results, long hypotheses, and raw details readable on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${unknownInvestigatorId}?tab=investigation`);
    const action = page.getByTestId('investigation-action-unknown-result');
    await expect(action).toContainText('Primary result unknown');
    await expect(action).not.toContainText('Tests passed');
    await expect(page.locator('.investigation-raw')).toHaveCount(0);
    await expect(page.getByText('MODEL_OUTPUT_ONLY_MARKER', { exact: true })).toHaveCount(0);
    await page.getByText('Recorded reason (unverified interpretation)', { exact: true }).click();
    await expect(page.locator('.investigation-status .investigation-prose')).toHaveText(longInvestigationText);
    await action.getByText('Hypothesis, result and logs', { exact: true }).click();
    await expect(action.getByText('No readable score recorded. No improvement can be inferred.')).toBeVisible();
    await expect(action.getByRole('table')).toHaveCount(0);
    await action.getByText('Raw result (unverified; may include model output)', { exact: true }).click();
    await expect(action.locator('pre')).toContainText('MODEL_OUTPUT_ONLY_MARKER');
    await expect(page.locator('.investigation-panel img')).toHaveCount(0);
    expect(await page.evaluate('window.__investigationExecuted')).toBeUndefined();
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
    const table = page.locator('.investigation-table-wrap');
    expect(await table.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(action.locator('.investigation-action-title')).toHaveCSS('overflow-wrap', 'anywhere');
    await expect(action).toHaveCSS('font-size', '12px');
    if (width === 390) {
      expect((await action.locator('summary').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
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
  await expect(page.getByLabel('Enable autonomous investigator')).toBeChecked();
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
    mode: 'supervised',
    investigator: { enabled: true, primaryReplicates: 2, maxTurns: 12, maxPrimaryEvaluations: 3, maxWallTimeMs: 14_400_000, maxAgentTokens: 2_000_000 },
    evaluation: { replicates: 2, replicateConcurrency: 2 },
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

for (const enabled of [true, false]) {
  test(`creates automatic campaigns with investigator ${enabled ? 'custom budgets' : 'disabled'}`, async ({ page }) => {
    const id = enabled ? 'custom-investigator-ui' : 'disabled-investigator-ui';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/campaigns/new`);
    await page.getByLabel('Campaign ID').fill(id);
    await page.getByLabel('Research goal').fill('Keep autonomous investigation independent of campaign control mode and planner budgets.');
    await page.getByLabel('Control mode').selectOption('automatic');
    await page.getByLabel('Planner repository').fill(plannerRepo);
    await page.getByLabel('Workflows repository').fill(workflowsRepo);
    await page.getByLabel('Planner environment file').fill(environmentFile);
    await page.getByLabel('Planner seed revision').fill(seedSha);
    await page.getByLabel('Workflows revision').fill(workflowsSha);
    await page.getByLabel('Primary requirements ZIP').setInputFiles(primaryZip);
    await page.getByLabel('Holdout requirements ZIP').setInputFiles(holdoutZip);
    await page.getByText('Advanced investigator budgets', { exact: true }).click();
    const screening = page.getByLabel('Primary screening replicates');
    await expect(screening).toHaveValue('2');
    await expect(page.getByLabel('Investigator wall time (minutes)')).toHaveValue('240');
    await expect(screening).toHaveAttribute('min', '1');
    await expect(screening).toHaveAttribute('max', '3');
    await screening.fill('2');
    await page.getByLabel('Maximum investigator turns').fill('6');
    await page.getByLabel('Maximum primary evaluations').fill('2');
    await page.getByLabel('Investigator wall time (minutes)').fill('45');
    await page.getByLabel('Maximum investigator tokens').fill('120000');
    await page.getByLabel('Enable autonomous investigator').uncheck();
    await expect(page.getByLabel('Maximum investigator turns')).toBeDisabled();
    await expect(screening).toBeDisabled();
    if (enabled) {
      await page.getByLabel('Enable autonomous investigator').check();
      await expect(page.getByLabel('Maximum investigator turns')).toHaveValue('6');
      await page.getByLabel('Maximum investigator turns').fill('0');
      await page.getByText('Advanced investigator budgets', { exact: true }).click();
      await page.getByRole('button', { name: 'Create frozen campaign' }).click();
      await expect(page.getByLabel('Maximum investigator turns')).toBeVisible();
      await page.getByLabel('Maximum investigator turns').fill('6');
    }
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(390);
    const request = page.waitForRequest((request) => request.method() === 'POST' && request.url() === `${baseUrl}/api/campaigns`);
    await page.getByRole('button', { name: 'Create frozen campaign' }).click();
    const input = (await request).postDataJSON();
    expect(input.mode).toBe('automatic');
    expect(input.evaluation).toEqual({ replicates: 3, replicateConcurrency: 2 });
    expect(input.investigator).toEqual(enabled
      ? { enabled: true, primaryReplicates: 2, maxTurns: 6, maxPrimaryEvaluations: 2, maxWallTimeMs: 2_700_000, maxAgentTokens: 120_000 }
      : { enabled: false });
    await expect(page).toHaveURL(`${baseUrl}/campaigns/${id}/overview`);
    expect(database.getCampaign(id).config.investigator?.enabled).toBe(enabled);
  });
}

test('timing help chips explain execution scopes without changing measurements', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
  const active = page.getByTestId(`active-variant-${liveId}`);
  for (const [label, definition] of [
    ['End-to-end', 'Elapsed time for this execution'],
    ['Phase 2', 'baseline or final evaluation batch'],
    ['Planner duration', 'Sum of planner-reported durations'],
    ['Wall elapsed', 'from startup through result capture'],
    ['Model duration', 'reported for this replicate'],
  ] as const) {
    const trigger = active.getByRole('button', { name: `Help with ${label}`, exact: true });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await trigger.press('Enter');
    const dialog = page.getByRole('dialog', { name: label, exact: true });
    await expect(dialog).toContainText(definition);
    await expect(dialog).toContainText('missing, not zero');
    await expect(dialog).toContainText('cannot be added or subtracted');
    if (label === 'End-to-end') {
      await expect(dialog).toContainText('human review or promotion');
      await expect(dialog).toContainText('resets');
    }
    if (label === 'Phase 2') {
      await expect(dialog).toContainText('after stack startup');
      await expect(dialog).toContainText('configured target-excluded work');
      await expect(dialog).toContainText('investigation trials, builds, or later judging');
    }
    if (label === 'Planner duration') {
      await expect(dialog).toContainText('latest trial');
      await expect(dialog).toContainText('final cohorts');
      await expect(dialog).toContainText('not wall-clock or active time');
      await expect(dialog).toContainText('investigator-agent and target-excluded usage');
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('.help-dialog')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await expect(active.getByLabel('Experiment timing and planner usage')).toContainText('820 incl. reasoning');
  await expect(active.getByLabel('Experiment timing and planner usage')).toContainText('$0.95');

  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${baselineId}?tab=summary`);
  const summary = page.getByLabel('Experiment timing and planner usage');
  for (const label of ['End-to-end', 'Phase 2', 'Planner duration']) {
    await expect(summary.getByRole('button', { name: `Help with ${label}`, exact: true })).toBeVisible();
  }
  await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${investigatorId}?tab=investigation`);
  await page.getByRole('button', { name: 'Help with Wall time', exact: true }).click();
  const wall = page.getByRole('dialog', { name: 'Wall time', exact: true });
  await expect(wall).toContainText('investigator session');
  await expect(wall).toContainText('configured wall-time budget');
  await expect(wall).toContainText('not planner model duration');
});

test('timing help survives refresh and restores the matching replaced trigger', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/experiments/${liveId}?tab=runs`);
  const trigger = page.getByRole('button', { name: 'Help with Wall elapsed', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Wall elapsed', exact: true });
  const originalDialog = await dialog.elementHandle();
  const refreshed = page.waitForResponse((response) => response.url() === `${baseUrl}/api/campaigns/${campaignId}`);
  database.addEvent(campaignId, liveId, 'variant.updated', { timingHelpRefresh: true });
  await refreshed;
  await expect(dialog).toBeVisible();
  expect(await originalDialog!.evaluate((node) => node.isConnected && node.parentElement === node.ownerDocument.body)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Close help' })).toBeFocused();
  // Exercise focus fallback even when live rendering preserves the original node.
  await page.evaluate(`import('/help.js').then(({ helpButton }) => {
    document.querySelector('[data-help-topic="Wall elapsed"]').replaceWith(helpButton('Wall elapsed'));
  })`);
  await dialog.getByRole('button', { name: 'Close help' }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.evaluate(`window.dispatchEvent(new PopStateEvent('popstate'))`);
  await expect(dialog).toHaveCount(0);
});

test('global help guide is scrollable and keyboard accessible at compact widths', async ({ page }) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`${baseUrl}/campaigns/new`);
    await expect(page.getByRole('heading', { name: 'Create an evaluation campaign', exact: true })).toBeVisible();
    const trigger = page.locator('.topbar').getByRole('button', { name: 'Help', exact: true });
    await expect(trigger).toBeVisible();
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Planner harness help', exact: true });
    await expect(dialog).toBeVisible();
    for (const heading of ['Getting started', 'Where to look', 'How autonomous investigation works', 'Reading results']) {
      await expect(dialog.getByRole('heading', { name: heading, exact: true })).toHaveCount(1);
    }
    await expect(dialog.getByRole('list', { name: 'Autonomous investigation steps' }).getByRole('listitem')).toHaveCount(6);
    for (const copy of [
      'Autonomous investigation is optional', 'archived evidence', 'persistent session',
      'Revise, abandon, or finalize', 'full configured tests', 'independent AI compliance review',
      'holdout/regression', 'configured target-excluded', 'development, not final validation',
      'tests do not establish accuracy', 'unverified model judgment', 'human-reviewed labels',
      'AI suggestions', 'Finalization is not promotion', 'Supervised mode', 'Automatic mode', 'eligible',
    ]) await expect(dialog).toContainText(copy);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
    expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const close = dialog.getByRole('button', { name: 'Close help' });
    await expect(close).toBeFocused();
    if (process.env.HARNESS_UI_SCREENSHOTS) await page.screenshot({ path: test.info().outputPath(`help-${width}.png`) });
    await dialog.locator('.help-body').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(dialog.getByRole('heading', { name: 'Reading results', exact: true })).toBeInViewport();
    await expect(close).toBeInViewport();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(node.ownerDocument.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('target separator remains subordinate to timing help table headers', async ({ page }) => {
  await page.goto(`${baseUrl}/campaigns/${campaignId}/overview`);
  const group = page.getByTestId(`replicate-group-${liveId}-target-excluded`);
  const title = group.locator('.replicate-group-title');
  await expect(title).toHaveText('Target-excluded guard');
  await expect(title).toHaveCSS('text-transform', 'none');
  await expect(title).toHaveCSS('font-weight', '500');
  expect(await title.evaluate((node) => parseFloat(node.ownerDocument.defaultView!.getComputedStyle(node).fontSize))).toBeLessThanOrEqual(9);
  await expect(group.locator('th')).toHaveCSS('padding-top', '5px');
  await expect(group.locator('.status')).toHaveText('running');
  await expect(group.locator('.replicate-group-note')).toContainText('excluded from standard totals');
  if (process.env.HARNESS_UI_SCREENSHOTS) await page.getByTestId(`active-variant-${liveId}`).screenshot({ path: test.info().outputPath('run-timing.png') });
});

test('renders real EvidenceStore responses through the local dashboard API', async ({ page }) => {
  const id = `${investigatorCampaignId}-evidence-contract`;
  const original = database.getVariant(investigatorId);
  const hypothesis = { ...original.hypothesis, title: 'Archived source eligibility trial' };
  const parentFacts = runFacts(primaryUsage(), 'build');
  const trialFacts = runFacts(primaryUsage(), 'reuse');
  trialFacts.units[0]!.sourceRefs = [{ path: 'src/shared/account.ts', symbol: 'accountId' }];
  const labels = [{ campaignId: investigatorCampaignId, benchmark: 'primary-pack', unitKey: trialFacts.units[0]!.key,
    expectedDecision: 'build', status: 'suggested', classification: 'real_gap', rationale: 'Synthetic reference interpretation.' }];
  const score = computeScore(trialFacts, [], null);
  const action = { ...original.investigation!.actions[2]!, id: 'action-099', hypothesis,
    artifactDirectory: 'investigation/action-099', result: { score, baselineScore: original.score, facts: trialFacts,
      replicateFacts: [trialFacts, trialFacts], labelSetHash: 'fixture-labels' } };
  database.createVariant({ id, campaignId: investigatorCampaignId, parentVariantId: investigatorId, round: 2, ordinal: 4, hypothesis });
  database.updateVariant(id, { status: 'review', investigation: { ...original.investigation!, status: 'abandoned', actions: [action] } });
  const current = path.join(paths.artifacts, investigatorCampaignId, id);
  const receiptDirectory = path.join(current, 'investigation/action-099');
  await mkdir(receiptDirectory, { recursive: true });
  await writeFile(path.join(current, 'investigator-reference.json'), JSON.stringify({ labels, labelSetHash: 'fixture-labels',
    baseline: { id: investigatorId, facts: parentFacts, replicateFacts: [parentFacts, parentFacts] } }));
  await writeFile(path.join(receiptDirectory, 'receipt.json'), JSON.stringify(action));
  const sourceDirectory = path.join(paths.worktrees, investigatorCampaignId, 'frozen-workflows/src/shared');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(path.join(sourceDirectory, 'account.ts'), 'export const accountId = "canonical-identifier";\n');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${baseUrl}/campaigns/${investigatorCampaignId}/experiments/${id}?tab=investigation`);
    const explorer = page.getByTestId('evidence-explorer');
    const listed = page.waitForResponse((response) => response.url().includes(`/variants/${id}/evidence?tool=list_observations`));
    await explorer.getByText('Explore evidence', { exact: true }).click();
    const listing = await (await listed).json();
    const observation = listing.items.find((item: { actionId?: string }) => item.actionId === 'action-099');
    expect(observation.snapshotRef).toMatch(/^snapshot_[a-f0-9]{64}$/);
    await expect(explorer.getByRole('heading', { name: 'action-099', exact: true })).toBeVisible();
    await explorer.getByLabel('Evidence tool').selectOption('compare_trial');
    await explorer.getByLabel('Observation').selectOption(observation.snapshotRef);
    const compared = page.waitForResponse((response) => response.url().includes(`/variants/${id}/evidence?tool=compare_trial`));
    await explorer.getByRole('button', { name: 'Load evidence' }).click();
    const comparison = await (await compared).json();
    expect(comparison.items[0].before).toEqual({ build: 1 });
    expect(comparison.items[0].after).toEqual({ reuse: 1 });
    await expect(explorer).toContainText('Build 100%');
    await expect(explorer).toContainText('Reuse 100%');
    await expect(explorer).toContainText('LLM suggestion / unverified');
    await expect(explorer.getByRole('button', { name: 'Inspect parent unit' })).toBeVisible();
    await explorer.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await fixtureScreenshot(page, `evidence-comparison-actual-${width}`);
    await explorer.getByRole('button', { name: 'Inspect unit', exact: true }).click();
    await expect(explorer.getByRole('heading', { name: 'Replicate 1', exact: true })).toBeVisible();
    await expect(explorer.getByRole('heading', { name: 'Replicate 2', exact: true })).toBeVisible();
    await expect(explorer).toContainText('Shortlist candidates');
    await expect(explorer).toContainText('src/shared/account.ts / accountId');
    await expect(explorer.locator('.evidence-item pre').first()).not.toBeVisible();
    const metadata = explorer.locator('.evidence-item .evidence-metadata').first();
    await metadata.locator('summary').click();
    await expect(metadata).toContainText('rawAnalysis');
    const node = await metadata.elementHandle();
    const refreshed = page.waitForResponse(`${baseUrl}/api/campaigns/${investigatorCampaignId}`);
    database.addEvent(investigatorCampaignId, id, 'investigator.updated', {});
    await refreshed;
    await expect(metadata).toHaveAttribute('open', '');
    expect(await node!.evaluate((node) => node.isConnected)).toBe(true);
    await metadata.locator('summary').click();
    await explorer.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await fixtureScreenshot(page, `evidence-unit-actual-${width}`);
    await explorer.getByRole('button', { name: 'Read source', exact: true }).first().click();
    await expect(explorer.getByLabel('Evidence excerpt')).toContainText('canonical-identifier');
    await expect(explorer).toContainText('UTF-8 bytes');
    const access = page.getByTestId('evidence-access');
    await access.getByText('Evidence access', { exact: true }).click();
    await expect(access.getByRole('heading', { name: 'inspect_unit / ok', exact: true }).first()).toBeVisible();
    await expect(access).toContainText(id);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBe(width);
  }
});
