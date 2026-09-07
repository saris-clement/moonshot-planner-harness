import { z } from 'zod';

const AbsolutePathSchema = z.string().min(1).refine((value) => value.startsWith('/'), {
  message: 'expected an absolute path',
});

const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const WorkflowKeySchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/);

const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const DecisionSchema = z.enum(['build', 'reuse', 'extend', 'defer', 'question']);
export type Decision = z.infer<typeof DecisionSchema>;

export const TargetExcludedAnswerInputSchema = z
  .object({
    answer: z.string().min(1).max(20_000),
    selectedOptionId: z.string().min(1).max(256).optional(),
    benchmark: z.string().min(1).max(512).optional(),
    replicate: z.number().int().positive().max(10).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.benchmark === undefined) !== (input.replicate === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'benchmark and replicate must be supplied together',
      });
    }
  });
export type TargetExcludedAnswerInput = z.infer<typeof TargetExcludedAnswerInputSchema>;

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
    targetExcluded: z
      .object({
        protocol: z.literal('standard-primary-v2'),
        targetImplementationWorkflow: WorkflowKeySchema,
      })
      .strict()
      .optional(),
    mode: z.enum(['supervised', 'automatic']).default('supervised'),
    evaluation: z
      .object({
        replicates: z.number().int().min(1).max(10).default(3),
        replicateConcurrency: z.number().int().min(1).max(3).default(2),
        analysisMaxCostUsd: z.number().finite().positive().max(1_000_000).default(2_000),
      })
      .default({ replicates: 3, replicateConcurrency: 2, analysisMaxCostUsd: 2_000 }),
    limits: z
      .object({
        concurrency: z.number().int().min(1).max(3).default(3),
        maxVariants: z.number().int().min(1).max(50).default(9),
        noImprovementRounds: z.number().int().min(1).max(10).default(2),
        phase2TimeoutMs: z.number().int().min(60_000).default(43_200_000),
        stackReadyTimeoutMs: z.number().int().min(10_000).default(300_000),
        maxChangedFiles: z.number().int().min(1).default(20),
        maxChangedLines: z.number().int().min(1).default(2_000),
        maxPatchBytes: z.number().int().min(1_024).default(10 * 1_024 * 1_024),
      })
      .default({
        concurrency: 3,
        maxVariants: 9,
        noImprovementRounds: 2,
        phase2TimeoutMs: 43_200_000,
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
    diagnosis: z
      .object({
        allowMissingParent: z.boolean().default(false),
      })
      .strict()
      .default({ allowMissingParent: false }),
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
  .strict()
  .superRefine((config, context) => {
    if (config.targetExcluded && config.evaluation.replicates !== 2) {
      context.addIssue({
        code: 'custom',
        path: ['evaluation', 'replicates'],
        message: 'standard-primary-v2 target exclusion requires exactly two evaluation replicates',
      });
    }
  });
export type CampaignConfigInput = z.input<typeof CampaignConfigSchema>;
export type CampaignConfig = z.output<typeof CampaignConfigSchema>;

const TargetExcludedConfigFields = {
  targetImplementationWorkflow: WorkflowKeySchema,
  baselineVariantId: z.string().min(1).max(256),
  comparatorImage: Sha256Schema,
  configuredAt: z.string().datetime(),
  replicates: z.literal(2).default(2),
  concurrency: z.literal(2).default(2),
  warningBuildDropRatio: z.literal(0.08).default(0.08),
  blockBuildDropRatio: z.literal(0.15).default(0.15),
};

const DedicatedControlV1ConfigSchema = z
  .object({
    protocol: z.literal('dedicated-control-v1').optional(),
    ...TargetExcludedConfigFields,
  })
  .strict()
  .transform((config) => ({ ...config, protocol: 'dedicated-control-v1' as const }));

const StandardPrimaryV2ConfigSchema = z
  .object({
    protocol: z.literal('standard-primary-v2'),
    normalArmSource: z.literal('standard_primary'),
    primaryResolvedArtifactSha: Sha256Schema,
    ...TargetExcludedConfigFields,
  })
  .strict();

export const TargetExcludedConfigSchema = z.union([
  DedicatedControlV1ConfigSchema,
  StandardPrimaryV2ConfigSchema,
]);
export type TargetExcludedConfigInput = z.input<typeof TargetExcludedConfigSchema>;
export type TargetExcludedConfig = z.output<typeof TargetExcludedConfigSchema>;

export const HypothesisSchema = z
  .object({
    title: z.string().min(1).max(200),
    rationale: z.string().min(1).max(4_000),
    instructions: z.string().min(1).max(8_000),
    expectedImpact: z.string().min(1).max(2_000),
    risk: z.string().min(1).max(2_000),
    findingIds: z
      .array(z.string().regex(/^finding-[a-z0-9][a-z0-9._-]{0,79}$/))
      .max(20)
      .default([]),
    assumptions: z.array(z.string().trim().min(1).max(2_000)).max(20).default([]),
    findingSnapshots: z
      .array(
        z
          .object({
            id: z.string().regex(/^finding-[a-z0-9][a-z0-9._-]{0,79}$/),
            category: z.string().min(1).max(128),
            causalMechanism: z.string().min(1).max(4_000),
            supportingEvidenceRefs: z.array(z.string().regex(/^evidence-[a-f0-9]{16}$/)).min(1).max(100),
            counterEvidenceRefs: z.array(z.string().regex(/^evidence-[a-f0-9]{16}$/)).min(1).max(100),
            confidence: z.enum(['low', 'medium', 'high']),
            genericIntervention: z.string().min(1).max(4_000),
            falsificationTest: z.string().min(1).max(4_000),
            limitations: z.array(z.string().min(1).max(2_000)).min(1).max(50),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type HypothesisInput = z.input<typeof HypothesisSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;

const RelativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').some((segment) => segment === '..'),
    { message: 'expected a safe relative artifact path' },
  );
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const DiagnosisFindingCategorySchema = z.enum([
  'workflow_resolution',
  'source_discovery',
  'candidate_ranking',
  'tool_selection',
  'evidence_hydration',
  'evidence_retention',
  'planner_interpretation',
  'confidence_calibration',
  'replicate_instability',
  'infrastructure',
  'unknown',
]);
export type DiagnosisFindingCategory = z.infer<typeof DiagnosisFindingCategorySchema>;

export const DiagnosisProvenanceClassSchema = z.enum([
  'observed_durable',
  'observed_langfuse',
  'deterministic_reconstruction',
  'model_inference',
  'not_captured',
]);
export type DiagnosisProvenanceClass = z.infer<typeof DiagnosisProvenanceClassSchema>;

export const DiagnosisProvenanceSchema = z
  .object({
    classification: DiagnosisProvenanceClassSchema,
    source: z.enum([
      'planner_api',
      's3',
      'langfuse',
      'replicate',
      'judge',
      'human_label',
      'frozen_source',
      'harness',
    ]),
    artifactPath: RelativeArtifactPathSchema.nullable(),
    artifactSha256: Sha256Schema.nullable(),
    integrity: z.enum(['verified', 'hash_only', 'unverified', 'unavailable']),
    caseId: z.string().min(1).max(256).nullable(),
    runId: z.string().min(1).max(256).nullable(),
    unitKey: z.string().min(1).max(512).nullable(),
    limitation: z.string().max(2_000).nullable(),
  })
  .strict();
export type DiagnosisProvenance = z.infer<typeof DiagnosisProvenanceSchema>;

export const DiagnosisCompletenessItemSchema = z
  .object({
    component: z.enum([
      'analysis',
      'replicate_facts',
      'case_run_lineage',
      'transcript_entries',
      'transcript_requests',
      'transcript_results',
      'shortlist_and_evidence',
      'langfuse',
      'judge',
      'labels',
      'frozen_source',
      'target_excluded',
    ]),
    scope: z.string().min(1).max(512),
    status: z.enum(['complete', 'partial', 'unavailable', 'not_configured', 'failed']),
    captured: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative().nullable(),
    limitations: z.array(z.string().min(1).max(2_000)).max(50),
  })
  .strict();
export type DiagnosisCompletenessItem = z.infer<typeof DiagnosisCompletenessItemSchema>;

export const DiagnosisCompletenessSchema = z
  .object({
    status: z.enum(['complete', 'partial']),
    items: z.array(DiagnosisCompletenessItemSchema).min(1).max(5_000),
    limitations: z.array(z.string().min(1).max(2_000)).max(200),
  })
  .strict();
export type DiagnosisCompleteness = z.infer<typeof DiagnosisCompletenessSchema>;

export const DiagnosisEvidenceSchema = z
  .object({
    id: z.string().regex(/^evidence-[a-f0-9]{16}$/),
    kind: z.string().min(1).max(128),
    summary: z.string().min(1).max(4_000),
    affectedUnitKeys: z.array(z.string().min(1).max(512)).max(500),
    provenance: DiagnosisProvenanceSchema,
    data: JsonValueSchema,
  })
  .strict();
export type DiagnosisEvidence = z.infer<typeof DiagnosisEvidenceSchema>;

export const DiagnosisReconstructionSignalSchema = z
  .object({
    category: DiagnosisFindingCategorySchema,
    affectedUnitKeys: z.array(z.string().min(1).max(512)).max(500),
    evidenceRefs: z.array(z.string().regex(/^evidence-[a-f0-9]{16}$/)).min(1).max(100),
    summary: z.string().min(1).max(4_000),
    provenance: z.literal('deterministic_reconstruction'),
  })
  .strict();
export type DiagnosisReconstructionSignal = z.infer<typeof DiagnosisReconstructionSignalSchema>;

export const DiagnosisLineageArmSchema = z.enum(['standard', 'control', 'excluded']);
export type DiagnosisLineageArm = z.infer<typeof DiagnosisLineageArmSchema>;

const DiagnosisLineageSchema = z
  .object({
    benchmark: z.string().min(1).max(128),
    role: z.enum(['primary', 'holdout']),
    arm: DiagnosisLineageArmSchema.default('standard'),
    replicate: z.number().int().positive(),
    caseId: z.string().min(1).max(256).nullable(),
    runId: z.string().min(1).max(256).nullable(),
    status: z.string().min(1).max(128),
  })
  .strict();

export const DiagnosisInputSchema = z
  .object({
    kind: z.literal('ainative-planner-eval/diagnosis-input'),
    schemaVersion: z.literal(1),
    interpretationPolicy: z.literal(
      'Diagnosis is model-generated, unverified, and excluded from numeric scoring.',
    ),
    campaign: z
      .object({
        id: z.string().min(1).max(128),
        plannerSeed: z.string().min(1).max(128),
        workflowsRevision: z.string().min(1).max(128),
        environmentSha256: Sha256Schema,
        benchmarkPins: z.array(
          z
            .object({
              name: z.string().min(1).max(128),
              role: z.enum(['primary', 'holdout']),
              sha256: Sha256Schema.nullable(),
            })
            .strict(),
          ),
        targetExcludedProtocol: z
          .object({
            protocol: z.enum(['dedicated-control-v1', 'standard-primary-v2']).optional(),
            targetImplementationWorkflow: WorkflowKeySchema,
            baselineVariantId: z.string().min(1).max(256),
            comparatorImage: Sha256Schema,
            replicates: z.literal(2),
            concurrency: z.literal(2),
            warningBuildDropRatio: z.literal(0.08),
            blockBuildDropRatio: z.literal(0.15),
            sourceManifestSha256: Sha256Schema.nullable(),
            normalArmBinding: z
              .object({
                source: z.literal('standard_primary'),
                benchmark: z.string().min(1).max(128),
                resolvedArtifactSha: Sha256Schema,
                replicates: z.tuple([
                  z
                    .object({
                      replicate: z.literal(1),
                      caseId: z.string().min(1).max(256),
                      runId: z.string().min(1).max(256),
                    })
                    .strict(),
                  z
                    .object({
                      replicate: z.literal(2),
                      caseId: z.string().min(1).max(256),
                      runId: z.string().min(1).max(256),
                    })
                    .strict(),
                ]),
              })
              .strict()
              .nullable()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    variant: z
      .object({
        id: z.string().min(1).max(256),
        parentVariantId: z.string().min(1).max(256).nullable(),
        round: z.number().int().nonnegative(),
        artifactCollectionComplete: z.boolean(),
      })
      .strict(),
    lineage: z.array(DiagnosisLineageSchema).max(1_000),
    completeness: DiagnosisCompletenessSchema,
    evidence: z.array(DiagnosisEvidenceSchema).max(10_000),
    reconstructionSignals: z.array(DiagnosisReconstructionSignalSchema).max(5_000),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.evidence.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['evidence'], message: 'evidence IDs must be unique' });
    }
    const known = new Set(ids);
    for (const [index, signal] of input.reconstructionSignals.entries()) {
      if (signal.evidenceRefs.some((id) => !known.has(id))) {
        context.addIssue({
          code: 'custom',
          path: ['reconstructionSignals', index, 'evidenceRefs'],
          message: 'reconstruction signals must cite input evidence IDs',
        });
      }
    }
  });
export type DiagnosisInput = z.infer<typeof DiagnosisInputSchema>;

export const DiagnosisFindingSchema = z
  .object({
    id: z.string().regex(/^finding-[a-z0-9][a-z0-9._-]{0,79}$/),
    category: DiagnosisFindingCategorySchema,
    affectedUnitKeys: z.array(z.string().min(1).max(512)).max(500),
    causalMechanism: z.string().min(1).max(4_000),
    supportingEvidenceRefs: z
      .array(z.string().regex(/^evidence-[a-f0-9]{16}$/))
      .min(1)
      .max(100),
    counterEvidenceRefs: z
      .array(z.string().regex(/^evidence-[a-f0-9]{16}$/))
      .min(1)
      .max(100),
    confidence: z.enum(['low', 'medium', 'high']),
    genericIntervention: z.string().min(1).max(4_000),
    falsificationTest: z.string().min(1).max(4_000),
    limitations: z.array(z.string().min(1).max(2_000)).min(1).max(50),
    provenance: z.literal('model_inference'),
  })
  .strict();
export type DiagnosisFinding = z.infer<typeof DiagnosisFindingSchema>;

export const DiagnosisOutputSchema = z
  .object({
    kind: z.literal('ainative-planner-eval/model-diagnosis'),
    schemaVersion: z.literal(1),
    interpretationStatus: z.literal('unverified_model_judgment'),
    inputSha256: Sha256Schema,
    summary: z.string().min(1).max(8_000),
    findings: z.array(DiagnosisFindingSchema).max(50),
    limitations: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  })
  .strict()
  .superRefine((output, context) => {
    const ids = output.findings.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'finding IDs must be unique' });
    }
  });
export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;

export const DiagnosisStatusSchema = z.enum([
  'not_started',
  'assembling',
  'running',
  'completed',
  'failed',
  'stale',
]);
export type DiagnosisStatus = z.infer<typeof DiagnosisStatusSchema>;

export const DiagnosisManifestSchema = z
  .object({
    kind: z.literal('ainative-planner-eval/diagnosis-manifest'),
    schemaVersion: z.literal(1),
    inputPath: RelativeArtifactPathSchema,
    inputSha256: Sha256Schema,
    inputBytes: z.number().int().positive(),
    artifacts: z
      .array(
        z
          .object({
            path: RelativeArtifactPathSchema,
            sha256: Sha256Schema,
            bytes: z.number().int().nonnegative(),
            integrity: z.enum(['verified', 'hash_only', 'unverified']),
          })
          .strict(),
      )
      .max(20_000),
  })
  .strict();
export type DiagnosisManifest = z.infer<typeof DiagnosisManifestSchema>;

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
  resolution:
    | 'requirements_agent'
    | 'source_fallback'
    | 'pm_simulation'
    | 'reused_source_answer'
    | 'human_answer';
  answer: string;
  selectedOptionId?: string;
  evidence: string[];
  arm?: 'control' | 'excluded';
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
  pmSimulationAnswers?: number;
  reusedAnswers: number;
  plannerQuestions: number;
  plannerRequirementsAgentRequests: number;
  plannerRequirementsAgentAnswers: number;
  plannerSourceFallbackAnswers: number;
  plannerReusedAnswers: number;
  plannerHumanAnswers?: number;
  entries: QuestionResolutionEntry[];
}

export interface RuntimeQuestionObservation {
  id: string;
  type: string;
  ownerRole: string;
  priority: string;
  prompt: string;
  responseKind?: 'single_select' | 'free_text' | 'value';
  options?: Array<{ id: string; label: string }>;
  rationale: string;
  status: string;
  answer: string | null;
  resolution: 'requirements_agent' | 'source_fallback' | 'reused_source_answer' | 'human_answer' | null;
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

export type TargetExcludedEvaluationStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_for_input'
  | 'judging'
  | 'completed'
  | 'failed';

export interface TargetExcludedComparison {
  replicate: number;
  normalCaseId: string | null;
  excludedCaseId: string | null;
  normalRunId: string | null;
  excludedRunId: string | null;
  valid: boolean;
  mismatches: string[];
  leakagePaths: string[];
  reportHash: string | null;
}

export interface TargetExcludedGate {
  status: 'pending' | 'passed' | 'warning' | 'blocked';
  baselineMeanBuildRate: number | null;
  candidateMeanBuildRate: number | null;
  buildDropRatio: number | null;
  reasons: string[];
}

const TargetNormalArmIdSchema = z.string().min(1).max(256);

export const TargetNormalArmBindingSchema = z
  .object({
    source: z.literal('standard_primary'),
    benchmark: z.string().min(1).max(128),
    resolvedArtifactSha: Sha256Schema,
    replicates: z.tuple([
      z
        .object({
          replicate: z.literal(1),
          caseId: TargetNormalArmIdSchema,
          runId: TargetNormalArmIdSchema,
        })
        .strict(),
      z
        .object({
          replicate: z.literal(2),
          caseId: TargetNormalArmIdSchema,
          runId: TargetNormalArmIdSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type TargetNormalArmBinding = z.output<typeof TargetNormalArmBindingSchema>;

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
  diagnosisStatus: DiagnosisStatus;
  diagnosisInputHash: string | null;
  diagnosisResultHash: string | null;
  diagnosis: DiagnosisOutput | null;
  diagnosisError: string | null;
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

export interface TargetExcludedEvaluationRecord {
  campaignId: string;
  variantId: string;
  status: TargetExcludedEvaluationStatus;
  controlFacts: RunFacts | null;
  controlReplicateFacts: RunFacts[] | null;
  holdoutFacts: Record<string, RunFacts> | null;
  holdoutReplicateFacts: Record<string, RunFacts[]> | null;
  excludedFacts: RunFacts | null;
  excludedReplicateFacts: RunFacts[] | null;
  judgment: JudgeOutput | null;
  score: Score | null;
  questionResolution: BenchmarkQuestionResolution | null;
  executionState: VariantExecutionState | null;
  comparisons: TargetExcludedComparison[] | null;
  gate: TargetExcludedGate | null;
  normalArmBinding: TargetNormalArmBinding | null;
  artifactCollectionComplete: boolean;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
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

export interface TargetExcludedLabelRecord extends Omit<LabelRecord, 'benchmark'> {}
