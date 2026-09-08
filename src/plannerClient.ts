import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractRunFacts } from './metrics.js';
import {
  executionSnapshotFromRun,
  plannerQuestionsFromResponse,
} from './executionState.js';
import type { Phase2RunSnapshot, RunFacts } from './types.js';
import { normalizeExecutionFailure, safeExecutionError, type ExecutionFailure } from './failures.js';

type JsonRecord = Record<string, unknown>;

class PlannerHttpError extends Error {
  readonly failure: ExecutionFailure;
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    const failure = normalizeExecutionFailure({ code }, { origin: 'http', httpStatus: status })!;
    super(failure.message);
    this.failure = failure;
    this.name = 'PlannerHttpError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nestedString(value: unknown, keys: readonly string[]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

function nestedValue(value: unknown, keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function runStatus(value: unknown): string {
  return (
    nestedString(value, ['runtime', 'status']) ??
    nestedString(value, ['run', 'status']) ??
    nestedString(value, ['status']) ??
    'unknown'
  );
}

function providerRetryInput(value: unknown): JsonRecord | null {
  if (nestedValue(value, ['runtime', 'providerRetryBudgetAvailable']) !== true) return null;
  const pins = nestedValue(value, ['runtime', 'pins']);
  const failureCode = nestedString(value, ['runtime', 'failureCode']);
  if (
    !isRecord(pins) ||
    typeof pins.inputSetHash !== 'string' ||
    !Number.isSafeInteger(pins.decisionSetVersion) ||
    typeof pins.decisionSetHash !== 'string' ||
    !failureCode
  ) {
    return null;
  }
  const input: JsonRecord = {
    expectedContext: {
      inputSetHash: pins.inputSetHash,
      decisionSetVersion: pins.decisionSetVersion,
      decisionSetHash: pins.decisionSetHash,
    },
    expectedFailureCode: failureCode,
    acknowledgeUncertainProviderBilling: true,
  };
  const checkpoint = nestedValue(value, ['checkpointMetadata']);
  const checkpointSha = nestedString(checkpoint, ['checkpointRef', 'artifactSha256']);
  if (
    isRecord(checkpoint) &&
    typeof checkpoint.id === 'string' &&
    Number.isSafeInteger(checkpoint.version) &&
    checkpointSha
  ) {
    input.expectedCheckpoint = {
      id: checkpoint.id,
      version: checkpoint.version,
      artifactSha256: checkpointSha,
    };
  }
  return input;
}

export interface Phase2Result {
  caseId: string;
  runId: string;
  status: string;
  facts: RunFacts | null;
  questions: Phase2QuestionAudit[];
  failure?: ExecutionFailure | null;
}

export interface PlannerQuestionRecord {
  id: string;
  createdByRunId: string;
  responseKind: 'single_select' | 'free_text' | 'value';
  prompt: string;
  rationale: string;
  context: Record<string, unknown>;
  options?: Array<{ id: string; label: string; description?: string; consequences?: string }>;
  status: string;
  type?: string;
  ownerRole?: string;
  priority?: string;
  coverageIds?: string[];
  requirementRefs?: Array<{ entity: string; anchor: string }>;
  /** Harness-only product scope; never replaces the planner's expected-context pins. */
  sourceContext?: { workflow?: string };
  answer?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface Phase2QuestionAudit {
  questionId: string;
  prompt: string;
  answer: string;
  resolution:
    | 'requirements_agent'
    | 'source_fallback'
    | 'pm_simulation'
    | 'reused_source_answer'
    | 'human_answer';
  evidence: string[];
  requirementsAgentRequests: number;
}

export interface Phase2QuestionAnswer {
  answer: string;
  selectedOptionId?: string;
  resolution: Phase2QuestionAudit['resolution'];
  evidence: string[];
  requirementsAgentRequests: number;
}

export interface Phase2CaseOptions {
  targetImplementationWorkflow: string;
}

export class PlannerClient {
  constructor(
    readonly baseUrl: string,
    readonly artifactDirectory: string,
    readonly authorizationToken?: string,
  ) {}

  private async request(
    artifactName: string,
    requestPath: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (this.authorizationToken) headers.set('Authorization', `Bearer ${this.authorizationToken}`);
    const response = await fetch(`${this.baseUrl}${requestPath}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) as unknown : null;
    } catch {
      // Parsing errors can contain fragments of the response body.
      if (!response.ok) throw new PlannerHttpError(response.status, null);
      throw new Error('The planner returned an invalid JSON response.');
    }
    await writeFile(
      path.join(this.artifactDirectory, `${artifactName}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    if (!response.ok) {
      throw new PlannerHttpError(
        response.status,
        normalizeExecutionFailure(value, { origin: 'http', httpStatus: response.status })?.code ?? null,
      );
    }
    return value;
  }

  async health(): Promise<unknown> {
    const origin = new URL(this.baseUrl).origin;
    const response = await fetch(`${origin}/readyz`, {
      headers: this.authorizationToken
        ? { Authorization: `Bearer ${this.authorizationToken}`, Accept: 'application/json' }
        : { Accept: 'application/json' },
      signal: AbortSignal.timeout(120_000),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      if (!response.ok) throw new PlannerHttpError(response.status, null);
      throw new Error('The planner returned an invalid JSON response.');
    }
    await writeFile(
      path.join(this.artifactDirectory, 'readyz.json'),
      `${JSON.stringify(value, null, 2)}\n`,
    );
    if (!response.ok) throw new PlannerHttpError(response.status, null);
    return value;
  }

  async collectCompletedPhase2(caseId: string, runId: string): Promise<Phase2Result> {
    const run = await this.request(
      'analysis-run-latest',
      `/api/planning-cases/${caseId}/runs/${runId}`,
    );
    const status = runStatus(run);
    if (status !== 'completed') {
      throw new Error('The Phase 2 run is not complete.');
    }
    const finalResponses = await Promise.all([
      this.request('case-final', `/api/planning-cases/${caseId}`),
      this.request('events', `/api/planning-cases/${caseId}/events`),
      this.request('analysis-runs', `/api/planning-cases/${caseId}/runs`),
      this.request('analyses', `/api/planning-cases/${caseId}/analyses`),
      this.request('planner-questions-final', `/api/planning-cases/${caseId}/planner-questions`),
      this.request(
        'requirements-consultations-final',
        `/api/planning-cases/${caseId}/requirements-consultations`,
      ),
    ]);
    const questions = plannerQuestionsFromResponse(finalResponses[4])
      .filter((question) => question.status === 'answered' && question.answer)
      .map((question): Phase2QuestionAudit => ({
        questionId: question.id,
        prompt: question.prompt,
        answer: question.answer!,
        resolution: question.resolution ?? 'human_answer',
        evidence: question.evidence,
        requirementsAgentRequests: 0,
      }));
    const analysis = await this.request('analysis', `/api/planning-cases/${caseId}/analysis`);
    const facts = extractRunFacts(analysis, run);
    await Promise.all([
      writeFile(
        path.join(this.artifactDirectory, 'question-audit.json'),
        `${JSON.stringify(questions, null, 2)}\n`,
      ),
      writeFile(
        path.join(this.artifactDirectory, 'facts.json'),
        `${JSON.stringify(facts, null, 2)}\n`,
      ),
    ]);
    return { caseId, runId, status, facts, questions };
  }

  async runPhase2(
    zipPath: string,
    idempotencyPrefix: string,
    timeoutMs: number,
    expectedArtifactSha?: string,
    answerQuestion?: (input: {
      question: PlannerQuestionRecord;
      consultations: unknown[];
    }) => Promise<Phase2QuestionAnswer>,
    onSnapshot?: (snapshot: Phase2RunSnapshot) => void | Promise<void>,
    caseOptions?: Phase2CaseOptions,
  ): Promise<Phase2Result> {
    let latestSnapshot: Phase2RunSnapshot | null = null;
    try {
      return await this.executePhase2(zipPath, idempotencyPrefix, timeoutMs, expectedArtifactSha,
        answerQuestion, async (snapshot) => {
          latestSnapshot = snapshot;
          await onSnapshot?.(snapshot);
        }, caseOptions);
    } catch (error) {
      const previous = latestSnapshot as Phase2RunSnapshot | null;
      const failure = previous?.failure ?? normalizeExecutionFailure({ status: 'failed',
        failure: isRecord(error) ? error.failure : undefined }, { origin: error instanceof PlannerHttpError ? 'http' : 'harness' });
      if (previous) await onSnapshot?.({ ...previous, status: 'failed', failure });
      throw Object.assign(new Error(safeExecutionError({ failure })), { failure });
    }
  }

  private async executePhase2(
    zipPath: string,
    idempotencyPrefix: string,
    timeoutMs: number,
    expectedArtifactSha?: string,
    answerQuestion?: (input: { question: PlannerQuestionRecord; consultations: unknown[] }) => Promise<Phase2QuestionAnswer>,
    onSnapshot?: (snapshot: Phase2RunSnapshot) => void | Promise<void>,
    caseOptions?: Phase2CaseOptions,
  ): Promise<Phase2Result> {
    const bytes = await readFile(zipPath);
    const upload = await this.request('requirements-upload', '/api/requirements-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: bytes,
    });
    const artifactSha =
      nestedString(upload, ['metadata', 'artifactSha256']) ??
      nestedString(upload, ['requirements', 'artifactSha256']);
    if (!artifactSha) throw new Error('requirements upload response omitted artifactSha256');
    if (expectedArtifactSha && artifactSha !== expectedArtifactSha) {
      throw new Error(`planner imported ${artifactSha}; expected ${expectedArtifactSha}`);
    }

    const created = await this.request('case-created', '/api/planning-cases', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${idempotencyPrefix}-case`,
      },
      body: JSON.stringify({
        requirementsArtifactSha256: artifactSha,
        ...(caseOptions
          ? {
              caseOptions: ['exclude-target-implementation'],
              targetImplementationWorkflow: caseOptions.targetImplementationWorkflow,
            }
          : {}),
      }),
    });
    const caseId = nestedString(created, ['case', 'id']) ?? nestedString(created, ['caseId']);
    if (!caseId) throw new Error('planning case response omitted case id');
    if (caseOptions) {
      const expectedRoot = `src/customers/${caseOptions.targetImplementationWorkflow}/`;
      const inputSet = nestedValue(created, ['resolvedInputSet', 'inputSet']);
      const sourcePolicy = isRecord(inputSet) && isRecord(inputSet.sourcePolicy) ? inputSet.sourcePolicy : null;
      const planningView =
        isRecord(inputSet) && isRecord(inputSet.workflowPlanningView)
          ? inputSet.workflowPlanningView
          : null;
      if (
        nestedString(created, ['case', 'mode']) !== 'greenfield' ||
        !isRecord(inputSet) ||
        !Array.isArray(inputSet.caseOptions) ||
        inputSet.caseOptions.length !== 1 ||
        inputSet.caseOptions[0] !== 'exclude-target-implementation' ||
        sourcePolicy?.workflow !== caseOptions.targetImplementationWorkflow ||
        sourcePolicy.root !== expectedRoot ||
        sourcePolicy.targetSelection !== 'explicit_override' ||
        planningView?.status !== 'new' ||
        planningView.implementationStatus !== 'absent_by_policy' ||
        planningView.harnessStatus !== 'missing_by_policy' ||
        planningView.requiresWorkflowEstablishment !== true
      ) {
        throw new Error('planner did not admit the requested target-excluded planning view');
      }
    }
    const observedQuestions = new Map<string, PlannerQuestionRecord>();
    const questionAudits: Phase2QuestionAudit[] = [];
    const emitSnapshot = async (value: unknown, currentRunId: string | null) => {
      if (!onSnapshot) return;
      await onSnapshot(
        executionSnapshotFromRun(value, {
          caseId,
          runId: currentRunId,
          questions: plannerQuestionsFromResponse(
            { questions: [...observedQuestions.values()] },
            questionAudits,
          ),
        }),
      );
    };
    await emitSnapshot(created, null);

    const readiness = await this.request(
      'analysis-readiness',
      `/api/planning-cases/${caseId}/analysis-readiness`,
    );
    if (isRecord(readiness) && readiness.ready === false) {
      const blockers = Array.isArray(readiness.blockerCodes)
        ? readiness.blockerCodes.filter((value): value is string => typeof value === 'string')
        : [];
      throw new Error(`analysis readiness blocked${blockers.length ? `: ${blockers.join(', ')}` : ''}`);
    }
    const admitted = await this.request('analysis-admitted', `/api/planning-cases/${caseId}/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `${idempotencyPrefix}-analysis`,
      },
      body: '{}',
    });
    let runId = nestedString(admitted, ['run', 'id']);
    if (!runId) throw new Error('analysis admission response omitted run id');
    await emitSnapshot(admitted, runId);

    const deadline = Date.now() + timeoutMs;
    let run: unknown = admitted;
    let status = runStatus(run);
    let transientPollFailures = 0;
    let providerRetryCount = 0;
    while (true) {
      while (status === 'queued' || status === 'running') {
        if (Date.now() >= deadline) throw new Error(`Phase 2 run timed out after ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        try {
          run = await this.request(
            'analysis-run-latest',
            `/api/planning-cases/${caseId}/runs/${runId}`,
          );
          transientPollFailures = 0;
        } catch (error) {
          if (
            error instanceof PlannerHttpError &&
            error.status === 400 &&
            error.code === 'InvalidRequest' &&
            transientPollFailures < 30
          ) {
            transientPollFailures += 1;
            continue;
          }
          throw error;
        }
        status = runStatus(run);
        await emitSnapshot(run, runId);
      }
      const retryInput = status === 'failed' ? providerRetryInput(run) : null;
      if (retryInput) {
        providerRetryCount += 1;
        const retried = await this.request(
          `analysis-provider-retry-${providerRetryCount}`,
          `/api/planning-cases/${caseId}/runs/${runId}/retry-provider-failure`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': `${idempotencyPrefix}-provider-retry-${providerRetryCount}`,
            },
            body: JSON.stringify(retryInput),
          },
        );
        const retryRunId = nestedString(retried, ['run', 'id']);
        if (!retryRunId) throw new Error('provider retry response omitted successor run id');
        runId = retryRunId;
        run = retried;
        status = runStatus(run);
        await emitSnapshot(run, runId);
        continue;
      }
      if (status !== 'waiting') break;
      if (!answerQuestion) throw new Error('Phase 2 requires a planner-question handler');
      if (questionAudits.length >= 20) throw new Error('Phase 2 exceeded 20 planner questions');
      const [questionsResponse, consultationsResponse] = await Promise.all([
        this.request(
          `planner-questions-${questionAudits.length + 1}`,
          `/api/planning-cases/${caseId}/planner-questions`,
        ),
        this.request(
          `requirements-consultations-${questionAudits.length + 1}`,
          `/api/planning-cases/${caseId}/requirements-consultations`,
        ),
      ]);
      const questions =
        isRecord(questionsResponse) && Array.isArray(questionsResponse.questions)
          ? questionsResponse.questions.filter(isRecord)
          : [];
      const question = questions.find(
        (candidate) =>
          candidate.status === 'open' &&
          (candidate.createdByRunId === runId || questions.length === 1),
      ) as PlannerQuestionRecord | undefined;
      if (!question) throw new Error('waiting Phase 2 run has no open planner question');
      for (const candidate of questions) {
        if (typeof candidate.id === 'string') {
          observedQuestions.set(candidate.id, candidate as unknown as PlannerQuestionRecord);
        }
      }
      await emitSnapshot(run, runId);
      const consultations =
        isRecord(consultationsResponse) && Array.isArray(consultationsResponse.consultations)
          ? consultationsResponse.consultations
          : [];
      const answer = await answerQuestion({ question, consultations });
      const answerBody = {
        idempotencyKey: `${idempotencyPrefix}-question-${questionAudits.length + 1}`,
        expectedContext: question.context,
        responseKind: question.responseKind,
        ...(question.responseKind === 'single_select'
          ? { selectedOptionId: answer.selectedOptionId }
          : question.responseKind === 'value'
            ? { value: answer.answer }
            : { freeText: answer.answer }),
      };
      if (question.responseKind === 'single_select' && !answer.selectedOptionId) {
        throw new Error(`source answer did not select an option for ${question.id}`);
      }
      const resumed = await this.request(
        `planner-question-answer-${questionAudits.length + 1}`,
        `/api/planning-cases/${caseId}/planner-questions/${question.id}/answer`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answerBody),
        },
      );
      questionAudits.push({
        questionId: question.id,
        prompt: question.prompt,
        answer: answer.answer,
        resolution: answer.resolution,
        evidence: answer.evidence,
        requirementsAgentRequests: answer.requirementsAgentRequests,
      });
      observedQuestions.set(question.id, {
        ...question,
        status: 'answered',
        answer: {
          ...(question.responseKind === 'single_select'
            ? { selectedOptionId: answer.selectedOptionId }
            : question.responseKind === 'value'
              ? { value: answer.answer }
              : { freeText: answer.answer }),
        },
        updatedAt: new Date().toISOString(),
      });
      const successorRunId = nestedString(resumed, ['run', 'id']);
      if (!successorRunId) throw new Error('planner question answer omitted successor run id');
      runId = successorRunId;
      run = resumed;
      status = runStatus(run);
      await emitSnapshot(run, runId);
    }

    let failure = normalizeExecutionFailure(run, { caseId, runId });
    // Publish terminal evidence before optional final collection can fail.
    if (failure) await emitSnapshot(run, runId);
    const finalRequests = [
      this.request('case-final', `/api/planning-cases/${caseId}`),
      this.request('events', `/api/planning-cases/${caseId}/events`),
      this.request('analysis-runs', `/api/planning-cases/${caseId}/runs`),
      this.request('analyses', `/api/planning-cases/${caseId}/analyses`),
      this.request('planner-questions-final', `/api/planning-cases/${caseId}/planner-questions`),
      this.request(
        'requirements-consultations-final',
        `/api/planning-cases/${caseId}/requirements-consultations`,
      ),
    ];
    const finalResponses = failure
      ? (await Promise.allSettled(finalRequests)).map((result) => result.status === 'fulfilled' ? result.value : null)
      : await Promise.all(finalRequests);
    if (failure) {
      run = { ...(isRecord(run) ? run : {}), events: nestedValue(finalResponses[1], ['events']) };
      failure = normalizeExecutionFailure(run, { caseId, runId });
    }
    const finalQuestions = finalResponses[4];
    if (isRecord(finalQuestions) && Array.isArray(finalQuestions.questions)) {
      for (const candidate of finalQuestions.questions.filter(isRecord)) {
        if (typeof candidate.id === 'string') {
          observedQuestions.set(candidate.id, candidate as unknown as PlannerQuestionRecord);
        }
      }
    }
    await emitSnapshot(run, runId);

    await writeFile(
      path.join(this.artifactDirectory, 'question-audit.json'),
      `${JSON.stringify(questionAudits, null, 2)}\n`,
    );
    if (status !== 'completed') return { caseId, runId, status, facts: null, questions: questionAudits, failure };
    const analysis = await this.request('analysis', `/api/planning-cases/${caseId}/analysis`);
    const facts = extractRunFacts(analysis, run);
    await writeFile(
      path.join(this.artifactDirectory, 'facts.json'),
      `${JSON.stringify(facts, null, 2)}\n`,
    );
    return { caseId, runId, status, facts, questions: questionAudits };
  }
}
