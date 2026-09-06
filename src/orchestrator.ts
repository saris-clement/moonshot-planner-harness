import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  loadCampaignConfig,
  readEnvironmentFile,
  resolveCampaignConfig,
  sha256File,
  writeResolvedCampaignConfig,
} from './config.js';
import { HarnessDatabase } from './db.js';
import { AgentRunner } from './agents.js';
import {
  compareCohort,
  compareScores,
  computeScore,
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
import { runCommand } from './process.js';
import {
  buildVariantImage,
  captureAndGateDiff,
  collectStackArtifacts,
  ensureVariantArtifactDirectory,
  loadCampaignEnvironment,
  prepareVariantWorktree,
  runVariantGates,
  startVariantStack,
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
  VariantRecord,
} from './types.js';
import { resolveBenchmarkQuestions } from './upstreamQuestions.js';

const baselineHypothesis: Hypothesis = {
  title: 'Unmodified campaign seed',
  rationale: 'Measure the selected seed revision before applying an experimental mutation.',
  instructions: 'Do not modify the planner.',
  expectedImpact: 'Establish reproducible primary and holdout facts for this campaign.',
  risk: 'Provider nondeterminism means one screening run is descriptive rather than conclusive.',
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

function nextVariantIdentity(campaign: CampaignRecord, variants: readonly VariantRecord[]): string {
  const ordinal = Math.max(0, ...variants.map((variant) => variant.ordinal)) + 1;
  return `${campaign.id}-v${String(ordinal).padStart(3, '0')}`;
}

type RuntimeAnswerCache = Map<
  string,
  Phase2QuestionAnswer | Promise<Phase2QuestionAnswer>
>;

function withRuntimeQuestions(
  summary: NonNullable<VariantRecord['questionResolutions']>[string],
  questions: readonly Phase2QuestionAudit[],
): NonNullable<VariantRecord['questionResolutions']>[string] {
  return {
    ...summary,
    plannerQuestions: questions.length,
    plannerRequirementsAgentRequests: questions.reduce(
      (total, question) => total + question.requirementsAgentRequests,
      0,
    ),
    plannerRequirementsAgentAnswers: questions.filter(
      (question) => question.resolution === 'requirements_agent',
    ).length,
    plannerSourceFallbackAnswers: questions.filter(
      (question) => question.resolution === 'source_fallback',
    ).length,
    plannerReusedAnswers: questions.filter(
      (question) => question.resolution === 'reused_source_answer',
    ).length,
    entries: [
      ...summary.entries,
      ...questions.map((question) => ({
        id: question.questionId,
        question: question.prompt,
        resolution: question.resolution,
        answer: question.answer,
        evidence: question.evidence,
      })),
    ],
  };
}

export class CampaignOrchestrator {
  private readonly activeCampaigns = new Set<string>();
  private readonly reportQueues = new Map<string, Promise<void>>();

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

  private async initializeResolved(
    resolved: Awaited<ReturnType<typeof resolveCampaignConfig>>,
  ): Promise<CampaignRecord> {
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
    await writeFile(frozenEnvironment, await readFile(resolved.config.environmentFile), {
      flag: 'wx',
      mode: 0o600,
    });
    const environmentSha = await sha256File(frozenEnvironment);
    const packsDirectory = path.join(directory, 'packs');
    await mkdir(packsDirectory, { recursive: true });
    const benchmarks = await Promise.all(
      resolved.config.benchmarks.map(async (benchmark) => {
        const frozenPath = path.join(packsDirectory, `${benchmark.name}.zip`);
        await writeFile(frozenPath, await readFile(benchmark.zipPath), { flag: 'wx', mode: 0o600 });
        return { ...benchmark, zipPath: frozenPath };
      }),
    );
    const config = {
      ...resolved.config,
      environmentFile: frozenEnvironment,
      benchmarks,
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
      const existing = this.database
        .listVariants(campaignId)
        .find((variant) => variant.round === 0 && variant.status === 'completed');
      if (existing) throw new Error(`baseline already exists: ${existing.id}`);
      if (campaign.status.startsWith('stopped')) throw new Error(`campaign is stopped: ${campaign.status}`);
      const existingVariants = this.database.listVariants(campaignId);
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
      const result = await this.runVariant(campaign, variant, false);
      return await this.finalizeBaseline(campaignId, result);
    });
  }

  private async finalizeBaseline(campaignId: string, result: VariantRecord): Promise<VariantRecord> {
      if (this.database.getCampaign(campaignId).status === 'stopped_by_user') return result;
      if (result.status !== 'review' || !result.facts || !result.artifactCollectionComplete) {
        this.database.updateCampaign(campaignId, { status: 'baseline_failed' });
        return result;
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
        );
        holdoutFacts[benchmark.name] = holdout;
        holdoutReplicateFacts[benchmark.name] = replicates;
        holdoutJudgments[benchmark.name] = evaluation.judgment;
        holdoutScores[benchmark.name] = evaluation.score;
      }
      return this.database.updateVariant(variant.id, {
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
      try {
        if (this.database.getCampaign(campaignId).config.mode !== 'automatic') {
          throw new Error('campaign mode is supervised; use round instead of auto');
        }
        while (true) {
          const campaign = this.database.getCampaign(campaignId);
          const generated = this.database.listVariants(campaignId).filter((variant) => variant.round > 0);
          if (campaign.status.startsWith('stopped')) return;
          if (generated.length >= campaign.config.limits.maxVariants) {
            this.database.updateCampaign(campaignId, { status: 'stopped_max_variants' });
            return;
          }
          await this.runRoundUnlocked(campaignId);
          const current = this.database.getCampaign(campaignId);
          if (current.status.startsWith('stopped')) return;
        }
      } catch (error) {
        this.markOperationFailed(campaignId, error);
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
    const historyPath = await this.refreshAgentHistory(campaignId);
    const hypotheses = await new AgentRunner(campaign).proposeHypotheses(
      campaignDirectory(this.paths, campaignId),
      historyPath,
      count,
    );
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
          variant.status === 'review' && variant.artifactCollectionComplete && variant.score !== null,
      )
      .filter((variant) => !variant.score.cohortMismatches.includes('requirement units'))
      .sort((left, right) => compareScores(left.score, right.score));
    if (eligible.length === 0) {
      this.database.updateCampaign(campaignId, { status: 'stopped_round_failed' });
    } else if (campaign.config.mode === 'automatic') {
      await this.promoteUnlocked(campaignId, eligible[0]!.id);
    } else {
      this.database.updateCampaign(campaignId, { status: 'awaiting_review' });
    }
    await this.refreshReports(campaignId);
    return results;
  }

  async promote(campaignId: string, variantId: string): Promise<VariantRecord> {
    return await this.withCampaignLock(
      campaignId,
      async () => await this.promoteUnlocked(campaignId, variantId),
    );
  }

  private async promoteUnlocked(campaignId: string, variantId: string): Promise<VariantRecord> {
    const campaign = this.database.getCampaign(campaignId);
    let variant = this.database.getVariant(variantId);
    if (
      variant.campaignId !== campaignId ||
      variant.status !== 'review' ||
      variant.parentVariantId !== campaign.currentParentVariantId ||
      !variant.artifactCollectionComplete ||
      !variant.facts ||
      !variant.score
    ) {
      throw new Error('variant is not eligible for promotion');
    }
    const latestRound = Math.max(...this.database.listVariants(campaignId).map((candidate) => candidate.round));
    if (variant.round !== latestRound) throw new Error('only the current round can be promoted');
    if (variant.score.cohortMismatches.includes('requirement units')) {
      throw new Error('variant changed the frozen requirement-unit cohort');
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

  stop(campaignId: string): CampaignRecord {
    const campaign = this.database.updateCampaign(campaignId, { status: 'stopped_by_user' });
    this.database.addEvent(campaignId, null, 'campaign.stop_requested', {});
    return campaign;
  }

  resume(campaignId: string): CampaignRecord {
    if (this.isActive(campaignId)) throw new Error('campaign is still active');
    const campaign = this.database.getCampaign(campaignId);
    const variants = this.database.listVariants(campaignId);
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
    this.database.upsertLabel({ ...input, status: 'verified' });
    const labels = this.database.listLabels(input.campaignId, input.benchmark);
    for (const variant of this.database.listVariants(input.campaignId)) {
      if (input.benchmark === primaryBenchmark(campaign).name) {
        if (!variant.facts || !variant.judgment) continue;
        const score = computeScore(variant.facts, labels, variant.judgment);
        score.cohortMismatches = variant.score?.cohortMismatches ?? [];
        this.database.updateVariant(variant.id, { score });
      } else {
        const facts = variant.holdoutFacts?.[input.benchmark];
        const judgment = variant.holdoutJudgments?.[input.benchmark];
        if (!facts || !judgment) continue;
        const score = computeScore(facts, labels, judgment);
        score.cohortMismatches = variant.holdoutScores?.[input.benchmark]?.cohortMismatches ?? [];
        this.database.updateVariant(variant.id, {
          holdoutScores: { ...(variant.holdoutScores ?? {}), [input.benchmark]: score },
        });
      }
    }
    await this.refreshReports(input.campaignId);
  }

  private async runVariant(
    campaign: CampaignRecord,
    initialVariant: VariantRecord,
    mutate: boolean,
  ): Promise<VariantRecord> {
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
    try {
      artifactDirectory = await ensureVariantArtifactDirectory(
        this.paths,
        campaign.id,
        variant.id,
      );
      variant = this.database.updateVariant(variant.id, { status: mutate ? 'mutating' : 'gating' });
      const parentPatch = variant.parentVariantId
        ? this.database.getVariant(variant.parentVariantId).patchPath
        : null;
      const worktree = await prepareVariantWorktree(
        this.paths,
        campaign,
        variant,
        parentPatch,
      );
      variant = this.database.updateVariant(variant.id, { worktreePath: worktree });
      if (mutate) {
        await new AgentRunner(campaign).mutate(variant, worktree, artifactDirectory);
        variant = this.database.updateVariant(variant.id, { status: 'gating' });
      }
      const { patchPath } = await captureAndGateDiff(
        campaign,
        variant,
        worktree,
        artifactDirectory,
      );
      variant = this.database.updateVariant(variant.id, { patchPath });

      const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
      const resolvedBenchmarks: Benchmark[] = [];
      const questionResolutions: NonNullable<VariantRecord['questionResolutions']> = {};
      for (const benchmark of campaign.config.benchmarks) {
        const resolved = await resolveBenchmarkQuestions({
          campaign,
          benchmark,
          workflowsSource,
          sharedDirectory: path.join(campaignDirectory(this.paths, campaign.id), 'resolved-packs'),
          artifactDirectory: path.join(artifactDirectory, benchmark.name, 'questions'),
        });
        resolvedBenchmarks.push(resolved.benchmark);
        questionResolutions[benchmark.name] = resolved.summary;
      }
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
      const primary = resolvedBenchmarks.find((benchmark) => benchmark.role === 'primary');
      if (!primary) throw new Error('resolved benchmark set omitted the primary pack');
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
      };
      const holdoutFacts: Record<string, RunFacts> = {};
      const holdoutReplicateFacts: Record<string, RunFacts[]> = {};
      try {
        primaryRuns = await this.runBenchmarkReplicates(
          campaign,
          variant,
          stack,
          primary,
          token,
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
          );
          holdoutFacts[benchmark.name] = holdout.facts;
          holdoutReplicateFacts[benchmark.name] = holdout.replicates;
          questionResolutions[benchmark.name] = withRuntimeQuestions(
            questionResolutions[benchmark.name]!,
            holdout.questions,
          );
        }
      } finally {
        const phase2CompletedAtMs = Date.now();
        variant = this.database.updateVariant(variant.id, {
          phase2CompletedAt: new Date(phase2CompletedAtMs).toISOString(),
          phase2ElapsedMs: phase2CompletedAtMs - phase2StartedAtMs,
        });
      }
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
        );
        holdoutJudgments[benchmark.name] = evaluation.judgment;
        holdoutScores[benchmark.name] = evaluation.score;
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

  private async runBenchmark(
    campaign: CampaignRecord,
    variant: VariantRecord,
    stack: StackHandle,
    benchmark: Benchmark,
    token: string | undefined,
    replicate: number,
    workflowsSource: string,
    answerCache: RuntimeAnswerCache,
  ): Promise<Phase2Result> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
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
      this.database.updateVariantExecution(variant.id, {
        benchmark: benchmark.name,
        role: benchmark.role,
        replicate,
        replicateCount: campaign.config.evaluation.replicates,
        snapshot,
      });
    };
    persistSnapshot(latestSnapshot);
    const directory = path.join(stack.artifactDirectory, benchmark.name, `replicate-${replicate}`);
    try {
      await mkdir(directory, { recursive: true });
      const client = new PlannerClient(stack.baseUrl, directory, token);
      await client.health();
      const result = await client.runPhase2(
        benchmark.zipPath,
        `${variant.id}-${benchmark.name}-r${replicate}`,
        campaign.config.limits.phase2TimeoutMs,
        benchmark.sha256,
        async ({ question, consultations }) =>
          await this.answerRuntimeQuestion(
            campaign,
            question,
            consultations,
            workflowsSource,
            path.join(directory, 'questions'),
            answerCache,
          ),
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
      );
      await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
      return result;
    } catch (error) {
      latestSnapshot = { ...latestSnapshot, status: 'failed' };
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
  ): Promise<{ facts: RunFacts; replicates: RunFacts[]; questions: Phase2QuestionAudit[] }> {
    const replicateResults: Array<Phase2Result | undefined> = new Array(
      campaign.config.evaluation.replicates,
    );
    const workflowsSource = await this.ensureFrozenWorkflowsSource(campaign);
    const answerCache: RuntimeAnswerCache = new Map();
    let nextReplicate = 1;
    let workerFailure: unknown;
    const worker = async (): Promise<void> => {
      while (!workerFailure && nextReplicate <= campaign.config.evaluation.replicates) {
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
          );
        } catch (error) {
          workerFailure ??= error;
        }
      }
    };
    const concurrency = Math.min(
      campaign.config.evaluation.replicateConcurrency ?? 2,
      campaign.config.evaluation.replicates,
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
    const directory = path.join(stack.artifactDirectory, benchmark.name);
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
    workflowsSource: string,
    artifactDirectory: string,
    answerCache: RuntimeAnswerCache,
  ): Promise<Phase2QuestionAnswer> {
    await mkdir(artifactDirectory, { recursive: true });
    const consultationRecords = matchQuestionConsultations(consultations, question);
    const cacheKey = JSON.stringify({
      responseKind: question.responseKind,
      prompt: question.prompt,
      type: question.type,
      ownerRole: question.ownerRole,
      coverageIds: question.coverageIds,
      options: question.options?.map(({ label, description, consequences }) => ({
        label,
        description: description ?? consequences ?? '',
      })),
    });
    const cachedValue = answerCache.get(cacheKey);
    if (cachedValue) {
      const cached = await cachedValue;
      const selectedOptionId = selectedOptionIdForAnswer(
        question,
        cached.answer,
        cached.selectedOptionId,
      );
      if (question.responseKind !== 'single_select' || selectedOptionId) {
        return {
          ...cached,
          ...(selectedOptionId ? { selectedOptionId } : {}),
          resolution: 'reused_source_answer',
          requirementsAgentRequests: consultationRecords.length,
        };
      }
    }
    const resolutionPromise = (async (): Promise<Phase2QuestionAnswer> => {
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
      const selectedOptionId = selectedOptionIdForAnswer(question, answerText);
      if (question.responseKind !== 'single_select' || selectedOptionId) {
        const answer: Phase2QuestionAnswer = {
          answer: answerText,
          ...(selectedOptionId ? { selectedOptionId } : {}),
          resolution: 'requirements_agent',
          evidence: citations,
          requirementsAgentRequests: consultationRecords.length,
        };
        return answer;
      }
    }
      const source = await new AgentRunner(campaign).answerUpstreamQuestion(
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
    );
      if (source.resolution !== 'answered') {
      throw new Error(`planner question ${question.id} remains unresolved: ${source.reason}`);
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
      resolution: 'source_fallback',
      evidence: source.evidence,
      requirementsAgentRequests: consultationRecords.length,
    };
      return answer;
    })();
    answerCache.set(cacheKey, resolutionPromise);
    try {
      const answer = await resolutionPromise;
      answerCache.set(cacheKey, answer);
      return answer;
    } catch (error) {
      if (answerCache.get(cacheKey) === resolutionPromise) answerCache.delete(cacheKey);
      throw error;
    }
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
  ): Promise<{ judgment: JudgeOutput; score: NonNullable<VariantRecord['score']> }> {
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
    const score = computeScore(
      facts,
      this.database.listLabels(campaign.id, benchmark.name),
      judgment,
    );
    const baseline = this.database
      .listVariants(campaign.id)
      .filter((candidate) => candidate.round === 0 && candidate.facts)
      .at(-1);
    const baselineFacts = benchmark.role === 'primary'
      ? baseline?.facts
      : baseline?.holdoutFacts?.[benchmark.name];
    score.cohortMismatches = baselineFacts && baseline?.id !== variant.id
      ? compareCohort(baselineFacts, facts)
      : [];
    await writeFile(
      path.join(artifactDirectory, 'cohort-comparison.json'),
      `${JSON.stringify({ mismatches: score.cohortMismatches }, null, 2)}\n`,
    );
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

  private async refreshAgentHistory(campaignId: string): Promise<string> {
    const campaign = this.database.getCampaign(campaignId);
    const filePath = path.join(campaignDirectory(this.paths, campaignId), 'history.json');
    await writeAgentHistory(
      filePath,
      this.paths.reports,
      campaign,
      this.database.listVariants(campaignId),
      this.database.listLabels(campaignId),
    );
    return filePath;
  }

  async refreshReports(campaignId: string): Promise<void> {
    const previous = this.reportQueues.get(campaignId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const campaign = this.database.getCampaign(campaignId);
      const variants = this.database.listVariants(campaignId);
      const labels = this.database.listLabels(campaignId);
      await Promise.all([
        writeCampaignIndex(this.paths, campaign, variants),
        ...variants.map((variant) => writeVariantReport(this.paths, campaign, variant, labels)),
      ]);
      await this.refreshAgentHistory(campaignId);
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
