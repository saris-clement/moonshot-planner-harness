import {
  DecisionSchema,
  type Benchmark,
  type Decision,
  type Phase2RunSnapshot,
  type RuntimeQuestionObservation,
  type VariantExecutionState,
} from './types.js';
import { extractPlannerUsage } from './metrics.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nestedValue(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function nestedString(value: unknown, keys: readonly string[]): string | null {
  const current = nestedValue(value, keys);
  return typeof current === 'string' ? current : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function emptyDecisions(): Record<Decision, number> {
  return { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 };
}

function answerText(question: JsonRecord): string | null {
  const answer = question.answer;
  if (!isRecord(answer)) return null;
  const direct = answer.freeText ?? answer.value;
  if (typeof direct === 'string') return direct;
  if (typeof answer.selectedOptionId !== 'string' || !Array.isArray(question.options)) {
    return null;
  }
  const selected = question.options
    .filter(isRecord)
    .find((option) => option.id === answer.selectedOptionId);
  return typeof selected?.label === 'string' ? selected.label : answer.selectedOptionId;
}

export function plannerQuestionsFromResponse(
  response: unknown,
  audits: readonly unknown[] = [],
): RuntimeQuestionObservation[] {
  const auditById = new Map(
    audits
      .filter(isRecord)
      .filter((audit) => typeof audit.questionId === 'string')
      .map((audit) => [String(audit.questionId), audit]),
  );
  const rawQuestions = isRecord(response) && Array.isArray(response.questions)
    ? response.questions.filter(isRecord)
    : [];
  const questionById = new Map<string, JsonRecord>();
  for (const question of rawQuestions) {
    if (typeof question.id === 'string') questionById.set(question.id, question);
  }
  for (const [id, audit] of auditById) {
    if (!questionById.has(id)) questionById.set(id, audit);
  }
  return [...questionById.entries()].map(([id, question]) => {
    const audit = auditById.get(id);
    return {
      id,
      type: typeof question.type === 'string' ? question.type : 'unknown',
      ownerRole: typeof question.ownerRole === 'string' ? question.ownerRole : 'unknown',
      priority: typeof question.priority === 'string' ? question.priority : 'unknown',
      prompt:
        typeof question.prompt === 'string'
          ? question.prompt
          : typeof audit?.prompt === 'string'
            ? audit.prompt
            : '',
      rationale: typeof question.rationale === 'string' ? question.rationale : '',
      status: audit
        ? 'answered'
        : typeof question.status === 'string'
          ? question.status
          : 'unknown',
      answer:
        typeof audit?.answer === 'string'
          ? audit.answer
          : answerText(question),
      resolution:
        audit?.resolution === 'requirements_agent' ||
        audit?.resolution === 'source_fallback' ||
        audit?.resolution === 'reused_source_answer'
          ? audit.resolution
          : null,
      evidence: Array.isArray(audit?.evidence)
        ? audit.evidence.filter((item): item is string => typeof item === 'string')
        : [],
      createdAt: typeof question.createdAt === 'string' ? question.createdAt : null,
      updatedAt: typeof question.updatedAt === 'string' ? question.updatedAt : null,
    };
  });
}

export function executionSnapshotFromRun(
  response: unknown,
  context: {
    caseId?: string | null;
    runId?: string | null;
    questions: RuntimeQuestionObservation[];
    startedAt?: string | null;
    completedAt?: string | null;
    elapsedMs?: number | null;
  },
): Phase2RunSnapshot {
  const completedUnits = nonnegativeInteger(nestedValue(response, ['runtime', 'progress', 'completedUnits']));
  const totalUnits = nonnegativeInteger(nestedValue(response, ['runtime', 'progress', 'totalUnits']));
  const decisions = emptyDecisions();
  const adjudications = nestedValue(response, ['checkpoint', 'completedAdjudications']);
  const seenUnits = new Set<string>();
  if (Array.isArray(adjudications)) {
    for (const adjudication of adjudications.filter(isRecord)) {
      const unitId = typeof adjudication.requirementUnitId === 'string'
        ? adjudication.requirementUnitId
        : null;
      const decision = DecisionSchema.safeParse(adjudication.result);
      if (!unitId || seenUnits.has(unitId) || !decision.success) continue;
      seenUnits.add(unitId);
      decisions[decision.data] += 1;
    }
  }
  return {
    caseId:
      context.caseId ??
      nestedString(response, ['run', 'caseId']) ??
      nestedString(response, ['runtime', 'caseId']) ??
      nestedString(response, ['case', 'id']),
    runId:
      context.runId ??
      nestedString(response, ['run', 'id']) ??
      nestedString(response, ['runtime', 'id']),
    status:
      nestedString(response, ['runtime', 'status']) ??
      nestedString(response, ['run', 'status']) ??
      nestedString(response, ['case', 'status']) ??
      'unknown',
    stage: nestedString(response, ['runtime', 'stage']),
    progress:
      completedUnits === null || totalUnits === null ? null : { completedUnits, totalUnits },
    decisions,
    questions: context.questions,
    startedAt: context.startedAt ?? null,
    completedAt: context.completedAt ?? null,
    elapsedMs: context.elapsedMs ?? null,
    usage: extractPlannerUsage(response),
    updatedAt:
      nestedString(response, ['checkpointMetadata', 'createdAt']) ??
      nestedString(response, ['runtime', 'updatedAt']) ??
      nestedString(response, ['run', 'updatedAt']) ??
      nestedString(response, ['case', 'updatedAt']) ??
      new Date().toISOString(),
  };
}

export function mergeExecutionSnapshot(
  state: VariantExecutionState | null,
  input: {
    benchmark: string;
    role: Benchmark['role'];
    replicate: number;
    replicateCount: number;
    snapshot: Phase2RunSnapshot;
  },
): VariantExecutionState {
  const previous = state?.executions.find(
    (candidate) =>
      candidate.benchmark === input.benchmark && candidate.replicate === input.replicate,
  );
  const decisionCount = Object.values(input.snapshot.decisions).reduce(
    (total, count) => total + count,
    0,
  );
  const previousDecisionCount = Object.values(previous?.decisions ?? {}).reduce(
    (total, count) => total + count,
    0,
  );
  const successorWithoutCheckpoint =
    previousDecisionCount > 0 &&
    decisionCount === 0 &&
    (input.snapshot.progress === null || input.snapshot.progress.completedUnits === 0);
  const checkpointSnapshot =
    successorWithoutCheckpoint && previous?.progress
      ? {
          ...input.snapshot,
          progress: previous.progress,
          decisions: previous.decisions,
        }
      : input.snapshot;
  const snapshot = {
    ...checkpointSnapshot,
    startedAt: checkpointSnapshot.startedAt ?? previous?.startedAt ?? null,
    completedAt: checkpointSnapshot.completedAt ?? previous?.completedAt ?? null,
    elapsedMs: checkpointSnapshot.elapsedMs ?? previous?.elapsedMs ?? null,
    usage: checkpointSnapshot.usage ?? previous?.usage ?? null,
  };
  const execution = {
    benchmark: input.benchmark,
    role: input.role,
    replicate: input.replicate,
    replicateCount: input.replicateCount,
    ...snapshot,
  };
  const executions = (state?.executions ?? []).filter(
    (candidate) =>
      candidate.benchmark !== input.benchmark || candidate.replicate !== input.replicate,
  );
  executions.push(execution);
  executions.sort(
    (left, right) =>
      Number(right.role === 'primary') - Number(left.role === 'primary') ||
      left.benchmark.localeCompare(right.benchmark) ||
      left.replicate - right.replicate,
  );
  return { executions };
}
