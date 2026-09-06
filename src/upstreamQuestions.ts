import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  answer?: unknown;
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

const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function questionFiles(files: Record<string, Uint8Array>): Array<[string, RawQuestion]> {
  return Object.entries(files)
    .filter(([name]) => name.startsWith('questions/') && name.endsWith('.yaml'))
    .map(([name, bytes]) => [name, parse(strFromU8(bytes)) as RawQuestion] as [string, RawQuestion])
    .filter(([, question]) => question.status === 'open' && question.severity === 'blocking');
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

function applyAnswer(question: RawQuestion, answer: string, by: string, at: string): RawQuestion {
  return {
    ...question,
    status: 'answered',
    answer: {
      selected: selectedOption(question),
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
}): Promise<ResolvedBenchmarkPack> {
  await Promise.all([
    mkdir(input.sharedDirectory, { recursive: true }),
    mkdir(input.artifactDirectory, { recursive: true }),
  ]);
  const sharedPackPath = path.join(input.sharedDirectory, `${input.benchmark.name}.zip`);
  const sharedSummaryPath = path.join(input.sharedDirectory, `${input.benchmark.name}.questions.json`);
  if (
    (await stat(sharedPackPath).catch(() => null))?.isFile() &&
    (await stat(sharedSummaryPath).catch(() => null))?.isFile()
  ) {
    const persisted = JSON.parse(await readFile(sharedSummaryPath, 'utf8')) as BenchmarkQuestionResolution;
    if (persisted.derivationVersion === 2) {
      const summary = {
        ...persisted,
        requirementsAgentRequests: 0,
        requirementsAgentAnswers: 0,
        sourceFallbackAnswers: 0,
        reusedAnswers: persisted.entries.length,
        plannerQuestions: 0,
        plannerRequirementsAgentRequests: 0,
        plannerRequirementsAgentAnswers: 0,
        plannerSourceFallbackAnswers: 0,
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

  const original = new Uint8Array(await readFile(input.benchmark.zipPath));
  const files = unzipSync(original);
  const openQuestions = questionFiles(files);
  const entries: QuestionResolutionEntry[] = [];
  let advisorAnswers = 0;
  let sourceAnswers = 0;
  const answeredAt = new Date().toISOString();
  const agent = new AgentRunner(input.campaign);

  for (const [fileName, question] of openQuestions) {
    const advisor = await askRequirementsAgent(input.campaign, question, input.artifactDirectory);
    let answer: string;
    let evidence: string[];
    let resolution: QuestionResolutionEntry['resolution'];
    if (advisor.resolution === 'answered' && typeof advisor.answer === 'string') {
      answer = advisor.answer.trim();
      const citations = Array.isArray(advisor.citations)
        ? (advisor.citations as Array<{ entity: string; anchor?: string; quote?: string }>)
        : [];
      evidence = citations.map((citation) =>
        citation.anchor ? `${citation.entity}#${citation.anchor}` : citation.entity,
      );
      if (evidence.length === 0) evidence.push('requirements-agent returned a grounded answer');
      resolution = 'requirements_agent';
      advisorAnswers += 1;
    } else {
      const source = await agent.answerUpstreamQuestion(
        {
          id: question.id,
          question: question.question,
          ...(question.entity ? { entity: question.entity } : {}),
          ...(question.anchor ? { anchor: question.anchor } : {}),
          type: question.type,
          options: question.options,
        },
        input.workflowsSource,
        input.artifactDirectory,
      );
      if (source.resolution !== 'answered') {
        throw new Error(`blocking question ${question.id} remains unresolved: ${source.reason}`);
      }
      answer = source.answer.trim();
      evidence = source.evidence;
      resolution = 'source_fallback';
      sourceAnswers += 1;
    }
    files[fileName] = strToU8(
      stringify(applyAnswer(question, answer, `planner-eval-harness/${resolution}`, answeredAt)),
    );
    entries.push({ id: question.id, question: question.question, resolution, answer, evidence });
  }

  updatePackBindings(files, entries.length);
  const resolvedBytes = openQuestions.length === 0 ? original : zipSync(files, { level: 6 });
  const resolvedArtifactSha = digest(resolvedBytes);
  await writeFile(sharedPackPath, resolvedBytes, { flag: 'wx', mode: 0o600 });
  const summary: BenchmarkQuestionResolution = {
    derivationVersion: 2,
    benchmark: input.benchmark.name,
    originalArtifactSha: input.benchmark.sha256 ?? digest(original),
    resolvedArtifactSha,
    blockingQuestions: openQuestions.length,
    requirementsAgentRequests: openQuestions.length,
    requirementsAgentAnswers: advisorAnswers,
    sourceFallbackAnswers: sourceAnswers,
    reusedAnswers: 0,
    plannerQuestions: 0,
    plannerRequirementsAgentRequests: 0,
    plannerRequirementsAgentAnswers: 0,
    plannerSourceFallbackAnswers: 0,
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
