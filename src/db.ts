import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  CampaignConfig,
  CampaignRecord,
  BenchmarkQuestionResolution,
  DiagnosisOutput,
  DiagnosisStatus,
  Hypothesis,
  HypothesisComplianceOutput,
  HypothesisComplianceAttempt,
  HypothesisComplianceStatus,
  HypothesisInput,
  JudgeOutput,
  LabelRecord,
  RunFacts,
  Score,
  TargetExcludedComparison,
  TargetExcludedConfig,
  TargetExcludedConfigInput,
  TargetExcludedEvaluationRecord,
  TargetExcludedEvaluationStatus,
  TargetExcludedGate,
  TargetExcludedLabelRecord,
  VariantExecutionState,
  VariantRecord,
  VariantStatus,
} from './types.js';
import {
  CampaignConfigSchema,
  DiagnosisOutputSchema,
  HypothesisComplianceOutputSchema,
  HypothesisComplianceAttemptSchema,
  HypothesisSchema,
  TargetExcludedConfigSchema,
  TargetNormalArmBindingSchema,
} from './types.js';
import { mergeExecutionSnapshot } from './executionState.js';

type Row = Record<string, unknown>;

const now = (): string => new Date().toISOString();

function parseJson<T>(value: unknown): T {
  if (typeof value !== 'string') throw new Error('expected persisted JSON string');
  return JSON.parse(value) as T;
}

type PersistedTargetExcludedComparison = Omit<
  TargetExcludedComparison,
  'normalCaseId' | 'excludedCaseId' | 'normalRunId' | 'excludedRunId'
> &
  Partial<
    Pick<
      TargetExcludedComparison,
      'normalCaseId' | 'excludedCaseId' | 'normalRunId' | 'excludedRunId'
    >
  >;

function parseTargetExcludedComparisons(value: unknown): TargetExcludedComparison[] {
  return parseJson<PersistedTargetExcludedComparison[]>(value).map((comparison) => ({
    ...comparison,
    normalCaseId: comparison.normalCaseId ?? null,
    excludedCaseId: comparison.excludedCaseId ?? null,
    normalRunId: comparison.normalRunId ?? null,
    excludedRunId: comparison.excludedRunId ?? null,
  }));
}

function campaignFromRow(row: Row): CampaignRecord {
  return {
    id: String(row.id),
    status: String(row.status),
    config: CampaignConfigSchema.parse(parseJson<CampaignConfig>(row.config_json)),
    seedSha: String(row.seed_sha),
    workflowsSha: String(row.workflows_sha),
    environmentSha: String(row.environment_sha),
    workflowsRemoteUrl: String(row.workflows_remote_url),
    currentParentVariantId:
      row.current_parent_variant_id === null ? null : String(row.current_parent_variant_id),
    noImprovementRounds: Number(row.no_improvement_rounds),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function variantFromRow(row: Row): VariantRecord {
  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    parentVariantId: row.parent_variant_id === null ? null : String(row.parent_variant_id),
    round: Number(row.round),
    ordinal: Number(row.ordinal),
    hypothesis: HypothesisSchema.parse(parseJson<Hypothesis>(row.hypothesis_json)),
    status: String(row.status) as VariantStatus,
    worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    imageTag: row.image_tag === null ? null : String(row.image_tag),
    composeProject: row.compose_project === null ? null : String(row.compose_project),
    baseUrl: row.base_url === null ? null : String(row.base_url),
    patchPath: row.patch_path === null ? null : String(row.patch_path),
    patchHash: row.patch_hash === null ? null : String(row.patch_hash),
    hypothesisComplianceStatus: String(
      row.hypothesis_compliance_status,
    ) as HypothesisComplianceStatus,
    hypothesisCompliancePatchHash:
      row.hypothesis_compliance_patch_hash === null
        ? null
        : String(row.hypothesis_compliance_patch_hash),
    hypothesisComplianceCandidatePatchHash:
      row.hypothesis_compliance_candidate_patch_hash === null
        ? null
        : String(row.hypothesis_compliance_candidate_patch_hash),
    hypothesisComplianceResultHash:
      row.hypothesis_compliance_result_hash === null
        ? null
        : String(row.hypothesis_compliance_result_hash),
    hypothesisCompliance:
      row.hypothesis_compliance_json === null
        ? null
        : HypothesisComplianceOutputSchema.parse(
            parseJson<HypothesisComplianceOutput>(row.hypothesis_compliance_json),
          ),
    hypothesisComplianceError:
      row.hypothesis_compliance_error === null
        ? null
        : String(row.hypothesis_compliance_error),
    hypothesisComplianceAttempts: [],
    artifactCollectionComplete: Boolean(row.artifact_collection_complete),
    facts: row.facts_json === null ? null : parseJson<RunFacts>(row.facts_json),
    replicateFacts:
      row.replicate_facts_json === null ? null : parseJson<RunFacts[]>(row.replicate_facts_json),
    holdoutFacts:
      row.holdout_facts_json === null
        ? null
        : parseJson<Record<string, RunFacts>>(row.holdout_facts_json),
    holdoutReplicateFacts:
      row.holdout_replicate_facts_json === null
        ? null
        : parseJson<Record<string, RunFacts[]>>(row.holdout_replicate_facts_json),
    holdoutJudgments:
      row.holdout_judgments_json === null
        ? null
        : parseJson<Record<string, JudgeOutput>>(row.holdout_judgments_json),
    holdoutScores:
      row.holdout_scores_json === null
        ? null
        : parseJson<Record<string, Score>>(row.holdout_scores_json),
    judgment: row.judgment_json === null ? null : parseJson<JudgeOutput>(row.judgment_json),
    score: row.score_json === null ? null : parseJson<Score>(row.score_json),
    questionResolutions:
      row.question_resolutions_json === null
        ? null
        : parseJson<Record<string, BenchmarkQuestionResolution>>(row.question_resolutions_json),
    executionState:
      row.execution_state_json === null
        ? null
        : parseJson<VariantExecutionState>(row.execution_state_json),
    diagnosisStatus: String(row.diagnosis_status) as DiagnosisStatus,
    diagnosisInputHash:
      row.diagnosis_input_hash === null ? null : String(row.diagnosis_input_hash),
    diagnosisResultHash:
      row.diagnosis_result_hash === null ? null : String(row.diagnosis_result_hash),
    diagnosis:
      row.diagnosis_json === null
        ? null
        : DiagnosisOutputSchema.parse(parseJson<DiagnosisOutput>(row.diagnosis_json)),
    diagnosisError: row.diagnosis_error === null ? null : String(row.diagnosis_error),
    error: row.error === null ? null : String(row.error),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    phase2StartedAt: row.phase2_started_at === null ? null : String(row.phase2_started_at),
    phase2CompletedAt:
      row.phase2_completed_at === null ? null : String(row.phase2_completed_at),
    phase2ElapsedMs: row.phase2_elapsed_ms === null ? null : Number(row.phase2_elapsed_ms),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function labelFromRow(row: Row): LabelRecord {
  return {
    campaignId: String(row.campaign_id),
    benchmark: String(row.benchmark),
    unitKey: String(row.unit_key),
    expectedDecision: String(row.expected_decision) as LabelRecord['expectedDecision'],
    classification: String(row.classification) as LabelRecord['classification'],
    rationale: String(row.rationale),
    status: String(row.status) as LabelRecord['status'],
    updatedAt: String(row.updated_at),
  };
}

function targetExcludedLabelFromRow(row: Row): TargetExcludedLabelRecord {
  return {
    campaignId: String(row.campaign_id),
    unitKey: String(row.unit_key),
    expectedDecision: String(row.expected_decision) as TargetExcludedLabelRecord['expectedDecision'],
    classification: String(row.classification) as TargetExcludedLabelRecord['classification'],
    rationale: String(row.rationale),
    status: String(row.status) as TargetExcludedLabelRecord['status'],
    updatedAt: String(row.updated_at),
  };
}

function targetExcludedEvaluationFromRow(row: Row): TargetExcludedEvaluationRecord {
  return {
    campaignId: String(row.campaign_id),
    variantId: String(row.variant_id),
    status: String(row.status) as TargetExcludedEvaluationStatus,
    controlFacts: row.control_facts_json === null ? null : parseJson<RunFacts>(row.control_facts_json),
    controlReplicateFacts:
      row.control_replicate_facts_json === null
        ? null
        : parseJson<RunFacts[]>(row.control_replicate_facts_json),
    holdoutFacts:
      row.holdout_facts_json === null
        ? null
        : parseJson<Record<string, RunFacts>>(row.holdout_facts_json),
    holdoutReplicateFacts:
      row.holdout_replicate_facts_json === null
        ? null
        : parseJson<Record<string, RunFacts[]>>(row.holdout_replicate_facts_json),
    excludedFacts: row.excluded_facts_json === null ? null : parseJson<RunFacts>(row.excluded_facts_json),
    excludedReplicateFacts:
      row.excluded_replicate_facts_json === null
        ? null
        : parseJson<RunFacts[]>(row.excluded_replicate_facts_json),
    judgment: row.judgment_json === null ? null : parseJson<JudgeOutput>(row.judgment_json),
    score: row.score_json === null ? null : parseJson<Score>(row.score_json),
    questionResolution:
      row.question_resolution_json === null
        ? null
        : parseJson<BenchmarkQuestionResolution>(row.question_resolution_json),
    executionState:
      row.execution_state_json === null
        ? null
        : parseJson<VariantExecutionState>(row.execution_state_json),
    comparisons:
      row.comparisons_json === null
        ? null
        : parseTargetExcludedComparisons(row.comparisons_json),
    gate: row.gate_json === null ? null : parseJson<TargetExcludedGate>(row.gate_json),
    normalArmBinding:
      row.normal_arm_binding_json === null
        ? null
        : TargetNormalArmBindingSchema.parse(parseJson<unknown>(row.normal_arm_binding_json)),
    artifactCollectionComplete: Boolean(row.artifact_collection_complete),
    error: row.error === null ? null : String(row.error),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class HarnessDatabase {
  readonly database: DatabaseSync;

  constructor(filePath: string) {
    this.database = new DatabaseSync(filePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        seed_sha TEXT NOT NULL,
        workflows_sha TEXT NOT NULL,
        environment_sha TEXT NOT NULL,
        workflows_remote_url TEXT NOT NULL,
        current_parent_variant_id TEXT,
        no_improvement_rounds INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS variants (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        parent_variant_id TEXT,
        round INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        hypothesis_json TEXT NOT NULL,
        status TEXT NOT NULL,
        worktree_path TEXT,
        image_tag TEXT,
        compose_project TEXT,
        base_url TEXT,
        patch_path TEXT,
        patch_hash TEXT,
        hypothesis_compliance_status TEXT NOT NULL DEFAULT 'not_required',
        hypothesis_compliance_patch_hash TEXT,
        hypothesis_compliance_candidate_patch_hash TEXT,
        hypothesis_compliance_result_hash TEXT,
        hypothesis_compliance_json TEXT,
        hypothesis_compliance_error TEXT,
        artifact_collection_complete INTEGER NOT NULL DEFAULT 0,
        facts_json TEXT,
        replicate_facts_json TEXT,
        holdout_facts_json TEXT,
        holdout_replicate_facts_json TEXT,
        holdout_judgments_json TEXT,
        holdout_scores_json TEXT,
        judgment_json TEXT,
        score_json TEXT,
        question_resolutions_json TEXT,
        execution_state_json TEXT,
        diagnosis_status TEXT NOT NULL DEFAULT 'not_started',
        diagnosis_input_hash TEXT,
        diagnosis_result_hash TEXT,
        diagnosis_json TEXT,
        diagnosis_error TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        elapsed_ms INTEGER,
        phase2_started_at TEXT,
        phase2_completed_at TEXT,
        phase2_elapsed_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS labels (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        benchmark TEXT NOT NULL,
        unit_key TEXT NOT NULL,
        expected_decision TEXT NOT NULL,
        classification TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(campaign_id, benchmark, unit_key)
      );
      CREATE TABLE IF NOT EXISTS target_excluded_configs (
        campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS target_excluded_evaluations (
        variant_id TEXT PRIMARY KEY REFERENCES variants(id),
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        status TEXT NOT NULL,
        control_facts_json TEXT,
        control_replicate_facts_json TEXT,
        holdout_facts_json TEXT,
        holdout_replicate_facts_json TEXT,
        excluded_facts_json TEXT,
        excluded_replicate_facts_json TEXT,
        judgment_json TEXT,
        score_json TEXT,
        question_resolution_json TEXT,
        execution_state_json TEXT,
        comparisons_json TEXT,
        gate_json TEXT,
        normal_arm_binding_json TEXT,
        artifact_collection_complete INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, variant_id)
      );
      CREATE TABLE IF NOT EXISTS target_excluded_labels (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        unit_key TEXT NOT NULL,
        expected_decision TEXT NOT NULL,
        classification TEXT NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(campaign_id, unit_key)
      );
      CREATE TABLE IF NOT EXISTS hypothesis_compliance_attempts (
        variant_id TEXT NOT NULL REFERENCES variants(id),
        attempt INTEGER NOT NULL,
        attempt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(variant_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        variant_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS variants_campaign_idx ON variants(campaign_id, ordinal);
      CREATE INDEX IF NOT EXISTS events_campaign_idx ON events(campaign_id, id);
      CREATE INDEX IF NOT EXISTS target_excluded_evaluations_campaign_idx
        ON target_excluded_evaluations(campaign_id, created_at);
    `);
    this.ensureColumn('campaigns', 'environment_sha', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('campaigns', 'workflows_remote_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('campaigns', 'lease_owner', 'TEXT');
    this.ensureColumn('campaigns', 'lease_expires_at', 'INTEGER');
    this.ensureColumn('variants', 'holdout_facts_json', 'TEXT');
    this.ensureColumn('variants', 'patch_hash', 'TEXT');
    this.ensureColumn('variants', 'artifact_collection_complete', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('variants', 'replicate_facts_json', 'TEXT');
    this.ensureColumn('variants', 'holdout_replicate_facts_json', 'TEXT');
    this.ensureColumn('variants', 'holdout_judgments_json', 'TEXT');
    this.ensureColumn('variants', 'holdout_scores_json', 'TEXT');
    this.ensureColumn('variants', 'question_resolutions_json', 'TEXT');
    this.ensureColumn('variants', 'execution_state_json', 'TEXT');
    this.ensureColumn('variants', 'diagnosis_status', "TEXT NOT NULL DEFAULT 'not_started'");
    this.ensureColumn('variants', 'diagnosis_input_hash', 'TEXT');
    this.ensureColumn('variants', 'diagnosis_result_hash', 'TEXT');
    this.ensureColumn('variants', 'diagnosis_json', 'TEXT');
    this.ensureColumn('variants', 'diagnosis_error', 'TEXT');
    this.ensureColumn(
      'variants',
      'hypothesis_compliance_status',
      "TEXT NOT NULL DEFAULT 'not_required'",
    );
    this.ensureColumn('variants', 'hypothesis_compliance_patch_hash', 'TEXT');
    this.ensureColumn('variants', 'hypothesis_compliance_candidate_patch_hash', 'TEXT');
    this.ensureColumn('variants', 'hypothesis_compliance_result_hash', 'TEXT');
    this.ensureColumn('variants', 'hypothesis_compliance_json', 'TEXT');
    this.ensureColumn('variants', 'hypothesis_compliance_error', 'TEXT');
    this.ensureColumn('variants', 'started_at', 'TEXT');
    this.ensureColumn('variants', 'completed_at', 'TEXT');
    this.ensureColumn('variants', 'elapsed_ms', 'INTEGER');
    this.ensureColumn('variants', 'phase2_started_at', 'TEXT');
    this.ensureColumn('variants', 'phase2_completed_at', 'TEXT');
    this.ensureColumn('variants', 'phase2_elapsed_ms', 'INTEGER');
    this.ensureColumn('target_excluded_evaluations', 'normal_arm_binding_json', 'TEXT');
  }

  private ensureColumn(
    table: 'campaigns' | 'variants' | 'target_excluded_evaluations',
    column: string,
    definition: string,
  ): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createCampaign(
    config: CampaignConfig,
    seedSha: string,
    workflowsSha: string,
    environmentSha: string,
    workflowsRemoteUrl: string,
  ): CampaignRecord {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO campaigns
          (id, status, config_json, seed_sha, workflows_sha, environment_sha, workflows_remote_url, current_parent_variant_id, no_improvement_rounds, created_at, updated_at)
         VALUES (?, 'ready', ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(
        config.id,
        JSON.stringify(config),
        seedSha,
        workflowsSha,
        environmentSha,
        workflowsRemoteUrl,
        timestamp,
        timestamp,
      );
    this.addEvent(config.id, null, 'campaign.created', {
      seedSha,
      workflowsSha,
      environmentSha,
      workflowsRemoteUrl,
    });
    return this.getCampaign(config.id);
  }

  acquireLease(campaignId: string, owner: string, ttlMs: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE campaigns SET lease_owner = ?, lease_expires_at = ?
         WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at < ? OR lease_owner = ?)`,
      )
      .run(owner, Date.now() + ttlMs, campaignId, Date.now(), owner);
    return result.changes === 1;
  }

  renewLease(campaignId: string, owner: string, ttlMs: number): boolean {
    const result = this.database
      .prepare('UPDATE campaigns SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?')
      .run(Date.now() + ttlMs, campaignId, owner);
    return result.changes === 1;
  }

  releaseLease(campaignId: string, owner: string): void {
    this.database
      .prepare(
        'UPDATE campaigns SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?',
      )
      .run(campaignId, owner);
  }

  getCampaign(id: string): CampaignRecord {
    const row = this.database.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`campaign not found: ${id}`);
    return campaignFromRow(row);
  }

  listCampaigns(): CampaignRecord[] {
    return (this.database.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all() as Row[]).map(
      campaignFromRow,
    );
  }

  updateCampaign(
    id: string,
    changes: {
      status?: string;
      currentParentVariantId?: string | null;
      noImprovementRounds?: number;
    },
  ): CampaignRecord {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    if (changes.status !== undefined) {
      assignments.push('status = ?');
      values.push(changes.status);
    }
    if (changes.currentParentVariantId !== undefined) {
      assignments.push('current_parent_variant_id = ?');
      values.push(changes.currentParentVariantId);
    }
    if (changes.noImprovementRounds !== undefined) {
      assignments.push('no_improvement_rounds = ?');
      values.push(changes.noImprovementRounds);
    }
    if (assignments.length === 0) return this.getCampaign(id);
    assignments.push('updated_at = ?');
    values.push(now(), id);
    this.database.prepare(`UPDATE campaigns SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    const campaign = this.getCampaign(id);
    this.addEvent(id, null, 'campaign.updated', changes);
    return campaign;
  }

  createVariant(input: {
    id: string;
    campaignId: string;
    parentVariantId: string | null;
    round: number;
    ordinal: number;
    hypothesis: HypothesisInput;
  }): VariantRecord {
    const timestamp = now();
    const hypothesis = HypothesisSchema.parse(input.hypothesis);
    this.database
      .prepare(
        `INSERT INTO variants
          (id, campaign_id, parent_variant_id, round, ordinal, hypothesis_json, status, hypothesis_compliance_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.campaignId,
        input.parentVariantId,
        input.round,
        input.ordinal,
        JSON.stringify(hypothesis),
        input.round === 0 ? 'not_required' : 'not_started',
        timestamp,
        timestamp,
      );
    this.addEvent(input.campaignId, input.id, 'variant.created', { hypothesis });
    return this.getVariant(input.id);
  }

  getVariant(id: string): VariantRecord {
    const row = this.database.prepare('SELECT * FROM variants WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`variant not found: ${id}`);
    return { ...variantFromRow(row), hypothesisComplianceAttempts: this.listHypothesisComplianceAttempts(id) };
  }

  listVariants(campaignId: string): VariantRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM variants WHERE campaign_id = ? ORDER BY ordinal ASC')
        .all(campaignId) as Row[]
    ).map((row) => {
      const variant = variantFromRow(row);
      return {
        ...variant,
        hypothesisComplianceAttempts: this.listHypothesisComplianceAttempts(variant.id),
      };
    });
  }

  private listHypothesisComplianceAttempts(variantId: string): HypothesisComplianceAttempt[] {
    const rows = this.database
      .prepare(
        'SELECT attempt_json FROM hypothesis_compliance_attempts WHERE variant_id = ? ORDER BY attempt ASC',
      )
      .all(variantId) as Row[];
    return rows.map((row) =>
      HypothesisComplianceAttemptSchema.parse(parseJson<unknown>(row.attempt_json)),
    );
  }

  appendHypothesisComplianceAttempt(
    variantId: string,
    input: HypothesisComplianceAttempt,
  ): HypothesisComplianceAttempt {
    const variant = this.getVariant(variantId);
    const attempt = HypothesisComplianceAttemptSchema.parse(input);
    if (attempt.variantId !== variantId) {
      throw new Error('hypothesis compliance attempt belongs to another variant');
    }
    const existing = this.database
      .prepare(
        'SELECT attempt_json FROM hypothesis_compliance_attempts WHERE variant_id = ? AND attempt = ?',
      )
      .get(variantId, attempt.attempt) as Row | undefined;
    if (existing) {
      const persisted = HypothesisComplianceAttemptSchema.parse(
        parseJson<unknown>(existing.attempt_json),
      );
      if (JSON.stringify(persisted) !== JSON.stringify(attempt)) {
        throw new Error('immutable hypothesis compliance attempt changed');
      }
      return persisted;
    }
    this.database
      .prepare(
        `INSERT INTO hypothesis_compliance_attempts
          (variant_id, attempt, attempt_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(variantId, attempt.attempt, JSON.stringify(attempt), now());
    this.addEvent(variant.campaignId, variantId, 'hypothesis_compliance.attempted', {
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      resultSha256: attempt.resultSha256,
    });
    return attempt;
  }

  updateVariant(
    id: string,
    changes: Partial<{
      status: VariantStatus;
      worktreePath: string | null;
      imageTag: string | null;
      composeProject: string | null;
      baseUrl: string | null;
      patchPath: string | null;
      patchHash: string | null;
      hypothesisComplianceStatus: HypothesisComplianceStatus;
      hypothesisCompliancePatchHash: string | null;
      hypothesisComplianceCandidatePatchHash: string | null;
      hypothesisComplianceResultHash: string | null;
      hypothesisCompliance: HypothesisComplianceOutput | null;
      hypothesisComplianceError: string | null;
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
    }>,
  ): VariantRecord {
    const columns = {
      status: 'status',
      worktreePath: 'worktree_path',
      imageTag: 'image_tag',
      composeProject: 'compose_project',
      baseUrl: 'base_url',
      patchPath: 'patch_path',
      patchHash: 'patch_hash',
      hypothesisComplianceStatus: 'hypothesis_compliance_status',
      hypothesisCompliancePatchHash: 'hypothesis_compliance_patch_hash',
      hypothesisComplianceCandidatePatchHash: 'hypothesis_compliance_candidate_patch_hash',
      hypothesisComplianceResultHash: 'hypothesis_compliance_result_hash',
      hypothesisCompliance: 'hypothesis_compliance_json',
      hypothesisComplianceError: 'hypothesis_compliance_error',
      artifactCollectionComplete: 'artifact_collection_complete',
      facts: 'facts_json',
      replicateFacts: 'replicate_facts_json',
      holdoutFacts: 'holdout_facts_json',
      holdoutReplicateFacts: 'holdout_replicate_facts_json',
      holdoutJudgments: 'holdout_judgments_json',
      holdoutScores: 'holdout_scores_json',
      judgment: 'judgment_json',
      score: 'score_json',
      questionResolutions: 'question_resolutions_json',
      executionState: 'execution_state_json',
      diagnosisStatus: 'diagnosis_status',
      diagnosisInputHash: 'diagnosis_input_hash',
      diagnosisResultHash: 'diagnosis_result_hash',
      diagnosis: 'diagnosis_json',
      diagnosisError: 'diagnosis_error',
      error: 'error',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      elapsedMs: 'elapsed_ms',
      phase2StartedAt: 'phase2_started_at',
      phase2CompletedAt: 'phase2_completed_at',
      phase2ElapsedMs: 'phase2_elapsed_ms',
    } as const;
    const jsonFields = new Set([
      'facts',
      'replicateFacts',
      'holdoutFacts',
      'holdoutReplicateFacts',
      'holdoutJudgments',
      'holdoutScores',
      'judgment',
      'score',
      'questionResolutions',
      'executionState',
      'diagnosis',
      'hypothesisCompliance',
    ]);
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const column = columns[key as keyof typeof columns];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(
        value === null
          ? null
          : jsonFields.has(key)
            ? JSON.stringify(value)
            : typeof value === 'boolean'
              ? value
                ? 1
                : 0
              : typeof value === 'number'
                ? value
                : String(value),
      );
    }
    if (assignments.length === 0) return this.getVariant(id);
    assignments.push('updated_at = ?');
    values.push(now(), id);
    this.database.prepare(`UPDATE variants SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    const variant = this.getVariant(id);
    this.addEvent(variant.campaignId, id, 'variant.updated', changes);
    return variant;
  }

  updateVariantExecution(
    id: string,
    input: Parameters<typeof mergeExecutionSnapshot>[1],
  ): VariantRecord {
    const variant = this.getVariant(id);
    const executionState = mergeExecutionSnapshot(variant.executionState, input);
    if (JSON.stringify(executionState) === JSON.stringify(variant.executionState)) return variant;
    return this.updateVariant(id, { executionState });
  }

  upsertLabel(label: Omit<LabelRecord, 'updatedAt'>): LabelRecord {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO labels
          (campaign_id, benchmark, unit_key, expected_decision, classification, rationale, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, benchmark, unit_key) DO UPDATE SET
          expected_decision = excluded.expected_decision,
          classification = excluded.classification,
          rationale = excluded.rationale,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        label.campaignId,
        label.benchmark,
        label.unitKey,
        label.expectedDecision,
        label.classification,
        label.rationale,
        label.status,
        timestamp,
      );
    this.addEvent(label.campaignId, null, 'label.updated', { ...label, updatedAt: timestamp });
    if (label.status === 'verified') {
      this.markCampaignDiagnosesStale(
        label.campaignId,
        `Human label changed for ${label.benchmark}/${label.unitKey}.`,
      );
    }
    return { ...label, updatedAt: timestamp };
  }

  markCampaignDiagnosesStale(campaignId: string, reason: string): number {
    const timestamp = now();
    const result = this.database
      .prepare(
        `UPDATE variants
         SET diagnosis_status = 'stale', diagnosis_error = ?, updated_at = ?
         WHERE campaign_id = ?
           AND diagnosis_status IN ('assembling', 'running', 'completed', 'failed')`,
      )
      .run(reason.slice(0, 20_000), timestamp, campaignId);
    if (result.changes > 0) {
      this.addEvent(campaignId, null, 'diagnosis.stale', {
        reason: reason.slice(0, 2_000),
        variants: result.changes,
      });
    }
    return Number(result.changes);
  }

  listLabels(campaignId: string, benchmark?: string): LabelRecord[] {
    const rows = benchmark
      ? (this.database
          .prepare('SELECT * FROM labels WHERE campaign_id = ? AND benchmark = ? ORDER BY unit_key')
          .all(campaignId, benchmark) as Row[])
      : (this.database
          .prepare('SELECT * FROM labels WHERE campaign_id = ? ORDER BY benchmark, unit_key')
          .all(campaignId) as Row[]);
    return rows.map(labelFromRow);
  }

  createTargetExcludedConfig(campaignId: string, input: TargetExcludedConfigInput): TargetExcludedConfig {
    this.getCampaign(campaignId);
    if (this.getTargetExcludedConfig(campaignId)) {
      throw new Error(`target-excluded protocol is already configured: ${campaignId}`);
    }
    const config = TargetExcludedConfigSchema.parse(input);
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO target_excluded_configs (campaign_id, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(campaignId, JSON.stringify(config), timestamp, timestamp);
    this.addEvent(campaignId, null, 'target_excluded.configured', config);
    this.markCampaignDiagnosesStale(
      campaignId,
      `Target-excluded protocol configured for ${config.targetImplementationWorkflow}.`,
    );
    return config;
  }

  getTargetExcludedConfig(campaignId: string): TargetExcludedConfig | null {
    const row = this.database
      .prepare('SELECT config_json FROM target_excluded_configs WHERE campaign_id = ?')
      .get(campaignId) as Row | undefined;
    return row ? TargetExcludedConfigSchema.parse(parseJson<unknown>(row.config_json)) : null;
  }

  createTargetExcludedEvaluation(
    campaignId: string,
    variantId: string,
  ): TargetExcludedEvaluationRecord {
    const variant = this.getVariant(variantId);
    if (variant.campaignId !== campaignId) throw new Error('variant belongs to another campaign');
    const existing = this.getTargetExcludedEvaluation(variantId);
    if (existing) return existing;
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO target_excluded_evaluations
          (variant_id, campaign_id, status, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?)`,
      )
      .run(variantId, campaignId, timestamp, timestamp);
    this.addEvent(campaignId, variantId, 'target_excluded.created', {});
    return this.getTargetExcludedEvaluation(variantId)!;
  }

  getTargetExcludedEvaluation(variantId: string): TargetExcludedEvaluationRecord | null {
    const row = this.database
      .prepare('SELECT * FROM target_excluded_evaluations WHERE variant_id = ?')
      .get(variantId) as Row | undefined;
    return row ? targetExcludedEvaluationFromRow(row) : null;
  }

  listTargetExcludedEvaluations(campaignId: string): TargetExcludedEvaluationRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM target_excluded_evaluations WHERE campaign_id = ? ORDER BY created_at')
        .all(campaignId) as Row[]
    ).map(targetExcludedEvaluationFromRow);
  }

  updateTargetExcludedEvaluation(
    variantId: string,
    changes: Partial<
      Pick<
        TargetExcludedEvaluationRecord,
        | 'status'
        | 'controlFacts'
        | 'controlReplicateFacts'
        | 'holdoutFacts'
        | 'holdoutReplicateFacts'
        | 'excludedFacts'
        | 'excludedReplicateFacts'
        | 'judgment'
        | 'score'
        | 'questionResolution'
        | 'executionState'
        | 'comparisons'
        | 'gate'
        | 'normalArmBinding'
        | 'artifactCollectionComplete'
        | 'error'
        | 'startedAt'
        | 'completedAt'
      >
    >,
  ): TargetExcludedEvaluationRecord {
    const columns: Record<string, string> = {
      status: 'status',
      controlFacts: 'control_facts_json',
      controlReplicateFacts: 'control_replicate_facts_json',
      holdoutFacts: 'holdout_facts_json',
      holdoutReplicateFacts: 'holdout_replicate_facts_json',
      excludedFacts: 'excluded_facts_json',
      excludedReplicateFacts: 'excluded_replicate_facts_json',
      judgment: 'judgment_json',
      score: 'score_json',
      questionResolution: 'question_resolution_json',
      executionState: 'execution_state_json',
      comparisons: 'comparisons_json',
      gate: 'gate_json',
      normalArmBinding: 'normal_arm_binding_json',
      artifactCollectionComplete: 'artifact_collection_complete',
      error: 'error',
      startedAt: 'started_at',
      completedAt: 'completed_at',
    };
    const scalar = new Set(['status', 'error', 'startedAt', 'completedAt']);
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const column = columns[key];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(
        value === null
          ? null
          : key === 'artifactCollectionComplete'
            ? value
              ? 1
              : 0
            : scalar.has(key)
              ? String(value)
              : JSON.stringify(value),
      );
    }
    if (assignments.length === 0) return this.getTargetExcludedEvaluation(variantId)!;
    assignments.push('updated_at = ?');
    values.push(now(), variantId);
    this.database
      .prepare(`UPDATE target_excluded_evaluations SET ${assignments.join(', ')} WHERE variant_id = ?`)
      .run(...values);
    const evaluation = this.getTargetExcludedEvaluation(variantId);
    if (!evaluation) throw new Error(`target-excluded evaluation not found: ${variantId}`);
    this.addEvent(evaluation.campaignId, variantId, 'target_excluded.updated', changes);
    return evaluation;
  }

  updateTargetExcludedExecution(
    variantId: string,
    input: Parameters<typeof mergeExecutionSnapshot>[1],
  ): TargetExcludedEvaluationRecord {
    const evaluation = this.getTargetExcludedEvaluation(variantId);
    if (!evaluation) throw new Error(`target-excluded evaluation not found: ${variantId}`);
    const executionState = mergeExecutionSnapshot(evaluation.executionState, input);
    if (JSON.stringify(executionState) === JSON.stringify(evaluation.executionState)) return evaluation;
    return this.updateTargetExcludedEvaluation(variantId, { executionState });
  }

  upsertTargetExcludedLabel(
    label: Omit<TargetExcludedLabelRecord, 'updatedAt'>,
  ): TargetExcludedLabelRecord {
    const timestamp = now();
    this.database
      .prepare(
        `INSERT INTO target_excluded_labels
          (campaign_id, unit_key, expected_decision, classification, rationale, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, unit_key) DO UPDATE SET
          expected_decision = excluded.expected_decision,
          classification = excluded.classification,
          rationale = excluded.rationale,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        label.campaignId,
        label.unitKey,
        label.expectedDecision,
        label.classification,
        label.rationale,
        label.status,
        timestamp,
      );
    this.addEvent(label.campaignId, null, 'target_excluded.label_updated', {
      ...label,
      updatedAt: timestamp,
    });
    if (label.status === 'verified') {
      this.markCampaignDiagnosesStale(
        label.campaignId,
        `Human target-excluded label changed for ${label.unitKey}.`,
      );
    }
    return { ...label, updatedAt: timestamp };
  }

  listTargetExcludedLabels(campaignId: string): TargetExcludedLabelRecord[] {
    return (
      this.database
        .prepare('SELECT * FROM target_excluded_labels WHERE campaign_id = ? ORDER BY unit_key')
        .all(campaignId) as Row[]
    ).map(targetExcludedLabelFromRow);
  }

  addEvent(
    campaignId: string,
    variantId: string | null,
    type: string,
    payload: unknown,
  ): void {
    this.database
      .prepare(
        'INSERT INTO events (campaign_id, variant_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(campaignId, variantId, type, JSON.stringify(payload), now());
  }

  listEvents(campaignId: string, afterId = 0): Array<{
    id: number;
    campaignId: string;
    variantId: string | null;
    type: string;
    payload: unknown;
    createdAt: string;
  }> {
    const rows = this.database
      .prepare('SELECT * FROM events WHERE campaign_id = ? AND id > ? ORDER BY id ASC')
      .all(campaignId, afterId) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      campaignId: String(row.campaign_id),
      variantId: row.variant_id === null ? null : String(row.variant_id),
      type: String(row.type),
      payload: parseJson(row.payload_json),
      createdAt: String(row.created_at),
    }));
  }
}
