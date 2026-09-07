import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parse, stringify } from 'yaml';
import { AgentRunner } from './agents.js';
import { readEnvironmentFile } from './config.js';
import type {
  Benchmark,
  BenchmarkQuestionResolution,
  CampaignRecord,
  QuestionResolutionEntry,
} from './types.js';

type RawQuestion = {
  id: string;
  type: string;
  workflow?: string;
  entity?: string;
  anchor?: string;
  question: string;
  severity: string;
  status: string;
  options: Array<{ id: string; label: string; description: string; outcome?: string }>;
  answer?: {
    selected?: unknown;
    value?: unknown;
    freeText?: unknown;
    by?: unknown;
    at?: unknown;
  };
};

type AdvisorResolution =
  | {
      resolution: 'answered';
      answer: string;
      citations?: Array<{ entity: string; anchor?: string; quote?: string }>;
    }
  | { resolution: 'raised'; question_id: string; deduplicated?: boolean }
  | { resolution: string; [key: string]: unknown };

export interface ResolvedBenchmarkPack {
  benchmark: Benchmark;
  summary: BenchmarkQuestionResolution;
}

interface ResolvedAnswerCandidate {
  answer: string;
  evidence: string[];
  resolution: 'requirements_agent' | 'source_fallback' | 'pm_simulation';
}

const PM_SIMULATION_MAX_ANSWER_LENGTH = 1_000;

const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function parsedQuestionFiles(files: Record<string, Uint8Array>): Array<[string, RawQuestion]> {
  return Object.entries(files)
    .filter(([name]) => name.startsWith('questions/') && name.endsWith('.yaml'))
    .map(([name, bytes]) => [name, parse(strFromU8(bytes)) as RawQuestion] as [string, RawQuestion]);
}

function questionFiles(files: Record<string, Uint8Array>): Array<[string, RawQuestion]> {
  return parsedQuestionFiles(files)
    .filter(([, question]) => question.status === 'open' && question.severity === 'blocking');
}

function validatePmSimulationAnswer(answer: string, questionId: string): void {
  if (answer.length === 0) {
    throw new Error(`PM-simulation answer for blocking question ${questionId} must be nonempty`);
  }
  if (answer.length > PM_SIMULATION_MAX_ANSWER_LENGTH) {
    throw new Error(
      `PM-simulation answer for blocking question ${questionId} must be at most ${PM_SIMULATION_MAX_ANSWER_LENGTH} characters`,
    );
  }
  const sentenceCount = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(answer)]
    .filter(({ segment }) => segment.trim().length > 0)
    .length;
  if (sentenceCount > 3) {
    throw new Error(`PM-simulation answer for blocking question ${questionId} must be at most 3 sentences`);
  }
}

function reconstructExpectedResolvedPack(
  original: Uint8Array,
  originalFiles: Record<string, Uint8Array>,
  resolvedFiles: Record<string, Uint8Array>,
  persisted: BenchmarkQuestionResolution,
  benchmarkName: string,
): Uint8Array {
  const expectedFiles = { ...originalFiles };
  const originalById = new Map<string, Array<[string, RawQuestion]>>();
  const resolvedById = new Map<string, Array<[string, RawQuestion]>>();
  for (const questionFile of parsedQuestionFiles(originalFiles)) {
    const matches = originalById.get(questionFile[1].id) ?? [];
    matches.push(questionFile);
    originalById.set(questionFile[1].id, matches);
  }
  for (const questionFile of parsedQuestionFiles(resolvedFiles)) {
    const matches = resolvedById.get(questionFile[1].id) ?? [];
    matches.push(questionFile);
    resolvedById.set(questionFile[1].id, matches);
  }
  for (const [id, matches] of originalById) {
    if (matches.length !== 1) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: duplicate original question ${id}`,
      );
    }
  }
  const entriesById = new Map<string, QuestionResolutionEntry>();
  for (const entry of persisted.entries) {
    if (entriesById.has(entry.id)) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: duplicate summary entry ${entry.id}`,
      );
    }
    entriesById.set(entry.id, entry);
  }
  let answeredAt: string | undefined;

  for (const [id, originalMatches] of originalById) {
    const [originalPath, originalQuestion] = originalMatches[0]!;
    const resolvedMatches = resolvedById.get(id) ?? [];
    const isBlockingTransition =
      originalQuestion.status === 'open' && originalQuestion.severity === 'blocking';
    if (!isBlockingTransition) {
      const unchanged =
        resolvedMatches.length === 1 &&
        resolvedMatches[0]![0] === originalPath &&
        isDeepStrictEqual(resolvedMatches[0]![1], originalQuestion);
      if (!unchanged) {
        throw new Error(
          `resolved pack cache content mismatch for ${benchmarkName}: unrelated question ${id} changed`,
        );
      }
      if (entriesById.has(id)) {
        throw new Error(
          `resolved pack cache content mismatch for ${benchmarkName}: summary entry ${id} is not an open blocking transition`,
        );
      }
      continue;
    }

    const answeredMatches = resolvedMatches.filter(([, question]) => question.status === 'answered');
    if (answeredMatches.length !== 1 || resolvedMatches.length !== 1) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: expected one answered question ${id}, found ${answeredMatches.length}`,
      );
    }
    const entry = entriesById.get(id);
    if (!entry) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: missing summary entry for ${id}`,
      );
    }
    const [resolvedPath, question] = answeredMatches[0]!;
    const originalDefinition = { ...originalQuestion } as Record<string, unknown>;
    const resolvedDefinition = { ...question } as Record<string, unknown>;
    delete originalDefinition.status;
    delete originalDefinition.answer;
    delete resolvedDefinition.status;
    delete resolvedDefinition.answer;
    if (
      resolvedPath !== originalPath ||
      !isDeepStrictEqual(resolvedDefinition, originalDefinition) ||
      entry.question !== originalQuestion.question
    ) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: transitioned question ${id} changed`,
      );
    }
    const materializedAnswer =
      question.type === 'data_request' ? question.answer?.value : question.answer?.freeText;
    if (materializedAnswer !== entry.answer) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: answer for ${entry.id}`,
      );
    }
    if (
      entry.selectedOptionId !== undefined &&
      !originalQuestion.options.some((option) => option.id === entry.selectedOptionId)
    ) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: unknown selected option ${entry.selectedOptionId} for ${entry.id}`,
      );
    }
    const selectedOptionIds = entry.selectedOptionId
      ? [entry.selectedOptionId]
      : selectedOption(originalQuestion);
    if (!isDeepStrictEqual(question.answer?.selected, selectedOptionIds)) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: selected options for ${entry.id}`,
      );
    }
    if (question.answer?.by !== `planner-eval-harness/${entry.resolution}`) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: provenance for ${entry.id}`,
      );
    }
    const materializedAt = question.answer?.at;
    if (
      typeof materializedAt !== 'string' ||
      Number.isNaN(new Date(materializedAt).getTime()) ||
      (answeredAt !== undefined && materializedAt !== answeredAt)
    ) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: timestamp for ${entry.id}`,
      );
    }
    answeredAt = materializedAt;
    expectedFiles[originalPath] = strToU8(
      stringify(
        applyAnswer(
          originalQuestion,
          entry.answer,
          selectedOptionIds,
          `planner-eval-harness/${entry.resolution}`,
          materializedAt,
        ),
      ),
    );
  }

  for (const id of resolvedById.keys()) {
    if (!originalById.has(id)) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: unexpected resolved question ${id}`,
      );
    }
  }
  for (const id of entriesById.keys()) {
    if (!originalById.has(id)) {
      throw new Error(
        `resolved pack cache content mismatch for ${benchmarkName}: unexpected summary entry ${id}`,
      );
    }
  }
  if (persisted.entries.length === 0) return original;
  if (!answeredAt) {
    throw new Error(`resolved pack cache content mismatch for ${benchmarkName}: missing timestamp`);
  }
  updatePackBindings(expectedFiles, persisted.entries.length);
  return zipSync(expectedFiles, { level: 6, mtime: new Date(answeredAt) });
}

async function askRequirementsAgent(
  campaign: CampaignRecord,
  question: RawQuestion,
  artifactDirectory: string,
): Promise<AdvisorResolution> {
  const environment = await readEnvironmentFile(campaign.config.environmentFile);
  const baseUrl = environment.PLANNER_REQUIREMENTS_AGENT_BASE_URL;
  const secret = environment.PLANNER_REQUIREMENTS_AGENT_SERVICE_SECRET;
  if (!baseUrl || !secret) return { resolution: 'unavailable' };
  const request = {
    workflow: question.workflow ?? 'unknown/unknown',
    raised_by: 'planner',
    ask: question.question,
    ...(question.entity ? { entity: question.entity } : {}),
    hints: `Resolve imported blocking question ${question.id} from the current reviewed requirements ledger. Answer concisely when grounded; otherwise raise it.`,
  };
  await writeFile(
    path.join(artifactDirectory, `requirements-agent-request-${question.id}.json`),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/internal/questions`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(330_000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = { resolution: 'invalid_response', status: response.status };
  }
  await writeFile(
    path.join(artifactDirectory, `requirements-agent-response-${question.id}.json`),
    `${JSON.stringify(body, null, 2)}\n`,
  );
  if (!response.ok) return { resolution: `http_${response.status}` };
  return body as AdvisorResolution;
}

function selectedOption(question: RawQuestion): string[] {
  const option = question.options.find(
    (candidate) =>
      candidate.outcome === undefined ||
      !['unavailable', 'out_of_scope', 'defer', 'keep'].includes(candidate.outcome),
  );
  return option ? [option.id] : [];
}

function applyAnswer(
  question: RawQuestion,
  answer: string,
  selected: string[],
  by: string,
  at: string,
): RawQuestion {
  return {
    ...question,
    status: 'answered',
    answer: {
      selected,
      ...(question.type === 'data_request' ? { value: answer } : { freeText: answer }),
      by,
      at,
    },
  };
}

function updatePackBindings(files: Record<string, Uint8Array>, answeredCount: number): void {
  const manifestBytes = files['manifest.yaml'];
  const summaryBytes = files['SUMMARY.yaml'];
  if (!manifestBytes || !summaryBytes || answeredCount === 0) return;
  const manifest = parse(strFromU8(manifestBytes)) as {
    exportHash: string;
    questions?: { open?: number; answered?: number; total?: number };
  };
  if (manifest.questions) {
    manifest.questions.open = Math.max(0, (manifest.questions.open ?? 0) - answeredCount);
    manifest.questions.answered = (manifest.questions.answered ?? 0) + answeredCount;
  }
  const summary = parse(strFromU8(summaryBytes)) as {
    exportHash: string;
    binding?: { openQuestions?: unknown[] };
  };
  if (summary.binding) summary.binding.openQuestions = [];
  const hash = createHash('sha256');
  for (const [relativePath, bytes] of Object.entries(files)
    .filter(
      ([relativePath]) =>
        relativePath.startsWith('requirements/') || relativePath.startsWith('questions/'),
    )
    .sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`${relativePath} ${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  const exportHash = hash.digest('hex').slice(0, 12);
  manifest.exportHash = exportHash;
  summary.exportHash = exportHash;
  files['manifest.yaml'] = strToU8(stringify(manifest));
  files['SUMMARY.yaml'] = strToU8(stringify(summary));
}

export async function resolveBenchmarkQuestions(input: {
  campaign: CampaignRecord;
  benchmark: Benchmark;
  workflowsSource: string;
  sharedDirectory: string;
  artifactDirectory: string;
  sourceAnswerMode?: 'source-grounded' | 'pm-simulation';
  answerAllowed?: (candidate: ResolvedAnswerCandidate) => boolean;
  agent?: Pick<AgentRunner, 'answerUpstreamQuestion'>;
}): Promise<ResolvedBenchmarkPack> {
  const original = new Uint8Array(await readFile(input.benchmark.zipPath));
  const originalArtifactSha = digest(original);
  if (input.benchmark.sha256 && input.benchmark.sha256 !== originalArtifactSha) {
    throw new Error(
      `benchmark input SHA mismatch for ${input.benchmark.name}: expected ${input.benchmark.sha256}, measured ${originalArtifactSha}`,
    );
  }
  const originalFiles = unzipSync(original);
  await Promise.all([
    mkdir(input.sharedDirectory, { recursive: true }),
    mkdir(input.artifactDirectory, { recursive: true }),
  ]);
  const sharedPackPath = path.join(input.sharedDirectory, `${input.benchmark.name}.zip`);
  const sharedSummaryPath = path.join(input.sharedDirectory, `${input.benchmark.name}.questions.json`);
  const [sharedPackExists, sharedSummaryExists] = await Promise.all([
    stat(sharedPackPath).then((entry) => entry.isFile()).catch(() => false),
    stat(sharedSummaryPath).then((entry) => entry.isFile()).catch(() => false),
  ]);
  if (sharedPackExists !== sharedSummaryExists) {
    await Promise.all([rm(sharedPackPath, { force: true }), rm(sharedSummaryPath, { force: true })]);
  } else if (sharedPackExists && sharedSummaryExists) {
    const persisted = JSON.parse(await readFile(sharedSummaryPath, 'utf8')) as BenchmarkQuestionResolution;
    if (persisted.derivationVersion === 2) {
      const pmSimulationAnswers = persisted.pmSimulationAnswers ?? 0;
      const pmSimulationEntries = persisted.entries.filter(
        (entry) => entry.resolution === 'pm_simulation',
      ).length;
      if (
        !Number.isSafeInteger(pmSimulationAnswers) ||
        pmSimulationAnswers < 0 ||
        pmSimulationAnswers !== pmSimulationEntries
      ) {
        throw new Error(
          `resolved pack cache content mismatch for ${input.benchmark.name}: PM simulation answer count`,
        );
      }
      const sourceAnswerMode = input.sourceAnswerMode ?? 'source-grounded';
      if (
        (sourceAnswerMode === 'pm-simulation' &&
          persisted.entries.some((entry) => entry.resolution === 'source_fallback')) ||
        (sourceAnswerMode === 'source-grounded' && pmSimulationEntries > 0)
      ) {
        throw new Error(
          `resolved pack cache provenance mode mismatch for ${input.benchmark.name}: ${sourceAnswerMode}`,
        );
      }
      if (
        input.answerAllowed &&
        persisted.entries.some((entry) =>
          !input.answerAllowed!({
            answer: entry.answer,
            evidence: entry.evidence,
            resolution:
              entry.resolution === 'requirements_agent'
                ? 'requirements_agent'
                : entry.resolution === 'pm_simulation'
                  ? 'pm_simulation'
                : 'source_fallback',
          }),
        )
      ) {
        throw new Error(`persisted resolved pack contains a disallowed answer: ${input.benchmark.name}`);
      }
      const cachedBytes = await readFile(sharedPackPath);
      if (digest(cachedBytes) !== persisted.resolvedArtifactSha) {
        throw new Error(
          `resolved pack cache integrity mismatch for ${input.benchmark.name}: resolved artifact SHA`,
        );
      }
      if (persisted.originalArtifactSha !== originalArtifactSha) {
        throw new Error(
          `resolved pack cache integrity mismatch for ${input.benchmark.name}: original artifact SHA`,
        );
      }
      const reconstructedBytes = reconstructExpectedResolvedPack(
        original,
        originalFiles,
        unzipSync(cachedBytes),
        persisted,
        input.benchmark.name,
      );
      if (
        digest(reconstructedBytes) !== persisted.resolvedArtifactSha ||
        reconstructedBytes.length !== cachedBytes.length ||
        !reconstructedBytes.every((byte, index) => byte === cachedBytes[index])
      ) {
        throw new Error(`resolved pack cache reconstruction mismatch for ${input.benchmark.name}`);
      }
      const summary = {
        ...persisted,
        requirementsAgentRequests: 0,
        requirementsAgentAnswers: 0,
        sourceFallbackAnswers: 0,
        pmSimulationAnswers,
        reusedAnswers: persisted.entries.length,
        plannerQuestions: 0,
        plannerRequirementsAgentRequests: 0,
        plannerRequirementsAgentAnswers: 0,
        plannerSourceFallbackAnswers: 0,
        plannerPmSimulationAnswers: 0,
        plannerReusedAnswers: 0,
        plannerHumanAnswers: 0,
      };
      await writeFile(
        path.join(input.artifactDirectory, 'question-resolutions.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      return {
        benchmark: {
          ...input.benchmark,
          zipPath: sharedPackPath,
          sha256: persisted.resolvedArtifactSha,
        },
        summary,
      };
    }
    await Promise.all([rm(sharedPackPath, { force: true }), rm(sharedSummaryPath, { force: true })]);
  }

  const files = originalFiles;
  const openQuestions = questionFiles(files);
  const entries: QuestionResolutionEntry[] = [];
  let advisorAnswers = 0;
  let sourceAnswers = 0;
  let pmSimulationAnswers = 0;
  const answeredAt = new Date().toISOString();
  const agent = input.agent ?? new AgentRunner(input.campaign);

  for (const [fileName, question] of openQuestions) {
    const advisor = await askRequirementsAgent(input.campaign, question, input.artifactDirectory);
    let answer: string | undefined;
    let evidence: string[] | undefined;
    let resolution: QuestionResolutionEntry['resolution'] | undefined;
    let selectedOptionId: string | undefined;
    if (advisor.resolution === 'answered' && typeof advisor.answer === 'string') {
      const advisorAnswer = advisor.answer.trim();
      const citations = Array.isArray(advisor.citations)
        ? (advisor.citations as Array<{ entity: string; anchor?: string; quote?: string }>)
        : [];
      const advisorEvidence = citations.map((citation) =>
        citation.anchor ? `${citation.entity}#${citation.anchor}` : citation.entity,
      );
      if (advisorEvidence.length === 0) advisorEvidence.push('requirements-agent returned a grounded answer');
      const candidate: ResolvedAnswerCandidate = {
        answer: advisorAnswer,
        evidence: advisorEvidence,
        resolution: 'requirements_agent',
      };
      if (!input.answerAllowed || input.answerAllowed(candidate)) {
        answer = candidate.answer;
        evidence = candidate.evidence;
        resolution = candidate.resolution;
        selectedOptionId = selectedOption(question)[0];
        advisorAnswers += 1;
      }
    }
    if (!answer) {
      const sourceQuestion = {
        id: question.id,
        question: question.question,
        ...(question.entity ? { entity: question.entity } : {}),
        ...(question.anchor ? { anchor: question.anchor } : {}),
        type: question.type,
        options: question.options,
      };
      const source =
        input.sourceAnswerMode === 'pm-simulation'
          ? await agent.answerUpstreamQuestion(
              sourceQuestion,
              input.workflowsSource,
              input.artifactDirectory,
              { mode: 'pm-simulation' },
            )
          : await agent.answerUpstreamQuestion(
              sourceQuestion,
              input.workflowsSource,
              input.artifactDirectory,
            );
      if (source.resolution !== 'answered') {
        throw new Error(`blocking question ${question.id} remains unresolved: ${source.reason}`);
      }
      if (
        source.selectedOptionId !== undefined &&
        !question.options.some((option) => option.id === source.selectedOptionId)
      ) {
        throw new Error(
          `blocking question ${question.id} selected unknown option ${source.selectedOptionId}`,
        );
      }
      answer = source.answer.trim();
      evidence = source.evidence;
      resolution = input.sourceAnswerMode === 'pm-simulation' ? 'pm_simulation' : 'source_fallback';
      if (resolution === 'pm_simulation') validatePmSimulationAnswer(answer, question.id);
      selectedOptionId = source.selectedOptionId ?? selectedOption(question)[0];
      if (input.answerAllowed && !input.answerAllowed({ answer, evidence, resolution })) {
        throw new Error(`blocking question ${question.id} produced a disallowed source answer`);
      }
      if (resolution === 'pm_simulation') pmSimulationAnswers += 1;
      else sourceAnswers += 1;
    }
    if (!answer || !evidence || !resolution) {
      throw new Error(`blocking question ${question.id} did not produce a complete answer`);
    }
    files[fileName] = strToU8(
      stringify(
        applyAnswer(
          question,
          answer,
          selectedOptionId ? [selectedOptionId] : [],
          `planner-eval-harness/${resolution}`,
          answeredAt,
        ),
      ),
    );
    entries.push({
      id: question.id,
      question: question.question,
      resolution,
      answer,
      ...(selectedOptionId ? { selectedOptionId } : {}),
      evidence,
    });
  }

  updatePackBindings(files, entries.length);
  const resolvedBytes =
    openQuestions.length === 0
      ? original
      : zipSync(files, { level: 6, mtime: new Date(answeredAt) });
  const resolvedArtifactSha = digest(resolvedBytes);
  await writeFile(sharedPackPath, resolvedBytes, { flag: 'wx', mode: 0o600 });
  const summary: BenchmarkQuestionResolution = {
    derivationVersion: 2,
    benchmark: input.benchmark.name,
    originalArtifactSha,
    resolvedArtifactSha,
    blockingQuestions: openQuestions.length,
    requirementsAgentRequests: openQuestions.length,
    requirementsAgentAnswers: advisorAnswers,
    sourceFallbackAnswers: sourceAnswers,
    pmSimulationAnswers,
    reusedAnswers: 0,
    plannerQuestions: 0,
    plannerRequirementsAgentRequests: 0,
    plannerRequirementsAgentAnswers: 0,
    plannerSourceFallbackAnswers: 0,
    plannerPmSimulationAnswers: 0,
    plannerReusedAnswers: 0,
    plannerHumanAnswers: 0,
    entries,
  };
  await Promise.all([
    writeFile(sharedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' }),
    writeFile(
      path.join(input.artifactDirectory, 'question-resolutions.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    ),
  ]);
  return {
    benchmark: { ...input.benchmark, zipPath: sharedPackPath, sha256: resolvedArtifactSha },
    summary,
  };
}
