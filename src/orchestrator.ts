import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  loadCampaignConfig,
  readEnvironmentFile,
  resolveCampaignConfig,
  sha256File,
  withPlannerAnalysisLimits,
  writeResolvedCampaignConfig,
} from './config.js';
import { HarnessDatabase } from './db.js';
import { AgentRunner, type SourceQuestionAnswer } from './agents.js';
import { normalizeExecutionFailure } from './failures.js';
import { runInvestigatorLoop } from './investigatorLoop.js';
import type { InvestigationState } from './investigator.js';
import {
  canonicalHash,
  compareCohort,
  compareScores,
  computeReplicateMeanScore,
  computeScore,
  computeTargetExcludedGate,
  consensusRunFacts,
  validateMeaningfulFacts,
} from './metrics.js';
import type { HarnessPaths } from './paths.js';
import {
  campaignDirectory,
  campaignReportDirectory,
  ensureHarnessPaths,
  variantArtifactDirectory,
} from './paths.js';
import {
  PlannerClient,
  type Phase2QuestionAnswer,
  type Phase2QuestionAudit,
  type Phase2Result,
  type PlannerQuestionRecord,
} from './plannerClient.js';
import { writeAgentHistory, writeCampaignIndex, writeVariantReport } from './reports.js';
import { captureResearchInputs, freezeResearchInputs } from './research.js';
import {
  archiveHypothesisComplianceAttemptInputs,
  archivePartialHypothesisComplianceAttemptInputs,
  hypothesisComplianceAttemptDirectory,
  hypothesisComplianceResultPath,
  mutationContextRequiresFalsification,
  verifyHypothesisComplianceResult,
} from './hypothesisCompliance.js';
import {
  assembleDiagnosisInput,
  diagnosisResultPath,
  readDiagnosisInput,
  verifyDiagnosisArtifacts,
  verifyDiagnosisResult,
  writeMutationContext,
} from './diagnosis.js';
import { runCommand } from './process.js';
import {
  buildVariantImage,
  captureAndGateDiff,
  captureMutationDiff,
  collectStackArtifacts,
  ensureVariantArtifactDirectory,
  loadCampaignEnvironment,
  prepareVariantWorktree,
  reattachVariantStack,
  runVariantGates,
  runInvestigatorTests,
  startVariantStack,
  stageMutationBaseline,
  stopVariantStack,
  type StackHandle,
} from './stack.js';
import type {
  Benchmark,
  CampaignRecord,
  Decision,
  Hypothesis,
  JudgeOutput,
  Phase2RunSnapshot,
  RunFacts,
  TargetExcludedConfig,
  TargetExcludedEvaluationRecord,
  TargetNormalArmBinding,
  VariantRecord,
} from './types.js';
import { TargetExcludedConfigSchema } from './types.js';
import { resolveBenchmarkQuestions } from './upstreamQuestions.js';
import { answerWithRuntimeLedger, runtimeQuestionCacheKey } from './runtimeAnswerLedger.js';
import {
  runTargetExcludedComparison,
  summarizeTargetExcludedComparisonReport,
} from './targetExcludedComparison.js';
import {
  containsTargetIdentityLeak,
  createTargetExcludedSourceSnapshot,
  verifyTargetExcludedSourceSnapshot,
} from './targetExcludedSource.js';

const baselineHypothesis: Hypothesis = {
  title: 'Unmodified campaign seed',
  rationale: 'Measure the selected seed revision before applying an experimental mutation.',
  instructions: 'Do not modify the planner.',
  expectedImpact: 'Establish reproducible primary and holdout facts for this campaign.',
  risk: 'Provider nondeterminism means one screening run is descriptive rather than conclusive.',
  findingIds: [],
  assumptions: [
    'Repeated runs with frozen inputs provide a campaign-local behavioral baseline.',
    'The unmodified seed is a reference observation, not evidence that its decisions are correct.',
  ],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function matchQuestionConsultations(
  consultations: readonly unknown[],
  question: PlannerQuestionRecord,
): Record<string, unknown>[] {
  return consultations.filter((value): value is Record<string, unknown> => {
    if (!isRecord(value) || !isRecord(value.intent)) return false;
    const origin = isRecord(value.intent.origin) ? value.intent.origin : {};
    const request = isRecord(value.intent.request) ? value.intent.request : {};
    const requirementUnitId = origin.requirementUnitId;
    const coversRequirement =
      !question.coverageIds?.length ||
      (typeof requirementUnitId === 'string' && question.coverageIds.includes(requirementUnitId));
    return (
      origin.runId === question.createdByRunId &&
      request.ask === question.prompt &&
      coversRequirement
    );
  });
}

export function selectedOptionIdForAnswer(
  question: PlannerQuestionRecord,
  answer: string,
  previousOptionId?: string,
): string | undefined {
  const options = question.options ?? [];
  if (previousOptionId && options.some((option) => option.id === previousOptionId)) {
    return previousOptionId;
  }
  const normalized = answer.trim().toLocaleLowerCase();
  return options.find(
    (option) =>
      option.id === answer || option.label.trim().toLocaleLowerCase() === normalized,
  )?.id;
}

export function citationEvidence(citation: unknown): string {
  if (!isRecord(citation)) return 'requirements-agent citation';
  const entity = typeof citation.entity === 'string' ? citation.entity : null;
  const anchor = typeof citation.anchor === 'string' ? citation.anchor : null;
  if (entity && anchor) return `${entity}#${anchor}`;
  if (anchor) return anchor;
  if (entity) return entity;
  return 'requirements-agent citation';
}

function normalizeHttpsGitRemote(value: string): string {
  const trimmed = value.trim();
  const scpStyle = /^git@([^:]+):(.+)$/.exec(trimmed);
  const candidate = scpStyle ? `https://${scpStyle[1]}/${scpStyle[2]}` : trimmed;
  let remote: URL;
  try {
    remote = new URL(candidate);
  } catch {
    throw new Error(`workflows source remote is not a valid URL: ${trimmed}`);
  }
  if (remote.protocol === 'ssh:' && remote.hostname) {
    remote = new URL(`https://${remote.hostname}${remote.pathname}`);
  }
  if (remote.protocol !== 'https:' || remote.username || remote.password) {
    throw new Error('workflows source remote must resolve to HTTPS without embedded credentials');
  }
  return remote.toString();
}

function primaryBenchmark(campaign: CampaignRecord): Benchmark {
  const benchmark = campaign.config.benchmarks.find((item) => item.role === 'primary');
  if (!benchmark) throw new Error('campaign has no primary benchmark');
  return benchmark;
}

export function targetExcludedProtocolPlan(
  campaign: CampaignRecord,
  config: TargetExcludedConfig | null,
): {
  protocol: TargetExcludedConfig['protocol'];
  targetImplementationWorkflow: string;
  targetSafePrimary: boolean;
  integrated: boolean;
} | null {
  const declared = campaign.config.targetExcluded;
  if (declared) {
    if (config && config.protocol !== 'standard-primary-v2') {
      throw new Error('campaign-frozen V2 target cannot use a dedicated-control V1 config');
    }
    if (config && config.targetImplementationWorkflow !== declared.targetImplementationWorkflow) {
      throw new Error('target-excluded config differs from the campaign-frozen target identity');
    }
    return {
      protocol: 'standard-primary-v2',
      targetImplementationWorkflow: declared.targetImplementationWorkflow,
      targetSafePrimary: true,
      integrated: true,
    };
  }
  if (!config) return null;
  if (config.protocol === 'standard-primary-v2') {
    throw new Error('V2 target-excluded config has no campaign-frozen target identity');
  }
  return {
    protocol: 'dedicated-control-v1',
    targetImplementationWorkflow: config.targetImplementationWorkflow,
    targetSafePrimary: false,
    integrated: true,
  };
}

export function targetExcludedComparisonDirectories(
  variantArtifactRoot: string,
  primaryName: string,
  replicate: number,
  protocol: TargetExcludedConfig['protocol'],
): { normalArtifactDirectory: string; excludedArtifactDirectory: string } {
  const targetRoot = path.join(variantArtifactRoot, 'target-excluded');
  return {
    normalArtifactDirectory:
      protocol === 'standard-primary-v2'
        ? path.join(variantArtifactRoot, primaryName, `replicate-${replicate}`)
        : path.join(targetRoot, 'control', primaryName, `replicate-${replicate}`),
    excludedArtifactDirectory: path.join(
      targetRoot,
      'excluded',
      primaryName,
      `replicate-${replicate}`,
    ),
  };
}

export function targetExcludedLiveStackDirectory(
  variantArtifactRoot: string,
  variantStatus: VariantRecord['status'],
): string {
  return variantStatus === 'starting' || variantStatus === 'running'
    ? variantArtifactRoot
    : path.join(variantArtifactRoot, 'target-excluded');
}

export function targetExcludedControlHoldoutDirectory(
  variantArtifactRoot: string,
  holdoutName: string,
  integratedStack: boolean,
): string {
  return integratedStack
    ? path.join(variantArtifactRoot, holdoutName)
    : path.join(variantArtifactRoot, 'target-excluded', 'control', holdoutName);
}

export function complianceBatchExhausted(
  campaign: CampaignRecord,
  variants: readonly VariantRecord[],
): boolean {
  const expectedAttempts = 1 + campaign.config.limits.hypothesisComplianceRepairAttempts;
  return (
    variants.length > 0 &&
    variants.every((variant) => {
      const attempts = variant.hypothesisComplianceAttempts;
      return (
        variant.status === 'failed' &&
        variant.facts === null &&
        attempts.length === expectedAttempts &&
        attempts.every(({ outcome }) => outcome === 'semantic_failed' || outcome === 'no_op')
      );
    })
  );
}

function normalArmBindingsEqual(
  left: TargetNormalArmBinding,
  right: TargetNormalArmBinding,
): boolean {
  if (
    !Array.isArray(left.replicates) ||
    !Array.isArray(right.replicates) ||
    left.replicates.length !== 2 ||
    right.replicates.length !== 2
  ) {
    return false;
  }
  return (
    left.source === right.source &&
    left.benchmark === right.benchmark &&
    left.resolvedArtifactSha === right.resolvedArtifactSha &&
    left.replicates.every((replicate, index) => {
      const candidate = right.replicates[index];
      if (!replicate || !candidate) return false;
      return (
        candidate.replicate === replicate.replicate &&
        candidate.caseId === replicate.caseId &&
        candidate.runId === replicate.runId
      );
    })
  );
}

function nextVariantIdentity(campaign: CampaignRecord, variants: readonly VariantRecord[]): string {
  const ordinal = Math.max(0, ...variants.map((variant) => variant.ordinal)) + 1;
  return `${campaign.id}-v${String(ordinal).padStart(3, '0')}`;
}

interface CachedRuntimeAnswer {
  value: Phase2QuestionAnswer;
  selectedOption?: {
    index: number;
    label: string;
    description: string | null;
    consequences: string | null;
  };
}

type RuntimeAnswerCache = Map<string, CachedRuntimeAnswer | Promise<CachedRuntimeAnswer | null>>;

interface BenchmarkRunOptions {
  replicateCount?: number;
  scope?: string;
  executionScope?: string;
  answerSourceTargetWorkflow?: string;
  excludedTargetWorkflow?: string;
  answerCache?: RuntimeAnswerCache;
  persistToTargetEvaluation?: boolean;
}

interface BenchmarkReplicateResult {
  facts: RunFacts;
  replicates: RunFacts[];
  questions: Phase2QuestionAudit[];
}

interface PendingTargetAnswer {
  campaignId: string;
  variantId: string;
  benchmark: string;
  replicate: number;
  targetWorkflow: string;
  question: PlannerQuestionRecord;
  resolve: (answer: Phase2QuestionAnswer) => void;
  reject: (error: Error) => void;
}

function pendingTargetAnswerKey(
  variantId: string,
  benchmark: string,
  replicate: number,
  questionId: string,
): string {
  return JSON.stringify([variantId, benchmark, replicate, questionId]);
}

export function withRuntimeQuestions(
  summary: NonNullable<VariantRecord['questionResolutions']>[string],
  questions: readonly Phase2QuestionAudit[],
  arm?: 'control' | 'excluded',
): NonNullable<VariantRecord['questionResolutions']>[string] {
  return {
    ...summary,
    plannerQuestions: summary.plannerQuestions + questions.length,
    plannerRequirementsAgentRequests: summary.plannerRequirementsAgentRequests + questions.reduce(
      (total, question) => total + question.requirementsAgentRequests,
      0,
    ),
    plannerRequirementsAgentAnswers: summary.plannerRequirementsAgentAnswers + questions.filter(
      (question) => question.resolution === 'requirements_agent',
    ).length,
    plannerSourceFallbackAnswers: summary.plannerSourceFallbackAnswers + questions.filter(
      (question) => question.resolution === 'source_fallback',
    ).length,
    plannerPmSimulationAnswers: (summary.plannerPmSimulationAnswers ?? 0) + questions.filter(
      (question) => question.resolution === 'pm_simulation',
    ).length,
    plannerReusedAnswers: summary.plannerReusedAnswers + questions.filter(
      (question) => question.resolution === 'reused_source_answer',
    ).length,
    plannerHumanAnswers: (summary.plannerHumanAnswers ?? 0) + questions.filter(
      (question) => question.resolution === 'human_answer',
    ).length,
    entries: [
      ...summary.entries,
      ...questions.map((question) => ({
        id: question.questionId,
        question: question.prompt,
        resolution: question.resolution,
        answer: question.answer,
        evidence: question.evidence,
        ...(arm ? { arm } : {}),
      })),
    ],
  };
}

const TARGET_SAFE_PM_EVIDENCE =
  'PM simulation evidence is retained in the immutable harness agent transcript.';

export function targetSafeQuestionResolution(
  summary: NonNullable<VariantRecord['questionResolutions']>[string],
  targetWorkflow: string,
): NonNullable<VariantRecord['questionResolutions']>[string] {
  return {
    ...summary,
    entries: summary.entries.map((entry) => ({
      ...entry,
      evidence:
        entry.resolution === 'pm_simulation' &&
        entry.evidence.some((item) => containsTargetIdentityLeak(item, targetWorkflow))
          ? [TARGET_SAFE_PM_EVIDENCE]
          : entry.evidence,
    })),
  };
}

export function targetSafeJudgeOutput(
  judgment: JudgeOutput,
  targetWorkflow: string,
): JudgeOutput {
  return {
    ...judgment,
    verdicts: judgment.verdicts.map((verdict) => ({
      ...verdict,
      evidence: verdict.evidence.map((item) =>
        containsTargetIdentityLeak(item, targetWorkflow)
          ? 'Target implementation is absent from the target-excluded source snapshot.'
          : item,
      ),
    })),
  };
}

export class CampaignOrchestrator {
  private readonly activeCampaigns = new Set<string>();
  private readonly reportQueues = new Map<string, Promise<void>>();
  private readonly pendingTargetAnswers = new Map<string, PendingTargetAnswer>();

  constructor(
    readonly paths: HarnessPaths,
    readonly database: HarnessDatabase,
  ) {}

  async initialize(configPath: string): Promise<CampaignRecord> {
    const resolved = await loadCampaignConfig(configPath);
    return await this.initializeResolved(resolved);
  }

  async initializeFromInput(input: unknown): Promise<CampaignRecord> {
    const resolved = await resolveCampaignConfig(input);
    return await this.initializeResolved(resolved);
  }

  async configureTargetExcluded(
    campaignId: string,
    baselineVariantId: string,
    targetImplementationWorkflow: string,
  ): Promise<TargetExcludedConfig> {
    return await this.withCampaignLock(campaignId, async () => {
      const campaign = this.database.getCampaign(campaignId);
      if (campaign.config.targetExcluded) {
        throw new Error('campaign-frozen V2 target exclusion is configured automatically at baseline');
      }
      const baseline = this.database.getVariant(baselineVariantId);
      if (
        baseline.campaignId !== campaignId ||
        baseline.status !== 'completed' ||
        !baseline.artifactCollectionComplete ||
        !baseline.imageTag ||
        !baseline.worktreePath
      ) {
        throw new Error('target-excluded baseline must be a completed, archived campaign variant');
      }
      if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(targetImplementationWorkflow)) {
        throw new Error('invalid target implementation workflow');
      }
      const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
      const targetIndex = path.join(
        workflowsSource,
        'src',
        'customers',
        ...targetImplementationWorkflow.split('/'),
        'index.ts',
      );
      if (!(await stat(targetIndex).catch(() => null))?.isFile()) {
        throw new Error(`target implementation is not present at the frozen source revision: ${targetImplementationWorkflow}`);
      }
      const comparatorImage = (
        await runCommand(
          'docker',
          ['image', 'inspect', '--format', '{{.Id}}', `${baseline.imageTag}-test`],
          { timeoutMs: 120_000 },
        )
      ).stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(comparatorImage)) {
        throw new Error('baseline comparator image did not resolve to an immutable image ID');
      }
      const config = TargetExcludedConfigSchema.parse({
        protocol: 'dedicated-control-v1',
        targetImplementationWorkflow,
        baselineVariantId,
        comparatorImage,
        configuredAt: new Date().toISOString(),
        replicates: 2,
        concurrency: 2,
        warningBuildDropRatio: 0.08,
        blockBuildDropRatio: 0.15,
      });
      const sidecar = path.join(campaignDirectory(this.paths, campaign.id), 'target-excluded.json');
      await writeFile(sidecar, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      let persisted = false;
      try {
        const saved = this.database.createTargetExcludedConfig(campaign.id, config);
        persisted = true;
        try {
          await this.refreshReports(campaign.id);
        } catch (error) {
          this.database.addEvent(campaign.id, null, 'target_excluded.report_failed', {
            error: errorMessage(error),
          });
        }
        return saved;
      } catch (error) {
        if (!persisted) await rm(sidecar, { force: true });
        throw error;
      }
    });
  }

  async runTargetExcluded(campaignId: string, variantId: string): Promise<TargetExcludedEvaluationRecord> {
    return await this.withCampaignLock(campaignId, async () => {
      const campaign = this.database.getCampaign(campaignId);
      const variant = this.database.getVariant(variantId);
      if (variant.campaignId !== campaignId) throw new Error('variant belongs to another campaign');
      const config = this.database.getTargetExcludedConfig(campaignId);
      if (!config) throw new Error('target-excluded protocol is not configured');
      return await this.runTargetExcludedBackfill(campaign, variant, config);
    });
  }

  async finalizeLiveTargetExcluded(
    campaignId: string,
    variantId: string,
  ): Promise<TargetExcludedEvaluationRecord> {
    return await this.withCampaignLock(campaignId, async () => {
      const campaign = this.database.getCampaign(campaignId);
      const variant = this.database.getVariant(variantId);
      const config = this.database.getTargetExcludedConfig(campaignId);
      const existing = this.database.getTargetExcludedEvaluation(variantId);
      if (!config || !existing || variant.campaignId !== campaignId) {
        throw new Error('target-excluded live evaluation is not configured');
      }
      if (existing.status === 'completed' && existing.artifactCollectionComplete) {
        return existing;
      }
      const variantArtifacts = variantArtifactDirectory(this.paths, campaign.id, variant.id);
      const artifactDirectory = path.join(variantArtifacts, 'target-excluded');
      let stack: StackHandle | null = null;
      let evaluation = existing;
      let failure: unknown;
      let integratedStack = false;
      try {
        const preferredStackDirectory = targetExcludedLiveStackDirectory(
          variantArtifacts,
          variant.status,
        );
        const alternateStackDirectory = preferredStackDirectory === variantArtifacts
          ? artifactDirectory
          : variantArtifacts;
        const stackDirectory = (await stat(path.join(preferredStackDirectory, 'stack.env')).catch(
          () => null,
        ))?.isFile()
          ? preferredStackDirectory
          : alternateStackDirectory;
        integratedStack = stackDirectory === variantArtifacts;
        stack = await reattachVariantStack(
          campaign,
          variant,
          stackDirectory,
          await this.ensureFrozenPlannerSource(campaign),
        );
        const token = stack.environment.PLANNER_EVAL_API_TOKEN || stack.environment.PLANNER_API_TOKEN;
        const primary = primaryBenchmark(campaign);
      const excludedExecutions = existing.executionState?.executions
        .filter((execution) => execution.benchmark === `${primary.name}:excluded`)
        .sort((left, right) => left.replicate - right.replicate) ?? [];
      if (excludedExecutions.length !== config.replicates) {
        throw new Error('live target-excluded execution set is incomplete');
      }
      const results = [] as Phase2Result[];
      for (const execution of excludedExecutions) {
        if (!execution.caseId) throw new Error('live target-excluded execution omitted its case ID');
        const response = await fetch(
          `${stack.baseUrl}/api/planning-cases/${execution.caseId}/runs`,
          {
            headers: token
              ? { Authorization: `Bearer ${token}`, Accept: 'application/json' }
              : { Accept: 'application/json' },
            signal: AbortSignal.timeout(120_000),
          },
        );
        if (!response.ok) throw new Error(`failed to list live target runs (${response.status})`);
        const body = await response.json() as { runs?: unknown[] };
        const completed = (body.runs ?? [])
          .filter(isRecord)
          .filter((candidate) =>
            (isRecord(candidate.runtime) && candidate.runtime.status === 'completed') ||
            (isRecord(candidate.run) && candidate.run.status === 'completed'),
          )
          .sort((left, right) =>
            Date.parse(String((isRecord(right.run) ? right.run.updatedAt : '') ?? '')) -
            Date.parse(String((isRecord(left.run) ? left.run.updatedAt : '') ?? '')),
          )[0];
        const runId = isRecord(completed?.run) && typeof completed.run.id === 'string'
          ? completed.run.id
          : null;
        if (!runId) {
          throw new Error(`target-excluded replicate ${execution.replicate} is still running`);
        }
        const directory = path.join(
          artifactDirectory,
          'excluded',
          primary.name,
          `replicate-${execution.replicate}`,
        );
        const result = await new PlannerClient(stack.baseUrl, directory, token)
          .collectCompletedPhase2(execution.caseId, runId);
        await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
        if (result.facts) {
          const completedAt = new Date().toISOString();
          const elapsedMs = execution.startedAt
            ? Math.max(0, Date.parse(completedAt) - Date.parse(execution.startedAt))
            : null;
          this.database.updateTargetExcludedExecution(variant.id, {
            benchmark: `${primary.name}:excluded`,
            role: 'primary',
            replicate: execution.replicate,
            replicateCount: config.replicates,
            snapshot: {
              caseId: execution.caseId,
              runId,
              status: 'completed',
              stage: 'completed',
              progress: {
                completedUnits: result.facts.unitCount,
                totalUnits: result.facts.unitCount,
              },
              decisions: result.facts.decisions,
              questions: result.questions.map((question) => ({
                id: question.questionId,
                type: 'unknown',
                ownerRole: 'unknown',
                priority: 'blocking',
                prompt: question.prompt,
                rationale: '',
                status: 'answered',
                answer: question.answer,
                resolution: question.resolution,
                evidence: question.evidence,
                createdAt: null,
                updatedAt: null,
              })),
              completedAt,
              elapsedMs,
              usage: result.facts.usage,
              updatedAt: completedAt,
            },
          });
        }
        results.push(result);
      }
      const excludedReplicates = results.map(({ facts }, index) => {
        if (!facts) throw new Error(`target-excluded replicate ${index + 1} omitted facts`);
        validateMeaningfulFacts(facts);
        return facts;
      });
      const excludedFacts = consensusRunFacts(excludedReplicates);
      const excludedRoot = path.join(artifactDirectory, 'excluded', primary.name);
      await Promise.all([
        writeFile(path.join(excludedRoot, 'facts.json'), `${JSON.stringify(excludedFacts, null, 2)}\n`),
        writeFile(path.join(excludedRoot, 'replicates.json'), `${JSON.stringify(excludedReplicates, null, 2)}\n`),
      ]);
      const comparisonDirectory = path.join(artifactDirectory, 'comparisons');
      await mkdir(comparisonDirectory, { recursive: true });
      const comparisons = await Promise.all(
        Array.from({ length: config.replicates }, (_, index) => {
          const replicate = index + 1;
          return runTargetExcludedComparison({
            ...targetExcludedComparisonDirectories(
              variantArtifacts,
              primary.name,
              replicate,
              config.protocol,
            ),
            outputPath: path.join(comparisonDirectory, `replicate-${replicate}.json`),
            imageTag: config.comparatorImage,
            replicate,
          });
        }),
      );
      let controlFacts: RunFacts | null = null;
      let controlReplicates: RunFacts[] | null = null;
      let holdoutFacts: Record<string, RunFacts> | null = null;
      let holdoutReplicateFacts: Record<string, RunFacts[]> | null = null;
      let normalArmBinding: TargetNormalArmBinding | null = null;
      let questionResolution: NonNullable<VariantRecord['questionResolutions']>[string];
      if (config.protocol === 'standard-primary-v2') {
        const summary = variant.questionResolutions?.[primary.name];
        if (!summary || summary.resolvedArtifactSha !== config.primaryResolvedArtifactSha) {
          throw new Error('V2 standard primary question resolution is unavailable or stale');
        }
        normalArmBinding = this.buildTargetNormalArmBinding(
          variant.id,
          primary,
          config.primaryResolvedArtifactSha,
        );
        if (
          existing.normalArmBinding &&
          !normalArmBindingsEqual(existing.normalArmBinding, normalArmBinding)
        ) {
          throw new Error('persisted V2 normal-arm binding differs from standard execution');
        }
        questionResolution = withRuntimeQuestions(
          targetSafeQuestionResolution(summary, config.targetImplementationWorkflow),
          results.flatMap(({ questions }) => questions),
          'excluded',
        );
      } else {
        controlFacts = JSON.parse(
          await readFile(path.join(artifactDirectory, 'control', primary.name, 'facts.json'), 'utf8'),
        ) as RunFacts;
        controlReplicates = JSON.parse(
          await readFile(path.join(artifactDirectory, 'control', primary.name, 'replicates.json'), 'utf8'),
        ) as RunFacts[];
        const controlQuestions = (
          await Promise.all(
            Array.from({ length: config.replicates }, async (_, index) =>
              JSON.parse(
                await readFile(
                  path.join(
                    artifactDirectory,
                    'control',
                    primary.name,
                    `replicate-${index + 1}`,
                    'result.json',
                  ),
                  'utf8',
                ),
              ) as Phase2Result,
            ),
          )
        ).flatMap(({ questions }) => questions);
        holdoutFacts = {};
        holdoutReplicateFacts = {};
        for (const holdout of campaign.config.benchmarks.filter(({ role }) => role === 'holdout')) {
          const holdoutDirectory = targetExcludedControlHoldoutDirectory(
            variantArtifacts,
            holdout.name,
            integratedStack,
          );
          holdoutFacts[holdout.name] = JSON.parse(
            await readFile(path.join(holdoutDirectory, 'facts.json'), 'utf8'),
          ) as RunFacts;
          holdoutReplicateFacts[holdout.name] = JSON.parse(
            await readFile(path.join(holdoutDirectory, 'replicates.json'), 'utf8'),
          ) as RunFacts[];
        }
        const summaryPath = path.join(
          campaignDirectory(this.paths, campaign.id),
          'target-excluded-resolved-packs',
          `${primary.name}.questions.json`,
        );
        const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as NonNullable<
          VariantRecord['questionResolutions']
        >[string];
        questionResolution = withRuntimeQuestions(
          withRuntimeQuestions(summary, controlQuestions, 'control'),
          results.flatMap(({ questions }) => questions),
          'excluded',
        );
      }
      this.database.updateTargetExcludedEvaluation(variant.id, {
        status: 'judging',
        controlFacts,
        controlReplicateFacts: controlReplicates,
        holdoutFacts,
        holdoutReplicateFacts,
        excludedFacts,
        excludedReplicateFacts: excludedReplicates,
        questionResolution,
        comparisons,
        normalArmBinding,
      });
      const judged = await this.judgeTargetExcluded(
        campaign,
        variant,
        primary,
        excludedFacts,
        config,
        excludedRoot,
        excludedReplicates,
      );
      const comparisonValid = comparisons.length === config.replicates &&
        comparisons.every(({ valid }) => valid);
      const leakageDetected = comparisons.some(({ leakagePaths }) => leakagePaths.length > 0) ||
        containsTargetIdentityLeak(judged.judgment, config.targetImplementationWorkflow) ||
        (config.protocol === 'standard-primary-v2' &&
          containsTargetIdentityLeak(questionResolution, config.targetImplementationWorkflow));
      const baseline = this.database.getTargetExcludedEvaluation(config.baselineVariantId);
      const baselineRuns = variant.id === config.baselineVariantId
        ? excludedReplicates
        : baseline?.excludedReplicateFacts ?? [];
      const gate = computeTargetExcludedGate(
        baselineRuns,
        excludedReplicates,
        comparisonValid,
        leakageDetected,
        config.warningBuildDropRatio,
        config.blockBuildDropRatio,
      );
      evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
        status: 'completed',
        judgment: judged.judgment,
        score: judged.score,
        gate,
        completedAt: new Date().toISOString(),
      });
      } catch (error) {
        failure = error;
        evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
          status: 'failed',
          error: errorMessage(error).slice(0, 20_000),
        });
      } finally {
        let collectionComplete = false;
        if (stack) {
          collectionComplete = true;
          try {
            await collectStackArtifacts(stack);
          } catch (error) {
            collectionComplete = false;
            this.database.addEvent(campaign.id, variant.id, 'target_excluded.artifacts_failed', {
              error: errorMessage(error),
            });
          }
          try {
            await stopVariantStack(stack, collectionComplete);
          } catch (error) {
            collectionComplete = false;
            this.database.addEvent(campaign.id, variant.id, 'target_excluded.teardown_failed', {
              error: errorMessage(error),
            });
          }
        }
        const current = this.database.getTargetExcludedEvaluation(variant.id) ?? evaluation;
        evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
          artifactCollectionComplete: collectionComplete,
          completedAt: new Date().toISOString(),
          ...(!collectionComplete
            ? {
                status: 'failed',
                error:
                  current.error ?? 'required target-excluded artifacts were not completely archived',
              }
            : {}),
        });
        if (stack && integratedStack) {
          const currentVariant = this.database.getVariant(variant.id);
          this.database.updateVariant(variant.id, {
            artifactCollectionComplete: collectionComplete,
            ...(!collectionComplete
              ? {
                  status: 'failed',
                  error:
                    currentVariant.error ?? 'required stack artifacts were not completely archived',
                }
              : {}),
          });
        }
      }
      if (failure) {
        try {
          await this.refreshReports(campaign.id);
        } catch (reportError) {
          this.database.addEvent(campaign.id, variant.id, 'target_excluded.report_failed', {
            error: errorMessage(reportError),
          });
        }
        throw failure;
      }
      await this.runDiagnosis(
        campaign,
        this.database.getVariant(variant.id),
        variantArtifacts,
      );
      await this.refreshReports(campaign.id);
      return evaluation;
    });
  }

  answerTargetExcludedQuestion(
    campaignId: string,
    variantId: string,
    questionId: string,
    answer: string,
    selectedOptionId?: string,
    benchmark?: string,
    replicate?: number,
  ): void {
    if ((benchmark === undefined) !== (replicate === undefined)) {
      throw new Error('target-excluded answer scope requires both benchmark and replicate');
    }
    const matches = [...this.pendingTargetAnswers.entries()].filter(
      ([, pending]) => pending.variantId === variantId && pending.question.id === questionId,
    );
    let selected: [string, PendingTargetAnswer] | undefined;
    if (benchmark !== undefined && replicate !== undefined) {
      const key = pendingTargetAnswerKey(variantId, benchmark, replicate, questionId);
      const pending = this.pendingTargetAnswers.get(key);
      if (pending) selected = [key, pending];
    } else {
      if (matches.length > 1) {
        throw new Error(
          'ambiguous target-excluded question; benchmark and replicate are required',
        );
      }
      selected = matches[0];
    }
    if (!selected) throw new Error('target-excluded question is not waiting for an answer');
    const [key, pending] = selected;
    if (
      pending.campaignId !== campaignId ||
      this.database.getVariant(variantId).campaignId !== campaignId
    ) {
      throw new Error('target-excluded question belongs to another campaign');
    }
    if (containsTargetIdentityLeak(answer, pending.targetWorkflow)) {
      throw new Error('target-excluded answer references the excluded implementation');
    }
    if (pending.question.responseKind === 'single_select') {
      if (!selectedOptionId || !pending.question.options?.some((option) => option.id === selectedOptionId)) {
        throw new Error('target-excluded answer must select one of the current question options');
      }
    } else if (selectedOptionId) {
      throw new Error('selectedOptionId is only valid for single-select questions');
    }
    this.pendingTargetAnswers.delete(key);
    pending.resolve({
      answer,
      ...(selectedOptionId ? { selectedOptionId } : {}),
      resolution: 'human_answer',
      evidence: ['human operator answer'],
      requirementsAgentRequests: 0,
    });
    const stillWaiting = [...this.pendingTargetAnswers.values()].some(
      (candidate) => candidate.variantId === variantId,
    );
    this.database.updateTargetExcludedEvaluation(variantId, {
      status: stillWaiting ? 'waiting_for_input' : 'running',
    });
  }

  async saveTargetExcludedVerifiedLabel(input: {
    campaignId: string;
    unitKey: string;
    expectedDecision: Decision;
    classification: 'system_error' | 'real_gap' | 'uncertain';
    rationale: string;
  }): Promise<void> {
    const campaign = this.database.getCampaign(input.campaignId);
    const investigator = campaign.config.investigator?.enabled;
    const evaluations = this.database.listTargetExcludedEvaluations(input.campaignId)
      .filter((evaluation) => evaluation.excludedFacts && evaluation.judgment);
    const config = investigator ? this.database.getTargetExcludedConfig(input.campaignId) : null;
    const baseline = config ? this.database.getTargetExcludedEvaluation(config.baselineVariantId) : null;
    if (investigator && evaluations.length > 0) {
      if (!baseline?.judgment) throw new Error('investigator scoring requires the baseline excluded judgment');
      for (const evaluation of evaluations) {
        if (!Array.isArray(evaluation.excludedReplicateFacts) || evaluation.excludedReplicateFacts.length !== config!.replicates) {
          throw new Error(`${evaluation.variantId}: investigator scoring requires complete raw replicate facts`);
        }
      }
    }
    this.database.upsertTargetExcludedLabel({ ...input, status: 'verified' });
    const labels = this.database.listTargetExcludedLabels(input.campaignId)
      .map((label) => ({ ...label, benchmark: 'target-excluded' }));
    for (const evaluation of evaluations) {
      const score = investigator
        ? computeReplicateMeanScore(evaluation.excludedReplicateFacts!, labels, baseline!.judgment)
        : computeScore(evaluation.excludedFacts!, labels, evaluation.judgment);
      if (investigator) {
        score.cohortMismatches = [...new Set([
          ...score.cohortMismatches,
          ...(evaluation.score?.cohortMismatches ?? []),
          ...(baseline?.excludedFacts && baseline.variantId !== evaluation.variantId
            ? compareCohort(baseline.excludedFacts, evaluation.excludedFacts!) : []),
        ])];
      }
      this.database.updateTargetExcludedEvaluation(evaluation.variantId, { score });
    }
    await this.refreshReports(input.campaignId);
  }

  private async initializeResolved(
    resolved: Awaited<ReturnType<typeof resolveCampaignConfig>>,
  ): Promise<CampaignRecord> {
    const [measuredBenchmarks, researchInputs] = await Promise.all([
      Promise.all(
        resolved.config.benchmarks.map(async (benchmark) => {
          const bytes = await readFile(benchmark.zipPath);
          const measuredSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          if (benchmark.sha256 !== measuredSha) {
            throw new Error(
              `${benchmark.name} SHA mismatch during frozen copy: expected ${benchmark.sha256 ?? '<missing>'}, got ${measuredSha}`,
            );
          }
          return { benchmark, bytes };
        }),
      ),
      captureResearchInputs(resolved.researchInputs),
    ]);
    if (resolved.config.targetExcluded) {
      const targetIndex = [
        'src',
        'customers',
        ...resolved.config.targetExcluded.targetImplementationWorkflow.split('/'),
        'index.ts',
      ].join('/');
      const objectType = await runCommand(
        'git',
        ['cat-file', '-t', `${resolved.workflowsSha}:${targetIndex}`],
        { cwd: resolved.config.workflowsRepo },
      ).catch(() => null);
      if (objectType?.stdout.trim() !== 'blob') {
        throw new Error(
          `target implementation is not present at the pinned workflows revision: ${resolved.config.targetExcluded.targetImplementationWorkflow}`,
        );
      }
    }
    await ensureHarnessPaths(this.paths);
    const directory = campaignDirectory(this.paths, resolved.config.id);
    const reportDirectory = campaignReportDirectory(this.paths, resolved.config.id);
    const sourceEnvironment = await readEnvironmentFile(resolved.config.environmentFile);
    const configuredWorkflowsRemote =
      sourceEnvironment.PLANNER_SOURCE_REMOTE_URL ||
      (
        await runCommand('git', ['remote', 'get-url', 'origin'], {
          cwd: resolved.config.workflowsRepo,
        })
      ).stdout.trim();
    const workflowsRemoteUrl = normalizeHttpsGitRemote(configuredWorkflowsRemote);
    await Promise.all([mkdir(directory, { recursive: false }), mkdir(reportDirectory, { recursive: true })]);
    const frozenEnvironment = path.join(directory, 'environment.env');
    await writeFile(
      frozenEnvironment,
      withPlannerAnalysisLimits(
        await readFile(resolved.config.environmentFile, 'utf8'),
        resolved.config.limits.phase2TimeoutMs,
        resolved.config.evaluation.analysisMaxCostUsd,
      ),
      {
      flag: 'wx',
      mode: 0o600,
      },
    );
    const environmentSha = await sha256File(frozenEnvironment);
    const packsDirectory = path.join(directory, 'packs');
    await mkdir(packsDirectory, { recursive: true });
    const [benchmarks, researchPaths] = await Promise.all([
      Promise.all(
        measuredBenchmarks.map(async ({ benchmark, bytes }) => {
          const frozenPath = path.join(packsDirectory, `${benchmark.name}.zip`);
          await writeFile(frozenPath, bytes, { flag: 'wx', mode: 0o600 });
          return { ...benchmark, zipPath: frozenPath };
        }),
      ),
      freezeResearchInputs(directory, researchInputs),
    ]);
    const config = {
      ...resolved.config,
      environmentFile: frozenEnvironment,
      benchmarks,
      researchPaths,
    };
    await Promise.all([
      writeResolvedCampaignConfig(
        path.join(directory, 'campaign.json'),
        config,
        resolved.seedSha,
        resolved.workflowsSha,
      ),
      writeFile(path.join(directory, 'GOAL.md'), `# Goal\n\n${config.goal.trim()}\n`, { flag: 'wx' }),
    ]);
    const campaign = this.database.createCampaign(
      config,
      resolved.seedSha,
      resolved.workflowsSha,
      environmentSha,
      workflowsRemoteUrl,
    );
    await this.refreshReports(campaign.id);
    return campaign;
  }

  async runBaseline(campaignId: string): Promise<VariantRecord> {
    return await this.withCampaignLock(campaignId, async () => {
      const campaign = this.database.getCampaign(campaignId);
      if (campaign.status.startsWith('stopped')) throw new Error(`campaign is stopped: ${campaign.status}`);
      let existingVariants = this.database.listVariants(campaignId);
      let targetConfig = campaign.config.targetExcluded
        ? await this.recoverAutomaticV2Config(campaign)
        : this.database.getTargetExcludedConfig(campaignId);
      if (campaign.config.targetExcluded) {
        let interrupted: VariantRecord | null = null;
        for (const candidate of [...existingVariants].reverse()) {
          if (
            candidate.round === 0 &&
            !candidate.artifactCollectionComplete &&
            (await stat(
              path.join(
                variantArtifactDirectory(this.paths, campaign.id, candidate.id),
                'stack.env',
              ),
            ).catch(() => null))?.isFile()
          ) {
            interrupted = candidate;
            break;
          }
        }
        if (interrupted) {
          this.database.updateCampaign(campaignId, { status: 'recovering_baseline_stack' });
          const archived = await this.archiveInterruptedIntegratedStack(campaign, interrupted, {
            allowIncomplete: !targetConfig,
          });
          const standardComplete = Boolean(
            archived.facts &&
            archived.questionResolutions &&
            (await this.hasCompleteEvaluationArtifacts(campaign, archived)),
          );
          if (!standardComplete) {
            this.database.updateVariant(archived.id, {
              status: 'failed',
              error:
                archived.error ??
                'interrupted baseline stack was archived without complete standard facts',
            });
          }
          existingVariants = this.database.listVariants(campaignId);
        }
        let bound = targetConfig
          ? this.database.getVariant(targetConfig.baselineVariantId)
          : null;
        if (!bound) {
          for (const candidate of [...existingVariants].reverse()) {
            if (
              candidate.round === 0 &&
              candidate.artifactCollectionComplete &&
              candidate.facts &&
              candidate.questionResolutions &&
              (await this.hasCompleteEvaluationArtifacts(campaign, candidate))
            ) {
              bound = candidate;
              break;
            }
          }
        }
        if (bound) {
          if (targetConfig && !bound.artifactCollectionComplete) {
            bound = await this.archiveInterruptedIntegratedStack(campaign, bound);
          }
          if (!(await this.hasCompleteEvaluationArtifacts(campaign, bound))) {
            if (targetConfig) {
              throw new Error('config-bound V2 baseline does not have recoverable standard artifacts');
            }
          } else {
            this.database.updateCampaign(campaignId, { status: 'recovering_baseline_target' });
            if (bound.status !== 'review' && bound.status !== 'completed') {
              bound = await this.recoverEvaluation(campaign, bound);
            }
            if (bound.status === 'review' || bound.status === 'completed') {
              if (!targetConfig) {
                const summary = bound.questionResolutions?.[primaryBenchmark(campaign).name];
                if (!bound.imageTag || !summary) {
                  throw new Error('recoverable V2 baseline is missing its image or primary resolution');
                }
                targetConfig = await this.prepareAutomaticV2Config(
                  campaign,
                  bound,
                  `${bound.imageTag}-test`,
                  summary,
                );
                targetConfig = await this.persistAutomaticV2Config(campaign, targetConfig);
              }
              let evaluation = this.database.getTargetExcludedEvaluation(bound.id);
              evaluation = this.reconcileTargetSafeQuestionResolution(
                campaign,
                targetConfig,
                evaluation,
              );
              if (!this.targetExcludedEvaluationReady(campaign, targetConfig, evaluation, true)) {
                await this.runTargetExcludedBackfill(campaign, bound, targetConfig);
              }
              return await this.finalizeBaseline(
                campaignId,
                this.database.getVariant(bound.id),
              );
            }
            return await this.finalizeBaseline(campaignId, bound);
          }
        }
      }
      const existing = this.database
        .listVariants(campaignId)
        .find((variant) => variant.round === 0 && variant.status === 'completed');
      if (existing) throw new Error(`baseline already exists: ${existing.id}`);
      const recoverable = existingVariants.findLast(
        (variant) =>
          variant.round === 0 &&
          variant.status === 'failed' &&
          variant.artifactCollectionComplete &&
          variant.facts !== null &&
          variant.questionResolutions !== null,
      );
      if (recoverable && (await this.hasCompleteEvaluationArtifacts(campaign, recoverable))) {
        this.database.updateCampaign(campaignId, { status: 'recovering_baseline' });
        const recovered = await this.recoverEvaluation(campaign, recoverable);
        return await this.finalizeBaseline(campaignId, recovered);
      }
      const ordinal = existingVariants.length === 0
        ? 0
        : Math.max(...existingVariants.map((variant) => variant.ordinal)) + 1;
      this.database.updateCampaign(campaignId, { status: 'running_baseline' });
      const variant = this.database.createVariant({
        id: `${campaign.id}-v${String(ordinal).padStart(3, '0')}`,
        campaignId,
        parentVariantId: null,
        round: 0,
        ordinal,
        hypothesis: baselineHypothesis,
      });
      try {
        await this.refreshReports(campaignId);
      } catch (error) {
        this.database.updateVariant(variant.id, {
          status: 'failed',
          error: `pre-run report generation failed: ${errorMessage(error)}`.slice(0, 20_000),
        });
        this.database.updateCampaign(campaignId, { status: 'baseline_failed' });
        throw error;
      }
      const result = await this.runVariant(campaign, variant, false);
      return await this.finalizeBaseline(campaignId, result);
    });
  }

  private async archiveInterruptedIntegratedStack(
    campaign: CampaignRecord,
    variant: VariantRecord,
    options: {
      allowIncomplete?: boolean;
      reattach?: typeof reattachVariantStack;
      collect?: typeof collectStackArtifacts;
      stop?: typeof stopVariantStack;
    } = {},
  ): Promise<VariantRecord> {
    const artifactDirectory = variantArtifactDirectory(this.paths, campaign.id, variant.id);
    let stack: StackHandle | null = null;
    let collectionComplete = false;
    let reattachFailure: unknown;
    let collectionFailure: unknown;
    let stopFailure: unknown;
    try {
      stack = await (options.reattach ?? reattachVariantStack)(
        campaign,
        variant,
        artifactDirectory,
        await this.ensureFrozenPlannerSource(campaign),
      );
    } catch (error) {
      reattachFailure = error;
    }
    if (stack) {
      try {
        await (options.collect ?? collectStackArtifacts)(stack);
        collectionComplete = true;
      } catch (error) {
        collectionFailure = error;
      }
      try {
        await (options.stop ?? stopVariantStack)(stack, collectionComplete);
      } catch (error) {
        collectionComplete = false;
        stopFailure = error;
      }
    }
    const abandoned = Boolean(
      options.allowIncomplete && stack && collectionFailure && !stopFailure,
    );
    const failure = stopFailure ?? reattachFailure ?? collectionFailure;
    const current = this.database.getVariant(variant.id);
    this.database.updateVariant(variant.id, {
      artifactCollectionComplete: collectionComplete,
      ...(!collectionComplete
        ? {
            status: 'failed',
            error: abandoned
              ? `incomplete integrated stack archive abandoned after stop: ${errorMessage(collectionFailure)}`
              : current.error ?? 'interrupted integrated stack artifacts could not be archived',
          }
        : {}),
    });
    const targetEvaluation = this.database.getTargetExcludedEvaluation(variant.id);
    if (targetEvaluation) {
      this.database.updateTargetExcludedEvaluation(variant.id, {
        artifactCollectionComplete: collectionComplete,
        ...(targetEvaluation.status === 'completed'
          ? {}
          : {
              status: 'failed',
              error:
                targetEvaluation.error ??
                'interrupted integrated stack was archived before target evaluation completed',
            }),
      });
    }
    if (!abandoned && (failure || !collectionComplete)) {
      throw failure ?? new Error('interrupted integrated stack artifacts could not be archived');
    }
    return this.database.getVariant(variant.id);
  }

  async diagnoseVariant(campaignId: string, variantId: string): Promise<VariantRecord> {
    return await this.withCampaignLock(campaignId, async () => {
      const campaign = this.database.getCampaign(campaignId);
      const variant = this.database.getVariant(variantId);
      if (variant.campaignId !== campaignId) throw new Error('variant belongs to another campaign');
      if (!variant.artifactCollectionComplete || !variant.facts || !variant.judgment) {
        throw new Error('diagnosis requires archived artifacts, measured facts, and a blind judgment');
      }
      const artifactDirectory = variantArtifactDirectory(this.paths, campaignId, variantId);
      await this.runDiagnosis(campaign, variant, artifactDirectory);
      await this.refreshReports(campaignId);
      return this.database.getVariant(variantId);
    });
  }

  private async finalizeBaseline(campaignId: string, result: VariantRecord): Promise<VariantRecord> {
      const campaign = this.database.getCampaign(campaignId);
      if (campaign.status === 'stopped_by_user') return result;
      if (
        (result.status !== 'review' && result.status !== 'completed') ||
        !result.facts ||
        !result.artifactCollectionComplete
      ) {
        this.database.updateCampaign(campaignId, { status: 'baseline_failed' });
        return result;
      }
      if (campaign.config.targetExcluded) {
        const config = this.database.getTargetExcludedConfig(campaignId);
        const evaluation = config && config.baselineVariantId === result.id
          ? this.database.getTargetExcludedEvaluation(result.id)
          : null;
        if (!config || !this.targetExcludedEvaluationReady(campaign, config, evaluation, true)) {
          this.database.updateCampaign(campaignId, {
            status: 'baseline_target_failed',
            currentParentVariantId: null,
          });
          await this.refreshReports(campaignId);
          return result;
        }
        await this.verifyArchivedTargetExcludedComparisonsForAction(
          campaign,
          result.id,
          config,
          evaluation,
        );
      }
      const completed = this.database.updateVariant(result.id, { status: 'completed' });
      this.database.updateCampaign(campaignId, {
        status: 'ready',
        currentParentVariantId: completed.id,
      });
      await this.refreshReports(campaignId);
      return completed;
  }

  private async hasCompleteEvaluationArtifacts(
    campaign: CampaignRecord,
    variant: VariantRecord,
  ): Promise<boolean> {
    const root = variantArtifactDirectory(this.paths, campaign.id, variant.id);
    return (
      await Promise.all(
        campaign.config.benchmarks.flatMap((benchmark) => [
          stat(path.join(root, benchmark.name, 'facts.json')).then(
            (value) => value.isFile(),
            () => false,
          ),
          stat(path.join(root, benchmark.name, 'replicates.json')).then(
            (value) => value.isFile(),
            () => false,
          ),
        ]),
      )
    ).every(Boolean);
  }

  private async recoverEvaluation(
    campaign: CampaignRecord,
    variant: VariantRecord,
  ): Promise<VariantRecord> {
    try {
      const root = variantArtifactDirectory(this.paths, campaign.id, variant.id);
      const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
      const primary = primaryBenchmark(campaign);
      const facts = JSON.parse(
        await readFile(path.join(root, primary.name, 'facts.json'), 'utf8'),
      ) as RunFacts;
      const replicateFacts = JSON.parse(
        await readFile(path.join(root, primary.name, 'replicates.json'), 'utf8'),
      ) as RunFacts[];
      validateMeaningfulFacts(facts);
      const primaryEvaluation = await this.judgeBenchmark(
        campaign,
        variant,
        primary,
        facts,
        workflowsSource,
        path.join(root, primary.name),
        replicateFacts,
      );
      const holdoutFacts: Record<string, RunFacts> = {};
      const holdoutReplicateFacts: Record<string, RunFacts[]> = {};
      const holdoutJudgments: Record<string, JudgeOutput> = {};
      const holdoutScores: Record<string, NonNullable<VariantRecord['score']>> = {};
      for (const benchmark of campaign.config.benchmarks.filter((item) => item.role === 'holdout')) {
        const holdout = JSON.parse(
          await readFile(path.join(root, benchmark.name, 'facts.json'), 'utf8'),
        ) as RunFacts;
        const replicates = JSON.parse(
          await readFile(path.join(root, benchmark.name, 'replicates.json'), 'utf8'),
        ) as RunFacts[];
        validateMeaningfulFacts(holdout);
        const evaluation = await this.judgeBenchmark(
          campaign,
          variant,
          benchmark,
          holdout,
          workflowsSource,
          path.join(root, benchmark.name),
          replicates,
        );
        holdoutFacts[benchmark.name] = holdout;
        holdoutReplicateFacts[benchmark.name] = replicates;
        holdoutJudgments[benchmark.name] = evaluation.judgment;
        holdoutScores[benchmark.name] = evaluation.score;
      }
      const recovered = this.database.updateVariant(variant.id, {
        facts,
        replicateFacts,
        holdoutFacts,
        holdoutReplicateFacts,
        holdoutJudgments,
        holdoutScores,
        judgment: primaryEvaluation.judgment,
        score: primaryEvaluation.score,
        status: 'review',
        error: null,
      });
      await this.runDiagnosis(campaign, recovered, root);
      return this.database.getVariant(variant.id);
    } catch (error) {
      return this.database.updateVariant(variant.id, {
        status: 'failed',
        error: errorMessage(error).slice(0, 20_000),
      });
    } finally {
      await this.refreshReports(campaign.id);
    }
  }

  async runRound(campaignId: string): Promise<VariantRecord[]> {
    return await this.withCampaignLock(campaignId, async () => {
      try {
        return await this.runRoundUnlocked(campaignId);
      } catch (error) {
        this.markOperationFailed(campaignId, error);
        throw error;
      }
    });
  }

  async runAutomatic(campaignId: string): Promise<void> {
    await this.withCampaignLock(campaignId, async () => {
      const investigator = this.database.getCampaign(campaignId).config.investigator?.enabled;
      const owner = this.database.database.prepare('SELECT lease_owner FROM campaigns WHERE id = ?')
        .get(campaignId)?.lease_owner;
      const ownsLease = () => !investigator || Boolean(this.database.database.prepare(
        'SELECT id FROM campaigns WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?',
      ).get(campaignId, String(owner), Date.now()));
      try {
        if (this.database.getCampaign(campaignId).config.mode !== 'automatic') {
          throw new Error('campaign mode is supervised; use round instead of auto');
        }
        while (true) {
          if (!ownsLease()) throw new Error('investigator campaign lease lost; no new round was dispatched');
          const campaign = this.database.getCampaign(campaignId);
          const generated = this.database.listVariants(campaignId).filter((variant) => variant.round > 0);
          if (campaign.status.startsWith('stopped')) return;
          if (investigator && campaign.status === 'awaiting_review') return;
          const resumable = investigator && generated.some((variant) => variant.investigation &&
            ['running', 'stopped'].includes(variant.investigation.status));
          if (generated.length >= campaign.config.limits.maxVariants && !resumable) {
            this.database.updateCampaign(campaignId, { status: 'stopped_max_variants' });
            return;
          }
          await this.runRoundUnlocked(campaignId);
          if (!ownsLease()) throw new Error('investigator campaign lease lost; no subsequent round was dispatched');
          const current = this.database.getCampaign(campaignId);
          if (current.status.startsWith('stopped')) return;
        }
      } catch (error) {
        if (ownsLease()) this.markOperationFailed(campaignId, error);
        throw error;
      }
    });
  }

  private async runRoundUnlocked(campaignId: string): Promise<VariantRecord[]> {
    const campaign = this.database.getCampaign(campaignId);
    if (!campaign.currentParentVariantId) throw new Error('run the campaign baseline first');
    if (campaign.status !== 'ready') {
      throw new Error(`campaign cannot start a round from status=${campaign.status}`);
    }
    const targetConfig = campaign.config.targetExcluded
      ? await this.recoverAutomaticV2Config(campaign)
      : this.database.getTargetExcludedConfig(campaignId);
    if (campaign.config.targetExcluded && !targetConfig) {
      throw new Error('campaign-declared V2 runtime config is missing');
    }
    if (targetConfig) {
      const baselineEvaluation = this.database.getTargetExcludedEvaluation(
        targetConfig.baselineVariantId,
      );
      if (!this.targetExcludedEvaluationReady(campaign, targetConfig, baselineEvaluation, true)) {
        throw new Error('run a valid target-excluded baseline calibration before starting a round');
      }
      await this.verifyArchivedTargetExcludedComparisonsForAction(
        campaign,
        targetConfig.baselineVariantId,
        targetConfig,
        baselineEvaluation,
      );
    }
    if (campaign.config.investigator?.enabled) return await this.runInvestigatorRound(campaign);
    const diagnosisAvailable = await this.requireCurrentParentDiagnosis(campaign);
    const variants = this.database.listVariants(campaignId);
    const generatedCount = variants.filter((variant) => variant.round > 0).length;
    const remaining = campaign.config.limits.maxVariants - generatedCount;
    if (remaining <= 0) throw new Error('campaign reached maxVariants');
    const count = Math.min(campaign.config.limits.concurrency, remaining);
    const nextRound = Math.max(0, ...variants.map((variant) => variant.round)) + 1;
    this.database.updateCampaign(campaignId, { status: `running_round_${nextRound}` });
    await Promise.all([
      this.ensureFrozenPlannerSource(campaign),
      this.ensureFrozenWorkflowsSource(campaign),
    ]);
    const parentDiagnosis = diagnosisAvailable
      ? this.database.getVariant(campaign.currentParentVariantId).diagnosis
      : null;
    const currentParentFindingIds = parentDiagnosis?.findings.map(({ id }) => id) ?? [];
    const parentBeforeStrategy = this.database.getVariant(campaign.currentParentVariantId);
    const historyPath = await this.refreshAgentHistory(campaignId, currentParentFindingIds);
    const proposedHypotheses = await new AgentRunner(campaign).proposeHypotheses(
      campaignDirectory(this.paths, campaignId),
      historyPath,
      count,
      diagnosisAvailable,
      currentParentFindingIds,
    );
    const hypotheses = proposedHypotheses.map((hypothesis) => ({
      ...hypothesis,
      findingSnapshots:
        parentDiagnosis?.findings
          .filter(({ id }) => hypothesis.findingIds.includes(id))
          .map(
            ({
              id,
              category,
              causalMechanism,
              supportingEvidenceRefs,
              counterEvidenceRefs,
              confidence,
              genericIntervention,
              falsificationTest,
              limitations,
            }) => ({
              id,
              category,
              causalMechanism,
              supportingEvidenceRefs,
              counterEvidenceRefs,
              confidence,
              genericIntervention,
              falsificationTest,
              limitations,
            }),
          ) ?? [],
    }));
    const findingIds = new Set(parentDiagnosis?.findings.map((finding) => finding.id) ?? []);
    for (const hypothesis of hypotheses) {
      if (diagnosisAvailable && hypothesis.findingIds.length === 0) {
        throw new Error('strategist hypothesis must cite at least one current-parent diagnosis finding');
      }
      if (diagnosisAvailable && hypothesis.findingIds.some((id) => !findingIds.has(id))) {
        throw new Error('strategist hypothesis cited an unknown or stale diagnosis finding');
      }
      if (!diagnosisAvailable && hypothesis.findingIds.length > 0) {
        throw new Error('strategist invented diagnosis finding IDs during the explicit opt-out');
      }
    }
    if (diagnosisAvailable) {
      const stillAvailable = await this.requireCurrentParentDiagnosis(
        this.database.getCampaign(campaignId),
      );
      const parentAfterStrategy = this.database.getVariant(campaign.currentParentVariantId);
      if (
        !stillAvailable ||
        parentAfterStrategy.diagnosisStatus !== 'completed' ||
        parentAfterStrategy.diagnosisInputHash !== parentBeforeStrategy.diagnosisInputHash ||
        parentAfterStrategy.diagnosisResultHash !== parentBeforeStrategy.diagnosisResultHash
      ) {
        throw new Error('current parent diagnosis became stale while the strategist was running');
      }
    }
    let ordinal = Math.max(0, ...variants.map((variant) => variant.ordinal));
    const candidates = hypotheses.map((hypothesis) => {
      ordinal += 1;
      return this.database.createVariant({
        id: nextVariantIdentity(campaign, [...variants, ...this.database.listVariants(campaignId)]),
        campaignId,
        parentVariantId: campaign.currentParentVariantId,
        round: nextRound,
        ordinal,
        hypothesis,
      });
    });
    try {
      await this.refreshReports(campaignId);
    } catch (error) {
      for (const candidate of candidates) {
        this.database.updateVariant(candidate.id, {
          status: 'failed',
          error: `pre-run report generation failed: ${errorMessage(error)}`.slice(0, 20_000),
        });
      }
      this.database.updateCampaign(campaignId, { status: 'stopped_round_failed' });
      throw error;
    }
    const results = await Promise.all(
      candidates.map((candidate) => this.runVariant(campaign, candidate, true)),
    );
    if (this.database.getCampaign(campaignId).status === 'stopped_by_user') {
      await this.refreshReports(campaignId);
      return results;
    }
    const eligible = results
      .filter(
        (variant): variant is VariantRecord & { score: NonNullable<VariantRecord['score']> } =>
          variant.status === 'review' &&
          variant.artifactCollectionComplete &&
          variant.score !== null &&
          variant.hypothesisComplianceStatus === 'passed' &&
          variant.diagnosisStatus === 'completed' &&
          variant.diagnosisInputHash !== null,
      )
      .filter((variant) => !variant.score.cohortMismatches.includes('requirement units'))
      .filter((variant) => {
        const config = this.database.getTargetExcludedConfig(campaignId);
        return config
          ? this.targetExcludedEvaluationReady(
              campaign,
              config,
              this.database.getTargetExcludedEvaluation(variant.id),
              false,
            )
          : true;
      })
      .sort((left, right) => compareScores(left.score, right.score));
    if (eligible.length === 0) {
      const generatedTotal = this.database
        .listVariants(campaignId)
        .filter((variant) => variant.round > 0).length;
      const replenish =
        campaign.config.mode === 'automatic' &&
        generatedTotal < campaign.config.limits.maxVariants &&
        complianceBatchExhausted(campaign, results);
      this.database.updateCampaign(campaignId, {
        status: replenish
          ? 'ready'
          : generatedTotal >= campaign.config.limits.maxVariants
            ? 'stopped_max_variants'
            : 'stopped_round_failed',
      });
      if (replenish) {
        this.database.addEvent(campaignId, null, 'round.compliance_replenished', {
          round: nextRound,
          exhaustedVariants: results.map(({ id }) => id),
        });
      }
    } else if (campaign.config.mode === 'automatic') {
      if (!(await this.promoteFirstEligibleAutomaticCandidate(campaignId, eligible))) {
        this.database.updateCampaign(campaignId, { status: 'stopped_round_failed' });
      }
    } else {
      this.database.updateCampaign(campaignId, { status: 'awaiting_review' });
    }
    await this.refreshReports(campaignId);
    return results;
  }

  private async promoteFirstEligibleAutomaticCandidate(
    campaignId: string,
    eligible: readonly VariantRecord[],
  ): Promise<boolean> {
    for (const candidate of eligible) {
      try {
        await this.promoteUnlocked(campaignId, candidate.id);
        return true;
      } catch (error) {
        if (this.database.getVariant(candidate.id).status !== 'rejected') throw error;
      }
    }
    return false;
  }

  async promote(campaignId: string, variantId: string): Promise<VariantRecord> {
    return await this.withCampaignLock(
      campaignId,
      async () => await this.promoteUnlocked(campaignId, variantId),
    );
  }

  private async promoteUnlocked(campaignId: string, variantId: string): Promise<VariantRecord> {
    const campaign = this.database.getCampaign(campaignId);
    const targetConfig = campaign.config.targetExcluded
      ? await this.recoverAutomaticV2Config(campaign)
      : this.database.getTargetExcludedConfig(campaignId);
    if (campaign.config.targetExcluded && !targetConfig) {
      throw new Error('campaign-declared V2 runtime config is missing');
    }
    let variant = this.database.getVariant(variantId);
    if (targetConfig) {
      const targetEvaluation = this.database.getTargetExcludedEvaluation(variant.id);
      if (!this.targetExcludedEvaluationReady(campaign, targetConfig, targetEvaluation, false)) {
        throw new Error('variant is missing a completed target-excluded evaluation');
      }
      await this.verifyArchivedTargetExcludedComparisonsForAction(
        campaign,
        variant.id,
        targetConfig,
        targetEvaluation,
      );
    }
    if (
      variant.campaignId !== campaignId ||
      variant.status !== 'review' ||
      variant.parentVariantId !== campaign.currentParentVariantId ||
      !variant.artifactCollectionComplete ||
      !variant.facts ||
      !variant.score ||
      (variant.round > 0 &&
        !['passed', 'not_required'].includes(variant.hypothesisComplianceStatus)) ||
      variant.diagnosisStatus !== 'completed' ||
      !variant.diagnosisInputHash ||
      !variant.diagnosisResultHash
    ) {
      throw new Error('variant is not eligible for promotion');
    }
    const latestRound = Math.max(...this.database.listVariants(campaignId).map((candidate) => candidate.round));
    if (variant.round !== latestRound) throw new Error('only the current round can be promoted');
    if (variant.score.cohortMismatches.includes('requirement units')) {
      throw new Error('variant changed the frozen requirement-unit cohort');
    }
    await this.verifyVariantHypothesisCompliance(campaign, variant, true);
    await verifyDiagnosisArtifacts(
      variantArtifactDirectory(this.paths, campaign.id, variant.id),
      variant.diagnosisInputHash,
    );
    const verifiedDiagnosis = await verifyDiagnosisResult(
      variantArtifactDirectory(this.paths, campaign.id, variant.id),
      variant.diagnosisInputHash,
      variant.diagnosisResultHash,
    );
    if (JSON.stringify(verifiedDiagnosis) !== JSON.stringify(variant.diagnosis)) {
      throw new Error('persisted diagnosis result differs from the verified artifact');
    }
    const requiredHoldouts = campaign.config.benchmarks
      .filter((benchmark) => benchmark.role === 'holdout')
      .map((benchmark) => benchmark.name);
    if (
      requiredHoldouts.some(
        (name) =>
          !variant.holdoutFacts?.[name] ||
          !variant.holdoutJudgments?.[name] ||
          !variant.holdoutScores?.[name],
      )
    ) {
      throw new Error('variant is missing a completed, judged holdout');
    }
    if (!variant.score) throw new Error('variant score disappeared during holdout evaluation');
    const parent = campaign.currentParentVariantId
      ? this.database.getVariant(campaign.currentParentVariantId)
      : null;
    if (
      parent?.score &&
      (parent.score.verified.labeled !== variant.score.verified.labeled ||
        parent.score.provisional.labeled !== variant.score.provisional.labeled)
    ) {
      throw new Error('variant and parent do not have identical scoring coverage');
    }
    const holdoutRegressions = Object.entries(variant.holdoutScores ?? {})
      .filter(([name, score]) => {
        const parentScore = parent?.holdoutScores?.[name];
        return parentScore
          ? score.cohortMismatches.includes('requirement units') ||
              score.verified.labeled !== parentScore.verified.labeled ||
              score.provisional.labeled !== parentScore.provisional.labeled ||
              compareScores(score, parentScore) > 0
          : true;
      })
      .map(([name]) => name);
    if (holdoutRegressions.length > 0) {
      this.database.updateVariant(variant.id, {
        status: 'rejected',
        error: `holdout regression: ${holdoutRegressions.join(', ')}`,
      });
      throw new Error(`variant regressed holdout benchmarks: ${holdoutRegressions.join(', ')}`);
    }
    const improved = !parent?.score || compareScores(variant.score, parent.score) < 0;
    const noImprovementRounds = improved ? 0 : campaign.noImprovementRounds + 1;
    variant = this.database.updateVariant(variant.id, { status: 'completed' });
    for (const sibling of this.database.listVariants(campaignId)) {
      if (sibling.round === variant.round && sibling.id !== variant.id && sibling.status === 'review') {
        this.database.updateVariant(sibling.id, { status: 'rejected' });
      }
    }
    const stopped = noImprovementRounds >= campaign.config.limits.noImprovementRounds;
    this.database.updateCampaign(campaignId, {
      currentParentVariantId: variant.id,
      noImprovementRounds,
      status: stopped ? 'stopped_no_improvement' : 'ready',
    });
    this.database.addEvent(campaignId, variant.id, 'variant.promoted', { improved, noImprovementRounds });
    await this.refreshReports(campaignId);
    return variant;
  }

  private buildTargetNormalArmBinding(
    variantId: string,
    benchmark: Benchmark,
    resolvedArtifactSha: string,
  ): TargetNormalArmBinding {
    const variant = this.database.getVariant(variantId);
    if (variant.questionResolutions?.[benchmark.name]?.resolvedArtifactSha !== resolvedArtifactSha) {
      throw new Error('standard primary question resolution differs from the V2 config');
    }
    const executions = (variant.executionState?.executions ?? [])
      .filter(
        (execution) => execution.benchmark === benchmark.name && execution.role === 'primary',
      )
      .sort((left, right) => left.replicate - right.replicate);
    if (executions.length !== 2) {
      throw new Error('V2 standard primary must have exactly two execution records');
    }
    const first = executions[0]!;
    const second = executions[1]!;
    if (
      first.replicate !== 1 ||
      second.replicate !== 2 ||
      first.replicateCount !== 2 ||
      second.replicateCount !== 2 ||
      first.status !== 'completed' ||
      second.status !== 'completed' ||
      !first.caseId ||
      !first.runId ||
      !second.caseId ||
      !second.runId
    ) {
      throw new Error('V2 standard primary execution lineage is incomplete');
    }
    return {
      source: 'standard_primary',
      benchmark: benchmark.name,
      resolvedArtifactSha,
      replicates: [
        { replicate: 1, caseId: first.caseId, runId: first.runId },
        { replicate: 2, caseId: second.caseId, runId: second.runId },
      ],
    };
  }

  private async verifyArchivedTargetExcludedComparisons(
    campaign: CampaignRecord,
    variantId: string,
    config: TargetExcludedConfig,
    evaluation: TargetExcludedEvaluationRecord,
  ): Promise<void> {
    if (evaluation.variantId !== variantId || evaluation.campaignId !== campaign.id) {
      throw new Error('target-excluded comparison evaluation lineage is invalid');
    }
    const persisted = evaluation.comparisons ?? [];
    if (persisted.length !== config.replicates) {
      throw new Error('persisted target-excluded comparison set is incomplete');
    }
    const comparisonDirectory = path.join(
      variantArtifactDirectory(this.paths, campaign.id, variantId),
      'target-excluded',
      'comparisons',
    );
    for (let replicate = 1; replicate <= config.replicates; replicate += 1) {
      const matches = persisted.filter((comparison) => comparison.replicate === replicate);
      if (matches.length !== 1) {
        throw new Error(`persisted target-excluded comparison replicate ${replicate} is invalid`);
      }
      const report = JSON.parse(
        await readFile(path.join(comparisonDirectory, `replicate-${replicate}.json`), 'utf8'),
      ) as unknown;
      const archived = summarizeTargetExcludedComparisonReport(replicate, report);
      const expected = matches[0]!;
      const comparable = config.protocol === 'dedicated-control-v1'
        ? {
            ...expected,
            normalCaseId: expected.normalCaseId ?? archived.normalCaseId,
            excludedCaseId: expected.excludedCaseId ?? archived.excludedCaseId,
            normalRunId: expected.normalRunId ?? archived.normalRunId,
            excludedRunId: expected.excludedRunId ?? archived.excludedRunId,
          }
        : expected;
      if (!isDeepStrictEqual(archived, comparable)) {
        throw new Error(
          `archived target-excluded comparison differs from persisted summary: replicate ${replicate}`,
        );
      }
    }
  }

  private async verifyArchivedTargetExcludedComparisonsForAction(
    campaign: CampaignRecord,
    variantId: string,
    config: TargetExcludedConfig,
    evaluation: TargetExcludedEvaluationRecord,
  ): Promise<void> {
    try {
      await this.verifyArchivedTargetExcludedComparisons(
        campaign,
        variantId,
        config,
        evaluation,
      );
    } catch (error) {
      if (evaluation.campaignId === campaign.id && evaluation.variantId === variantId) {
        const current = this.database.getTargetExcludedEvaluation(variantId);
        if (current?.campaignId === campaign.id && current.variantId === variantId) {
          this.database.updateTargetExcludedEvaluation(variantId, {
            status: 'failed',
            error: `target-excluded comparison integrity failure: ${errorMessage(error)}`.slice(
              0,
              20_000,
            ),
          });
        }
      }
      throw error;
    }
  }

  private targetExcludedEvaluationReady(
    campaign: CampaignRecord,
    config: TargetExcludedConfig,
    evaluation: TargetExcludedEvaluationRecord | null,
    baseline: boolean,
  ): evaluation is TargetExcludedEvaluationRecord {
    if (!evaluation) return false;
    if (config.protocol === 'standard-primary-v2') {
      const variant = this.database.getVariant(evaluation.variantId);
      const declared = campaign.config.targetExcluded;
      const primary = primaryBenchmark(campaign);
      const binding = evaluation.normalArmBinding;
      const requiredHoldouts = campaign.config.benchmarks.filter(({ role }) => role === 'holdout');
      let expectedBinding: TargetNormalArmBinding | null = null;
      try {
        expectedBinding = this.buildTargetNormalArmBinding(
          variant.id,
          primary,
          config.primaryResolvedArtifactSha,
        );
      } catch {
        return false;
      }
      const excludedExecutions = (evaluation.executionState?.executions ?? [])
        .filter((execution) => execution.benchmark === `${primary.name}:excluded`)
        .sort((left, right) => left.replicate - right.replicate);
      const excludedExecutionComplete = excludedExecutions.length === config.replicates &&
        excludedExecutions.every(
          (execution, index) =>
            execution.replicate === index + 1 &&
            execution.replicateCount === config.replicates &&
            execution.status === 'completed' &&
            Boolean(execution.caseId) &&
            Boolean(execution.runId),
        );
      const normalCaseIds = new Map<number, string>(
        binding?.replicates.map(({ replicate, caseId }) => [replicate, caseId] as const) ?? [],
      );
      const excludedCaseIds = new Map<number, string | null>(
        excludedExecutions.map(({ replicate, caseId }) => [replicate, caseId] as const),
      );
      const normalRunIds = new Map<number, string>(
        binding?.replicates.map(({ replicate, runId }) => [replicate, runId] as const) ?? [],
      );
      const excludedRunIds = new Map<number, string | null>(
        excludedExecutions.map(({ replicate, runId }) => [replicate, runId] as const),
      );
      const comparisonOrdinals = evaluation.comparisons
        ?.map(({ replicate }) => replicate)
        .sort((left, right) => left - right) ?? [];
      const baselineRuns = baseline
        ? evaluation.excludedReplicateFacts ?? []
        : this.database.getTargetExcludedEvaluation(config.baselineVariantId)
            ?.excludedReplicateFacts ?? [];
      const comparisonsValid = evaluation.comparisons?.length === config.replicates &&
        evaluation.comparisons.every(
          (comparison) =>
            comparison.valid &&
            comparison.leakagePaths.length === 0 &&
            comparison.normalCaseId === normalCaseIds.get(comparison.replicate) &&
            comparison.excludedCaseId === excludedCaseIds.get(comparison.replicate) &&
            comparison.normalRunId === normalRunIds.get(comparison.replicate) &&
            comparison.excludedRunId === excludedRunIds.get(comparison.replicate) &&
            Boolean(comparison.reportHash?.match(/^sha256:[a-f0-9]{64}$/)),
        );
      const leakageDetected =
        (evaluation.comparisons?.some(({ leakagePaths }) => leakagePaths.length > 0) ?? false) ||
        containsTargetIdentityLeak(evaluation.judgment, config.targetImplementationWorkflow) ||
        containsTargetIdentityLeak(evaluation.questionResolution, config.targetImplementationWorkflow);
      const expectedGate = computeTargetExcludedGate(
        baselineRuns,
        evaluation.excludedReplicateFacts ?? [],
        comparisonsValid ?? false,
        leakageDetected,
        config.warningBuildDropRatio,
        config.blockBuildDropRatio,
      );
      return Boolean(
          declared?.protocol === 'standard-primary-v2' &&
          declared.targetImplementationWorkflow === config.targetImplementationWorkflow &&
          (!baseline || variant.id === config.baselineVariantId) &&
          evaluation.campaignId === campaign.id &&
          config.normalArmSource === 'standard_primary' &&
          variant.campaignId === campaign.id &&
          variant.artifactCollectionComplete &&
          variant.facts &&
          variant.replicateFacts?.length === config.replicates &&
          requiredHoldouts.every(
            ({ name }) =>
              Boolean(variant.holdoutFacts?.[name]) &&
              variant.holdoutReplicateFacts?.[name]?.length === config.replicates,
          ) &&
          variant.questionResolutions?.[primary.name]?.resolvedArtifactSha ===
            config.primaryResolvedArtifactSha &&
          binding &&
          normalArmBindingsEqual(binding, expectedBinding) &&
          evaluation.controlFacts === null &&
          evaluation.controlReplicateFacts === null &&
          evaluation.holdoutFacts === null &&
          evaluation.holdoutReplicateFacts === null &&
          evaluation.status === 'completed' &&
          evaluation.artifactCollectionComplete &&
          evaluation.excludedFacts &&
          evaluation.excludedReplicateFacts?.length === config.replicates &&
          excludedExecutionComplete &&
          comparisonsValid &&
          JSON.stringify(comparisonOrdinals) === JSON.stringify([1, 2]) &&
          evaluation.judgment &&
          evaluation.score &&
          evaluation.questionResolution?.resolvedArtifactSha === config.primaryResolvedArtifactSha &&
          evaluation.gate &&
          JSON.stringify(evaluation.gate) === JSON.stringify(expectedGate) &&
          (baseline
            ? evaluation.gate.status === 'passed'
            : evaluation.gate.status === 'passed' || evaluation.gate.status === 'warning'),
      );
    }
    const comparisonOrdinals = evaluation.comparisons?.map(({ replicate }) => replicate).sort() ?? [];
    const holdoutsComplete = campaign.config.benchmarks
      .filter(({ role }) => role === 'holdout')
      .every(
        ({ name }) => evaluation.holdoutReplicateFacts?.[name]?.length === config.replicates,
      );
    const baselineRuns = baseline
      ? evaluation.excludedReplicateFacts ?? []
      : this.database.getTargetExcludedEvaluation(config.baselineVariantId)?.excludedReplicateFacts ?? [];
    const expectedGate = computeTargetExcludedGate(
      baselineRuns,
      evaluation.excludedReplicateFacts ?? [],
      evaluation.comparisons?.length === config.replicates &&
        evaluation.comparisons.every(({ valid }) => valid),
      evaluation.comparisons?.some(({ leakagePaths }) => leakagePaths.length > 0) ?? false,
      config.warningBuildDropRatio,
      config.blockBuildDropRatio,
    );
    return Boolean(
      evaluation.status === 'completed' &&
        evaluation.artifactCollectionComplete &&
        evaluation.controlReplicateFacts?.length === config.replicates &&
        evaluation.excludedReplicateFacts?.length === config.replicates &&
        holdoutsComplete &&
        evaluation.comparisons?.length === config.replicates &&
        JSON.stringify(comparisonOrdinals) ===
          JSON.stringify(Array.from({ length: config.replicates }, (_, index) => index + 1)) &&
        evaluation.comparisons.every(
          (comparison) => comparison.valid && comparison.leakagePaths.length === 0,
        ) &&
        evaluation.judgment &&
        evaluation.score &&
        evaluation.questionResolution &&
        evaluation.gate &&
        JSON.stringify(evaluation.gate) === JSON.stringify(expectedGate) &&
        (baseline
          ? evaluation.gate.status === 'passed'
          : evaluation.gate.status === 'passed' || evaluation.gate.status === 'warning'),
    );
  }

  private reconcileTargetSafeQuestionResolution(
    campaign: CampaignRecord,
    config: TargetExcludedConfig,
    evaluation: TargetExcludedEvaluationRecord | null,
  ): TargetExcludedEvaluationRecord | null {
    if (
      config.protocol !== 'standard-primary-v2' ||
      !evaluation?.questionResolution ||
      !evaluation.excludedReplicateFacts ||
      !evaluation.comparisons ||
      !evaluation.judgment
    ) {
      return evaluation;
    }
    const questionResolution = targetSafeQuestionResolution(
      evaluation.questionResolution,
      config.targetImplementationWorkflow,
    );
    if (isDeepStrictEqual(questionResolution, evaluation.questionResolution)) return evaluation;
    const baselineRuns =
      evaluation.variantId === config.baselineVariantId
        ? evaluation.excludedReplicateFacts
        : this.database.getTargetExcludedEvaluation(config.baselineVariantId)
            ?.excludedReplicateFacts ?? [];
    const comparisonValid =
      evaluation.comparisons.length === config.replicates &&
      evaluation.comparisons.every((comparison) => comparison.valid);
    const leakageDetected =
      evaluation.comparisons.some((comparison) => comparison.leakagePaths.length > 0) ||
      containsTargetIdentityLeak(evaluation.judgment, config.targetImplementationWorkflow) ||
      containsTargetIdentityLeak(questionResolution, config.targetImplementationWorkflow);
    return this.database.updateTargetExcludedEvaluation(evaluation.variantId, {
      questionResolution,
      gate: computeTargetExcludedGate(
        baselineRuns,
        evaluation.excludedReplicateFacts,
        comparisonValid,
        leakageDetected,
        config.warningBuildDropRatio,
        config.blockBuildDropRatio,
      ),
    });
  }

  stop(campaignId: string): CampaignRecord {
    for (const [key, pending] of this.pendingTargetAnswers) {
      if (pending.campaignId !== campaignId) continue;
      this.pendingTargetAnswers.delete(key);
      pending.reject(new Error('target-excluded question wait was stopped by the user'));
      if (this.database.getTargetExcludedEvaluation(pending.variantId)) {
        this.database.updateTargetExcludedEvaluation(pending.variantId, {
          status: 'failed',
          error: 'target-excluded question wait was stopped by the user',
        });
      }
    }
    const campaign = this.database.updateCampaign(campaignId, { status: 'stopped_by_user' });
    this.database.addEvent(campaignId, null, 'campaign.stop_requested', {});
    return campaign;
  }

  resume(campaignId: string): CampaignRecord {
    if (this.isActive(campaignId)) throw new Error('campaign is still active');
    const leased = this.database.database.prepare(
      'SELECT lease_owner FROM campaigns WHERE id = ? AND lease_owner IS NOT NULL AND lease_expires_at > ?',
    ).get(campaignId, Date.now());
    if (leased) throw new Error('campaign is leased by another coordinator; wait for lease expiry before resume');
    const campaign = this.database.getCampaign(campaignId);
    const variants = this.database.listVariants(campaignId);
    const investigations = campaign.config.investigator?.enabled
      ? variants.filter((variant) => variant.round > 0 && variant.investigation &&
          ['running', 'stopped'].includes(variant.investigation.status))
      : [];
    // Validate every candidate before changing any persisted state. Never reconstruct a lost baseline.
    for (const variant of investigations) {
      const state = variant.investigation!;
      if (!variant.worktreePath || typeof state.harnessPins?.mutationBaselineTree !== 'string' ||
          !state.harnessPins.mutationBaselineTree || typeof state.harnessPins.contextHash !== 'string' ||
          !state.harnessPins.contextHash || (state.turnCount > 0 && !state.sessionId)) {
        throw new Error(`cannot resume ${variant.id}: saved session, worktree, or mutation baseline provenance is missing`);
      }
      if (state.actions.some((action) => action.kind === 'evaluate_primary' &&
          (['running', 'interrupted'].includes(action.status) || (action.status === 'failed' && variant.composeProject)))) {
        throw new Error(`cannot resume ${variant.id}: archive and reconcile the interrupted primary stack before resuming; no action was replayed`);
      }
      if (variant.hypothesisComplianceAttempts.length > 0) {
        throw new Error(`cannot resume ${variant.id}: existing final compliance attempts require explicit recovery`);
      }
    }
    const interrupted = variants.filter(
      (variant) =>
        variant.round > 0 &&
        !investigations.some((candidate) => candidate.id === variant.id) &&
        ['queued', 'mutating', 'gating', 'building', 'starting', 'running', 'judging'].includes(
          variant.status,
        ),
    );
    if (interrupted.length > 0) {
      throw new Error(
        `cannot resume with interrupted generated variants: ${interrupted.map(({ id }) => id).join(', ')}`,
      );
    }
    for (const variant of investigations) {
      const state = structuredClone(variant.investigation!);
      const timestamp = new Date().toISOString();
      for (const action of state.actions) {
        if (action.status !== 'running') continue;
        action.status = 'interrupted';
        action.completedAt = timestamp;
        action.error = 'Coordinator interrupted. This action was not replayed; inspect archived evidence before requesting another.';
      }
      if (state.status === 'running' && state.turnCount > 0 &&
          !state.actions.some((action) => action.id === `action-${String(state.turnCount).padStart(3, '0')}`)) {
        state.agentTokens = null;
        state.agentCostUsd = null;
      }
      state.status = 'stopped';
      state.updatedAt = timestamp;
      state.reason = 'Resuming the saved session without replaying interrupted turns or actions.';
      this.database.updateVariant(variant.id, { investigation: state, status: 'stopped' });
    }
    const hasReview = variants.some((variant) => variant.status === 'review');
    const hasBaseline = variants.some(
      (variant) => variant.round === 0 && variant.status === 'completed',
    );
    const status = hasReview ? 'awaiting_review' : hasBaseline ? 'ready' : 'baseline_failed';
    const resumed = this.database.updateCampaign(campaignId, { status });
    this.database.addEvent(campaignId, null, 'campaign.resumed', { previousStatus: campaign.status });
    return resumed;
  }

  private markOperationFailed(campaignId: string, error: unknown): void {
    const campaign = this.database.getCampaign(campaignId);
    if (!campaign.status.startsWith('stopped')) {
      this.database.updateCampaign(campaignId, { status: 'stopped_operation_failed' });
    }
    this.database.addEvent(campaignId, null, 'campaign.operation_failed', {
      error: errorMessage(error),
    });
  }

  isActive(campaignId: string): boolean {
    return this.activeCampaigns.has(campaignId);
  }

  async saveVerifiedLabel(input: {
    campaignId: string;
    benchmark: string;
    unitKey: string;
    expectedDecision: Decision;
    classification: 'system_error' | 'real_gap' | 'uncertain';
    rationale: string;
  }): Promise<void> {
    const campaign = this.database.getCampaign(input.campaignId);
    if (!campaign.config.benchmarks.some((benchmark) => benchmark.name === input.benchmark)) {
      throw new Error(`unknown benchmark: ${input.benchmark}`);
    }
    const investigator = campaign.config.investigator?.enabled;
    const variants = this.database.listVariants(input.campaignId);
    if (investigator) {
      for (const variant of variants) {
        const primary = input.benchmark === primaryBenchmark(campaign).name;
        const facts = primary ? variant.facts : variant.holdoutFacts?.[input.benchmark];
        const judgment = primary ? variant.judgment : variant.holdoutJudgments?.[input.benchmark];
        if (!facts || !judgment) continue;
        const replicates = primary ? variant.replicateFacts : variant.holdoutReplicateFacts?.[input.benchmark];
        if (!Array.isArray(replicates) || replicates.length !== campaign.config.evaluation.replicates) {
          throw new Error(`${variant.id}: investigator scoring requires complete raw replicate facts for ${input.benchmark}`);
        }
      }
    }
    this.database.upsertLabel({ ...input, status: 'verified' });
    const labels = this.database.listLabels(input.campaignId, input.benchmark);
    for (const variant of variants) {
      if (input.benchmark === primaryBenchmark(campaign).name) {
        if (!variant.facts || !variant.judgment) continue;
        const score = investigator
          ? computeReplicateMeanScore(variant.replicateFacts!, labels, variant.judgment)
          : computeScore(variant.facts, labels, variant.judgment);
        score.cohortMismatches = [...new Set([...score.cohortMismatches, ...(variant.score?.cohortMismatches ?? [])])];
        this.database.updateVariant(variant.id, { score });
      } else {
        const facts = variant.holdoutFacts?.[input.benchmark];
        const judgment = variant.holdoutJudgments?.[input.benchmark];
        if (!facts || !judgment) continue;
        const score = investigator
          ? computeReplicateMeanScore(variant.holdoutReplicateFacts![input.benchmark]!, labels, judgment)
          : computeScore(facts, labels, judgment);
        score.cohortMismatches = [...new Set([
          ...score.cohortMismatches, ...(variant.holdoutScores?.[input.benchmark]?.cohortMismatches ?? []),
        ])];
        this.database.updateVariant(variant.id, {
          holdoutScores: { ...(variant.holdoutScores ?? {}), [input.benchmark]: score },
        });
      }
    }
    await this.refreshReports(input.campaignId);
  }

  private persistV2StandardOutcomes(
    variantId: string,
    primary: Benchmark,
    holdouts: readonly Benchmark[],
    questionResolutions: NonNullable<VariantRecord['questionResolutions']>,
    outcomes: readonly PromiseSettledResult<BenchmarkReplicateResult>[],
  ): {
    primaryRuns: BenchmarkReplicateResult | null;
    holdoutFacts: Record<string, RunFacts>;
    holdoutReplicateFacts: Record<string, RunFacts[]>;
    failures: unknown[];
  } {
    const current = this.database.getVariant(variantId);
    const nextHoldoutFacts = { ...(current.holdoutFacts ?? {}) };
    const nextHoldoutReplicateFacts = { ...(current.holdoutReplicateFacts ?? {}) };
    const failures: unknown[] = [];
    const primaryOutcome = outcomes[0];
    const primaryRuns = primaryOutcome?.status === 'fulfilled' ? primaryOutcome.value : null;
    if (primaryOutcome?.status === 'rejected') failures.push(primaryOutcome.reason);
    if (!primaryOutcome) failures.push(new Error('standard primary outcome is missing'));
    if (primaryRuns) {
      questionResolutions[primary.name] = withRuntimeQuestions(
        questionResolutions[primary.name]!,
        primaryRuns.questions,
      );
    }
    for (const [index, benchmark] of holdouts.entries()) {
      const outcome = outcomes[index + 1];
      if (!outcome) {
        failures.push(new Error(`${benchmark.name} outcome is missing`));
        continue;
      }
      if (outcome.status === 'rejected') {
        failures.push(outcome.reason);
        continue;
      }
      nextHoldoutFacts[benchmark.name] = outcome.value.facts;
      nextHoldoutReplicateFacts[benchmark.name] = outcome.value.replicates;
      questionResolutions[benchmark.name] = withRuntimeQuestions(
        questionResolutions[benchmark.name]!,
        outcome.value.questions,
      );
    }
    this.database.updateVariant(variantId, {
      facts: primaryRuns?.facts ?? current.facts,
      replicateFacts: primaryRuns?.replicates ?? current.replicateFacts,
      holdoutFacts: Object.keys(nextHoldoutFacts).length > 0 ? nextHoldoutFacts : null,
      holdoutReplicateFacts:
        Object.keys(nextHoldoutReplicateFacts).length > 0 ? nextHoldoutReplicateFacts : null,
      questionResolutions,
    });
    return {
      primaryRuns,
      holdoutFacts: nextHoldoutFacts,
      holdoutReplicateFacts: nextHoldoutReplicateFacts,
      failures,
    };
  }

  private async runInvestigatorRound(campaign: CampaignRecord): Promise<VariantRecord[]> {
    const owner = this.database.database.prepare('SELECT lease_owner FROM campaigns WHERE id = ?')
      .get(campaign.id)?.lease_owner;
    const assertLease = () => {
      if (!owner || !this.database.database.prepare(
        'SELECT id FROM campaigns WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?',
      ).get(campaign.id, String(owner), Date.now())) {
        throw new Error('investigator campaign lease lost; no further candidate or promotion was dispatched');
      }
    };
    assertLease();
    const variants = this.database.listVariants(campaign.id);
    let candidates = variants.filter((variant) => variant.investigation &&
      ['running', 'stopped'].includes(variant.investigation.status));
    if (candidates.length === 0) {
      const remaining = campaign.config.limits.maxVariants - variants.filter((variant) => variant.round > 0).length;
      const count = Math.min(campaign.config.limits.concurrency, remaining);
      if (count <= 0) throw new Error('campaign reached maxVariants');
      const round = Math.max(...variants.map((variant) => variant.round), 0) + 1;
      let ordinal = Math.max(...variants.map((variant) => variant.ordinal), 0);
      candidates = Array.from({ length: count }, (_, index) => this.database.createVariant({
        id: nextVariantIdentity(campaign, this.database.listVariants(campaign.id)),
        campaignId: campaign.id, parentVariantId: campaign.currentParentVariantId,
        round, ordinal: ++ordinal,
        hypothesis: {
          title: `Source-grounded investigation ${index + 1}`,
          rationale: 'Investigate the measured parent against the complete campaign objective supplied in the investigator context.',
          instructions: 'Investigate the measured parent, challenge its diagnosis, and develop one generic, testable treatment. Preregister the actual hypothesis before each evaluation.',
          expectedImpact: 'A source-supported improvement in primary provisional decision accuracy, not merely fewer builds.',
          risk: 'Provisional labels and provider variation can mislead. Preserve counterevidence and abandon unsupported mechanisms.',
          findingIds: [], assumptions: ['At least one observed failure is addressable by a generic planner change.'],
        },
      }));
    }
    for (const candidate of candidates) {
      assertLease();
      const state = candidate.investigation;
      if (!state) continue;
      if (!candidate.worktreePath || !(await stat(candidate.worktreePath).catch(() => null))?.isDirectory() ||
          typeof state.harnessPins?.mutationBaselineTree !== 'string' || !state.harnessPins.mutationBaselineTree ||
          (state.turnCount > 0 && !state.sessionId)) {
        throw new Error(`cannot resume ${candidate.id}: saved session, worktree, or mutation baseline is missing; no worktree was recreated`);
      }
      if (state.actions.some((action) => action.kind === 'evaluate_primary' &&
          (['running', 'interrupted'].includes(action.status) || (action.status === 'failed' && candidate.composeProject)))) {
        throw new Error(`cannot resume ${candidate.id}: archive and reconcile the interrupted primary stack first`);
      }
      const directory = path.join(variantArtifactDirectory(this.paths, campaign.id, candidate.id),
        'investigation', `resume-${randomUUID()}`);
      await mkdir(directory, { recursive: true });
      // Capture through a temporary index and verify the persisted baseline; never stage on resume.
      await captureMutationDiff(campaign, candidate, candidate.worktreePath, directory, state.harnessPins.mutationBaselineTree);
      await captureAndGateDiff(campaign, candidate, candidate.worktreePath, directory);
    }
    assertLease();
    if (this.database.getCampaign(campaign.id).status === 'stopped_by_user') return candidates;
    this.database.updateCampaign(campaign.id, { status: `running_round_${candidates[0]!.round}` });
    await this.refreshReports(campaign.id);
    const results = await Promise.all(candidates.map((candidate) => {
      assertLease();
      if (this.database.getCampaign(campaign.id).status === 'stopped_by_user') return candidate;
      return this.runVariant(campaign, candidate, true);
    }));
    assertLease();
    if (this.database.getCampaign(campaign.id).status === 'stopped_by_user') return results;
    if (results.some((variant) => variant.status === 'failed' || variant.investigation?.status === 'failed')) {
      this.database.updateCampaign(campaign.id, { status: 'stopped_investigator_failed' });
      await this.refreshReports(campaign.id);
      return results;
    }
    if (results.some((variant) => variant.investigation && ['running', 'stopped'].includes(variant.investigation.status))) {
      this.database.updateCampaign(campaign.id, { status: 'stopped_investigator_incomplete' });
      await this.refreshReports(campaign.id);
      return results;
    }
    const targetConfig = this.database.getTargetExcludedConfig(campaign.id);
    const eligible = results.filter((variant) => variant.status === 'review' && variant.score &&
      !variant.score.cohortMismatches.includes('requirement units') &&
      variant.diagnosisStatus === 'completed' && variant.diagnosisInputHash &&
      variant.investigation?.status === 'finalized' &&
      variant.artifactCollectionComplete && variant.hypothesisComplianceStatus === 'passed' &&
      (!targetConfig || this.targetExcludedEvaluationReady(campaign, targetConfig,
        this.database.getTargetExcludedEvaluation(variant.id), false)))
      .sort((left, right) => compareScores(left.score!, right.score!));
    if (eligible.length && campaign.config.mode === 'automatic' &&
        await this.promoteFirstEligibleAutomaticCandidate(campaign.id, eligible)) {
      await this.refreshReports(campaign.id);
      return results;
    }
    const generated = this.database.listVariants(campaign.id).filter((variant) => variant.round > 0).length;
    this.database.updateCampaign(campaign.id, {
      status: eligible.length && campaign.config.mode !== 'automatic' ? 'awaiting_review'
        : generated >= campaign.config.limits.maxVariants ? 'stopped_max_variants' : 'ready',
    });
    await this.refreshReports(campaign.id);
    return results;
  }

  private async runInvestigatorCandidate(
    campaign: CampaignRecord,
    initialVariant: VariantRecord,
    worktree: string,
    artifactDirectory: string,
    mutationBaselineTree: string,
  ): Promise<VariantRecord> {
    const limits = campaign.config.investigator!;
    const parent = this.database.getVariant(initialVariant.parentVariantId!);
    const primary = primaryBenchmark(campaign);
    const trustedPlanner = await this.ensureFrozenPlannerSource(campaign);
    const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
    const contextPath = path.join(artifactDirectory, 'investigator-context.json');
    const referencePath = path.join(artifactDirectory, 'investigator-reference.json');
    const labels = this.database.listLabels(campaign.id, primary.name);
    if (!(await stat(contextPath).catch(() => null))) {
      await writeFile(referencePath, `${JSON.stringify({ labels, labelSetHash: canonicalHash(labels), baseline: {
        id: parent.id, facts: parent.facts, replicateFacts: parent.replicateFacts,
      } }, null, 2)}\n`, { flag: 'wx' });
      await writeFile(contextPath, `${JSON.stringify({
        goal: campaign.config.goal,
        authority: 'Measurements are observations; labels and diagnosis are unverified model judgments. You may challenge or replace any diagnosis intervention.',
        primary, labelSetHash: canonicalHash(labels), referencePath,
        baseline: { id: parent.id, decisions: parent.facts?.decisions, evidence: parent.facts?.evidence, score: parent.score },
        diagnosis: parent.diagnosis,
        artifacts: {
          parent: variantArtifactDirectory(this.paths, campaign.id, parent.id),
          current: artifactDirectory, workflowsSource,
          priorExperiments: this.database.listVariants(campaign.id).map((variant) => ({
            id: variant.id, hypothesis: variant.hypothesis, error: variant.error,
            investigation: variant.investigation ? { status: variant.investigation.status, reason: variant.investigation.reason,
              actions: variant.investigation.actions.map(({ id, kind, status, error }) => ({ id, kind, status, error })) } : null, score: variant.score,
            directory: variantArtifactDirectory(this.paths, campaign.id, variant.id),
          })),
        },
        measurementPolicy: 'Primary labels are frozen for these trials. Runtime question answers and decision context may differ: inspect question audits and never claim controlled replay unless the context matches. Catalyst is regression data, not an unseen holdout.',
      }, null, 2)}\n`, { flag: 'wx' });
    }
    const contextHash = await sha256File(contextPath);
    const referenceHash = await sha256File(referencePath);
    const reference = JSON.parse(await readFile(referencePath, 'utf8')) as {
      labels: typeof labels; labelSetHash: string; baseline: { replicateFacts: RunFacts[] | null; facts: RunFacts | null };
    };
    if (!reference.baseline.replicateFacts?.length) throw new Error('investigator requires archived parent replicates');
    const startedAt = new Date().toISOString();
    const executionHarnessPins = {
      revision: (await runCommand('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      dirtyPatchHash: canonicalHash((await runCommand('git', ['diff', 'HEAD', '--', 'src', 'public'])).stdout),
      runtimeSourceHash: canonicalHash(await Promise.all((await readdir(path.resolve('src'))).filter((name) => name.endsWith('.ts')).sort().map(async (name) => [name, await sha256File(path.resolve('src', name))]))),
    };
    let state: InvestigationState = initialVariant.investigation ?? {
      schemaVersion: 1, sessionId: null, status: 'running', startedAt, updatedAt: startedAt,
      turnCount: 0, agentTokens: 0, agentCostUsd: 0, reason: null, actions: [],
      harnessPins: {
        ...executionHarnessPins,
        contextHash, referenceHash, mutationBaselineTree, labelSetHash: reference.labelSetHash,
      },
    };
    if (state.harnessPins?.contextHash !== contextHash) throw new Error('investigator context was modified');
    if (state.harnessPins?.referenceHash !== referenceHash) throw new Error('investigator score reference was modified');
    this.database.addEvent(campaign.id, initialVariant.id, 'investigator.coordinator_started', {
      ...executionHarnessPins, sessionId: state.sessionId, turnCount: state.turnCount, contextHash, referenceHash,
    });
    const leaseOwner = this.database.database.prepare('SELECT lease_owner FROM campaigns WHERE id = ?').get(campaign.id)?.lease_owner;
    const assertActive = () => {
      if (leaseOwner && !this.database.database.prepare('SELECT id FROM campaigns WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?').get(campaign.id, String(leaseOwner), Date.now())) {
        throw new Error('investigator coordinator lease lost; no further actions admitted');
      }
    };
    const save = (next: InvestigationState) => {
      state = next;
      this.database.updateVariant(initialVariant.id, { investigation: next });
      this.database.addEvent(campaign.id, initialVariant.id, 'investigator.updated', {
        status: next.status, turnCount: next.turnCount, actionId: next.actions.at(-1)?.id,
      });
    };
    const runner = new AgentRunner(campaign);
    const completed = await runInvestigatorLoop(state, limits, {
      save,
      assertActive,
      stopped: () => this.database.getCampaign(campaign.id).status === 'stopped_by_user',
      turn: async (current, feedback, onSession) => {
        this.database.updateVariant(initialVariant.id, { status: 'mutating' });
        return await runner.investigate(this.database.getVariant(initialVariant.id), worktree,
          artifactDirectory, contextPath, current, feedback, onSession);
      },
      execute: async (action, record, current) => {
        const directory = path.join(artifactDirectory, 'investigation', record.id);
        await mkdir(directory, { recursive: true });
        const relativeDirectory = path.relative(artifactDirectory, directory);
        await writeFile(path.join(directory, 'request.json'), `${JSON.stringify(action, null, 2)}\n`, { flag: 'wx' });
        const variant = this.database.updateVariant(initialVariant.id, {
          hypothesis: action.hypothesis, status: 'gating',
          hypothesisComplianceStatus: 'not_required', hypothesisCompliance: null,
          hypothesisComplianceResultHash: null, hypothesisComplianceError: null,
        });
        let candidateHash: string | null = null;
        try {
          if ((await sha256File(contextPath)) !== contextHash || (await sha256File(referencePath)) !== referenceHash) throw new Error('investigator modified frozen context or score reference');
          const treatment = await captureMutationDiff(campaign, variant, worktree, directory, mutationBaselineTree);
          const candidate = await captureAndGateDiff(campaign, variant, worktree, directory);
          candidateHash = await sha256File(candidate.patchPath);
          record.patchHash = candidateHash;
          record.artifactDirectory = relativeDirectory;
          save({ ...current, actions: current.actions.map((item) => item.id === record.id ? { ...record } : item) });
          this.database.updateVariant(variant.id, { patchPath: candidate.patchPath, patchHash: candidateHash });
          if (action.action !== 'abandon' && treatment.result.changedFiles.length === 0) throw new Error('No treatment beyond inherited parent. Make a bounded change or abandon.');
          if (action.action === 'abandon') {
            const receipt = { patchHash: candidateHash, artifactDirectory: relativeDirectory, result: { reason: action.rationale } };
            await writeFile(path.join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
            return receipt;
          }
          const prior = current.actions.slice(0, -1);
          if (action.action === 'evaluate_primary' && !prior.some((item) => item.kind === 'test' && item.status === 'completed' && item.patchHash === candidateHash)) {
            throw new Error('Request trusted tests for this exact patch before primary evaluation.');
          }
          const evaluatedTrial = prior.findLast((item) => item.kind === 'evaluate_primary' && item.status === 'completed' && item.patchHash === candidateHash && canonicalHash(item.hypothesis) === canonicalHash(action.hypothesis));
          if (action.action === 'finalize' && !evaluatedTrial) {
            throw new Error('Finalize requires a completed primary evaluation of this exact patch and preregistered hypothesis. Test/evaluate revised patches first.');
          }
          this.database.updateVariant(variant.id, { status: 'building' });
          const built = await buildVariantImage(campaign, variant, worktree, directory, trustedPlanner);
          const imageId = (await runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', built.imageTag])).stdout.trim();
          await writeFile(path.join(directory, 'pins.json'), `${JSON.stringify({ hypothesis: action.hypothesis, candidateHash, treatmentHash: await sha256File(treatment.patchPath), contextHash, imageId, harness: { ...state.harnessPins, ...executionHarnessPins } }, null, 2)}\n`, { flag: 'wx' });
          let result: unknown;
          if (action.action === 'test' || action.action === 'finalize') {
            this.database.updateVariant(variant.id, { status: 'gating' });
            result = await runInvestigatorTests(campaign, built.testImageTag, directory, built.environment,
              action.action === 'test' ? action.testFiles : undefined);
          }
          if (action.action === 'evaluate_primary') {
            const target = this.database.getTargetExcludedConfig(campaign.id);
            const resolved = target?.protocol === 'standard-primary-v2'
              ? await this.resolveV2PrimaryBenchmark(campaign, primary, target.targetImplementationWorkflow, path.join(directory, 'questions'))
              : await resolveBenchmarkQuestions({ campaign, benchmark: primary, workflowsSource, sharedDirectory: path.join(campaignDirectory(this.paths, campaign.id), 'resolved-packs'), artifactDirectory: path.join(directory, 'questions') });
            let stack: StackHandle | null = null;
            try {
              stack = await startVariantStack(this.paths, campaign, variant, worktree, directory, built.imageTag, built.environment, trustedPlanner, `investigation-${record.id}`);
              this.database.updateVariant(variant.id, { status: 'running', composeProject: stack.composeProject, baseUrl: stack.baseUrl });
              const runs = await this.runBenchmarkReplicates(campaign, variant, stack, resolved.benchmark,
                stack.environment.PLANNER_EVAL_API_TOKEN || stack.environment.PLANNER_API_TOKEN,
                { replicateCount: limits.primaryReplicates ?? 1,
                  ...(target ? { answerSourceTargetWorkflow: target.targetImplementationWorkflow } : {}) });
              const score = computeReplicateMeanScore(runs.replicates, reference.labels, null);
              score.cohortMismatches = [...new Set([...score.cohortMismatches, ...compareCohort(reference.baseline.facts!, runs.facts)])];
              result = {
                score, baselineScore: computeReplicateMeanScore(reference.baseline.replicateFacts!, reference.labels, null),
                facts: runs.facts, replicateFacts: runs.replicates, labelSetHash: reference.labelSetHash,
                questions: runs.questions,
                comparisonNotes: ['Scores use frozen provisional labels and raw-replicate means.', 'Runtime answers and decision-set hashes can vary; this is a development trial, not fixed-evidence replay.'],
                transitions: runs.facts.units.filter((unit) => reference.baseline.facts?.units.find((before) => before.key === unit.key)?.decision !== unit.decision).map((unit) => ({
                  key: unit.key, before: reference.baseline.facts?.units.find((before) => before.key === unit.key)?.decision,
                  after: unit.decision, expected: reference.labels.find((label) => label.unitKey === unit.key)?.expectedDecision,
                  rationale: unit.rationale, sourceRefs: unit.sourceRefs,
                })),
              };
            } finally {
              if (stack) {
                let collected = false;
                try { await collectStackArtifacts(stack); collected = true; }
                finally { await stopVariantStack(stack, collected); }
              }
            }
          }
          if (action.action === 'finalize') {
            const finalContext = path.join(artifactDirectory, 'mutation-context.json');
            await writeFile(finalContext, `${JSON.stringify({
              kind: 'ainative-planner-eval/mutation-context', schemaVersion: 1,
              interpretationPolicy: 'Investigator-owned preregistration. Historical diagnosis is advisory, not a mandatory intervention.',
              parentVariantId: parent.id, explicitMissingParentOptOut: true, selectedFindings: [], citedEvidence: [],
              hypothesis: action.hypothesis,
              trustedTestResult: result,
              evaluatedTrial,
            }, null, 2)}\n`);
            const rootTreatment = await captureMutationDiff(campaign, variant, worktree, artifactDirectory, mutationBaselineTree);
            const rootCandidate = await captureAndGateDiff(campaign, variant, worktree, artifactDirectory);
            await this.runHypothesisCompliance(campaign, this.database.getVariant(variant.id), worktree, artifactDirectory,
              finalContext, rootTreatment.patchPath, rootCandidate.patchPath, await sha256File(finalContext), mutationBaselineTree);
            this.database.updateVariant(variant.id, { patchPath: rootCandidate.patchPath, patchHash: await sha256File(rootCandidate.patchPath) });
            result = { passed: true, tests: result, compliance: this.database.getVariant(variant.id).hypothesisCompliance };
          }
          const returned = { patchHash: candidateHash, artifactDirectory: relativeDirectory, result };
          await writeFile(path.join(directory, 'receipt.json'), `${JSON.stringify(returned, null, 2)}\n`, { flag: 'wx' });
          return returned;
        } catch (error) {
          await writeFile(path.join(directory, 'failure.json'), `${JSON.stringify({ patchHash: candidateHash, error: errorMessage(error) }, null, 2)}\n`, { flag: 'wx' });
          record.patchHash = candidateHash;
          record.artifactDirectory = relativeDirectory;
          throw new Error(`${errorMessage(error)}\nArtifacts: ${relativeDirectory}`);
        }
      },
    });
    return this.database.updateVariant(initialVariant.id, {
      investigation: completed,
      status: completed.status === 'finalized' ? 'gating' : completed.status === 'stopped' ? 'mutating' : 'rejected',
      error: completed.reason,
    });
  }

  private async runVariant(
    campaign: CampaignRecord,
    initialVariant: VariantRecord,
    mutate: boolean,
  ): Promise<VariantRecord> {
    if (initialVariant.hypothesisComplianceAttempts.length > 0) {
      throw new Error('cannot restart an existing hypothesis compliance attempt loop');
    }
    const variantStartedAtMs = Date.now();
    let variant = this.database.updateVariant(initialVariant.id, {
      startedAt: new Date(variantStartedAtMs).toISOString(),
      completedAt: null,
      elapsedMs: null,
      phase2StartedAt: null,
      phase2CompletedAt: null,
      phase2ElapsedMs: null,
    });
    let stack: StackHandle | null = null;
    let artifactDirectory = '';
    let mutationContextPath: string | null = null;
    let mutationContextSha256: string | null = null;
    let mutationBaselineTree: string | null = null;
    let automaticV2Config: TargetExcludedConfig | null = null;
    let standardCohortsComplete = false;
    try {
      artifactDirectory = await ensureVariantArtifactDirectory(
        this.paths,
        campaign.id,
        variant.id,
      );
      variant = this.database.updateVariant(variant.id, { status: mutate ? 'mutating' : 'gating' });
      const parentVariant = variant.parentVariantId
        ? this.database.getVariant(variant.parentVariantId)
        : null;
      const parentPatch = parentVariant?.patchPath ?? null;
      let parentPatchHash = parentVariant?.patchHash ?? null;
      if (parentVariant && parentPatch && !parentPatchHash) {
        parentPatchHash = await sha256File(parentPatch);
        this.database.updateVariant(parentVariant.id, { patchHash: parentPatchHash });
        this.database.addEvent(campaign.id, parentVariant.id, 'variant.legacy_patch_bound', {
          patchHash: parentPatchHash,
        });
      }
      const worktree = campaign.config.investigator?.enabled && variant.investigation && variant.worktreePath
        ? variant.worktreePath
        : await prepareVariantWorktree(
        this.paths,
        campaign,
        variant,
        parentPatch,
        parentPatchHash,
      );
      variant = this.database.updateVariant(variant.id, { worktreePath: worktree });
      if (mutate && campaign.config.investigator?.enabled) {
        const recordedIndex = variant.investigation?.harnessPins?.mutationBaselineTree;
        mutationBaselineTree = typeof recordedIndex === 'string' ? recordedIndex : await stageMutationBaseline(worktree);
        variant = await this.runInvestigatorCandidate(campaign, variant, worktree, artifactDirectory, mutationBaselineTree);
        if (variant.investigation?.status !== 'finalized') return variant;
      }
      if (mutate && !campaign.config.investigator?.enabled) {
        mutationBaselineTree = await stageMutationBaseline(worktree);
        const parent = variant.parentVariantId
          ? this.database.getVariant(variant.parentVariantId)
          : null;
        if (!parent) throw new Error('mutation parent is unavailable');
        if (parent.diagnosisInputHash && parent.diagnosisStatus === 'completed') {
          const parentInput = await readDiagnosisInput(
            variantArtifactDirectory(this.paths, campaign.id, parent.id),
            parent.diagnosisInputHash,
          );
          mutationContextPath = await writeMutationContext(
            artifactDirectory,
            parent,
            parentInput,
            variant.hypothesis.findingIds,
          );
        } else if (campaign.config.diagnosis.allowMissingParent) {
          mutationContextPath = path.join(artifactDirectory, 'mutation-context.json');
          const optOutContext = `${JSON.stringify(
            {
              kind: 'ainative-planner-eval/mutation-context',
              schemaVersion: 1,
              interpretationPolicy:
                'The campaign explicitly opted out of a current-parent diagnosis. No diagnosis finding is available or implied; measured facts and labels remain separate.',
              parentVariantId: parent.id,
              explicitMissingParentOptOut: true,
              selectedFindings: [],
              citedEvidence: [],
            },
            null,
            2,
          )}\n`;
          const existing = await readFile(mutationContextPath, 'utf8').catch(() => null);
          if (existing !== null && existing !== optOutContext) {
            throw new Error('immutable mutation opt-out context changed');
          }
          if (existing === null) {
            await writeFile(mutationContextPath, optOutContext, { flag: 'wx', mode: 0o600 });
          }
        } else {
          throw new Error('mutation parent has no completed diagnosis input');
        }
        mutationContextSha256 = await sha256File(mutationContextPath);
        await new AgentRunner(campaign).mutate(
          variant,
          worktree,
          artifactDirectory,
          mutationContextPath,
        );
        variant = this.database.updateVariant(variant.id, { status: 'gating' });
      }
      if (mutate && !campaign.config.investigator?.enabled) {
        if (!mutationContextPath) throw new Error('mutation context is unavailable for compliance');
        if (!mutationContextSha256) throw new Error('mutation context hash is unavailable for compliance');
        variant = await this.runMutationComplianceAttempts(
          campaign,
          variant,
          worktree,
          artifactDirectory,
          mutationContextPath,
          mutationContextSha256,
          mutationBaselineTree!,
        );
      } else {
        const { patchPath } = await captureAndGateDiff(
          campaign,
          variant,
          worktree,
          artifactDirectory,
        );
        variant = this.database.updateVariant(variant.id, {
          patchPath,
          patchHash: await sha256File(patchPath),
        });
      }

      const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
      let targetConfig = this.database.getTargetExcludedConfig(campaign.id);
      let protocolPlan = targetExcludedProtocolPlan(campaign, targetConfig);
      const resolvedBenchmarks: Benchmark[] = [];
      const questionResolutions: NonNullable<VariantRecord['questionResolutions']> = {};
      for (const benchmark of campaign.config.benchmarks) {
        const resolved =
          benchmark.role === 'primary' && protocolPlan?.targetSafePrimary
            ? await this.resolveV2PrimaryBenchmark(
                campaign,
                benchmark,
                protocolPlan.targetImplementationWorkflow,
                path.join(artifactDirectory, benchmark.name, 'questions'),
              )
            : await resolveBenchmarkQuestions({
                campaign,
                benchmark,
                workflowsSource,
                sharedDirectory: path.join(campaignDirectory(this.paths, campaign.id), 'resolved-packs'),
                artifactDirectory: path.join(artifactDirectory, benchmark.name, 'questions'),
              });
        resolvedBenchmarks.push(resolved.benchmark);
        questionResolutions[benchmark.name] = resolved.summary;
      }
      const standardPrimary = resolvedBenchmarks.find((benchmark) => benchmark.role === 'primary');
      if (!standardPrimary) throw new Error('resolved benchmark set omitted the primary pack');
      const targetPair = targetConfig?.protocol === 'dedicated-control-v1'
        ? await this.resolveTargetPairBenchmark(
            campaign,
            primaryBenchmark(campaign),
            targetConfig,
            path.join(artifactDirectory, 'target-excluded', 'pack-questions'),
          )
        : null;
      variant = this.database.updateVariant(variant.id, { questionResolutions });

      variant = this.database.updateVariant(variant.id, { status: 'building' });
      const trustedPlanner = await this.ensureFrozenPlannerSource(campaign);
      const built = await buildVariantImage(
        campaign,
        variant,
        worktree,
        artifactDirectory,
        trustedPlanner,
      );
      variant = this.database.updateVariant(variant.id, { imageTag: built.imageTag, status: 'gating' });
      if (variant.round === 0 && protocolPlan?.protocol === 'standard-primary-v2') {
        targetConfig = await this.prepareAutomaticV2Config(
          campaign,
          variant,
          built.testImageTag,
          questionResolutions[standardPrimary.name]!,
        );
        automaticV2Config = targetConfig;
        protocolPlan = targetExcludedProtocolPlan(campaign, targetConfig);
      }
      if (protocolPlan?.protocol === 'standard-primary-v2' && !targetConfig) {
        throw new Error('V2 target-excluded config was not established by the campaign baseline');
      }
      if (
        targetConfig?.protocol === 'standard-primary-v2' &&
        (standardPrimary.sha256 !== targetConfig.primaryResolvedArtifactSha ||
          questionResolutions[standardPrimary.name]?.resolvedArtifactSha !==
            targetConfig.primaryResolvedArtifactSha)
      ) {
        throw new Error('V2 standard primary differs from the campaign-frozen resolved artifact');
      }
      await runVariantGates(
        campaign,
        built.testImageTag,
        artifactDirectory,
        built.environment,
      );
      variant = this.database.updateVariant(variant.id, { status: 'starting' });
      stack = await startVariantStack(
        this.paths,
        campaign,
        variant,
        worktree,
        artifactDirectory,
        built.imageTag,
        built.environment,
        trustedPlanner,
      );
      variant = this.database.updateVariant(variant.id, {
        composeProject: stack.composeProject,
        baseUrl: stack.baseUrl,
        status: 'running',
      });
      const environment = stack.environment;
      const token = environment.PLANNER_EVAL_API_TOKEN || environment.PLANNER_API_TOKEN;
      const primary = standardPrimary;
      if (targetConfig) {
        this.database.createTargetExcludedEvaluation(campaign.id, variant.id);
        this.database.updateTargetExcludedEvaluation(variant.id, {
          status: 'running',
          startedAt: new Date().toISOString(),
          completedAt: null,
          artifactCollectionComplete: false,
          error: null,
        });
      }
      const phase2StartedAtMs = Date.now();
      variant = this.database.updateVariant(variant.id, {
        phase2StartedAt: new Date(phase2StartedAtMs).toISOString(),
        phase2CompletedAt: null,
        phase2ElapsedMs: null,
      });
      let primaryRuns: {
        facts: RunFacts;
        replicates: RunFacts[];
        questions: Phase2QuestionAudit[];
      } | null = null;
      const holdoutFacts: Record<string, RunFacts> = {};
      const holdoutReplicateFacts: Record<string, RunFacts[]> = {};
      let targetControlRuns: Awaited<ReturnType<CampaignOrchestrator['runBenchmarkReplicates']>> | null = null;
      let targetExcludedRuns: Awaited<ReturnType<CampaignOrchestrator['runBenchmarkReplicates']>> | null = null;
      let targetComparisons: Awaited<ReturnType<typeof runTargetExcludedComparison>>[] = [];
      try {
        if (targetConfig?.protocol === 'standard-primary-v2') {
          const v2Config = targetConfig;
          const holdouts = resolvedBenchmarks.filter((item) => item.role === 'holdout');
          const sharedAnswerCache: RuntimeAnswerCache = new Map();
          const standardPromises = [
            this.runBenchmarkReplicates(campaign, variant, stack, primary, token, {
              replicateCount: v2Config.replicates,
              answerSourceTargetWorkflow: v2Config.targetImplementationWorkflow,
              answerCache: sharedAnswerCache,
            }),
            ...holdouts.map((benchmark) =>
              this.runBenchmarkReplicates(campaign, variant, stack!, benchmark, token, {
                replicateCount: v2Config.replicates,
              }),
            ),
          ];
          const excludedSettled = Promise.allSettled([
            this.runBenchmarkReplicates(campaign, variant, stack, primary, token, {
              replicateCount: v2Config.replicates,
              scope: 'target-excluded/excluded',
              executionScope: 'excluded',
              answerSourceTargetWorkflow: v2Config.targetImplementationWorkflow,
              excludedTargetWorkflow: v2Config.targetImplementationWorkflow,
              answerCache: sharedAnswerCache,
              persistToTargetEvaluation: true,
            }),
          ]);
          const standardOutcomes = await Promise.allSettled(standardPromises);
          const standard = this.persistV2StandardOutcomes(
            variant.id,
            primary,
            holdouts,
            questionResolutions,
            standardOutcomes,
          );
          primaryRuns = standard.primaryRuns;
          Object.assign(holdoutFacts, standard.holdoutFacts);
          Object.assign(holdoutReplicateFacts, standard.holdoutReplicateFacts);
          standardCohortsComplete =
            standard.failures.length === 0 &&
            primaryRuns !== null &&
            holdouts.every(({ name }) => Boolean(holdoutFacts[name]));
          const excludedOutcome = (await excludedSettled)[0]!;
          let normalArmBinding: TargetNormalArmBinding | null = null;
          if (primaryRuns) {
            normalArmBinding = this.buildTargetNormalArmBinding(
              variant.id,
              primary,
              v2Config.primaryResolvedArtifactSha,
            );
            this.database.updateTargetExcludedEvaluation(variant.id, {
              controlFacts: null,
              controlReplicateFacts: null,
              holdoutFacts: null,
              holdoutReplicateFacts: null,
              normalArmBinding,
            });
          }
          if (excludedOutcome.status === 'fulfilled') {
            targetExcludedRuns = excludedOutcome.value;
            try {
              if (!normalArmBinding) {
                throw new Error('standard primary did not produce a normal-arm binding');
              }
              const comparisonDirectory = path.join(
                artifactDirectory,
                'target-excluded',
                'comparisons',
              );
              await mkdir(comparisonDirectory, { recursive: true });
              targetComparisons = await Promise.all(
                Array.from({ length: v2Config.replicates }, (_, index) => {
                  const replicate = index + 1;
                  const directories = targetExcludedComparisonDirectories(
                    artifactDirectory,
                    primary.name,
                    replicate,
                    v2Config.protocol,
                  );
                  return runTargetExcludedComparison({
                    ...directories,
                    outputPath: path.join(comparisonDirectory, `replicate-${replicate}.json`),
                    imageTag: v2Config.comparatorImage,
                    replicate,
                  });
                }),
              );
              this.database.updateTargetExcludedEvaluation(variant.id, {
                controlFacts: null,
                controlReplicateFacts: null,
                holdoutFacts: null,
                holdoutReplicateFacts: null,
                excludedFacts: targetExcludedRuns.facts,
                excludedReplicateFacts: targetExcludedRuns.replicates,
                questionResolution: withRuntimeQuestions(
                  targetSafeQuestionResolution(
                    questionResolutions[primary.name]!,
                    v2Config.targetImplementationWorkflow,
                  ),
                  targetExcludedRuns.questions,
                  'excluded',
                ),
                comparisons: targetComparisons,
                normalArmBinding,
                status: 'judging',
              });
            } catch (error) {
              targetExcludedRuns = null;
              targetComparisons = [];
              this.database.updateTargetExcludedEvaluation(variant.id, {
                status: 'failed',
                error: errorMessage(error).slice(0, 20_000),
              });
            }
          } else {
            this.database.updateTargetExcludedEvaluation(variant.id, {
              status: 'failed',
              error: errorMessage(excludedOutcome.reason).slice(0, 20_000),
            });
          }
          if (standard.failures.length > 0) {
            const failure = standard.failures[0];
            this.database.updateTargetExcludedEvaluation(variant.id, {
              status: 'failed',
              error: `standard evaluation failed: ${errorMessage(failure)}`.slice(0, 20_000),
            });
            throw failure;
          }
        } else {
          primaryRuns = await this.runBenchmarkReplicates(
            campaign,
            variant,
            stack,
            primary,
            token,
            targetConfig ? { replicateCount: targetConfig.replicates } : {},
          );
          questionResolutions[primary.name] = withRuntimeQuestions(
            questionResolutions[primary.name]!,
            primaryRuns.questions,
          );
          for (const benchmark of resolvedBenchmarks.filter((item) => item.role === 'holdout')) {
            const holdout = await this.runBenchmarkReplicates(
              campaign,
              variant,
              stack,
              benchmark,
              token,
              targetConfig ? { replicateCount: targetConfig.replicates } : {},
            );
            holdoutFacts[benchmark.name] = holdout.facts;
            holdoutReplicateFacts[benchmark.name] = holdout.replicates;
            questionResolutions[benchmark.name] = withRuntimeQuestions(
              questionResolutions[benchmark.name]!,
              holdout.questions,
            );
          }
          if (targetConfig && targetPair) {
            try {
              targetControlRuns = await this.runBenchmarkReplicates(
                campaign,
                variant,
                stack,
                targetPair.benchmark,
                token,
                {
                  replicateCount: targetConfig.replicates,
                  scope: 'target-excluded/control',
                  executionScope: 'control',
                  persistToTargetEvaluation: true,
                },
              );
              targetExcludedRuns = await this.runBenchmarkReplicates(
                campaign,
                variant,
                stack,
                targetPair.benchmark,
                token,
                {
                  replicateCount: targetConfig.replicates,
                  scope: 'target-excluded/excluded',
                  executionScope: 'excluded',
                  answerSourceTargetWorkflow: targetConfig.targetImplementationWorkflow,
                  excludedTargetWorkflow: targetConfig.targetImplementationWorkflow,
                  persistToTargetEvaluation: true,
                },
              );
              const comparisonDirectory = path.join(artifactDirectory, 'target-excluded', 'comparisons');
              await mkdir(comparisonDirectory, { recursive: true });
              targetComparisons = await Promise.all(
                Array.from({ length: targetConfig.replicates }, (_, index) => {
                  const replicate = index + 1;
                  const directories = targetExcludedComparisonDirectories(
                    artifactDirectory,
                    targetPair.benchmark.name,
                    replicate,
                    targetConfig.protocol,
                  );
                  return runTargetExcludedComparison({
                    ...directories,
                    outputPath: path.join(comparisonDirectory, `replicate-${replicate}.json`),
                    imageTag: targetConfig.comparatorImage,
                    replicate,
                  });
                }),
              );
              this.database.updateTargetExcludedEvaluation(variant.id, {
                controlFacts: targetControlRuns.facts,
                controlReplicateFacts: targetControlRuns.replicates,
                holdoutFacts,
                holdoutReplicateFacts,
                excludedFacts: targetExcludedRuns.facts,
                excludedReplicateFacts: targetExcludedRuns.replicates,
                questionResolution: withRuntimeQuestions(
                  withRuntimeQuestions(targetPair.summary, targetControlRuns.questions, 'control'),
                  targetExcludedRuns.questions,
                  'excluded',
                ),
                comparisons: targetComparisons,
                status: 'judging',
              });
            } catch (error) {
              targetControlRuns = null;
              targetExcludedRuns = null;
              targetComparisons = [];
              this.database.updateTargetExcludedEvaluation(variant.id, {
                status: 'failed',
                error: errorMessage(error).slice(0, 20_000),
              });
            }
          }
        }
      } finally {
        const phase2CompletedAtMs = Date.now();
        variant = this.database.updateVariant(variant.id, {
          phase2CompletedAt: new Date(phase2CompletedAtMs).toISOString(),
          phase2ElapsedMs: phase2CompletedAtMs - phase2StartedAtMs,
        });
      }
      if (!primaryRuns) throw new Error('standard primary evaluation did not complete');
      const facts = primaryRuns.facts;
      variant = this.database.updateVariant(variant.id, { questionResolutions });

      variant = this.database.updateVariant(variant.id, { status: 'judging', facts });
      const primaryEvaluation = await this.judgeBenchmark(
        campaign,
        variant,
        primary,
        facts,
        workflowsSource,
        path.join(artifactDirectory, primary.name),
        primaryRuns.replicates,
      );
      const holdoutJudgments: Record<string, JudgeOutput> = {};
      const holdoutScores: Record<string, NonNullable<VariantRecord['score']>> = {};
      for (const benchmark of resolvedBenchmarks.filter((item) => item.role === 'holdout')) {
        const holdout = holdoutFacts[benchmark.name];
        if (!holdout) continue;
        const evaluation = await this.judgeBenchmark(
          campaign,
          variant,
          benchmark,
          holdout,
          workflowsSource,
          path.join(artifactDirectory, benchmark.name),
          holdoutReplicateFacts[benchmark.name],
        );
        holdoutJudgments[benchmark.name] = evaluation.judgment;
        holdoutScores[benchmark.name] = evaluation.score;
      }
      if (targetConfig && targetExcludedRuns) {
        try {
          const judged = await this.judgeTargetExcluded(
            campaign,
            variant,
            primary,
            targetExcludedRuns.facts,
            targetConfig,
            path.join(artifactDirectory, 'target-excluded', 'excluded', targetPair?.benchmark.name ?? primary.name),
            targetExcludedRuns.replicates,
          );
          const baselineEvaluation = this.database.getTargetExcludedEvaluation(
            targetConfig.baselineVariantId,
          );
          const baselineRuns = variant.id === targetConfig.baselineVariantId
            ? targetExcludedRuns.replicates
            : baselineEvaluation?.excludedReplicateFacts ?? [];
          const comparisonValid =
            targetComparisons.length === targetConfig.replicates &&
            targetComparisons.every((comparison) => comparison.valid);
          const leakageDetected =
            targetComparisons.some((comparison) => comparison.leakagePaths.length > 0) ||
            containsTargetIdentityLeak(judged.judgment, targetConfig.targetImplementationWorkflow) ||
            (targetConfig.protocol === 'standard-primary-v2' &&
              containsTargetIdentityLeak(
                this.database.getTargetExcludedEvaluation(variant.id)?.questionResolution,
                targetConfig.targetImplementationWorkflow,
              ));
          const gate = computeTargetExcludedGate(
            baselineRuns,
            targetExcludedRuns.replicates,
            comparisonValid,
            leakageDetected,
            targetConfig.warningBuildDropRatio,
            targetConfig.blockBuildDropRatio,
          );
          this.database.updateTargetExcludedEvaluation(variant.id, {
            status: 'completed',
            judgment: judged.judgment,
            score: judged.score,
            gate,
            error: null,
            completedAt: new Date().toISOString(),
          });
        } catch (error) {
          this.database.updateTargetExcludedEvaluation(variant.id, {
            status: 'failed',
            error: errorMessage(error).slice(0, 20_000),
          });
        }
      }
      variant = this.database.updateVariant(variant.id, {
        facts,
        replicateFacts: primaryRuns.replicates,
        holdoutFacts: Object.keys(holdoutFacts).length > 0 ? holdoutFacts : null,
        holdoutReplicateFacts:
          Object.keys(holdoutReplicateFacts).length > 0 ? holdoutReplicateFacts : null,
        holdoutJudgments: Object.keys(holdoutJudgments).length > 0 ? holdoutJudgments : null,
        holdoutScores: Object.keys(holdoutScores).length > 0 ? holdoutScores : null,
        judgment: primaryEvaluation.judgment,
        score: primaryEvaluation.score,
        status: 'review',
        error: null,
      });
    } catch (error) {
      variant = this.database.updateVariant(variant.id, {
        status: 'failed',
        error: errorMessage(error).slice(0, 20_000),
      });
      const targetEvaluation = this.database.getTargetExcludedEvaluation(variant.id);
      if (targetEvaluation && !['completed', 'failed'].includes(targetEvaluation.status)) {
        this.database.updateTargetExcludedEvaluation(variant.id, {
          status: 'failed',
          error: `standard evaluation failed before target-excluded completion: ${errorMessage(error)}`.slice(
            0,
            20_000,
          ),
        });
      }
    } finally {
      if (stack) {
        let collectionComplete = true;
        try {
          await collectStackArtifacts(stack);
        } catch (error) {
          collectionComplete = false;
          this.database.addEvent(campaign.id, variant.id, 'artifacts.collection_failed', {
            error: errorMessage(error),
          });
        }
        try {
          await stopVariantStack(stack, collectionComplete);
        } catch (error) {
          collectionComplete = false;
          this.database.addEvent(campaign.id, variant.id, 'stack.teardown_failed', {
            error: errorMessage(error),
          });
        }
        variant = this.database.updateVariant(variant.id, {
          artifactCollectionComplete: collectionComplete,
          ...(collectionComplete
            ? {}
            : {
                status: 'failed',
                error: variant.error ?? 'required stack artifacts were not completely archived',
              }),
        });
        const targetEvaluation = this.database.getTargetExcludedEvaluation(variant.id);
        if (targetEvaluation) {
          this.database.updateTargetExcludedEvaluation(variant.id, {
            artifactCollectionComplete: collectionComplete,
            ...(!collectionComplete && targetEvaluation.status === 'completed'
              ? {
                  status: 'failed',
                  error: 'required target-excluded artifacts were not completely archived',
                }
              : {}),
          });
        }
      }
      variant = this.database.getVariant(variant.id);
      if (
        automaticV2Config &&
        standardCohortsComplete &&
        variant.artifactCollectionComplete
      ) {
        try {
          await this.persistAutomaticV2Config(campaign, automaticV2Config);
        } catch (error) {
          variant = this.database.updateVariant(variant.id, {
            status: 'failed',
            error: `V2 config persistence failed: ${errorMessage(error)}`.slice(0, 20_000),
          });
          const targetEvaluation = this.database.getTargetExcludedEvaluation(variant.id);
          if (targetEvaluation) {
            this.database.updateTargetExcludedEvaluation(variant.id, {
              status: 'failed',
              error: `V2 config persistence failed: ${errorMessage(error)}`.slice(0, 20_000),
            });
          }
        }
      }
      if (artifactDirectory && variant.facts && variant.judgment) {
        await this.runDiagnosis(campaign, variant, artifactDirectory);
        variant = this.database.getVariant(variant.id);
      }
      const variantCompletedAtMs = Date.now();
      variant = this.database.updateVariant(variant.id, {
        completedAt: new Date(variantCompletedAtMs).toISOString(),
        elapsedMs: variantCompletedAtMs - variantStartedAtMs,
      });
      await this.refreshReports(campaign.id);
    }
    return variant;
  }

  private async runHypothesisCompliance(
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
      assess?: AgentRunner['assessHypothesisCompliance'];
      captureMutation?: typeof captureMutationDiff;
      captureDiff?: typeof captureAndGateDiff;
      allowSemanticFailure?: boolean;
    } = {},
  ): Promise<VariantRecord> {
    const expectedResultSha256 = variant.hypothesisComplianceResultHash;
    const expectedCandidatePatchSha256 = variant.hypothesisComplianceCandidatePatchHash;
    const [
      patchSha256,
      cumulativePatchSha256,
      mutationContextSha256,
      treatmentDetails,
    ] = await Promise.all([
      sha256File(treatmentPatchPath),
      sha256File(cumulativePatchPath),
      sha256File(mutationContextPath),
      stat(treatmentPatchPath),
    ]);
    this.database.updateVariant(variant.id, {
      hypothesisComplianceStatus: 'running',
      hypothesisCompliancePatchHash: patchSha256,
      hypothesisComplianceCandidatePatchHash: cumulativePatchSha256,
      hypothesisComplianceResultHash: null,
      hypothesisCompliance: null,
      hypothesisComplianceError: null,
    });
    this.database.addEvent(campaign.id, variant.id, 'hypothesis_compliance.running', {
      patchSha256,
      cumulativePatchSha256,
      mutationContextSha256,
    });
    const failBeforeAssessment = (message: string): never => {
      this.database.updateVariant(variant.id, {
        hypothesisComplianceStatus: 'failed',
        hypothesisCompliancePatchHash: patchSha256,
        hypothesisComplianceCandidatePatchHash: cumulativePatchSha256,
        hypothesisComplianceResultHash: null,
        hypothesisCompliance: null,
        hypothesisComplianceError: message,
      });
      this.database.addEvent(campaign.id, variant.id, 'hypothesis_compliance.failed', {
        patchSha256,
        cumulativePatchSha256,
        mutationContextSha256,
        error: message,
      });
      throw new Error(message);
    };
    if (mutationContextSha256 !== expectedMutationContextSha256) {
      failBeforeAssessment('mutator modified the immutable mutation context');
    }
    const falsificationRequired = await mutationContextRequiresFalsification(
      mutationContextPath,
    ).catch((error) =>
      failBeforeAssessment(`mutation context is invalid: ${errorMessage(error)}`),
    );
    if (treatmentDetails.size === 0) {
      failBeforeAssessment('mutator produced no changes beyond the inherited parent');
    }
    if (
      expectedResultSha256 &&
      (variant.hypothesisCompliancePatchHash !== patchSha256 ||
        expectedCandidatePatchSha256 !== cumulativePatchSha256 ||
        variant.hypothesisCompliance?.mutationContextSha256 !== mutationContextSha256)
    ) {
      failBeforeAssessment('persisted hypothesis compliance result is stale for this mutation');
    }
    let assessmentPersisted = false;
    try {
      const runner = new AgentRunner(campaign);
      const assess = dependencies.assess ?? runner.assessHypothesisCompliance.bind(runner);
      const assessment = await assess(
        variant,
        treatmentPatchPath,
        mutationContextPath,
        artifactDirectory,
        worktree,
        expectedResultSha256,
      );
      const recapturedMutation = await (dependencies.captureMutation ?? captureMutationDiff)(
        campaign,
        variant,
        worktree,
        artifactDirectory,
        expectedIndexTree,
      );
      const recaptured = await (dependencies.captureDiff ?? captureAndGateDiff)(
        campaign,
        variant,
        worktree,
        artifactDirectory,
      );
      if (
        (await sha256File(recapturedMutation.patchPath)) !== patchSha256 ||
        (await sha256File(recaptured.patchPath)) !== cumulativePatchSha256 ||
        (await sha256File(mutationContextPath)) !== mutationContextSha256
      ) {
        throw new Error('hypothesis compliance reviewer modified its immutable inputs');
      }
      const resultSha256 = await sha256File(assessment.resultPath);
      const verified = await verifyHypothesisComplianceResult(
        assessment.resultPath,
        variant.id,
        patchSha256,
        mutationContextSha256,
        resultSha256,
        falsificationRequired,
      );
      if (!isDeepStrictEqual(verified, assessment.result)) {
        throw new Error('hypothesis compliance result differs from its immutable artifact');
      }
      const persisted = this.database.updateVariant(variant.id, {
        hypothesisComplianceStatus: verified.status,
        hypothesisCompliancePatchHash: patchSha256,
        hypothesisComplianceCandidatePatchHash: cumulativePatchSha256,
        hypothesisComplianceResultHash: resultSha256,
        hypothesisCompliance: verified,
        hypothesisComplianceError: null,
      });
      assessmentPersisted = true;
      this.database.addEvent(
        campaign.id,
        variant.id,
        `hypothesis_compliance.${verified.status}`,
        {
          patchSha256,
          cumulativePatchSha256,
          mutationContextSha256,
          resultSha256,
          intervention: verified.intervention.status,
          codeRegression:
            'codeRegression' in verified ? verified.codeRegression.status : 'legacy_not_recorded',
          falsificationTest: verified.falsificationTest.status,
        },
      );
      if (verified.status === 'failed' && !dependencies.allowSemanticFailure) {
        throw new Error(`hypothesis compliance failed: ${verified.summary}`);
      }
      return persisted;
    } catch (error) {
      if (!assessmentPersisted) {
        const message = errorMessage(error).slice(0, 20_000);
        this.database.updateVariant(variant.id, {
          hypothesisComplianceStatus: 'failed',
          hypothesisCompliancePatchHash: patchSha256,
          hypothesisComplianceCandidatePatchHash: cumulativePatchSha256,
          hypothesisComplianceResultHash: null,
          hypothesisCompliance: null,
          hypothesisComplianceError: message,
        });
        this.database.addEvent(campaign.id, variant.id, 'hypothesis_compliance.failed', {
          patchSha256,
          cumulativePatchSha256,
          mutationContextSha256,
          error: message,
        });
      }
      throw error;
    }
  }

  private async runMutationComplianceAttempts(
    campaign: CampaignRecord,
    initialVariant: VariantRecord,
    worktree: string,
    artifactDirectory: string,
    mutationContextPath: string,
    mutationContextSha256: string,
    mutationBaselineTree: string,
    dependencies: {
      assess?: AgentRunner['assessHypothesisCompliance'];
      repair?: AgentRunner['repairHypothesisCompliance'];
      captureMutation?: typeof captureMutationDiff;
      captureDiff?: typeof captureAndGateDiff;
    } = {},
  ): Promise<VariantRecord> {
    const maximumAttempts = 1 + campaign.config.limits.hypothesisComplianceRepairAttempts;
    let variant = initialVariant;
    let previousTreatmentSha256: string | null = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const startedAt = new Date().toISOString();
      let mutationDiff: Awaited<ReturnType<typeof captureMutationDiff>> | null = null;
      let cumulativeDiff: Awaited<ReturnType<typeof captureAndGateDiff>>;
      try {
        mutationDiff = await (dependencies.captureMutation ?? captureMutationDiff)(
          campaign,
          variant,
          worktree,
          artifactDirectory,
          mutationBaselineTree,
        );
        await rm(path.join(artifactDirectory, 'variant.patch'), { force: true });
        cumulativeDiff = await (dependencies.captureDiff ?? captureAndGateDiff)(
          campaign,
          variant,
          worktree,
          artifactDirectory,
        );
      } catch (error) {
        const message = errorMessage(error).slice(0, 20_000);
        const candidatePatchPath = path.join(artifactDirectory, 'variant.patch');
        const candidateAvailable = (await stat(candidatePatchPath).catch(() => null))?.isFile() ?? false;
        const partial = mutationDiff
          ? await archivePartialHypothesisComplianceAttemptInputs(
              artifactDirectory,
              attempt,
              mutationDiff.patchPath,
              candidateAvailable ? candidatePatchPath : null,
              mutationContextPath,
            )
          : await archivePartialHypothesisComplianceAttemptInputs(
              artifactDirectory,
              attempt,
              null,
              null,
              mutationContextPath,
            );
        this.database.appendHypothesisComplianceAttempt(variant.id, {
          variantId: variant.id,
          attempt,
          phase: attempt === 1 ? 'initial' : 'repair',
          outcome: 'operational_failed',
          treatmentPatchSha256: partial?.treatmentPatchSha256 ?? null,
          candidatePatchSha256: partial.candidatePatchSha256,
          mutationContextSha256: partial.mutationContextSha256,
          resultSha256: null,
          result: null,
          error: message,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        this.database.updateVariant(variant.id, {
          hypothesisComplianceStatus: 'failed',
          hypothesisComplianceError: message,
          patchPath: partial.candidatePatchPath,
          patchHash: partial.candidatePatchSha256,
        });
        throw error;
      }
      const patchHash = await sha256File(cumulativeDiff.patchPath);
      variant = this.database.updateVariant(variant.id, {
        patchPath: cumulativeDiff.patchPath,
        patchHash,
      });
      const archived = await archiveHypothesisComplianceAttemptInputs(
        artifactDirectory,
        attempt,
        mutationDiff.patchPath,
        cumulativeDiff.patchPath,
        mutationContextPath,
      );
      if (archived.mutationContextSha256 !== mutationContextSha256) {
        const message = 'mutator modified the immutable mutation context';
        this.database.appendHypothesisComplianceAttempt(variant.id, {
          variantId: variant.id,
          attempt,
          phase: attempt === 1 ? 'initial' : 'repair',
          outcome: 'operational_failed',
          treatmentPatchSha256: archived.treatmentPatchSha256,
          candidatePatchSha256: archived.candidatePatchSha256,
          mutationContextSha256: archived.mutationContextSha256,
          resultSha256: null,
          result: null,
          error: message,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        this.database.updateVariant(variant.id, {
          hypothesisComplianceStatus: 'failed',
          hypothesisCompliancePatchHash: null,
          hypothesisComplianceCandidatePatchHash: null,
          hypothesisComplianceResultHash: null,
          hypothesisCompliance: null,
          hypothesisComplianceError: message,
        });
        throw new Error(message);
      }
      const unchangedRepair =
        attempt > 1 && archived.treatmentPatchSha256 === previousTreatmentSha256;
      const noOp = (await stat(archived.treatmentPatchPath)).size === 0 || unchangedRepair;
      if (noOp) {
        const message = unchangedRepair
          ? 'compliance repair produced no patch change'
          : 'mutator produced no changes beyond the inherited parent';
        this.database.appendHypothesisComplianceAttempt(variant.id, {
          variantId: variant.id,
          attempt,
          phase: attempt === 1 ? 'initial' : 'repair',
          outcome: 'no_op',
          treatmentPatchSha256: archived.treatmentPatchSha256,
          candidatePatchSha256: archived.candidatePatchSha256,
          mutationContextSha256: archived.mutationContextSha256,
          resultSha256: null,
          result: null,
          error: message,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        if (attempt === maximumAttempts) {
          this.database.updateVariant(variant.id, {
            hypothesisComplianceStatus: 'failed',
            hypothesisCompliancePatchHash: archived.treatmentPatchSha256,
            hypothesisComplianceCandidatePatchHash: archived.candidatePatchSha256,
            hypothesisComplianceResultHash: null,
            hypothesisCompliance: null,
            hypothesisComplianceError: message,
          });
          throw new Error(message);
        }
        const feedbackPath = path.join(archived.directory, 'repair-feedback.json');
        await writeFile(
          feedbackPath,
          `${JSON.stringify({
            kind: 'ainative-planner-eval/hypothesis-compliance-repair-feedback',
            schemaVersion: 1,
            outcome: 'no_op',
            error: message,
          }, null, 2)}\n`,
          { flag: 'wx', mode: 0o600 },
        );
        previousTreatmentSha256 = archived.treatmentPatchSha256;
        variant = await this.repairHypothesisComplianceAttempt(
          campaign,
          variant,
          worktree,
          artifactDirectory,
          archived.mutationContextPath,
          archived.treatmentPatchPath,
          feedbackPath,
          attempt + 1,
          dependencies.repair,
          mutationBaselineTree,
          dependencies.captureMutation,
        );
        continue;
      }
      let assessed: VariantRecord;
      try {
        assessed = await this.runHypothesisCompliance(
          campaign,
          variant,
          worktree,
          artifactDirectory,
          archived.mutationContextPath,
          archived.treatmentPatchPath,
          archived.candidatePatchPath,
          mutationContextSha256,
          mutationBaselineTree,
          {
            ...(dependencies.assess ? { assess: dependencies.assess } : {}),
            ...(dependencies.captureMutation
              ? { captureMutation: dependencies.captureMutation }
              : {}),
            ...(dependencies.captureDiff ? { captureDiff: dependencies.captureDiff } : {}),
            allowSemanticFailure: true,
          },
        );
      } catch (error) {
        const message = errorMessage(error).slice(0, 20_000);
        this.database.appendHypothesisComplianceAttempt(variant.id, {
          variantId: variant.id,
          attempt,
          phase: attempt === 1 ? 'initial' : 'repair',
          outcome: 'operational_failed',
          treatmentPatchSha256: archived.treatmentPatchSha256,
          candidatePatchSha256: archived.candidatePatchSha256,
          mutationContextSha256: archived.mutationContextSha256,
          resultSha256: null,
          result: null,
          error: message,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        throw error;
      }
      const result = assessed.hypothesisCompliance;
      if (!result || result.schemaVersion !== 2 || !assessed.hypothesisComplianceResultHash) {
        throw new Error('compliance attempt did not persist a V2 result');
      }
      this.database.appendHypothesisComplianceAttempt(variant.id, {
        variantId: variant.id,
        attempt,
        phase: attempt === 1 ? 'initial' : 'repair',
        outcome: result.status === 'passed' ? 'passed' : 'semantic_failed',
        treatmentPatchSha256: archived.treatmentPatchSha256,
        candidatePatchSha256: archived.candidatePatchSha256,
        mutationContextSha256: archived.mutationContextSha256,
        resultSha256: assessed.hypothesisComplianceResultHash,
        result,
        error: null,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      if (result.status === 'passed') return this.database.getVariant(variant.id);
      if (attempt === maximumAttempts) {
        throw new Error(`hypothesis compliance failed after repair exhaustion: ${result.summary}`);
      }
      const failedResultPath = hypothesisComplianceResultPath(
        artifactDirectory,
        archived.treatmentPatchSha256,
        archived.mutationContextSha256,
      );
      previousTreatmentSha256 = archived.treatmentPatchSha256;
      variant = await this.repairHypothesisComplianceAttempt(
        campaign,
        assessed,
        worktree,
        artifactDirectory,
        archived.mutationContextPath,
        archived.treatmentPatchPath,
        failedResultPath,
        attempt + 1,
        dependencies.repair,
        mutationBaselineTree,
        dependencies.captureMutation,
      );
    }
    throw new Error('hypothesis compliance attempt loop exhausted unexpectedly');
  }

  private async repairHypothesisComplianceAttempt(
    campaign: CampaignRecord,
    variant: VariantRecord,
    worktree: string,
    artifactDirectory: string,
    mutationContextPath: string,
    treatmentPatchPath: string,
    feedbackPath: string,
    attempt: number,
    repair?: AgentRunner['repairHypothesisCompliance'],
    mutationBaselineTree?: string,
    captureMutation?: typeof captureMutationDiff,
  ): Promise<VariantRecord> {
    this.database.updateVariant(variant.id, {
      status: 'mutating',
      hypothesisComplianceStatus: 'needs_revision',
      hypothesisCompliancePatchHash: null,
      hypothesisComplianceCandidatePatchHash: null,
      hypothesisComplianceResultHash: null,
      hypothesisCompliance: null,
      hypothesisComplianceError: null,
    });
    this.database.addEvent(campaign.id, variant.id, 'hypothesis_compliance.repairing', {
      attempt,
    });
    const runner = new AgentRunner(campaign);
    const action = repair ?? runner.repairHypothesisCompliance.bind(runner);
    try {
      await action(
        variant,
        worktree,
        artifactDirectory,
        mutationContextPath,
        treatmentPatchPath,
        feedbackPath,
        attempt,
      );
    } catch (error) {
      const message = errorMessage(error).slice(0, 20_000);
      let partial: Awaited<ReturnType<typeof archivePartialHypothesisComplianceAttemptInputs>>;
      try {
        const mutationDiff = await (captureMutation ?? captureMutationDiff)(
          campaign,
          variant,
          worktree,
          artifactDirectory,
          mutationBaselineTree!,
        );
        partial = await archivePartialHypothesisComplianceAttemptInputs(
          artifactDirectory,
          attempt,
          mutationDiff.patchPath,
          null,
          mutationContextPath,
        );
      } catch {
        partial = await archivePartialHypothesisComplianceAttemptInputs(
          artifactDirectory,
          attempt,
          null,
          null,
          mutationContextPath,
        );
      }
      this.database.appendHypothesisComplianceAttempt(variant.id, {
        variantId: variant.id,
        attempt,
        phase: 'repair',
        outcome: 'operational_failed',
        treatmentPatchSha256: partial.treatmentPatchSha256,
        candidatePatchSha256: null,
        mutationContextSha256: partial.mutationContextSha256,
        resultSha256: null,
        result: null,
        error: message,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      this.database.updateVariant(variant.id, {
        hypothesisComplianceStatus: 'failed',
        hypothesisCompliancePatchHash: null,
        hypothesisComplianceCandidatePatchHash: null,
        hypothesisComplianceResultHash: null,
        hypothesisCompliance: null,
        hypothesisComplianceError: message,
      });
      throw error;
    }
    return this.database.updateVariant(variant.id, {
      status: 'gating',
      hypothesisComplianceStatus: 'not_started',
      hypothesisCompliancePatchHash: null,
      hypothesisComplianceCandidatePatchHash: null,
      hypothesisComplianceResultHash: null,
      hypothesisCompliance: null,
      hypothesisComplianceError: null,
    });
  }

  private async verifyVariantHypothesisCompliance(
    campaign: CampaignRecord,
    variant: VariantRecord,
    allowLegacyParent = false,
  ): Promise<void> {
    if (variant.round === 0) return;
    if (allowLegacyParent && variant.hypothesisComplianceStatus === 'not_required') {
      this.database.addEvent(campaign.id, variant.id, 'hypothesis_compliance.legacy_parent', {});
      return;
    }
    if (
      variant.hypothesisComplianceStatus !== 'passed' ||
      !variant.hypothesisCompliance ||
      !variant.hypothesisCompliancePatchHash ||
      !variant.hypothesisComplianceCandidatePatchHash ||
      !variant.hypothesisComplianceResultHash ||
      !variant.patchPath ||
      !variant.patchHash
    ) {
      throw new Error('variant has no completed hypothesis compliance preflight');
    }
    const artifactDirectory = variantArtifactDirectory(this.paths, campaign.id, variant.id);
    for (const attempt of variant.hypothesisComplianceAttempts) {
      const attemptDirectory = hypothesisComplianceAttemptDirectory(
        artifactDirectory,
        attempt.attempt,
      );
      const contextPath = path.join(attemptDirectory, 'mutation-context.json');
      if ((await sha256File(contextPath)) !== attempt.mutationContextSha256) {
        throw new Error(`hypothesis compliance attempt ${attempt.attempt} context is stale`);
      }
      if (
        attempt.treatmentPatchSha256 &&
        (await sha256File(path.join(attemptDirectory, 'mutation.patch'))) !==
          attempt.treatmentPatchSha256
      ) {
        throw new Error(`hypothesis compliance attempt ${attempt.attempt} treatment is stale`);
      }
      if (
        attempt.candidatePatchSha256 &&
        (await sha256File(path.join(attemptDirectory, 'variant.patch'))) !==
          attempt.candidatePatchSha256
      ) {
        throw new Error(`hypothesis compliance attempt ${attempt.attempt} candidate is stale`);
      }
      if (attempt.result && attempt.resultSha256 && attempt.treatmentPatchSha256) {
        const resultPath = hypothesisComplianceResultPath(
          artifactDirectory,
          attempt.treatmentPatchSha256,
          attempt.mutationContextSha256,
        );
        const verifiedAttempt = await verifyHypothesisComplianceResult(
          resultPath,
          variant.id,
          attempt.treatmentPatchSha256,
          attempt.mutationContextSha256,
          attempt.resultSha256,
          await mutationContextRequiresFalsification(contextPath),
        );
        if (!isDeepStrictEqual(verifiedAttempt, attempt.result)) {
          throw new Error(`hypothesis compliance attempt ${attempt.attempt} result is stale`);
        }
      }
    }
    const finalAttempt = variant.hypothesisComplianceAttempts.at(-1) ?? null;
    if (
      finalAttempt &&
      (finalAttempt.outcome !== 'passed' ||
        finalAttempt.treatmentPatchSha256 !== variant.hypothesisCompliancePatchHash ||
        finalAttempt.candidatePatchSha256 !== variant.hypothesisComplianceCandidatePatchHash ||
        finalAttempt.resultSha256 !== variant.hypothesisComplianceResultHash ||
        !isDeepStrictEqual(finalAttempt.result, variant.hypothesisCompliance))
    ) {
      throw new Error('final hypothesis compliance attempt differs from the variant projection');
    }
    if (finalAttempt) {
      const attemptDirectory = hypothesisComplianceAttemptDirectory(
        artifactDirectory,
        finalAttempt.attempt,
      );
      const [attemptPatchSha256, attemptCandidateSha256, attemptContextSha256] =
        await Promise.all([
          sha256File(path.join(attemptDirectory, 'mutation.patch')),
          sha256File(path.join(attemptDirectory, 'variant.patch')),
          sha256File(path.join(attemptDirectory, 'mutation-context.json')),
        ]);
      if (
        attemptPatchSha256 !== finalAttempt.treatmentPatchSha256 ||
        attemptCandidateSha256 !== finalAttempt.candidatePatchSha256 ||
        attemptContextSha256 !== finalAttempt.mutationContextSha256
      ) {
        throw new Error('final hypothesis compliance attempt artifacts are missing or stale');
      }
    }
    const mutationPatchPath = path.join(artifactDirectory, 'mutation.patch');
    const mutationContextPath = path.join(artifactDirectory, 'mutation-context.json');
    const [patchSha256, candidatePatchSha256, mutationContextSha256, falsificationRequired] =
      await Promise.all([
        sha256File(mutationPatchPath),
        sha256File(variant.patchPath),
        sha256File(mutationContextPath),
        mutationContextRequiresFalsification(mutationContextPath),
      ]);
    if (
      patchSha256 !== variant.hypothesisCompliancePatchHash ||
      candidatePatchSha256 !== variant.hypothesisComplianceCandidatePatchHash ||
      candidatePatchSha256 !== variant.patchHash ||
      mutationContextSha256 !== variant.hypothesisCompliance.mutationContextSha256
    ) {
      throw new Error('hypothesis compliance inputs are missing or stale');
    }
    const resultPath = hypothesisComplianceResultPath(
      artifactDirectory,
      patchSha256,
      mutationContextSha256,
    );
    const verified = await verifyHypothesisComplianceResult(
      resultPath,
      variant.id,
      patchSha256,
      mutationContextSha256,
      variant.hypothesisComplianceResultHash,
      falsificationRequired,
    );
    if (verified.status !== 'passed' || !isDeepStrictEqual(verified, variant.hypothesisCompliance)) {
      throw new Error('persisted hypothesis compliance differs from its immutable result artifact');
    }
  }

  private async runBenchmark(
    campaign: CampaignRecord,
    variant: VariantRecord,
    stack: StackHandle,
    benchmark: Benchmark,
    token: string | undefined,
    replicate: number,
    workflowsSource: string,
    answerCache: RuntimeAnswerCache,
    options: BenchmarkRunOptions = {},
  ): Promise<Phase2Result> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const executionBenchmark = options.executionScope
      ? `${benchmark.name}:${options.executionScope}`
      : options.scope
        ? `${benchmark.name}:${options.scope}`
        : benchmark.name;
    let latestSnapshot: Phase2RunSnapshot = {
      caseId: null,
      runId: null,
      status: 'starting',
      stage: null,
      progress: null,
      decisions: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
      questions: [],
      startedAt,
      completedAt: null,
      elapsedMs: 0,
      usage: null,
      updatedAt: startedAt,
    };
    const persistSnapshot = (snapshot: Phase2RunSnapshot): void => {
      const input = {
        benchmark: executionBenchmark,
        role: benchmark.role,
        replicate,
        replicateCount: options.replicateCount ?? campaign.config.evaluation.replicates,
        snapshot,
      };
      if (options.persistToTargetEvaluation) {
        this.database.updateTargetExcludedExecution(variant.id, input);
      } else {
        this.database.updateVariantExecution(variant.id, input);
      }
    };
    persistSnapshot(latestSnapshot);
    const directory = path.join(
      stack.artifactDirectory,
      ...(options.scope ? [options.scope] : []),
      benchmark.name,
      `replicate-${replicate}`,
    );
    try {
      await mkdir(directory, { recursive: true });
      const client = new PlannerClient(stack.baseUrl, directory, token);
      await client.health();
      const result = await client.runPhase2(
        benchmark.zipPath,
        `${variant.id}-${benchmark.name}${options.scope ? `-${options.scope}` : ''}-r${replicate}`,
        campaign.config.limits.phase2TimeoutMs,
        benchmark.sha256,
        async ({ question, consultations }) =>
          await answerWithRuntimeLedger({
            campaign, benchmark, database: this.database,
            campaignDirectory: campaignDirectory(this.paths, campaign.id),
            artifactDirectory: directory, variantId: variant.id, executionBenchmark, replicate,
            question, requirementsAgentRequests: matchQuestionConsultations(consultations, question).length,
            targetWorkflow: options.answerSourceTargetWorkflow,
            selectOption: selectedOptionIdForAnswer,
            resolve: () => this.answerRuntimeQuestion(
              campaign,
              question,
              consultations,
              workflowsSource,
              path.join(directory, 'questions'),
              // The campaign ledger owns investigator reuse; fresh entries retain original provenance.
              campaign.config.investigator?.enabled ? new Map() : answerCache,
              options.answerSourceTargetWorkflow
                ? {
                    targetWorkflow: options.answerSourceTargetWorkflow,
                    variantId: variant.id,
                    benchmark: executionBenchmark,
                    replicate,
                  }
                : undefined,
            ),
          }),
        async (snapshot) => {
          const updatedAtMs = Date.now();
          latestSnapshot = {
            ...snapshot,
            startedAt,
            completedAt: null,
            elapsedMs: updatedAtMs - startedAtMs,
          };
          persistSnapshot(latestSnapshot);
        },
        options.excludedTargetWorkflow
          ? { targetImplementationWorkflow: options.excludedTargetWorkflow }
          : undefined,
      );
      await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
      return result;
    } catch (error) {
      latestSnapshot = { ...latestSnapshot, status: 'failed', failure: latestSnapshot.failure ?? normalizeExecutionFailure(error, {
        status: 'failed',
        ...(isRecord(error) && isRecord(error.failure) ? {} : { origin: isRecord(error) && typeof error.status === 'number' ? 'http' as const : 'harness' as const }),
        ...(isRecord(error) && typeof error.status === 'number' ? { httpStatus: error.status } : {}),
      }) };
      throw error;
    } finally {
      const completedAtMs = Date.now();
      const completedAt = new Date(completedAtMs).toISOString();
      latestSnapshot = {
        ...latestSnapshot,
        startedAt,
        completedAt,
        elapsedMs: completedAtMs - startedAtMs,
        updatedAt: completedAt,
      };
      persistSnapshot(latestSnapshot);
    }
  }

  private async runBenchmarkReplicates(
    campaign: CampaignRecord,
    variant: VariantRecord,
    stack: StackHandle,
    benchmark: Benchmark,
    token: string | undefined,
    options: BenchmarkRunOptions = {},
  ): Promise<{ facts: RunFacts; replicates: RunFacts[]; questions: Phase2QuestionAudit[] }> {
    const replicateCount = options.replicateCount ?? campaign.config.evaluation.replicates;
    const replicateResults: Array<Phase2Result | undefined> = new Array(
      replicateCount,
    );
    const workflowsSource = options.answerSourceTargetWorkflow
      ? await this.ensureTargetExcludedWorkflowsSource(campaign, options.answerSourceTargetWorkflow)
      : await this.ensureFrozenWorkflowsSource(campaign);
    const answerCache = options.answerCache ?? new Map();
    let nextReplicate = 1;
    let workerFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!workerFailure && nextReplicate <= replicateCount) {
        const replicate = nextReplicate;
        nextReplicate += 1;
        try {
          replicateResults[replicate - 1] = await this.runBenchmark(
            campaign,
            variant,
            stack,
            benchmark,
            token,
            replicate,
            workflowsSource,
            answerCache,
            { ...options, replicateCount },
          );
        } catch (error) {
          workerFailure ??= error;
        }
      }
    };
    const concurrency = Math.min(
      options.replicateCount ? Math.min(2, options.replicateCount) : campaign.config.evaluation.replicateConcurrency ?? 2,
      replicateCount,
    );
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (workerFailure) throw workerFailure;
    const replicates: RunFacts[] = [];
    const questions: Phase2QuestionAudit[] = [];
    for (const [index, result] of replicateResults.entries()) {
      if (!result) throw new Error(`${benchmark.name} replicate ${index + 1} did not return`);
      const facts = result.facts;
      if (!facts) throw new Error(`${benchmark.name} replicate ${index + 1} did not complete`);
      validateMeaningfulFacts(facts);
      replicates.push(facts);
      questions.push(...result.questions);
    }
    const facts = consensusRunFacts(replicates);
    const directory = path.join(
      stack.artifactDirectory,
      ...(options.scope ? [options.scope] : []),
      benchmark.name,
    );
    await Promise.all([
      writeFile(path.join(directory, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`),
      writeFile(path.join(directory, 'replicates.json'), `${JSON.stringify(replicates, null, 2)}\n`),
    ]);
    return { facts, replicates, questions };
  }

  private async answerRuntimeQuestion(
    campaign: CampaignRecord,
    question: PlannerQuestionRecord,
    consultations: unknown[],
    _workflowsSource: string,
    artifactDirectory: string,
    answerCache: RuntimeAnswerCache,
    targetContext?: {
      targetWorkflow: string;
      variantId: string;
      benchmark: string;
      replicate: number;
    },
  ): Promise<Phase2QuestionAnswer> {
    await mkdir(artifactDirectory, { recursive: true });
    const consultationRecords = matchQuestionConsultations(consultations, question);
    const cacheKey = runtimeQuestionCacheKey(question);
    const cacheAnswer = (value: Phase2QuestionAnswer): CachedRuntimeAnswer => {
      const selectedOptionIndex = value.selectedOptionId
        ? question.options?.findIndex(({ id }) => id === value.selectedOptionId) ?? -1
        : -1;
      const selectedOption =
        selectedOptionIndex >= 0 ? question.options?.[selectedOptionIndex] : undefined;
      return {
        value,
        ...(selectedOption
          ? {
              selectedOption: {
                index: selectedOptionIndex,
                label: selectedOption.label,
                description: selectedOption.description ?? null,
                consequences: selectedOption.consequences ?? null,
              },
            }
          : {}),
      };
    };
    const answerForCurrentQuestion = (
      cached: CachedRuntimeAnswer,
    ): Phase2QuestionAnswer | null => {
      const currentOption = cached.selectedOption
        ? question.options?.[cached.selectedOption.index]
        : undefined;
      const selectedOptionMatches = Boolean(
        cached.selectedOption &&
          currentOption &&
          currentOption.label === cached.selectedOption.label &&
          (currentOption.description ?? null) === cached.selectedOption.description &&
          (currentOption.consequences ?? null) === cached.selectedOption.consequences,
      );
      const selectedOptionId = cached.selectedOption
        ? selectedOptionMatches
          ? selectedOptionIdForAnswer(
              question,
              cached.selectedOption.label,
              currentOption!.id,
            )
          : undefined
        : selectedOptionIdForAnswer(
            question,
            cached.value.answer,
            cached.value.selectedOptionId,
          );
      if (question.responseKind === 'single_select' && !selectedOptionId) return null;
      return {
        ...cached.value,
        ...(selectedOptionId ? { selectedOptionId } : {}),
      };
    };
    const waitForHumanAnswer = async (): Promise<Phase2QuestionAnswer> => {
      if (!targetContext) {
        throw new Error(`planner question ${question.id} remains unresolved`);
      }
      return await this.waitForTargetExcludedAnswer(
        targetContext.variantId,
        targetContext.targetWorkflow,
        targetContext.benchmark,
        targetContext.replicate,
        question,
      );
    };
    const waitForSharedHumanAnswer = async (
      automatedCacheValue: CachedRuntimeAnswer | Promise<CachedRuntimeAnswer | null>,
    ): Promise<Phase2QuestionAnswer> => {
      const forCurrentQuestion = (shared: CachedRuntimeAnswer): Phase2QuestionAnswer => {
        const answer = answerForCurrentQuestion(shared);
        if (!answer) {
          throw new Error(`shared human answer did not select an option for ${question.id}`);
        }
        return answer;
      };
      const current = answerCache.get(cacheKey);
      if (current && current !== automatedCacheValue) {
        const shared = await current;
        if (shared) return forCurrentQuestion(shared);
      }
      const humanPromise = waitForHumanAnswer().then(cacheAnswer);
      answerCache.set(cacheKey, humanPromise);
      try {
        const humanAnswer = await humanPromise;
        if (answerCache.get(cacheKey) === humanPromise) {
          answerCache.set(cacheKey, humanAnswer);
        }
        return forCurrentQuestion(humanAnswer);
      } catch (error) {
        if (answerCache.get(cacheKey) === humanPromise) answerCache.delete(cacheKey);
        throw error;
      }
    };
    const cachedValue = answerCache.get(cacheKey);
    if (cachedValue) {
      const cached = await cachedValue;
      if (!cached) {
        return await waitForSharedHumanAnswer(cachedValue);
      }
      const answer = answerForCurrentQuestion(cached);
      if (
        answer &&
        (!targetContext || !containsTargetIdentityLeak(answer, targetContext.targetWorkflow))
      ) {
        return {
          ...answer,
          resolution: 'reused_source_answer',
          requirementsAgentRequests: consultationRecords.length,
        };
      }
    }
    const resolutionPromise = (async (): Promise<CachedRuntimeAnswer | null> => {
      const answeredConsultation = consultationRecords.find((record) => {
      const outcome = record.outcome;
      return (
        outcome !== null &&
        typeof outcome === 'object' &&
        (outcome as Record<string, unknown>).resolution === 'answered' &&
        typeof (outcome as Record<string, unknown>).answer === 'string'
      );
      });
      if (answeredConsultation) {
      const outcome = answeredConsultation.outcome as Record<string, unknown>;
      const citations = Array.isArray(outcome.citations)
        ? outcome.citations.map(citationEvidence)
        : ['requirements-agent returned a grounded answer'];
      const answerText = String(outcome.answer);
      const selectedOptionId = selectedOptionIdForAnswer(
        question,
        answerText,
        typeof outcome.selectedOptionId === 'string' ? outcome.selectedOptionId : undefined,
      );
       if (
         (question.responseKind !== 'single_select' || selectedOptionId) &&
         (!targetContext ||
           !containsTargetIdentityLeak(
             { answer: answerText, evidence: citations },
             targetContext.targetWorkflow,
           ))
       ) {
        const answer: Phase2QuestionAnswer = {
          answer: answerText,
          ...(selectedOptionId ? { selectedOptionId } : {}),
          resolution: 'requirements_agent',
          evidence: citations,
          requirementsAgentRequests: consultationRecords.length,
        };
         return cacheAnswer(answer);
      }
    }
      const source = await this.answerRuntimeQuestionFromImplementation(
        campaign,
        question,
        await this.ensureFrozenWorkflowsSource(campaign),
        artifactDirectory,
      );
      if (source.resolution !== 'answered') {
        if (!targetContext) {
          throw new Error(`planner question ${question.id} remains unresolved: ${source.reason}`);
        }
        return null;
      }
      const selectedOptionId = selectedOptionIdForAnswer(
        question,
        source.answer,
        source.selectedOptionId,
      );
      if (question.responseKind === 'single_select' && !selectedOptionId) {
        throw new Error(`source answer did not select an option for ${question.id}`);
      }
      const answer: Phase2QuestionAnswer = {
        answer: source.answer,
        ...(selectedOptionId ? { selectedOptionId } : {}),
        resolution: 'pm_simulation',
        evidence: targetContext
          ? [TARGET_SAFE_PM_EVIDENCE]
          : source.evidence,
        requirementsAgentRequests: consultationRecords.length,
      };
      if (
        targetContext &&
        containsTargetIdentityLeak({ answer: answer.answer }, targetContext.targetWorkflow)
      ) {
        return null;
      }
      return cacheAnswer(answer);
    })();
    answerCache.set(cacheKey, resolutionPromise);
    try {
      const answer = await resolutionPromise;
      if (!answer) {
        return await waitForSharedHumanAnswer(resolutionPromise);
      }
      answerCache.set(cacheKey, answer);
      const currentAnswer = answerForCurrentQuestion(answer);
      if (!currentAnswer) {
        throw new Error(`cached answer did not select an option for ${question.id}`);
      }
      return currentAnswer;
    } catch (error) {
      if (answerCache.get(cacheKey) === resolutionPromise) answerCache.delete(cacheKey);
      throw error;
    }
  }

  private async answerRuntimeQuestionFromImplementation(
    campaign: CampaignRecord,
    question: PlannerQuestionRecord,
    workflowsSource: string,
    artifactDirectory: string,
  ): Promise<SourceQuestionAnswer> {
    return await new AgentRunner(campaign).answerUpstreamQuestion(
      {
        id: question.id,
        question: question.prompt,
        type: question.responseKind,
        options: (question.options ?? []).map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description ?? option.consequences ?? '',
        })),
      },
      workflowsSource,
      artifactDirectory,
      { mode: 'pm-simulation' },
    );
  }

  private async waitForTargetExcludedAnswer(
    variantId: string,
    targetWorkflow: string,
    benchmark: string,
    replicate: number,
    question: PlannerQuestionRecord,
  ): Promise<Phase2QuestionAnswer> {
    const key = pendingTargetAnswerKey(variantId, benchmark, replicate, question.id);
    if (this.pendingTargetAnswers.has(key)) {
      throw new Error(`target-excluded question is already waiting: ${question.id}`);
    }
    this.database.updateTargetExcludedEvaluation(variantId, { status: 'waiting_for_input' });
    this.database.addEvent(
      this.database.getVariant(variantId).campaignId,
      variantId,
      'target_excluded.question_waiting',
      {
        id: question.id,
        benchmark,
        replicate,
        prompt: question.prompt,
        responseKind: question.responseKind,
        options: question.options ?? [],
      },
    );
    return await new Promise<Phase2QuestionAnswer>((resolve, reject) => {
      this.pendingTargetAnswers.set(key, {
        campaignId: this.database.getVariant(variantId).campaignId,
        variantId,
        benchmark,
        replicate,
        targetWorkflow,
        question,
        resolve,
        reject,
      });
    });
  }

  private async runTargetExcludedBackfill(
    campaign: CampaignRecord,
    variant: VariantRecord,
    config: TargetExcludedConfig,
  ): Promise<TargetExcludedEvaluationRecord> {
    const existing = this.database.getTargetExcludedEvaluation(variant.id);
    const existingComplete =
      config.protocol === 'standard-primary-v2'
        ? this.targetExcludedEvaluationReady(
            campaign,
            config,
            existing,
            variant.id === config.baselineVariantId,
          )
        : existing?.status === 'completed' &&
          existing.artifactCollectionComplete &&
          (existing.gate?.status === 'passed' || existing.gate?.status === 'warning');
    if (existingComplete && existing) {
      let archiveValid = false;
      try {
        await this.verifyArchivedTargetExcludedComparisons(
          campaign,
          variant.id,
          config,
          existing,
        );
        archiveValid = true;
      } catch (error) {
        this.database.updateTargetExcludedEvaluation(variant.id, {
          status: 'failed',
          error: `invalid archived target attempt: ${errorMessage(error)}`.slice(0, 20_000),
        });
        this.database.addEvent(campaign.id, variant.id, 'target_excluded.invalid_attempt', {
          error: errorMessage(error),
        });
      }
      if (archiveValid) throw new Error(`target-excluded evaluation already exists: ${variant.id}`);
    }
    if (!variant.worktreePath || !variant.imageTag || !variant.artifactCollectionComplete) {
      throw new Error('variant worktree, image, and archived artifacts are required');
    }
    const variantArtifacts = variantArtifactDirectory(this.paths, campaign.id, variant.id);
    const artifactDirectory = path.join(variantArtifacts, 'target-excluded');
    if (existing && (await stat(artifactDirectory).catch(() => null))?.isDirectory()) {
      const attemptsRoot = path.join(variantArtifacts, 'target-excluded-attempts');
      await mkdir(attemptsRoot, { recursive: true });
      const attempts = (await readdir(attemptsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^attempt-\d{3}$/.test(entry.name))
        .map((entry) => Number.parseInt(entry.name.slice('attempt-'.length), 10));
      const nextAttempt = Math.max(0, ...attempts) + 1;
      await rename(
        artifactDirectory,
        path.join(attemptsRoot, `attempt-${String(nextAttempt).padStart(3, '0')}`),
      );
    }
    let evaluation = this.database.createTargetExcludedEvaluation(campaign.id, variant.id);
    evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
      status: 'starting',
      controlFacts: null,
      controlReplicateFacts: null,
      holdoutFacts: null,
      holdoutReplicateFacts: null,
      excludedFacts: null,
      excludedReplicateFacts: null,
      judgment: null,
      score: null,
      questionResolution: null,
      executionState: null,
      comparisons: null,
      gate: null,
      normalArmBinding:
        config.protocol === 'standard-primary-v2' ? existing?.normalArmBinding ?? null : null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      artifactCollectionComplete: false,
      error: null,
    });
    await mkdir(artifactDirectory, { recursive: true });
    let stack: StackHandle | null = null;
    try {
      const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
      await this.ensureTargetExcludedWorkflowsSource(
        campaign,
        config.targetImplementationWorkflow,
      );
      const resolvedBenchmarks: Benchmark[] = [];
      const resolutions: Record<string, NonNullable<VariantRecord['questionResolutions']>[string]> = {};
      if (config.protocol === 'standard-primary-v2') {
        const campaignPrimary = primaryBenchmark(campaign);
        const summary = variant.questionResolutions?.[campaignPrimary.name];
        const canonicalPackPath = path.join(
          campaignDirectory(this.paths, campaign.id),
          'resolved-packs',
          `${campaignPrimary.name}.zip`,
        );
        if (
          !summary ||
          summary.resolvedArtifactSha !== config.primaryResolvedArtifactSha ||
          (await sha256File(canonicalPackPath)) !== config.primaryResolvedArtifactSha ||
          !variant.facts ||
          variant.replicateFacts?.length !== config.replicates ||
          campaign.config.benchmarks
            .filter(({ role }) => role === 'holdout')
            .some(
              ({ name }) =>
                !variant.holdoutFacts?.[name] ||
                variant.holdoutReplicateFacts?.[name]?.length !== config.replicates,
            )
        ) {
          throw new Error('V2 backfill requires complete archived standard facts and resolved primary');
        }
        resolvedBenchmarks.push({
          ...campaignPrimary,
          zipPath: canonicalPackPath,
          sha256: config.primaryResolvedArtifactSha,
        });
        resolutions[campaignPrimary.name] = summary;
      } else {
        for (const benchmark of campaign.config.benchmarks) {
          const resolved = benchmark.role === 'primary'
            ? await this.resolveTargetPairBenchmark(
                campaign,
                benchmark,
                config,
                path.join(artifactDirectory, 'pack-questions', benchmark.name),
              )
            : await resolveBenchmarkQuestions({
                campaign,
                benchmark,
                workflowsSource,
                sharedDirectory: path.join(campaignDirectory(this.paths, campaign.id), 'resolved-packs'),
                artifactDirectory: path.join(artifactDirectory, 'pack-questions', benchmark.name),
              });
          resolvedBenchmarks.push(resolved.benchmark);
          resolutions[benchmark.name] = resolved.summary;
        }
      }
      const environment = await loadCampaignEnvironment(campaign);
      stack = await startVariantStack(
        this.paths,
        campaign,
        variant,
        variant.worktreePath,
        artifactDirectory,
        variant.imageTag,
        environment,
        await this.ensureFrozenPlannerSource(campaign),
        'target-excluded',
      );
      evaluation = this.database.updateTargetExcludedEvaluation(variant.id, { status: 'running' });
      const token = stack.environment.PLANNER_EVAL_API_TOKEN || stack.environment.PLANNER_API_TOKEN;
      const primary = resolvedBenchmarks.find((benchmark) => benchmark.role === 'primary');
      if (!primary) throw new Error('resolved benchmark set omitted the primary pack');
      let control: Awaited<ReturnType<CampaignOrchestrator['runBenchmarkReplicates']>> | null = null;
      let holdoutFacts: Record<string, RunFacts> | null = null;
      let holdoutReplicateFacts: Record<string, RunFacts[]> | null = null;
      let normalArmBinding: TargetNormalArmBinding | null = null;
      if (config.protocol === 'standard-primary-v2') {
        normalArmBinding = this.buildTargetNormalArmBinding(
          variant.id,
          primary,
          config.primaryResolvedArtifactSha,
        );
        if (
          existing?.normalArmBinding &&
          !normalArmBindingsEqual(existing.normalArmBinding, normalArmBinding)
        ) {
          throw new Error('persisted V2 normal-arm binding differs from archived standard execution');
        }
        evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
          normalArmBinding,
          controlFacts: null,
          controlReplicateFacts: null,
          holdoutFacts: null,
          holdoutReplicateFacts: null,
        });
      } else {
        control = await this.runBenchmarkReplicates(campaign, variant, stack, primary, token, {
          replicateCount: config.replicates,
          scope: 'control',
          persistToTargetEvaluation: true,
        });
        holdoutFacts = {};
        holdoutReplicateFacts = {};
        for (const holdout of resolvedBenchmarks.filter((benchmark) => benchmark.role === 'holdout')) {
          const result = await this.runBenchmarkReplicates(campaign, variant, stack, holdout, token, {
            replicateCount: config.replicates,
            scope: 'control',
            persistToTargetEvaluation: true,
          });
          holdoutFacts[holdout.name] = result.facts;
          holdoutReplicateFacts[holdout.name] = result.replicates;
        }
      }
      const excluded = await this.runBenchmarkReplicates(campaign, variant, stack, primary, token, {
        replicateCount: config.replicates,
        scope: 'excluded',
        executionScope: 'excluded',
        answerSourceTargetWorkflow: config.targetImplementationWorkflow,
        excludedTargetWorkflow: config.targetImplementationWorkflow,
        persistToTargetEvaluation: true,
      });
      const comparisonDirectory = path.join(artifactDirectory, 'comparisons');
      await mkdir(comparisonDirectory, { recursive: true });
      const comparisons = await Promise.all(
        Array.from({ length: config.replicates }, (_, index) => {
          const replicate = index + 1;
          return runTargetExcludedComparison({
            ...targetExcludedComparisonDirectories(
              variantArtifacts,
              primary.name,
              replicate,
              config.protocol,
            ),
            outputPath: path.join(comparisonDirectory, `replicate-${replicate}.json`),
            imageTag: config.comparatorImage,
            replicate,
          });
        }),
      );
      evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
        status: 'judging',
        controlFacts: control?.facts ?? null,
        controlReplicateFacts: control?.replicates ?? null,
        holdoutFacts,
        holdoutReplicateFacts,
        excludedFacts: excluded.facts,
        excludedReplicateFacts: excluded.replicates,
        questionResolution:
          config.protocol === 'standard-primary-v2'
            ? withRuntimeQuestions(
                targetSafeQuestionResolution(
                  resolutions[primary.name]!,
                  config.targetImplementationWorkflow,
                ),
                excluded.questions,
                'excluded',
              )
            : withRuntimeQuestions(
                withRuntimeQuestions(resolutions[primary.name]!, control!.questions, 'control'),
                excluded.questions,
                'excluded',
              ),
        comparisons,
        normalArmBinding,
      });
      const judged = await this.judgeTargetExcluded(
        campaign,
        variant,
        primary,
        excluded.facts,
        config,
        path.join(artifactDirectory, 'excluded', primary.name),
        excluded.replicates,
      );
      const comparisonValid =
        comparisons.length === config.replicates &&
        comparisons.every((comparison) => comparison.valid);
      const leakageDetected =
        comparisons.some((comparison) => comparison.leakagePaths.length > 0) ||
        containsTargetIdentityLeak(judged.judgment, config.targetImplementationWorkflow) ||
        (config.protocol === 'standard-primary-v2' &&
          containsTargetIdentityLeak(evaluation.questionResolution, config.targetImplementationWorkflow));
      const baselineEvaluation = this.database.getTargetExcludedEvaluation(config.baselineVariantId);
      const baselineRuns =
        variant.id === config.baselineVariantId
          ? excluded.replicates
          : baselineEvaluation?.excludedReplicateFacts ?? [];
      const gate = computeTargetExcludedGate(
        baselineRuns,
        excluded.replicates,
        comparisonValid,
        leakageDetected,
        config.warningBuildDropRatio,
        config.blockBuildDropRatio,
      );
      evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
        status: 'completed',
        judgment: judged.judgment,
        score: judged.score,
        gate,
        error: null,
      });
    } catch (error) {
      evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
        status: 'failed',
        error: errorMessage(error).slice(0, 20_000),
      });
    } finally {
      let collectionComplete = stack !== null;
      if (stack) {
        try {
          await collectStackArtifacts(stack);
        } catch (error) {
          collectionComplete = false;
          this.database.addEvent(campaign.id, variant.id, 'target_excluded.artifacts_failed', {
            error: errorMessage(error),
          });
        }
        try {
          await stopVariantStack(stack, collectionComplete);
        } catch (error) {
          collectionComplete = false;
          this.database.addEvent(campaign.id, variant.id, 'target_excluded.teardown_failed', {
            error: errorMessage(error),
          });
        }
      }
      evaluation = this.database.updateTargetExcludedEvaluation(variant.id, {
        artifactCollectionComplete: collectionComplete,
        completedAt: new Date().toISOString(),
        ...(!collectionComplete && evaluation.status === 'completed'
          ? { status: 'failed', error: 'required target-excluded artifacts were not completely archived' }
          : {}),
      });
      const currentVariant = this.database.getVariant(variant.id);
      if (currentVariant.facts && currentVariant.judgment) {
        await this.runDiagnosis(
          campaign,
          currentVariant,
          variantArtifactDirectory(this.paths, campaign.id, variant.id),
        );
      }
      await this.refreshReports(campaign.id);
    }
    return evaluation;
  }

  private async judgeTargetExcluded(
    campaign: CampaignRecord,
    variant: VariantRecord,
    benchmark: Benchmark,
    facts: RunFacts,
    config: TargetExcludedConfig,
    artifactDirectory: string,
    replicates?: readonly RunFacts[] | null,
  ): Promise<{ judgment: JudgeOutput; score: NonNullable<VariantRecord['score']> }> {
    const investigator = campaign.config.investigator?.enabled;
    if (investigator && (!Array.isArray(replicates) || replicates.length !== config.replicates)) {
      throw new Error('investigator scoring requires complete raw replicate facts for target-excluded');
    }
    const baseline = investigator
      ? this.database.getTargetExcludedEvaluation(config.baselineVariantId) : null;
    if (investigator && variant.id !== config.baselineVariantId && !baseline?.judgment) {
      throw new Error('investigator scoring requires the baseline excluded judgment');
    }
    const workflowsSource = await this.ensureTargetExcludedWorkflowsSource(
      campaign,
      config.targetImplementationWorkflow,
    );
    const judgment = targetSafeJudgeOutput(
      await new AgentRunner(campaign).judge(
        variant,
        workflowsSource,
        path.join(artifactDirectory, 'facts.json'),
        artifactDirectory,
        true,
      ),
      config.targetImplementationWorkflow,
    );
    await this.ensureTargetExcludedWorkflowsSource(
      campaign,
      config.targetImplementationWorkflow,
    );
    if (containsTargetIdentityLeak(judgment, config.targetImplementationWorkflow)) {
      throw new Error('target-blind judge referenced the excluded implementation');
    }
    this.validateJudgment(facts, judgment);
    const labels = this.database
      .listTargetExcludedLabels(campaign.id)
      .map((label) => ({ ...label, benchmark: `${benchmark.name}:target-excluded` }));
    const referenceJudgment = investigator && variant.id !== config.baselineVariantId
      ? baseline!.judgment! : judgment;
    const score = investigator
      ? computeReplicateMeanScore(replicates!, labels, referenceJudgment)
      : computeScore(facts, labels, judgment);
    if (investigator && baseline?.excludedFacts && variant.id !== config.baselineVariantId) {
      score.cohortMismatches = [...new Set([
        ...score.cohortMismatches, ...compareCohort(baseline.excludedFacts, facts),
      ])];
    }
    const decisionSetHashes = (replicates ?? []).map((run) =>
      typeof run.pins.decisionSetHash === 'string' ? run.pins.decisionSetHash : null);
    const baselineDecisionSetHashes = (baseline?.excludedReplicateFacts ?? []).map((run) =>
      typeof run.pins.decisionSetHash === 'string' ? run.pins.decisionSetHash : null);
    const decisionSetHashVariation = new Set(
      [...decisionSetHashes, ...baselineDecisionSetHashes].filter((hash) => hash !== null),
    ).size > 1;
    const comparison = {
      mismatches: score.cohortMismatches,
      decisionSetHashes,
      baselineDecisionSetHashes,
      decisionSetHashVariation,
      notes: [
        'Runtime answers are not globally frozen; input-cohort equality does not establish identical answers.',
        ...(decisionSetHashVariation ? ['Decision-set hashes vary across the compared runs.'] : []),
      ],
    };
    await Promise.all([
      writeFile(path.join(artifactDirectory, 'cohort-comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`),
      writeFile(path.join(artifactDirectory, 'score-basis.json'), `${JSON.stringify({
        schemaVersion: 1,
        metricMode: investigator ? 'replicate-mean' : 'consensus',
        benchmark: `${benchmark.name}:target-excluded`,
        labelHash: canonicalHash(labels),
        labels,
        referenceJudgmentVariantId: investigator ? config.baselineVariantId : variant.id,
        referenceJudgmentHash: canonicalHash(referenceJudgment),
        referenceJudgment,
        replicateCount: investigator ? replicates!.length : facts.sampleSize,
        score,
        comparison,
      }, null, 2)}\n`),
    ]);
    return { judgment, score };
  }

  private async runHoldouts(
    campaign: CampaignRecord,
    initialVariant: VariantRecord,
  ): Promise<VariantRecord> {
    if (!initialVariant.worktreePath || !initialVariant.imageTag) {
      throw new Error('variant image and worktree are required for holdout evaluation');
    }
    const root = variantArtifactDirectory(this.paths, campaign.id, initialVariant.id);
    const directory = path.join(root, 'promotion');
    await mkdir(directory, { recursive: true });
    const environment = await loadCampaignEnvironment(campaign);
    let stack: StackHandle | null = null;
    try {
      stack = await startVariantStack(
        this.paths,
        campaign,
        initialVariant,
        initialVariant.worktreePath,
        directory,
        initialVariant.imageTag,
        environment,
        await this.ensureFrozenPlannerSource(campaign),
      );
      const token = stack.environment.PLANNER_EVAL_API_TOKEN || stack.environment.PLANNER_API_TOKEN;
      const holdoutFacts: Record<string, RunFacts> = {};
      const holdoutReplicateFacts: Record<string, RunFacts[]> = {};
      for (const benchmark of campaign.config.benchmarks.filter((item) => item.role === 'holdout')) {
        const result = await this.runBenchmarkReplicates(
          campaign,
          initialVariant,
          stack,
          benchmark,
          token,
        );
        holdoutFacts[benchmark.name] = result.facts;
        holdoutReplicateFacts[benchmark.name] = result.replicates;
      }
      const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
      const holdoutJudgments: Record<string, JudgeOutput> = {};
      const holdoutScores: Record<string, NonNullable<VariantRecord['score']>> = {};
      for (const benchmark of campaign.config.benchmarks.filter((item) => item.role === 'holdout')) {
        const evaluation = await this.judgeBenchmark(
          campaign,
          initialVariant,
          benchmark,
          holdoutFacts[benchmark.name]!,
          workflowsSource,
          path.join(directory, benchmark.name),
          holdoutReplicateFacts[benchmark.name],
        );
        holdoutJudgments[benchmark.name] = evaluation.judgment;
        holdoutScores[benchmark.name] = evaluation.score;
      }
      return this.database.updateVariant(initialVariant.id, {
        holdoutFacts,
        holdoutReplicateFacts,
        holdoutJudgments,
        holdoutScores,
      });
    } finally {
      if (stack) {
        let collectionComplete = true;
        try {
          await collectStackArtifacts(stack);
        } catch (error) {
          collectionComplete = false;
          this.database.addEvent(campaign.id, initialVariant.id, 'artifacts.collection_failed', {
            error: errorMessage(error),
          });
        }
        await stopVariantStack(stack, collectionComplete);
      }
    }
  }

  private validateJudgment(facts: RunFacts, judgment: JudgeOutput): void {
    const expected = new Set(facts.units.map((unit) => unit.key));
    const actual = new Set(judgment.verdicts.map((verdict) => verdict.unitKey));
    if (actual.size !== judgment.verdicts.length) throw new Error('judge returned duplicate unit verdicts');
    if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
      throw new Error('judge must return exactly one verdict for every requirement unit');
    }
  }

  private async judgeBenchmark(
    campaign: CampaignRecord,
    variant: VariantRecord,
    benchmark: Benchmark,
    facts: RunFacts,
    workflowsSource: string,
    artifactDirectory: string,
    replicates?: readonly RunFacts[] | null,
  ): Promise<{ judgment: JudgeOutput; score: NonNullable<VariantRecord['score']> }> {
    const investigator = campaign.config.investigator?.enabled;
    if (investigator && (!Array.isArray(replicates) || replicates.length !== campaign.config.evaluation.replicates)) {
      throw new Error(`investigator scoring requires complete raw replicate facts for ${benchmark.name}`);
    }
    const factsPath = path.join(artifactDirectory, 'facts.json');
    const judgment = await new AgentRunner(campaign).judge(
      variant,
      workflowsSource,
      factsPath,
      artifactDirectory,
    );
    const [judgeHead, judgeStatus] = await Promise.all([
      runCommand('git', ['rev-parse', 'HEAD'], { cwd: workflowsSource }),
      runCommand('git', ['status', '--porcelain'], { cwd: workflowsSource }),
    ]);
    if (judgeHead.stdout.trim() !== campaign.workflowsSha || judgeStatus.stdout.trim()) {
      throw new Error('blind judge modified the frozen workflows checkout');
    }
    this.validateJudgment(facts, judgment);
    const existingLabels = new Map(
      this.database.listLabels(campaign.id, benchmark.name).map((label) => [label.unitKey, label]),
    );
    for (const verdict of judgment.verdicts) {
      if (existingLabels.has(verdict.unitKey)) continue;
      this.database.upsertLabel({
        campaignId: campaign.id,
        benchmark: benchmark.name,
        unitKey: verdict.unitKey,
        expectedDecision: verdict.expectedDecision,
        classification: verdict.classification,
        rationale: verdict.rationale,
        status: 'suggested',
      });
    }
    const labels = this.database.listLabels(campaign.id, benchmark.name);
    const score = investigator
      ? computeReplicateMeanScore(replicates!, labels, judgment)
      : computeScore(facts, labels, judgment);
    const baseline = this.database
      .listVariants(campaign.id)
      .filter((candidate) => candidate.round === 0 && candidate.facts)
      .at(-1);
    const baselineFacts = benchmark.role === 'primary'
      ? baseline?.facts
      : baseline?.holdoutFacts?.[benchmark.name];
    score.cohortMismatches = [...new Set([
      ...score.cohortMismatches,
      ...(baselineFacts && baseline?.id !== variant.id ? compareCohort(baselineFacts, facts) : []),
    ])];
    const baselineReplicates = benchmark.role === 'primary'
      ? baseline?.replicateFacts : baseline?.holdoutReplicateFacts?.[benchmark.name];
    const decisionSetHashes = (replicates ?? []).map((run) =>
      typeof run.pins.decisionSetHash === 'string' ? run.pins.decisionSetHash : null);
    const baselineDecisionSetHashes = (baselineReplicates ?? []).map((run) =>
      typeof run.pins.decisionSetHash === 'string' ? run.pins.decisionSetHash : null);
    const decisionSetHashVariation = new Set(
      [...decisionSetHashes, ...baselineDecisionSetHashes].filter((hash) => hash !== null),
    ).size > 1;
    const comparison = {
      mismatches: score.cohortMismatches,
      decisionSetHashes,
      baselineDecisionSetHashes,
      decisionSetHashVariation,
      notes: [
        'Runtime answers are not globally frozen; input-cohort equality does not establish identical answers.',
        ...(decisionSetHashVariation ? ['Decision-set hashes vary across the compared runs.'] : []),
      ],
    };
    await Promise.all([
      writeFile(path.join(artifactDirectory, 'cohort-comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`),
      writeFile(path.join(artifactDirectory, 'score-basis.json'), `${JSON.stringify({
        schemaVersion: 1,
        metricMode: investigator ? 'replicate-mean' : 'consensus',
        benchmark: benchmark.name,
        labelHash: canonicalHash(labels),
        labels,
        referenceJudgmentVariantId: variant.id,
        referenceJudgmentHash: canonicalHash(judgment),
        referenceJudgment: judgment,
        replicateCount: investigator ? replicates!.length : facts.sampleSize,
        score,
        comparison,
      }, null, 2)}\n`),
    ]);
    return { judgment, score };
  }

  private async ensureFrozenWorkflowsSource(campaign: CampaignRecord): Promise<string> {
    const destination = path.join(this.paths.worktrees, campaign.id, 'frozen-workflows');
    if ((await stat(destination).catch(() => null))?.isDirectory()) {
      const [head, status] = await Promise.all([
        runCommand('git', ['rev-parse', 'HEAD'], { cwd: destination }),
        runCommand('git', ['status', '--porcelain'], { cwd: destination }),
      ]);
      if (head.stdout.trim() !== campaign.workflowsSha || status.stdout.trim()) {
        throw new Error('frozen workflows checkout has drifted');
      }
      return destination;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await runCommand('git', ['worktree', 'add', '--detach', destination, campaign.workflowsSha], {
      cwd: campaign.config.workflowsRepo,
    });
    return destination;
  }

  private async ensureTargetExcludedWorkflowsSource(
    campaign: CampaignRecord,
    targetWorkflow: string,
  ): Promise<string> {
    const protocolPlan = targetExcludedProtocolPlan(
      campaign,
      this.database.getTargetExcludedConfig(campaign.id),
    );
    if (!protocolPlan) throw new Error('target-excluded source protocol is not configured');
    if (protocolPlan.targetImplementationWorkflow !== targetWorkflow) {
      throw new Error('target-excluded source target differs from the configured protocol');
    }
    const policyVersion = protocolPlan.protocol === 'standard-primary-v2' ? 2 : 1;
    const sourceRoot = await this.ensureFrozenWorkflowsSource(campaign);
    const destination = path.join(
      this.paths.worktrees,
      campaign.id,
      'target-excluded-workflows',
    );
    const manifestPath = path.join(
      campaignDirectory(this.paths, campaign.id),
      'target-excluded-source-manifest.json',
    );
    const [destinationState, manifestState] = await Promise.all([
      stat(destination).catch(() => null),
      stat(manifestPath).catch(() => null),
    ]);
    if (destinationState && manifestState) {
      if (!destinationState.isDirectory() || !manifestState.isFile()) {
        throw new Error('target-excluded source snapshot pair is invalid');
      }
      const expectedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Parameters<
        typeof verifyTargetExcludedSourceSnapshot
      >[0]['expectedManifest'];
      await verifyTargetExcludedSourceSnapshot({
        sourceRoot,
        snapshotRoot: destination,
        targetWorkflow,
        policyVersion,
        expectedManifest,
      });
      return destination;
    }
    if (destinationState || manifestState) {
      await Promise.all([
        rm(destination, { recursive: true, force: true }),
        rm(manifestPath, { force: true }),
      ]);
    }
    const manifest = await createTargetExcludedSourceSnapshot({
      sourceRoot,
      snapshotRoot: destination,
      targetWorkflow,
      policyVersion,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return destination;
  }

  private async readAutomaticV2Sidecar(
    campaign: CampaignRecord,
  ): Promise<TargetExcludedConfig | null> {
    const sidecarPath = path.join(campaignDirectory(this.paths, campaign.id), 'target-excluded.json');
    try {
      return TargetExcludedConfigSchema.parse(
        JSON.parse(await readFile(sidecarPath, 'utf8')) as unknown,
      );
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private validateAutomaticV2Config(
    campaign: CampaignRecord,
    config: TargetExcludedConfig,
  ): asserts config is TargetExcludedConfig & { protocol: 'standard-primary-v2' } {
    const declared = campaign.config.targetExcluded;
    if (
      !declared ||
      config.protocol !== 'standard-primary-v2' ||
      config.targetImplementationWorkflow !== declared.targetImplementationWorkflow ||
      config.normalArmSource !== 'standard_primary'
    ) {
      throw new Error('automatic V2 config differs from the campaign-frozen target identity');
    }
  }

  private automaticV2ConfigsEqual(
    left: TargetExcludedConfig,
    right: TargetExcludedConfig,
  ): boolean {
    if (left.protocol !== 'standard-primary-v2' || right.protocol !== 'standard-primary-v2') {
      return false;
    }
    return (
      left.targetImplementationWorkflow === right.targetImplementationWorkflow &&
      left.baselineVariantId === right.baselineVariantId &&
      left.comparatorImage === right.comparatorImage &&
      left.configuredAt === right.configuredAt &&
      left.replicates === right.replicates &&
      left.concurrency === right.concurrency &&
      left.warningBuildDropRatio === right.warningBuildDropRatio &&
      left.blockBuildDropRatio === right.blockBuildDropRatio &&
      left.normalArmSource === right.normalArmSource &&
      left.primaryResolvedArtifactSha === right.primaryResolvedArtifactSha
    );
  }

  private async standardBaselineDurable(
    campaign: CampaignRecord,
    config: TargetExcludedConfig,
  ): Promise<boolean> {
    if (config.protocol !== 'standard-primary-v2') return false;
    let baseline: VariantRecord;
    try {
      baseline = this.database.getVariant(config.baselineVariantId);
    } catch {
      return false;
    }
    const primary = primaryBenchmark(campaign);
    if (
      baseline.campaignId !== campaign.id ||
      baseline.round !== 0 ||
      !baseline.worktreePath ||
      !baseline.imageTag ||
      !baseline.facts ||
      baseline.replicateFacts?.length !== config.replicates ||
      baseline.questionResolutions?.[primary.name]?.resolvedArtifactSha !==
        config.primaryResolvedArtifactSha ||
      campaign.config.benchmarks.some(
        ({ name, role }) =>
          !baseline.questionResolutions?.[name] ||
          (role === 'holdout' &&
            (!baseline.holdoutFacts?.[name] ||
              baseline.holdoutReplicateFacts?.[name]?.length !== config.replicates)),
      ) ||
      !(await this.hasCompleteEvaluationArtifacts(campaign, baseline))
    ) {
      return false;
    }
    const canonicalPack = path.join(
      campaignDirectory(this.paths, campaign.id),
      'resolved-packs',
      `${primary.name}.zip`,
    );
    return (await sha256File(canonicalPack).catch(() => null)) === config.primaryResolvedArtifactSha;
  }

  private async prepareAutomaticV2Config(
    campaign: CampaignRecord,
    baseline: VariantRecord,
    testImageTag: string,
    primarySummary: NonNullable<VariantRecord['questionResolutions']>[string],
  ): Promise<TargetExcludedConfig> {
    const declared = campaign.config.targetExcluded;
    if (!declared) throw new Error('V2 target identity is not frozen in the campaign');
    if (primarySummary.benchmark !== primaryBenchmark(campaign).name) {
      throw new Error('V2 primary resolution summary names a different benchmark');
    }
    const comparatorImage = (
      await runCommand('docker', ['image', 'inspect', '--format', '{{.Id}}', testImageTag], {
        timeoutMs: 120_000,
      })
    ).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(comparatorImage)) {
      throw new Error('baseline comparator image did not resolve to an immutable image ID');
    }
    const sidecar = await this.readAutomaticV2Sidecar(campaign);
    const persisted = this.database.getTargetExcludedConfig(campaign.id);
    const validate = (config: TargetExcludedConfig): void => {
      this.validateAutomaticV2Config(campaign, config);
      if (
        config.baselineVariantId !== baseline.id ||
        config.comparatorImage !== comparatorImage ||
        config.primaryResolvedArtifactSha !== primarySummary.resolvedArtifactSha ||
        config.replicates !== 2 ||
        config.concurrency !== 2 ||
        config.warningBuildDropRatio !== 0.08 ||
        config.blockBuildDropRatio !== 0.15
      ) {
        throw new Error('immutable V2 target-excluded config differs from the baseline inputs');
      }
    };
    if (persisted) validate(persisted);
    if (sidecar) validate(sidecar);
    if (persisted && sidecar && persisted.configuredAt !== sidecar.configuredAt) {
      throw new Error('target-excluded sidecar differs from the persisted immutable config');
    }
    return persisted ?? sidecar ?? TargetExcludedConfigSchema.parse({
      protocol: 'standard-primary-v2',
      targetImplementationWorkflow: declared.targetImplementationWorkflow,
      baselineVariantId: baseline.id,
      comparatorImage,
      configuredAt: new Date().toISOString(),
      replicates: 2,
      concurrency: 2,
      warningBuildDropRatio: 0.08,
      blockBuildDropRatio: 0.15,
      normalArmSource: 'standard_primary',
      primaryResolvedArtifactSha: primarySummary.resolvedArtifactSha,
    });
  }

  private async persistAutomaticV2Config(
    campaign: CampaignRecord,
    config: TargetExcludedConfig,
  ): Promise<TargetExcludedConfig> {
    this.validateAutomaticV2Config(campaign, config);
    if (!(await this.standardBaselineDurable(campaign, config))) {
      throw new Error('standard baseline facts and artifacts are not durable');
    }
    const persisted = this.database.getTargetExcludedConfig(campaign.id);
    const sidecar = await this.readAutomaticV2Sidecar(campaign);
    if (persisted && !this.automaticV2ConfigsEqual(persisted, config)) {
      throw new Error('persisted immutable V2 config differs from the durable baseline');
    }
    if (sidecar && !this.automaticV2ConfigsEqual(sidecar, config)) {
      throw new Error('target-excluded sidecar differs from the durable baseline');
    }
    if (!sidecar) {
      const sidecarPath = path.join(campaignDirectory(this.paths, campaign.id), 'target-excluded.json');
      const temporaryPath = `${sidecarPath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporaryPath, sidecarPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }
    return persisted ?? this.database.createTargetExcludedConfig(campaign.id, config);
  }

  private async recoverAutomaticV2Config(
    campaign: CampaignRecord,
    dependencies: { runCommand?: typeof runCommand } = {},
  ): Promise<TargetExcludedConfig | null> {
    if (!campaign.config.targetExcluded) return this.database.getTargetExcludedConfig(campaign.id);
    const persisted = this.database.getTargetExcludedConfig(campaign.id);
    const sidecar = await this.readAutomaticV2Sidecar(campaign);
    const config = persisted ?? sidecar;
    if (!config) return null;
    this.validateAutomaticV2Config(campaign, config);
    if (persisted && sidecar && !this.automaticV2ConfigsEqual(persisted, sidecar)) {
      throw new Error('target-excluded sidecar differs from the persisted immutable config');
    }
    await this.verifyAutomaticV2ComparatorImage(
      campaign,
      config,
      dependencies.runCommand ?? runCommand,
    );
    return await this.persistAutomaticV2Config(campaign, config);
  }

  private async verifyAutomaticV2ComparatorImage(
    campaign: CampaignRecord,
    config: TargetExcludedConfig,
    commandRunner: typeof runCommand,
  ): Promise<void> {
    this.validateAutomaticV2Config(campaign, config);
    const baseline = this.database.getVariant(config.baselineVariantId);
    if (!baseline.imageTag) {
      throw new Error('bound V2 baseline is missing its image tag');
    }
    const comparatorImage = (
      await commandRunner(
        'docker',
        ['image', 'inspect', '--format', '{{.Id}}', `${baseline.imageTag}-test`],
        { timeoutMs: 120_000 },
      )
    ).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(comparatorImage)) {
      throw new Error('bound baseline comparator did not resolve to an immutable image ID');
    }
    if (comparatorImage !== config.comparatorImage) {
      throw new Error('comparator image differs from the bound baseline test image');
    }
  }

  private async resolveV2PrimaryBenchmark(
    campaign: CampaignRecord,
    benchmark: Benchmark,
    targetWorkflow: string,
    artifactDirectory: string,
    dependencies: { resolveBenchmarkQuestions?: typeof resolveBenchmarkQuestions } = {},
  ): Promise<Awaited<ReturnType<typeof resolveBenchmarkQuestions>>> {
    await this.ensureTargetExcludedWorkflowsSource(campaign, targetWorkflow);
    const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
    return await (dependencies.resolveBenchmarkQuestions ?? resolveBenchmarkQuestions)({
      campaign,
      benchmark,
      workflowsSource,
      sharedDirectory: path.join(campaignDirectory(this.paths, campaign.id), 'resolved-packs'),
      artifactDirectory,
      sourceAnswerMode: 'pm-simulation',
      answerAllowed: ({ answer }) => !containsTargetIdentityLeak(answer, targetWorkflow),
    });
  }

  private async resolveTargetPairBenchmark(
    campaign: CampaignRecord,
    benchmark: Benchmark,
    config: TargetExcludedConfig,
    artifactDirectory: string,
  ): Promise<Awaited<ReturnType<typeof resolveBenchmarkQuestions>>> {
    const workflowsSource = await this.ensureTargetExcludedWorkflowsSource(
      campaign,
      config.targetImplementationWorkflow,
    );
    return await resolveBenchmarkQuestions({
      campaign,
      benchmark,
      workflowsSource,
      sharedDirectory: path.join(
        campaignDirectory(this.paths, campaign.id),
        'target-excluded-resolved-packs',
      ),
      artifactDirectory,
      answerAllowed: ({ answer, evidence }) =>
        !containsTargetIdentityLeak(
          { answer, evidence },
          config.targetImplementationWorkflow,
        ),
    });
  }

  private async ensureFrozenPlannerSource(campaign: CampaignRecord): Promise<string> {
    const destination = path.join(this.paths.worktrees, campaign.id, 'frozen-planner');
    if ((await stat(destination).catch(() => null))?.isDirectory()) {
      const [head, status] = await Promise.all([
        runCommand('git', ['rev-parse', 'HEAD'], { cwd: destination }),
        runCommand('git', ['status', '--porcelain'], { cwd: destination }),
      ]);
      if (head.stdout.trim() !== campaign.seedSha || status.stdout.trim()) {
        throw new Error('frozen planner checkout has drifted');
      }
      return destination;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await runCommand('git', ['worktree', 'add', '--detach', destination, campaign.seedSha], {
      cwd: campaign.config.plannerRepo,
    });
    return destination;
  }

  private async requireCurrentParentDiagnosis(campaign: CampaignRecord): Promise<boolean> {
    if (!campaign.currentParentVariantId) throw new Error('campaign has no current parent variant');
    const parent = this.database.getVariant(campaign.currentParentVariantId);
    await this.verifyVariantHypothesisCompliance(campaign, parent, true);
    let failure: string | null = null;
    if (
      parent.diagnosisStatus !== 'completed' ||
      !parent.diagnosis ||
      !parent.diagnosisInputHash ||
      !parent.diagnosisResultHash
    ) {
      failure = `current parent diagnosis is ${parent.diagnosisStatus}`;
    } else {
      try {
        await verifyDiagnosisArtifacts(
          variantArtifactDirectory(this.paths, campaign.id, parent.id),
          parent.diagnosisInputHash,
        );
        const verified = await verifyDiagnosisResult(
          variantArtifactDirectory(this.paths, campaign.id, parent.id),
          parent.diagnosisInputHash,
          parent.diagnosisResultHash,
        );
        if (JSON.stringify(verified) !== JSON.stringify(parent.diagnosis)) {
          throw new Error('persisted diagnosis differs from its immutable result artifact');
        }
      } catch (error) {
        failure = `current parent diagnosis artifacts are missing or stale: ${errorMessage(error)}`;
      }
    }
    if (!failure) return true;
    if (campaign.config.diagnosis.allowMissingParent) {
      this.database.addEvent(campaign.id, parent.id, 'diagnosis.parent_opt_out', { reason: failure });
      return false;
    }
    throw new Error(`${failure}; set diagnosis.allowMissingParent=true only for an explicit opt-out`);
  }

  private async runDiagnosis(
    campaign: CampaignRecord,
    initialVariant: VariantRecord,
    artifactDirectory: string,
  ): Promise<void> {
    let inputSha256: string | null = null;
    this.database.updateVariant(initialVariant.id, {
      diagnosisStatus: 'assembling',
      diagnosisResultHash: null,
      diagnosisError: null,
    });
    this.database.addEvent(campaign.id, initialVariant.id, 'diagnosis.assembling', {});
    try {
      const diagnosisLabels = [
        ...this.database.listLabels(campaign.id),
        ...this.database.listTargetExcludedLabels(campaign.id).map((label) => ({
          ...label,
          benchmark: 'target-excluded',
        })),
      ];
      const [plannerSource, workflowsSource, environment] = await Promise.all([
        this.ensureFrozenPlannerSource(campaign),
        this.ensureFrozenWorkflowsSource(campaign),
        loadCampaignEnvironment(campaign),
      ]);
      const assembled = await assembleDiagnosisInput({
        artifactDirectory,
        campaign,
        variant: this.database.getVariant(initialVariant.id),
        labels: diagnosisLabels,
        targetExcluded: this.database.getTargetExcludedEvaluation(initialVariant.id),
        targetExcludedConfig: this.database.getTargetExcludedConfig(campaign.id),
        targetExcludedSourceManifestPath: path.join(
          campaignDirectory(this.paths, campaign.id),
          'target-excluded-source-manifest.json',
        ),
        workflowsSource,
        environment,
      });
      inputSha256 = assembled.inputSha256;
      const manifestSha256 = await sha256File(assembled.manifestPath);
      if (this.database.getVariant(initialVariant.id).diagnosisStatus === 'stale') {
        throw new Error('diagnosis_stale: human labels changed during diagnostic assembly');
      }
      this.database.updateVariant(initialVariant.id, {
        diagnosisStatus: 'running',
        diagnosisInputHash: inputSha256,
        diagnosisResultHash: null,
        diagnosis: null,
        diagnosisError: null,
      });
      this.database.addEvent(campaign.id, initialVariant.id, 'diagnosis.running', {
        inputSha256,
      });
      const diagnosis = await new AgentRunner(campaign).diagnose(
        assembled.inputPath,
        inputSha256,
        artifactDirectory,
        path.dirname(plannerSource),
      );
      const resultSha256 = await sha256File(diagnosisResultPath(artifactDirectory, inputSha256));
      await Promise.all([
        this.ensureFrozenPlannerSource(campaign),
        this.ensureFrozenWorkflowsSource(campaign),
        verifyDiagnosisArtifacts(artifactDirectory, inputSha256),
        verifyDiagnosisResult(artifactDirectory, inputSha256, resultSha256),
      ]);
      if ((await sha256File(assembled.manifestPath)) !== manifestSha256) {
        throw new Error('diagnostician modified the immutable diagnosis manifest');
      }
      const current = this.database.getVariant(initialVariant.id);
      if (current.diagnosisStatus === 'stale') {
        this.database.updateVariant(initialVariant.id, {
          diagnosisStatus: 'stale',
          diagnosisInputHash: inputSha256,
          diagnosisResultHash: resultSha256,
          diagnosis,
          diagnosisError:
            current.diagnosisError ?? 'Human labels changed while diagnosis was running.',
        });
        this.database.addEvent(campaign.id, initialVariant.id, 'diagnosis.completed_stale', {
          inputSha256,
          findingIds: diagnosis.findings.map((finding) => finding.id),
        });
        return;
      }
      this.database.updateVariant(initialVariant.id, {
        diagnosisStatus: 'completed',
        diagnosisInputHash: inputSha256,
        diagnosisResultHash: resultSha256,
        diagnosis,
        diagnosisError: null,
      });
      this.database.addEvent(campaign.id, initialVariant.id, 'diagnosis.completed', {
        inputSha256,
        findingIds: diagnosis.findings.map((finding) => finding.id),
      });
    } catch (error) {
      const message = errorMessage(error).slice(0, 20_000);
      const stale = message.startsWith('diagnosis_stale:');
      this.database.updateVariant(initialVariant.id, {
        diagnosisStatus: stale ? 'stale' : 'failed',
        diagnosisInputHash: inputSha256,
        diagnosisResultHash: null,
        diagnosis: null,
        diagnosisError: message,
      });
      this.database.addEvent(campaign.id, initialVariant.id, stale ? 'diagnosis.stale' : 'diagnosis.failed', {
        inputSha256,
        error: message,
      });
    }
  }

  private async refreshAgentHistory(
    campaignId: string,
    allowedCurrentParentFindingIds: readonly string[] = [],
  ): Promise<string> {
    const campaign = this.database.getCampaign(campaignId);
    const filePath = path.join(campaignDirectory(this.paths, campaignId), 'history.json');
    await writeAgentHistory(
      filePath,
      this.paths.reports,
      campaign,
      this.database.listVariants(campaignId),
      this.database.listLabels(campaignId),
      this.database.listTargetExcludedEvaluations(campaignId),
      allowedCurrentParentFindingIds,
    );
    return filePath;
  }

  async refreshReports(campaignId: string): Promise<void> {
    const previous = this.reportQueues.get(campaignId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const campaign = this.database.getCampaign(campaignId);
      const variants = this.database.listVariants(campaignId);
      const labels = this.database.listLabels(campaignId);
      const targetConfig = this.database.getTargetExcludedConfig(campaignId);
      const targetEvaluations = this.database.listTargetExcludedEvaluations(campaignId);
      const targetByVariant = new Map(
        targetEvaluations.map((evaluation) => [evaluation.variantId, evaluation]),
      );
      const variantById = new Map(variants.map((variant) => [variant.id, variant]));
      await Promise.all([
        writeCampaignIndex(this.paths, campaign, variants, targetConfig, targetEvaluations),
        ...variants.map((variant) =>
          writeVariantReport(
            this.paths,
            campaign,
            variant,
            labels,
            targetByVariant.get(variant.id),
            variant.parentVariantId ? variantById.get(variant.parentVariantId) : null,
          ),
        ),
      ]);
      await this.refreshAgentHistory(campaignId);
      this.database.addEvent(campaignId, null, 'reports.refreshed', {});
    });
    this.reportQueues.set(campaignId, current);
    try {
      await current;
    } finally {
      if (this.reportQueues.get(campaignId) === current) this.reportQueues.delete(campaignId);
    }
  }

  private async withCampaignLock<T>(campaignId: string, action: () => Promise<T>): Promise<T> {
    if (this.activeCampaigns.has(campaignId)) throw new Error(`campaign is already active: ${campaignId}`);
    const owner = `${process.pid}-${randomUUID()}`;
    const leaseTtlMs = 90_000;
    if (!this.database.acquireLease(campaignId, owner, leaseTtlMs)) {
      throw new Error(`campaign is leased by another coordinator: ${campaignId}`);
    }
    this.activeCampaigns.add(campaignId);
    const heartbeat = setInterval(() => {
      if (!this.database.renewLease(campaignId, owner, leaseTtlMs)) {
        this.database.addEvent(campaignId, null, 'campaign.lease_lost', { owner });
      }
    }, 30_000);
    heartbeat.unref();
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
      this.activeCampaigns.delete(campaignId);
      this.database.releaseLease(campaignId, owner);
    }
  }
}
