import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { HarnessPaths } from './paths.js';
import type { CampaignRecord, JsonObject, Phase2RunSnapshot, TargetExcludedEvaluationRecord, VariantRecord } from './types.js';

export interface ExecutionFailure {
  origin: 'planner' | 'http' | 'harness';
  code: string | null;
  message: string;
  occurredAt?: string;
  failedRequirementUnitIds?: string[];
  lastCheckpointStage?: string;
  providerRetryBudgetAvailable?: boolean | null;
  httpStatus?: number;
  details?: JsonObject | null;
  provenance?: { artifactPath?: string; source: 'runtime' | 'event' | 'archive' };
}

export interface FailureContext {
  caseId?: string | null;
  runId?: string | null;
  status?: string;
  origin?: ExecutionFailure['origin'];
  httpStatus?: number;
  artifactPath?: string;
  source?: 'runtime' | 'event' | 'archive';
}

const MESSAGES: Record<string, string> = {
  model_boundary_violation_candidate_outside_shortlist: 'The planner selected a candidate outside the allowed shortlist.',
  model_boundary_violation_evidence_outside_supplied_set: 'The planner referenced evidence outside the supplied set.',
  model_boundary_violation_question_outside_unit: 'The planner raised a question outside the current requirement unit.',
  model_boundary_violation_transient_source_echo: 'The planner echoed transient source content.',
  model_boundary_violation: 'The planner response violated an evidence boundary.',
  model_transport_error: 'The model provider request failed in transit.',
  model_timeout: 'The model provider request timed out.',
  model_invalid_response: 'The model provider returned an invalid response.',
  model_invalid_input: 'The model request input was invalid.',
  model_pin_mismatch: 'The model request did not match the pinned configuration.',
  model_provider_rejected: 'The model provider rejected the request.',
  model_aborted: 'The model provider request was aborted.',
  model_budget_exceeded: 'The model request exceeded its budget.',
  aggregate_budget_exceeded: 'The analysis exceeded its aggregate budget.',
  invalid_model_response: 'The planner could not validate the model response.',
  interrupted_inflight: 'The analysis was interrupted with a provider request in flight.',
  source_policy_violation: 'The analysis violated the pinned source policy.',
  analysis_failed: 'The planner analysis failed; exact diagnostic details are unavailable.',
  cancelled: 'The planner run was cancelled.',
  superseded: 'The planner run was superseded.',
  InvalidRequest: 'The planner rejected an invalid HTTP request.',
};
const UNAVAILABLE = 'Execution failed; diagnostic details are unavailable.';
const TERMINAL_FAILURE = new Set(['failed', 'cancelled', 'superseded']);
const STAGES = new Set(['decomposing', 'ranking', 'waiting_upstream', 'adjudicating', 'waiting_for_input', 'publishing', 'completed', 'failed']);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    !/(?:secret|password|bearer|api[_-]?key|token|sk-[A-Za-z0-9])/i.test(value)
    ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function knownCode(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(MESSAGES, value) ? value : null;
}

function safeArtifactPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048 &&
    value.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ? value : undefined;
}

const DiagnosticIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const DiagnosticCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const DiagnosticIndexSchema = DiagnosticCountSchema.max(4);

// Mirrors the planner's candidateBoundaryDiagnostic.ts V1 wire contract.
const CandidateBoundaryDetailsSchema = z.object({
  kind: z.literal('candidate_outside_shortlist'),
  version: z.literal(1),
  requirementUnitId: DiagnosticIdSchema,
  disposition: z.enum(['build', 'reuse', 'extend', 'defer', 'question']),
  selected: z.array(z.union([
    z.object({
      index: DiagnosticIndexSchema,
      id: DiagnosticIdSchema,
      allowed: z.boolean(),
      origin: z.enum(['shortlist', 'discovered', 'supporting']),
    }).strict(),
    z.object({
      index: DiagnosticIndexSchema,
      sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      utf8Bytes: DiagnosticCountSchema,
      allowed: z.literal(false),
      origin: z.literal('unknown'),
    }).strict(),
  ])).min(1).max(5),
  allowedIds: z.array(DiagnosticIdSchema).max(32),
  counts: z.object({
    selected: DiagnosticCountSchema,
    allowed: DiagnosticCountSchema,
    shortlist: DiagnosticCountSchema,
    discovered: DiagnosticCountSchema,
    supporting: DiagnosticCountSchema,
  }).strict(),
  truncated: z.boolean(),
}).strict().refine((details) =>
  details.selected.length === Math.min(details.counts.selected, 5) &&
  details.selected.every((selection, index) => selection.index === index) &&
  details.allowedIds.length === Math.min(details.counts.allowed, 32) &&
  new Set(details.allowedIds).size === details.allowedIds.length &&
  details.truncated === (details.counts.selected > 5 || details.counts.allowed > 32) &&
  Buffer.byteLength(JSON.stringify(details), 'utf8') <= 8 * 1024,
);

// Only this versioned planner diagnostic is public. Never recursively copy metadata.
function failureDetails(value: unknown): JsonObject | null {
  const raw = record(value);
  if (!Array.isArray(raw.selected) || raw.selected.length > 5 ||
    !Array.isArray(raw.allowedIds) || raw.allowedIds.length > 32) return null;
  const parsed = CandidateBoundaryDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function matchingFailureEvent(response: unknown, caseId: unknown, runId: unknown): Record<string, unknown> | undefined {
  if (!identifier(caseId) || !identifier(runId)) return undefined;
  const events = record(response).events;
  if (!Array.isArray(events)) return undefined;
  return events.map(record).filter((event) => event.name === 'run.failed' && event.caseId === caseId &&
    record(event.payload).runId === runId &&
    (record(event.payload).caseId === undefined || record(event.payload).caseId === caseId))
    .sort((a, b) => (count(a.sequence) ?? 0) - (count(b.sequence) ?? 0) ||
      (timestamp(a.occurredAt) ?? '').localeCompare(timestamp(b.occurredAt) ?? '')).at(-1);
}

export function normalizeExecutionFailure(response: unknown, context: FailureContext = {}): ExecutionFailure | null {
  const raw = record(response);
  const runtime = record(raw.runtime);
  const run = record(raw.run);
  const persisted = record(raw.failure);
  const status = context.status ?? runtime.status ?? run.status ?? raw.status;
  if (status === 'completed') return null;
  const caseId = context.caseId ?? run.caseId ?? runtime.caseId ?? raw.caseId;
  const runId = context.runId ?? run.id ?? runtime.id ?? raw.runId;
  const event = matchingFailureEvent(raw, caseId, runId);
  const payload = record(event?.payload);
  const httpStatus = count(context.httpStatus ?? persisted.httpStatus);
  if (!TERMINAL_FAILURE.has(String(status)) && !event && !Object.keys(persisted).length && !(httpStatus && httpStatus >= 400)) return null;
  const code = knownCode(runtime.failureCode) ?? knownCode(payload.code) ?? knownCode(persisted.code) ?? knownCode(raw.code) ?? knownCode(raw.error);
  const origin = context.origin ?? (httpStatus ? 'http' :
    persisted.origin === 'harness' || persisted.origin === 'http' ? persisted.origin : 'planner');
  const failure: ExecutionFailure = {
    origin, code, message: code ? MESSAGES[code]! : httpStatus ? 'The planner HTTP request failed; diagnostic details are unavailable.' : UNAVAILABLE,
    providerRetryBudgetAvailable: typeof runtime.providerRetryBudgetAvailable === 'boolean' ? runtime.providerRetryBudgetAvailable :
      typeof persisted.providerRetryBudgetAvailable === 'boolean' ? persisted.providerRetryBudgetAvailable : null,
    details: failureDetails(payload.details) ?? failureDetails(runtime.failureDetails) ?? failureDetails(persisted.details),
  };
  const occurredAt = timestamp(event?.occurredAt) ?? timestamp(persisted.occurredAt) ?? timestamp(runtime.updatedAt) ?? timestamp(run.updatedAt);
  if (occurredAt) failure.occurredAt = occurredAt;
  const checkpoint = record(raw.checkpoint);
  const metadata = record(raw.checkpointMetadata);
  const units = checkpoint.failedRequirementUnitIds ?? metadata.failedRequirementUnitIds ?? persisted.failedRequirementUnitIds;
  if (Array.isArray(units)) failure.failedRequirementUnitIds = [...new Set(units.slice(0, 100).flatMap((unit) => identifier(unit) ? [unit as string] : []))];
  if (!failure.failedRequirementUnitIds?.length && typeof failure.details?.requirementUnitId === 'string') {
    failure.failedRequirementUnitIds = [failure.details.requirementUnitId];
  }
  const stage = metadata.stage ?? checkpoint.stage ?? persisted.lastCheckpointStage;
  if (typeof stage === 'string' && STAGES.has(stage)) failure.lastCheckpointStage = stage;
  if (httpStatus && httpStatus >= 400 && httpStatus <= 599) failure.httpStatus = httpStatus;
  const provenance = record(persisted.provenance);
  const artifactPath = safeArtifactPath(context.artifactPath ?? provenance.artifactPath);
  const source = context.source ?? (event ? 'event' :
    provenance.source === 'event' || provenance.source === 'archive' ? provenance.source : 'runtime');
  failure.provenance = { source, ...(artifactPath ? { artifactPath } : {}) };
  return failure;
}

/** Safe for public errors. Raw Error.message, causes and HTTP bodies stay private. */
export function safeExecutionError(error: unknown): string {
  const raw = record(error);
  const failure = normalizeExecutionFailure({ failure: raw.failure, code: raw.code, status: 'failed' }, { origin: 'harness' });
  return failure?.message ?? UNAVAILABLE;
}

export interface VariantDiagnostics {
  status: 'blocked' | 'complete' | 'running' | 'unknown';
  counts: { completed: number; failed: number; pending: number; total: number };
  failures: Array<{
    scope: 'standard' | 'control' | 'excluded'; benchmark: string; replicate: number;
    caseId: string | null; runId: string | null; progress: Phase2RunSnapshot['progress'];
    /** Null means this failed execution has no safely captured diagnostic evidence. */
    failure: ExecutionFailure | null;
  }>;
  standardAvailable: boolean;
}

async function readArchive(root: string, segments: string[]): Promise<unknown> {
  if (!segments.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return null;
  let handle;
  try {
    if (!(await lstat(root)).isDirectory()) return null;
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      if (!(await lstat(current)).isDirectory()) return null;
    }
    const filename = path.join(root, ...segments);
    if (!(await lstat(filename)).isFile()) return null;
    const canonical = path.join(await realpath(root), ...segments);
    if (await realpath(filename) !== canonical) return null;
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > stat.size || await realpath(filename) !== canonical) return null;
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function matchesRun(value: unknown, caseId: string, runId: string): boolean {
  const raw = record(value);
  const records = [raw.run, raw.runtime].filter((item) => Object.keys(record(item)).length).map(record);
  if (!records.length) return raw.caseId === caseId && raw.runId === runId;
  return records.some((item) => item.caseId === caseId && item.id === runId) &&
    records.every((item) => (item.caseId === undefined || item.caseId === caseId) && (item.id === undefined || item.id === runId)) &&
    [raw.checkpointMetadata, raw.checkpoint].every((item) => {
      const checkpoint = record(item);
      return (checkpoint.caseId === undefined || checkpoint.caseId === caseId) && (checkpoint.runId === undefined || checkpoint.runId === runId);
    });
}

export async function readVariantDiagnostics(
  paths: HarnessPaths, campaign: CampaignRecord, variant: VariantRecord,
  targetEvaluation?: TargetExcludedEvaluationRecord | null,
): Promise<VariantDiagnostics> {
  const result: VariantDiagnostics = {
    status: 'unknown', counts: { completed: 0, failed: 0, pending: 0, total: 0 }, failures: [], standardAvailable: false,
  };
  if (campaign.id !== variant.campaignId || !safeArtifactPath(campaign.id) || campaign.id.includes('/') ||
    !safeArtifactPath(variant.id) || variant.id.includes('/')) return result;
  const target = targetEvaluation?.campaignId === campaign.id && targetEvaluation.variantId === variant.id ? targetEvaluation : null;
  const usesStandardPrimary = campaign.config.targetExcluded?.protocol === 'standard-primary-v2' ||
    target?.normalArmBinding?.source === 'standard_primary';
  let standardCompleted = 0;
  let standardTotal = 0;
  let active = false;
  let waiting = false;
  for (const scope of ['standard', 'control', 'excluded'] as const) {
    const executions = (scope === 'standard' ? variant.executionState : target?.executionState)?.executions ?? [];
    const benchmarks = scope === 'standard' ? campaign.config.benchmarks : scope === 'control'
      // V1 may have primary-only controls or standalone primary and holdout controls.
      ? usesStandardPrimary ? [] : campaign.config.benchmarks.filter(({ name }) => executions.some((item) =>
        item.benchmark === `${name}:control` || item.benchmark === `${name}:target-excluded/control`))
      : target || campaign.config.targetExcluded
        ? campaign.config.benchmarks.filter(({ role }) => role === 'primary') : [];
    for (const benchmark of benchmarks) {
      const replicateCount = scope === 'standard' ? campaign.config.evaluation.replicates : 2;
      for (let replicate = 1; replicate <= replicateCount; replicate += 1) {
        const execution = executions.find((item) => item.replicate === replicate &&
          (scope === 'standard' ? item.benchmark === benchmark.name :
            item.benchmark === `${benchmark.name}:${scope}` || item.benchmark === `${benchmark.name}:target-excluded/${scope}`));
        result.counts.total += 1;
        if (scope === 'standard') standardTotal += 1;
        if (execution?.status === 'completed') {
          result.counts.completed += 1;
          if (scope === 'standard') standardCompleted += 1;
          continue;
        }
        if (!execution || !TERMINAL_FAILURE.has(execution.status)) {
          result.counts.pending += 1;
          active ||= !!execution && ['starting', 'queued', 'running'].includes(execution.status);
          waiting ||= !!execution && ['waiting', 'waiting_for_input'].includes(execution.status);
          continue;
        }
        result.counts.failed += 1;
        const caseId = identifier(execution.caseId) ?? null;
        const runId = identifier(execution.runId) ?? null;
        let failure = execution.failure ? normalizeExecutionFailure(execution) : null;
        let progress = execution.progress;
        if (caseId && runId && (!failure || !failure.details)) {
          const directory = [...(scope === 'standard' ? [] : ['target-excluded', scope]), benchmark.name, `replicate-${replicate}`];
          let runtime: unknown = null;
          let runtimePath: string | undefined;
          for (const filename of ['analysis-run-latest.json', 'result.json', 'analysis-admitted.json']) {
            const value = await readArchive(paths.artifacts, [campaign.id, variant.id, ...directory, filename]);
            if (matchesRun(value, caseId, runId)) {
              const normalized = normalizeExecutionFailure(value, { caseId, runId });
              if (normalized) { runtime = value; runtimePath = [...directory, filename].join('/'); break; }
            }
          }
          const events = await readArchive(paths.artifacts, [campaign.id, variant.id, ...directory, 'events.json']);
          const event = matchingFailureEvent(events, caseId, runId);
          if (runtime || event) {
            const archived = normalizeExecutionFailure({ ...record(runtime), events: event ? [event] : [] }, {
              caseId, runId, source: 'archive', ...(event ? { artifactPath: [...directory, 'events.json'].join('/') } : runtimePath ? { artifactPath: runtimePath } : {}),
            });
            if (archived) {
              failure = failure ? {
                ...failure, ...archived,
                code: failure.code ?? archived.code,
                message: failure.code ? failure.message : archived.message,
                details: failure.details ?? archived.details ?? null,
                providerRetryBudgetAvailable: failure.providerRetryBudgetAvailable ?? archived.providerRetryBudgetAvailable ?? null,
              } : archived;
            }
            const archivedProgress = record(record(record(runtime).runtime).progress);
            if (!progress && count(archivedProgress.completedUnits) !== undefined && count(archivedProgress.totalUnits) !== undefined) {
              progress = { completedUnits: archivedProgress.completedUnits as number, totalUnits: archivedProgress.totalUnits as number };
            }
          }
        }
        result.failures.push({ scope, benchmark: benchmark.name, replicate, caseId, runId,
          progress: progress && count(progress.completedUnits) !== undefined && count(progress.totalUnits) !== undefined
            ? { completedUnits: progress.completedUnits, totalUnits: progress.totalUnits } : null,
          failure });
      }
    }
  }
  result.standardAvailable = standardTotal > 0 && standardCompleted === standardTotal;
  result.status = result.counts.failed > 0 || waiting ? 'blocked' : result.counts.total > 0 && result.counts.completed === result.counts.total
    ? 'complete' : active ? 'running' : 'unknown';
  return result;
}
