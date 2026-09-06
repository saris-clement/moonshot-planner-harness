import { z } from 'zod';

const AbsolutePathSchema = z.string().min(1).refine((value) => value.startsWith('/'), {
  message: 'expected an absolute path',
});

const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const DecisionSchema = z.enum(['build', 'reuse', 'extend', 'defer', 'question']);
export type Decision = z.infer<typeof DecisionSchema>;

export const BenchmarkSchema = z.object({
  name: SlugSchema,
  role: z.enum(['primary', 'holdout']),
  zipPath: AbsolutePathSchema,
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});
export type Benchmark = z.infer<typeof BenchmarkSchema>;

export const CampaignConfigSchema = z
  .object({
    id: SlugSchema,
    goal: z.string().min(20).max(20_000),
    plannerRepo: AbsolutePathSchema,
    workflowsRepo: AbsolutePathSchema,
    environmentFile: AbsolutePathSchema,
    seedRevision: z.string().min(1),
    workflowsRevision: z.string().min(1),
    benchmarks: z
      .array(BenchmarkSchema)
      .min(2)
      .refine((values) => values.filter((value) => value.role === 'primary').length === 1, {
        message: 'exactly one primary benchmark is required',
      })
      .refine((values) => values.some((value) => value.role === 'holdout'), {
        message: 'at least one holdout benchmark is required',
      })
      .refine((values) => new Set(values.map((value) => value.name)).size === values.length, {
        message: 'benchmark names must be unique',
      }),
    mode: z.enum(['supervised', 'automatic']).default('supervised'),
    evaluation: z
      .object({
        replicates: z.number().int().min(1).max(10).default(3),
        replicateConcurrency: z.number().int().min(1).max(3).default(2),
      })
      .default({ replicates: 3, replicateConcurrency: 2 }),
    limits: z
      .object({
        concurrency: z.number().int().min(1).max(3).default(3),
        maxVariants: z.number().int().min(1).max(50).default(9),
        noImprovementRounds: z.number().int().min(1).max(10).default(2),
        phase2TimeoutMs: z.number().int().min(60_000).default(36_000_000),
        stackReadyTimeoutMs: z.number().int().min(10_000).default(300_000),
        maxChangedFiles: z.number().int().min(1).default(20),
        maxChangedLines: z.number().int().min(1).default(2_000),
        maxPatchBytes: z.number().int().min(1_024).default(10 * 1_024 * 1_024),
      })
      .default({
        concurrency: 3,
        maxVariants: 9,
        noImprovementRounds: 2,
        phase2TimeoutMs: 36_000_000,
        stackReadyTimeoutMs: 300_000,
        maxChangedFiles: 20,
        maxChangedLines: 2_000,
        maxPatchBytes: 10 * 1_024 * 1_024,
      }),
    agent: z
      .object({
        command: z.string().min(1).default('opencode'),
        model: z.string().min(1).default('openai/gpt-5.6-sol'),
        variant: z.string().min(1).optional(),
        autoApprove: z.boolean().default(false),
      })
      .default({ command: 'opencode', model: 'openai/gpt-5.6-sol', autoApprove: false }),
    gates: z
      .object({
        commands: z
          .array(
            z.object({
              command: z.string().min(1),
              args: z.array(z.string()).default([]),
              timeoutMs: z.number().int().min(1_000).default(1_800_000),
            }),
          )
          .default([
            { command: 'npm', args: ['run', 'typecheck'], timeoutMs: 1_800_000 },
            {
              command: 'npm',
              args: [
                'exec',
                '--workspace',
                '@ainative-planner/server',
                '--',
                'vitest',
                'run',
                '--exclude',
                'test/deployment.integration.test.ts',
              ],
              timeoutMs: 1_800_000,
            },
          ]),
        allowedPathPrefixes: z
          .array(z.string().min(1))
          .min(1)
          .default(['server/src/', 'server/test/']),
      })
      .default({
        commands: [
          { command: 'npm', args: ['run', 'typecheck'], timeoutMs: 1_800_000 },
          {
            command: 'npm',
            args: [
              'exec',
              '--workspace',
              '@ainative-planner/server',
              '--',
              'vitest',
              'run',
              '--exclude',
              'test/deployment.integration.test.ts',
            ],
            timeoutMs: 1_800_000,
          },
        ],
        allowedPathPrefixes: ['server/src/', 'server/test/'],
      }),
  })
  .strict();
export type CampaignConfigInput = z.input<typeof CampaignConfigSchema>;
export type CampaignConfig = z.output<typeof CampaignConfigSchema>;

export const HypothesisSchema = z
  .object({
    title: z.string().min(1).max(200),
    rationale: z.string().min(1).max(4_000),
    instructions: z.string().min(1).max(8_000),
    expectedImpact: z.string().min(1).max(2_000),
    risk: z.string().min(1).max(2_000),
  })
  .strict();
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const VariantStatusSchema = z.enum([
  'queued',
  'mutating',
  'gating',
  'building',
  'starting',
  'running',
  'judging',
  'review',
  'completed',
  'rejected',
  'failed',
  'stopped',
]);
export type VariantStatus = z.infer<typeof VariantStatusSchema>;

export interface RequirementRef {
  entity: string;
  anchor: string;
}

export interface RequirementUnitFact {
  id: string;
  key: string;
  ref: RequirementRef;
  kind: string;
  semantics: string;
  decision: Decision;
  confidence: string;
  rationale: string;
  selectedCandidateIds: string[];
  sourceRefs: Array<{ capabilityId?: string; path?: string; symbol?: string }>;
  discoveredEvidenceCount: number;
  shortlistCandidateCount: number;
  uncoveredSemantics: string[];
}

export interface PlannerUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface RunFacts {
  status: string;
  sampleSize: number;
  decisionAgreement: number;
  unitCount: number;
  decisions: Record<Decision, number>;
  shortlist: { empty: number; nonempty: number; candidates: number };
  evidence: { discovered: number; selectedSourceRefs: number };
  usage: PlannerUsage;
  pins: Record<string, unknown>;
  units: RequirementUnitFact[];
}

export const JudgeVerdictSchema = z
  .object({
    unitKey: z.string().min(1),
    expectedDecision: DecisionSchema,
    classification: z.enum(['system_error', 'real_gap', 'uncertain']),
    confidence: z.enum(['low', 'medium', 'high']),
    rationale: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(10),
  })
  .strict();
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JudgeOutputSchema = z
  .object({
    summary: z.string().min(1).max(8_000),
    verdicts: z.array(JudgeVerdictSchema).max(10_000),
  })
  .strict();
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface Score {
  cohortMismatches: string[];
  verified: {
    labeled: number;
    correct: number;
    errors: number;
    accuracy: number | null;
  };
  provisional: {
    labeled: number;
    correct: number;
    errors: number;
    accuracy: number | null;
  };
  decisionErrors: Record<Decision, number>;
}

export interface QuestionResolutionEntry {
  id: string;
  question: string;
  resolution: 'requirements_agent' | 'source_fallback' | 'reused_source_answer';
  answer: string;
  evidence: string[];
}

export interface BenchmarkQuestionResolution {
  derivationVersion: 2;
  benchmark: string;
  originalArtifactSha: string;
  resolvedArtifactSha: string;
  blockingQuestions: number;
  requirementsAgentRequests: number;
  requirementsAgentAnswers: number;
  sourceFallbackAnswers: number;
  reusedAnswers: number;
  plannerQuestions: number;
  plannerRequirementsAgentRequests: number;
  plannerRequirementsAgentAnswers: number;
  plannerSourceFallbackAnswers: number;
  plannerReusedAnswers: number;
  entries: QuestionResolutionEntry[];
}

export interface RuntimeQuestionObservation {
  id: string;
  type: string;
  ownerRole: string;
  priority: string;
  prompt: string;
  rationale: string;
  status: string;
  answer: string | null;
  resolution: 'requirements_agent' | 'source_fallback' | 'reused_source_answer' | null;
  evidence: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Phase2RunSnapshot {
  caseId: string | null;
  runId: string | null;
  status: string;
  stage: string | null;
  progress: { completedUnits: number; totalUnits: number } | null;
  decisions: Record<Decision, number>;
  questions: RuntimeQuestionObservation[];
  startedAt?: string | null;
  completedAt?: string | null;
  elapsedMs?: number | null;
  usage?: PlannerUsage | null;
  updatedAt: string;
}

export interface VariantExecution extends Phase2RunSnapshot {
  benchmark: string;
  role: Benchmark['role'];
  replicate: number;
  replicateCount: number;
}

export interface VariantExecutionState {
  executions: VariantExecution[];
}

export interface CampaignRecord {
  id: string;
  status: string;
  config: CampaignConfig;
  seedSha: string;
  workflowsSha: string;
  environmentSha: string;
  workflowsRemoteUrl: string;
  currentParentVariantId: string | null;
  noImprovementRounds: number;
  createdAt: string;
  updatedAt: string;
}

export interface VariantRecord {
  id: string;
  campaignId: string;
  parentVariantId: string | null;
  round: number;
  ordinal: number;
  hypothesis: Hypothesis;
  status: VariantStatus;
  worktreePath: string | null;
  imageTag: string | null;
  composeProject: string | null;
  baseUrl: string | null;
  patchPath: string | null;
  artifactCollectionComplete: boolean;
  facts: RunFacts | null;
  replicateFacts: RunFacts[] | null;
  holdoutFacts: Record<string, RunFacts> | null;
  holdoutReplicateFacts: Record<string, RunFacts[]> | null;
  holdoutJudgments: Record<string, JudgeOutput> | null;
  holdoutScores: Record<string, Score> | null;
  judgment: JudgeOutput | null;
  score: Score | null;
  questionResolutions: Record<string, BenchmarkQuestionResolution> | null;
  executionState: VariantExecutionState | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  phase2StartedAt: string | null;
  phase2CompletedAt: string | null;
  phase2ElapsedMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRecord {
  campaignId: string;
  benchmark: string;
  unitKey: string;
  expectedDecision: Decision;
  classification: 'system_error' | 'real_gap' | 'uncertain';
  rationale: string;
  status: 'suggested' | 'verified';
  updatedAt: string;
}
