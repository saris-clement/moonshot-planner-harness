import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parse, stringify } from 'yaml';
import { resolveBenchmarkQuestions } from '../src/upstreamQuestions.js';
import {
  CampaignConfigSchema,
  type BenchmarkQuestionResolution,
  type CampaignRecord,
} from '../src/types.js';

const sha256 = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function cachedResolutionFixture(): Promise<{
  root: string;
  campaign: CampaignRecord;
  benchmark: CampaignRecord['config']['benchmarks'][number];
  sharedDirectory: string;
  artifactDirectory: string;
  sharedPackPath: string;
  sharedSummaryPath: string;
  resolvedBytes: Uint8Array;
  summary: BenchmarkQuestionResolution;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-cached-questions-'));
  const inputBytes = zipSync({ 'manifest.yaml': strToU8(stringify({ workflow: 'test/cache' })) });
  const zipPath = path.join(root, 'pack.zip');
  const environmentFile = path.join(root, 'planner.env');
  await Promise.all([writeFile(zipPath, inputBytes), writeFile(environmentFile, '')]);
  const originalArtifactSha = sha256(inputBytes);
  const config = CampaignConfigSchema.parse({
    id: 'cached-question-test',
    goal: 'Verify cached resolved question pack integrity before reuse.',
    plannerRepo: root,
    workflowsRepo: root,
    environmentFile,
    seedRevision: 'seed',
    workflowsRevision: 'source',
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath, sha256: originalArtifactSha },
      { name: 'holdout', role: 'holdout', zipPath, sha256: originalArtifactSha },
    ],
  });
  const campaign: CampaignRecord = {
    id: config.id,
    status: 'ready',
    config,
    seedSha: 'a'.repeat(40),
    workflowsSha: 'b'.repeat(40),
    environmentSha: `sha256:${'c'.repeat(64)}`,
    workflowsRemoteUrl: 'https://github.com/Saris-AI/workflows.git',
    currentParentVariantId: null,
    noImprovementRounds: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const sharedDirectory = path.join(root, 'shared');
  const artifactDirectory = path.join(root, 'artifacts');
  await mkdir(sharedDirectory);
  const sharedPackPath = path.join(sharedDirectory, 'primary.zip');
  const sharedSummaryPath = path.join(sharedDirectory, 'primary.questions.json');
  const resolvedBytes = zipSync({ 'resolved.txt': strToU8('trusted resolved cache') });
  const summary: BenchmarkQuestionResolution = {
    derivationVersion: 2,
    benchmark: 'primary',
    originalArtifactSha,
    resolvedArtifactSha: sha256(resolvedBytes),
    blockingQuestions: 0,
    requirementsAgentRequests: 0,
    requirementsAgentAnswers: 0,
    sourceFallbackAnswers: 0,
    reusedAnswers: 0,
    plannerQuestions: 0,
    plannerRequirementsAgentRequests: 0,
    plannerRequirementsAgentAnswers: 0,
    plannerSourceFallbackAnswers: 0,
    plannerReusedAnswers: 0,
    plannerHumanAnswers: 0,
    entries: [],
  };
  await Promise.all([
    writeFile(sharedPackPath, resolvedBytes),
    writeFile(sharedSummaryPath, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
  return {
    root,
    campaign,
    benchmark: config.benchmarks[0]!,
    sharedDirectory,
    artifactDirectory,
    sharedPackPath,
    sharedSummaryPath,
    resolvedBytes,
    summary,
  };
}

async function cachedAnsweredResolutionFixture() {
  const fixture = await cachedResolutionFixture();
  const answer = 'Use the trusted source-backed integration.';
  const answeredAt = '2026-09-06T00:00:00.000Z';
  const questionBase = {
    id: 'question-cached',
    type: 'data_request',
    question: 'Which integration should be used?',
    severity: 'blocking',
    options: [{ id: 'option-1', label: 'Provide', description: 'Provide the integration.' }],
  };
  const openQuestion = { ...questionBase, status: 'open' };
  const question = {
    ...questionBase,
    status: 'answered',
    answer: {
      selected: ['option-1'],
      value: answer,
      by: 'planner-eval-harness/source_fallback',
      at: answeredAt,
    },
  };
  const preExistingQuestion = {
    id: 'question-pre-existing',
    type: 'data_request',
    question: 'Which approved region is already configured?',
    severity: 'advisory',
    status: 'answered',
    options: [{ id: 'option-region', label: 'Provide', description: 'Provide the region.' }],
    answer: {
      selected: ['option-region'],
      value: 'Use the approved east region.',
      by: 'requirements-reviewer',
      at: '2026-09-05T00:00:00.000Z',
    },
  };
  const originalBytes = zipSync({
    'requirements/context.yaml': strToU8(stringify({ integration: 'trusted' })),
    'questions/question-cached.yaml': strToU8(stringify(openQuestion)),
    'questions/question-pre-existing.yaml': strToU8(stringify(preExistingQuestion)),
  });
  const resolvedBytes = zipSync(
    {
      'requirements/context.yaml': strToU8(stringify({ integration: 'trusted' })),
      'questions/question-cached.yaml': strToU8(stringify(question)),
      'questions/question-pre-existing.yaml': strToU8(stringify(preExistingQuestion)),
    },
    { level: 6, mtime: new Date(answeredAt) },
  );
  const originalArtifactSha = sha256(originalBytes);
  await writeFile(fixture.benchmark.zipPath, originalBytes);
  fixture.benchmark.sha256 = originalArtifactSha;
  fixture.summary.originalArtifactSha = originalArtifactSha;
  fixture.summary.resolvedArtifactSha = sha256(resolvedBytes);
  fixture.summary.blockingQuestions = 1;
  fixture.summary.sourceFallbackAnswers = 1;
  fixture.summary.entries = [
    {
      id: question.id,
      question: question.question,
      resolution: 'source_fallback',
      answer,
      selectedOptionId: 'option-1',
      evidence: ['src/integrations/trusted.ts:1'],
    },
  ];
  await Promise.all([
    writeFile(fixture.sharedPackPath, resolvedBytes),
    writeFile(fixture.sharedSummaryPath, `${JSON.stringify(fixture.summary, null, 2)}\n`),
  ]);
  return { ...fixture, answer, openQuestion, question, preExistingQuestion, resolvedBytes };
}

async function writeRehashedCache(
  fixture: Awaited<ReturnType<typeof cachedAnsweredResolutionFixture>>,
  files: Record<string, Uint8Array>,
): Promise<void> {
  const resolvedBytes = zipSync(files);
  fixture.summary.resolvedArtifactSha = sha256(resolvedBytes);
  await Promise.all([
    writeFile(fixture.sharedPackPath, resolvedBytes),
    writeFile(fixture.sharedSummaryPath, `${JSON.stringify(fixture.summary, null, 2)}\n`),
  ]);
}

async function sourceSelectionFixture() {
  const fixture = await cachedResolutionFixture();
  await Promise.all([
    rm(fixture.sharedPackPath, { force: true }),
    rm(fixture.sharedSummaryPath, { force: true }),
  ]);
  const question = {
    id: 'question-source-selection',
    type: 'data_request',
    question: 'Which grounded integration option should be used?',
    severity: 'blocking',
    status: 'open',
    options: [
      { id: 'option-first', label: 'First', description: 'Use the first integration.' },
      { id: 'option-second', label: 'Second', description: 'Use the second integration.' },
    ],
  };
  const originalBytes = zipSync({
    'questions/question-source-selection.yaml': strToU8(stringify(question)),
  });
  await writeFile(fixture.benchmark.zipPath, originalBytes);
  fixture.benchmark.sha256 = sha256(originalBytes);
  return { ...fixture, question };
}

test('requirements-agent answers produce one reusable derived pack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-questions-'));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        resolution: 'answered',
        answer: 'Use the reviewed production read-only integration.',
        citations: [
          {
            entity: 'solution/main',
            anchor: 'systems/core',
            quote: 'customer-specific source excerpt',
          },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('question test server did not bind');
  const environmentFile = path.join(root, 'planner.env');
  await writeFile(
    environmentFile,
    `PLANNER_REQUIREMENTS_AGENT_BASE_URL=http://127.0.0.1:${address.port}\nPLANNER_REQUIREMENTS_AGENT_SERVICE_SECRET=${'s'.repeat(32)}\n`,
  );
  const question = {
    id: 'question-1',
    type: 'data_request',
    workflow: 'customer/workflow',
    stage: 'proposed_solution',
    entity: 'solution/main',
    anchor: 'systems/core',
    header: 'Core env',
    question: 'Which read-only environment should be used?',
    severity: 'blocking',
    multiSelect: false,
    options: [{ id: 'option-1', label: 'Provide', description: 'Provide the value.' }],
    status: 'open',
  };
  const bytes = zipSync({
    'manifest.yaml': strToU8(
      stringify({
        workflow: 'customer/workflow',
        questions: { open: 1, answered: 0, total: 1 },
      }),
    ),
    'SUMMARY.yaml': strToU8(
      stringify({
        packVersion: 4,
        exportHash: 'originalhash',
        workflow: 'customer/workflow',
        generatedAt: '2026-09-06T00:00:00.000Z',
        binding: {
          openQuestions: [
            { id: 'question-1', kind: 'data_request', question: question.question, status: 'open' },
          ],
          outOfScope: [],
        },
      }),
    ),
    'questions/question-1.yaml': strToU8(stringify(question)),
  });
  const zipPath = path.join(root, 'pack.zip');
  await writeFile(zipPath, bytes);
  const artifactSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const config = CampaignConfigSchema.parse({
    id: 'question-test',
    goal: 'Resolve upstream questions before evaluating Phase 2 decisions.',
    plannerRepo: root,
    workflowsRepo: root,
    environmentFile,
    seedRevision: 'seed',
    workflowsRevision: 'source',
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath, sha256: artifactSha },
      { name: 'holdout', role: 'holdout', zipPath, sha256: artifactSha },
    ],
  });
  const campaign: CampaignRecord = {
    id: config.id,
    status: 'ready',
    config,
    seedSha: 'a'.repeat(40),
    workflowsSha: 'b'.repeat(40),
    environmentSha: `sha256:${'c'.repeat(64)}`,
    workflowsRemoteUrl: 'https://github.com/Saris-AI/workflows.git',
    currentParentVariantId: null,
    noImprovementRounds: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const sharedDirectory = path.join(root, 'shared');
  const artifactDirectory = path.join(root, 'artifacts');
  await mkdir(artifactDirectory);
  try {
    const first = await resolveBenchmarkQuestions({
      campaign,
      benchmark: config.benchmarks[0]!,
      workflowsSource: root,
      sharedDirectory,
      artifactDirectory,
    });
    assert.equal(first.summary.requirementsAgentRequests, 1);
    assert.equal(first.summary.requirementsAgentAnswers, 1);
    assert.equal(first.summary.sourceFallbackAnswers, 0);
    assert.deepEqual(first.summary.entries[0]?.evidence, ['solution/main#systems/core']);
    assert.equal(first.summary.entries[0]?.selectedOptionId, 'option-1');
    const resolved = unzipSync(new Uint8Array(await readFile(first.benchmark.zipPath)));
    const resolvedQuestion = parse(
      strFromU8(resolved['questions/question-1.yaml']!),
    ) as typeof question & { answer: { value: string } };
    assert.equal(resolvedQuestion.status, 'answered');
    assert.equal(resolvedQuestion.answer.value, 'Use the reviewed production read-only integration.');
    const manifest = parse(strFromU8(resolved['manifest.yaml']!)) as {
      exportHash: string;
      questions: { open: number; answered: number };
    };
    assert.deepEqual(manifest.questions, { open: 0, answered: 1, total: 1 });
    const summary = parse(strFromU8(resolved['SUMMARY.yaml']!)) as {
      exportHash: string;
      binding: { openQuestions: unknown[] };
    };
    assert.equal(summary.exportHash, manifest.exportHash);
    assert.deepEqual(summary.binding.openQuestions, []);

    const reused = await resolveBenchmarkQuestions({
      campaign,
      benchmark: config.benchmarks[0]!,
      workflowsSource: root,
      sharedDirectory,
      artifactDirectory,
    });
    assert.equal(reused.summary.requirementsAgentRequests, 0);
    assert.equal(reused.summary.reusedAnswers, 1);
    assert.equal(reused.benchmark.sha256, first.benchmark.sha256);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('source fallback materializes and reuses its grounded second option', async () => {
  const fixture = await sourceSelectionFixture();
  let sourceCalls = 0;
  const input = {
    campaign: fixture.campaign,
    benchmark: fixture.benchmark,
    workflowsSource: fixture.root,
    sharedDirectory: fixture.sharedDirectory,
    artifactDirectory: fixture.artifactDirectory,
    agent: {
      answerUpstreamQuestion: async () => {
        sourceCalls += 1;
        return {
          resolution: 'answered' as const,
          answer: 'Use the grounded second integration.',
          selectedOptionId: 'option-second',
          evidence: ['src/integrations/second.ts:1'],
        };
      },
    },
  };
  try {
    const first = await resolveBenchmarkQuestions(input);
    const files = unzipSync(new Uint8Array(await readFile(first.benchmark.zipPath)));
    const resolvedQuestion = parse(
      strFromU8(files['questions/question-source-selection.yaml']!),
    ) as typeof fixture.question & { answer: { selected: string[]; value: string } };
    assert.deepEqual(resolvedQuestion.answer.selected, ['option-second']);
    assert.equal(first.summary.entries[0]?.selectedOptionId, 'option-second');

    const reused = await resolveBenchmarkQuestions(input);
    assert.equal(reused.summary.reusedAnswers, 1);
    assert.equal(reused.summary.entries[0]?.selectedOptionId, 'option-second');
    assert.equal(sourceCalls, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('PM simulation materializes concise answers while keeping evidence in harness artifacts', async () => {
  const fixture = await sourceSelectionFixture();
  let sourceCalls = 0;
  let receivedMode: string | undefined;
  let allowedResolution: string | undefined;
  const input = {
    campaign: fixture.campaign,
    benchmark: fixture.benchmark,
    workflowsSource: fixture.root,
    sharedDirectory: fixture.sharedDirectory,
    artifactDirectory: fixture.artifactDirectory,
    sourceAnswerMode: 'pm-simulation' as const,
    answerAllowed: (candidate: { resolution: string }) => {
      allowedResolution = candidate.resolution;
      return true;
    },
    agent: {
      answerUpstreamQuestion: async (
        _question: unknown,
        _workflowsSource: string,
        _artifactDirectory: string,
        options?: { mode?: 'source-grounded' | 'pm-simulation' },
      ) => {
        sourceCalls += 1;
        receivedMode = options?.mode;
        return {
          resolution: 'answered' as const,
          answer: 'Use the second integration as the planning assumption.',
          selectedOptionId: 'option-second',
          evidence: ['PM simulation inferred this choice from the requirements context.'],
        };
      },
    },
  };
  try {
    const first = await resolveBenchmarkQuestions(input);
    assert.equal(receivedMode, 'pm-simulation');
    assert.equal(allowedResolution, 'pm_simulation');
    assert.equal(first.summary.pmSimulationAnswers, 1);
    assert.equal(first.summary.sourceFallbackAnswers, 0);
    assert.equal(first.summary.entries[0]?.resolution, 'pm_simulation');
    assert.deepEqual(first.summary.entries[0]?.evidence, [
      'PM simulation inferred this choice from the requirements context.',
    ]);

    const files = unzipSync(new Uint8Array(await readFile(first.benchmark.zipPath)));
    const question = parse(
      strFromU8(files['questions/question-source-selection.yaml']!),
    ) as typeof fixture.question & {
      answer: { selected: string[]; value: string; by: string; evidence?: unknown };
    };
    assert.equal(question.answer.by, 'planner-eval-harness/pm_simulation');
    assert.deepEqual(question.answer.selected, ['option-second']);
    assert.equal(question.answer.evidence, undefined);
    assert.equal(
      strFromU8(files['questions/question-source-selection.yaml']!).includes(
        'PM simulation inferred this choice',
      ),
      false,
    );
    const artifactSummary = JSON.parse(
      await readFile(path.join(fixture.artifactDirectory, 'question-resolutions.json'), 'utf8'),
    ) as BenchmarkQuestionResolution;
    assert.deepEqual(artifactSummary.entries[0]?.evidence, first.summary.entries[0]?.evidence);

    const reused = await resolveBenchmarkQuestions(input);
    assert.equal(reused.summary.pmSimulationAnswers, 1);
    assert.equal(reused.summary.reusedAnswers, 1);
    assert.equal(reused.summary.entries[0]?.resolution, 'pm_simulation');
    assert.equal(sourceCalls, 1);
    await assert.rejects(
      resolveBenchmarkQuestions({ ...input, sourceAnswerMode: 'source-grounded' }),
      /resolved pack cache provenance mode mismatch for primary: source-grounded/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('PM simulation rejects answers beyond its planner-visible concision limits', async () => {
  const fixture = await sourceSelectionFixture();
  let answer = '   ';
  const resolve = () =>
    resolveBenchmarkQuestions({
      campaign: fixture.campaign,
      benchmark: fixture.benchmark,
      workflowsSource: fixture.root,
      sharedDirectory: fixture.sharedDirectory,
      artifactDirectory: fixture.artifactDirectory,
      sourceAnswerMode: 'pm-simulation',
      agent: {
        answerUpstreamQuestion: async () => ({
          resolution: 'answered',
          answer,
          evidence: ['Harness-only PM simulation rationale.'],
        }),
      },
    });
  try {
    await assert.rejects(resolve(), /PM-simulation answer.*must be nonempty/);
    answer = 'One sentence. Two sentences. Three sentences. Four sentences.';
    await assert.rejects(resolve(), /PM-simulation answer.*at most 3 sentences/);
    answer = 'x'.repeat(1_001);
    await assert.rejects(resolve(), /PM-simulation answer.*at most 1000 characters/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('legacy cached summaries reuse with a zero PM simulation count', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const legacySummary = { ...fixture.summary };
    delete legacySummary.pmSimulationAnswers;
    await writeFile(fixture.sharedSummaryPath, `${JSON.stringify(legacySummary, null, 2)}\n`);

    const reused = await resolveBenchmarkQuestions({
      campaign: fixture.campaign,
      benchmark: fixture.benchmark,
      workflowsSource: fixture.root,
      sharedDirectory: fixture.sharedDirectory,
      artifactDirectory: fixture.artifactDirectory,
    });

    assert.equal(reused.summary.pmSimulationAnswers, 0);
    assert.equal(reused.summary.reusedAnswers, 1);
    assert.equal(reused.summary.entries[0]?.resolution, 'source_fallback');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('PM simulation cache rejects jointly rehashed provenance substitution', async () => {
  const fixture = await sourceSelectionFixture();
  const input = {
    campaign: fixture.campaign,
    benchmark: fixture.benchmark,
    workflowsSource: fixture.root,
    sharedDirectory: fixture.sharedDirectory,
    artifactDirectory: fixture.artifactDirectory,
    sourceAnswerMode: 'pm-simulation' as const,
    agent: {
      answerUpstreamQuestion: async () => ({
        resolution: 'answered' as const,
        answer: 'Use the second integration as the planning assumption.',
        selectedOptionId: 'option-second',
        evidence: ['Harness-only PM simulation rationale.'],
      }),
    },
  };
  try {
    const first = await resolveBenchmarkQuestions(input);
    const files = unzipSync(new Uint8Array(await readFile(first.benchmark.zipPath)));
    const question = parse(
      strFromU8(files['questions/question-source-selection.yaml']!),
    ) as typeof fixture.question & { answer: { by: string } };
    question.answer.by = 'planner-eval-harness/source_fallback';
    files['questions/question-source-selection.yaml'] = strToU8(stringify(question));
    const tamperedBytes = zipSync(files);
    const persisted = JSON.parse(
      await readFile(fixture.sharedSummaryPath, 'utf8'),
    ) as BenchmarkQuestionResolution;
    persisted.resolvedArtifactSha = sha256(tamperedBytes);
    await Promise.all([
      writeFile(fixture.sharedPackPath, tamperedBytes),
      writeFile(fixture.sharedSummaryPath, `${JSON.stringify(persisted, null, 2)}\n`),
    ]);

    await assert.rejects(
      resolveBenchmarkQuestions(input),
      /resolved pack cache content mismatch for primary: provenance for question-source-selection/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('source fallback rejects a selected option ID absent from the question', async () => {
  const fixture = await sourceSelectionFixture();
  try {
    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
        agent: {
          answerUpstreamQuestion: async () => ({
            resolution: 'answered',
            answer: 'Use an option that was not offered.',
            selectedOptionId: 'option-missing',
            evidence: ['src/integrations/missing.ts:1'],
          }),
        },
      }),
      /blocking question question-source-selection selected unknown option option-missing/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects tampered ZIP bytes', async () => {
  const fixture = await cachedResolutionFixture();
  try {
    await writeFile(
      fixture.sharedPackPath,
      zipSync({ 'resolved.txt': strToU8('poisoned resolved cache') }),
    );

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache integrity mismatch for primary: resolved artifact SHA/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects an original artifact SHA mismatch', async () => {
  const fixture = await cachedResolutionFixture();
  try {
    fixture.summary.originalArtifactSha = sha256(strToU8('different benchmark input'));
    await writeFile(
      fixture.sharedSummaryPath,
      `${JSON.stringify(fixture.summary, null, 2)}\n`,
    );

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache integrity mismatch for primary: original artifact SHA/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed materialized answer substitution', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    const question = parse(
      strFromU8(files['questions/question-cached.yaml']!),
    ) as typeof fixture.question;
    question.answer.value = 'Use the poisoned integration.';
    files['questions/question-cached.yaml'] = strToU8(stringify(question));
    await writeRehashedCache(fixture, files);
    let checkedAnswer: string | undefined;

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
        answerAllowed: ({ answer }) => {
          checkedAnswer = answer;
          return !answer.includes('poisoned');
        },
      }),
      /resolved pack cache content mismatch for primary: answer for question-cached/,
    );
    assert.equal(checkedAnswer, fixture.answer);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed provenance substitution', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    const question = parse(
      strFromU8(files['questions/question-cached.yaml']!),
    ) as typeof fixture.question;
    question.answer.by = 'planner-eval-harness/requirements_agent';
    files['questions/question-cached.yaml'] = strToU8(stringify(question));
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache content mismatch for primary: provenance for question-cached/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed selected-option substitution', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    const question = parse(
      strFromU8(files['questions/question-cached.yaml']!),
    ) as typeof fixture.question;
    question.answer.selected = ['option-attacker'];
    files['questions/question-cached.yaml'] = strToU8(stringify(question));
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache content mismatch for primary: selected options for question-cached/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a missing materialized answered question', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    await writeRehashedCache(fixture, {});

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache content mismatch for primary: expected one answered question question-cached, found 0/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects duplicate materialized answered question IDs', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    files['questions/question-cached-copy.yaml'] = files['questions/question-cached.yaml']!;
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache content mismatch for primary: expected one answered question question-cached, found 2/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed extra answered question', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    files['questions/question-extra.yaml'] = strToU8(
      stringify({
        ...fixture.question,
        id: 'question-extra',
        question: 'Which unreviewed integration should be added?',
      }),
    );
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache content mismatch for primary: unexpected resolved question question-extra/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed alteration to a pre-existing answer', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    const preExistingQuestion = parse(
      strFromU8(files['questions/question-pre-existing.yaml']!),
    ) as typeof fixture.preExistingQuestion;
    preExistingQuestion.answer.value = 'Use an attacker-selected west region.';
    files['questions/question-pre-existing.yaml'] = strToU8(stringify(preExistingQuestion));
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache content mismatch for primary: unrelated question question-pre-existing changed/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack allows an unchanged pre-existing answered question without a summary entry', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const reused = await resolveBenchmarkQuestions({
      campaign: fixture.campaign,
      benchmark: fixture.benchmark,
      workflowsSource: fixture.root,
      sharedDirectory: fixture.sharedDirectory,
      artifactDirectory: fixture.artifactDirectory,
    });

    assert.equal(reused.summary.reusedAnswers, 1);
    assert.equal(reused.summary.entries[0]?.id, fixture.question.id);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed non-question mutation', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    files['requirements/context.yaml'] = strToU8(stringify({ integration: 'poisoned' }));
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache reconstruction mismatch for primary/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('cached resolved pack rejects a jointly rehashed added file', async () => {
  const fixture = await cachedAnsweredResolutionFixture();
  try {
    const files = unzipSync(fixture.resolvedBytes);
    files['attacker-added.txt'] = strToU8('poisoned cache addition');
    await writeRehashedCache(fixture, files);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: fixture.benchmark,
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /resolved pack cache reconstruction mismatch for primary/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('benchmark input rejects a supplied SHA that differs from the measured ZIP', async () => {
  const fixture = await cachedResolutionFixture();
  try {
    await Promise.all([
      rm(fixture.sharedPackPath, { force: true }),
      rm(fixture.sharedSummaryPath, { force: true }),
    ]);

    await assert.rejects(
      resolveBenchmarkQuestions({
        campaign: fixture.campaign,
        benchmark: {
          ...fixture.benchmark,
          sha256: sha256(strToU8('not the frozen benchmark ZIP')),
        },
        workflowsSource: fixture.root,
        sharedDirectory: fixture.sharedDirectory,
        artifactDirectory: fixture.artifactDirectory,
      }),
      /benchmark input SHA mismatch for primary/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete cache with only a resolved ZIP is removed and regenerated', async () => {
  const fixture = await cachedResolutionFixture();
  try {
    await rm(fixture.sharedSummaryPath);

    const regenerated = await resolveBenchmarkQuestions({
      campaign: fixture.campaign,
      benchmark: fixture.benchmark,
      workflowsSource: fixture.root,
      sharedDirectory: fixture.sharedDirectory,
      artifactDirectory: fixture.artifactDirectory,
    });

    const persisted = JSON.parse(
      await readFile(fixture.sharedSummaryPath, 'utf8'),
    ) as BenchmarkQuestionResolution;
    assert.equal(regenerated.summary.reusedAnswers, 0);
    assert.equal(regenerated.summary.originalArtifactSha, fixture.summary.originalArtifactSha);
    assert.equal(sha256(await readFile(fixture.sharedPackPath)), regenerated.summary.resolvedArtifactSha);
    assert.equal(persisted.resolvedArtifactSha, regenerated.summary.resolvedArtifactSha);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete cache with only a resolution summary is removed and regenerated', async () => {
  const fixture = await cachedResolutionFixture();
  try {
    await rm(fixture.sharedPackPath);

    const regenerated = await resolveBenchmarkQuestions({
      campaign: fixture.campaign,
      benchmark: fixture.benchmark,
      workflowsSource: fixture.root,
      sharedDirectory: fixture.sharedDirectory,
      artifactDirectory: fixture.artifactDirectory,
    });

    const persisted = JSON.parse(
      await readFile(fixture.sharedSummaryPath, 'utf8'),
    ) as BenchmarkQuestionResolution;
    assert.equal(regenerated.summary.reusedAnswers, 0);
    assert.equal(regenerated.summary.originalArtifactSha, fixture.summary.originalArtifactSha);
    assert.equal(sha256(await readFile(fixture.sharedPackPath)), regenerated.summary.resolvedArtifactSha);
    assert.equal(persisted.resolvedArtifactSha, regenerated.summary.resolvedArtifactSha);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('target-safe resolution rejects advisor leakage and falls back to the filtered source agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-target-safe-'));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      resolution: 'answered',
      answer: 'Use trumark/deceased-accounts implementation behavior.',
      citations: [{ entity: 'src/customers/trumark/deceased-accounts/index.ts' }],
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('question test server did not bind');
  const environmentFile = path.join(root, 'planner.env');
  await writeFile(
    environmentFile,
    `PLANNER_REQUIREMENTS_AGENT_BASE_URL=http://127.0.0.1:${address.port}\nPLANNER_REQUIREMENTS_AGENT_SERVICE_SECRET=${'s'.repeat(32)}\n`,
  );
  const question = {
    id: 'question-safe',
    type: 'data_request',
    workflow: 'trumark/deceased-account',
    question: 'Which read boundary applies?',
    severity: 'blocking',
    status: 'open',
    options: [{ id: 'option-safe', label: 'Provide', description: 'Provide the value.' }],
  };
  const bytes = zipSync({
    'manifest.yaml': strToU8(stringify({ workflow: question.workflow, questions: { open: 1, answered: 0, total: 1 } })),
    'SUMMARY.yaml': strToU8(stringify({ exportHash: 'original', binding: { openQuestions: [question] } })),
    'questions/question-safe.yaml': strToU8(stringify(question)),
  });
  const zipPath = path.join(root, 'pack.zip');
  await writeFile(zipPath, bytes);
  const config = CampaignConfigSchema.parse({
    id: 'target-safe',
    goal: 'Resolve one target-safe imported question for a counterfactual pair.',
    plannerRepo: root,
    workflowsRepo: root,
    environmentFile,
    seedRevision: 'seed',
    workflowsRevision: 'source',
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath },
      { name: 'holdout', role: 'holdout', zipPath },
    ],
  });
  const campaign: CampaignRecord = {
    id: config.id,
    status: 'ready',
    config,
    seedSha: 'a'.repeat(40),
    workflowsSha: 'b'.repeat(40),
    environmentSha: `sha256:${'c'.repeat(64)}`,
    workflowsRemoteUrl: 'https://github.com/Saris-AI/workflows.git',
    currentParentVariantId: null,
    noImprovementRounds: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    const resolved = await resolveBenchmarkQuestions({
      campaign,
      benchmark: config.benchmarks[0]!,
      workflowsSource: root,
      sharedDirectory: path.join(root, 'safe'),
      artifactDirectory: path.join(root, 'artifacts'),
      answerAllowed: ({ answer, evidence }) =>
        !`${answer}\n${evidence.join('\n')}`.includes('trumark/deceased-accounts'),
      agent: {
        answerUpstreamQuestion: async () => ({
          resolution: 'answered',
          answer: 'Use the shared read-only integration boundary.',
          evidence: ['src/modules/shared/read.ts:1'],
        }),
      },
    });
    assert.equal(resolved.summary.requirementsAgentAnswers, 0);
    assert.equal(resolved.summary.sourceFallbackAnswers, 1);
    assert.equal(resolved.summary.entries[0]?.answer, 'Use the shared read-only integration boundary.');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
