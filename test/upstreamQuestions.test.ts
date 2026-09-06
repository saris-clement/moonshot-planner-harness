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
import { CampaignConfigSchema, type CampaignRecord } from '../src/types.js';

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
