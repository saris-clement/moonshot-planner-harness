import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRunner } from '../src/agents.js';
import {
  CampaignConfigSchema,
  DiagnosisInputSchema,
  type CampaignRecord,
  type VariantRecord,
} from '../src/types.js';
import type { CommandResult } from '../src/process.js';

const config = CampaignConfigSchema.parse({
  id: 'agent-repair',
  goal: 'Verify structured source answers recover from progress-only model output.',
  plannerRepo: '/tmp/planner',
  workflowsRepo: '/tmp/workflows',
  environmentFile: '/tmp/environment.env',
  seedRevision: 'seed',
  workflowsRevision: 'workflows',
  benchmarks: [
    { name: 'primary', role: 'primary', zipPath: '/tmp/primary.zip' },
    { name: 'holdout', role: 'holdout', zipPath: '/tmp/holdout.zip' },
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
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
};

test('source-answer agent retries progress-only output with a JSON repair request', async () => {
  const calls: string[][] = [];
  const outputs = [
    'I am tracing the source before answering.',
    '{"resolution":"answered","answer":"Use the shared format.","evidence":["src/shared.ts:1"]}',
  ];
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: outputs[calls.length - 1]!,
      stderr: '',
      durationMs: 1,
    };
  });

  const answer = await runner.answerUpstreamQuestion(
    { id: 'question-a', question: 'Which format?', type: 'free_text', options: [] },
    '/tmp',
    '/tmp',
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1]!.join(' '), /previous response was not valid JSON/);
  assert.equal(answer.resolution, 'answered');
});

test('strategist prompt and schema require current diagnosis finding citations', async () => {
  const calls: string[][] = [];
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: JSON.stringify({
        hypotheses: [
          {
            title: 'Retain executable evidence',
            rationale: 'The cited diagnosis identified a bounded loss.',
            instructions: 'Preserve qualified executable declarations.',
            expectedImpact: 'Reduce unsupported build decisions.',
            risk: 'Could admit declarations without behavior.',
            findingIds: ['finding-hydration'],
            assumptions: ['The diagnosed evidence loss is causally relevant.'],
          },
        ],
      }),
      stderr: '',
      durationMs: 1,
    };
  });
  const hypotheses = await runner.proposeHypotheses('/tmp', '/tmp/history.json', 1);
  assert.deepEqual(hypotheses[0]?.findingIds, ['finding-hydration']);
  assert.deepEqual(hypotheses[0]?.assumptions, [
    'The diagnosed evidence loss is causally relevant.',
  ]);
  assert.match(calls[0]!.join(' '), /real finding IDs/);
  assert.match(calls[0]!.join(' '), /counterevidence/);
  assert.match(calls[0]!.join(' '), /assumptions/);
});

test('strategist output is rejected when it omits explicit assumptions', async () => {
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => ({
    command,
    args: [...args],
    exitCode: 0,
    stdout: JSON.stringify({
      hypotheses: [
        {
          title: 'Missing assumption',
          rationale: 'A bounded rationale.',
          instructions: 'Make one bounded change.',
          expectedImpact: 'A measurable change.',
          risk: 'The mechanism may be wrong.',
          findingIds: ['finding-hydration'],
        },
      ],
    }),
    stderr: '',
    durationMs: 1,
  }));

  await assert.rejects(
    runner.proposeHypotheses('/tmp', '/tmp/history.json', 1),
    /invalid structured output/,
  );
});

test('diagnostician archives strict cited unverified output and mutator receives bounded context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-agent-diagnosis-'));
  const inputPath = path.join(directory, 'diagnosis-input.json');
  const evidence = (id: string, summary: string) => ({
    id,
    kind: 'fixture',
    summary,
    affectedUnitKeys: ['unit-a'],
    provenance: {
      classification: 'observed_durable' as const,
      source: 'harness' as const,
      artifactPath: null,
      artifactSha256: null,
      integrity: 'verified' as const,
      caseId: 'case-a',
      runId: 'run-a',
      unitKey: 'unit-a',
      limitation: null,
    },
    data: { value: summary },
  });
  const diagnosisInput = DiagnosisInputSchema.parse({
    kind: 'ainative-planner-eval/diagnosis-input',
    schemaVersion: 1,
    interpretationPolicy: 'Diagnosis is model-generated, unverified, and excluded from numeric scoring.',
    campaign: {
      id: campaign.id,
      plannerSeed: campaign.seedSha,
      workflowsRevision: campaign.workflowsSha,
      environmentSha256: campaign.environmentSha,
      benchmarkPins: [],
    },
    variant: {
      id: 'agent-repair-v000',
      parentVariantId: null,
      round: 0,
      artifactCollectionComplete: true,
    },
    lineage: [],
    completeness: {
      status: 'complete',
      items: [
        {
          component: 'analysis',
          scope: 'primary',
          status: 'complete',
          captured: 1,
          expected: 1,
          limitations: [],
        },
      ],
      limitations: [],
    },
    evidence: [
      evidence('evidence-1111111111111111', 'support'),
      evidence('evidence-2222222222222222', 'counter'),
    ],
    reconstructionSignals: [],
  });
  const serializedInput = `${JSON.stringify(diagnosisInput, null, 2)}\n`;
  const inputSha256 = `sha256:${createHash('sha256').update(serializedInput).digest('hex')}`;
  await writeFile(inputPath, serializedInput);
  const calls: string[][] = [];
  const output = {
    kind: 'ainative-planner-eval/model-diagnosis',
    schemaVersion: 1,
    interpretationStatus: 'unverified_model_judgment',
    inputSha256,
    summary: 'Evidence may be lost after hydration.',
    findings: [
      {
        id: 'finding-hydration',
        category: 'evidence_hydration',
        affectedUnitKeys: ['unit-a'],
        causalMechanism: 'A qualified pointer did not survive admission.',
        supportingEvidenceRefs: ['evidence-1111111111111111'],
        counterEvidenceRefs: ['evidence-2222222222222222'],
        confidence: 'medium',
        genericIntervention: 'Retain executable hydrated evidence.',
        falsificationTest: 'Verify valid evidence is admitted while declarations remain rejected.',
        limitations: ['This is model inference.'],
        provenance: 'model_inference',
      },
    ],
    limitations: ['This is model inference.'],
  };
  const runner = new AgentRunner(campaign, async (command, args): Promise<CommandResult> => {
    calls.push([...args]);
    return {
      command,
      args: [...args],
      exitCode: 0,
      stdout: calls.length === 1 ? 'I am still inspecting the trace.' : JSON.stringify(output),
      stderr: '',
      durationMs: 1,
    };
  });
  try {
    const result = await runner.diagnose(inputPath, inputSha256, directory, directory);
    assert.equal(result.interpretationStatus, 'unverified_model_judgment');
    assert.equal(result.findings[0]?.id, 'finding-hydration');
    assert.match(calls[0]!.join(' '), /both supporting evidence and counterevidence/);
    assert.match(calls[0]!.join(' '), /excluded from numeric scoring|unverified/);
    assert.match(calls[1]!.join(' '), /previous response did not satisfy the required JSON contract/);
    assert.match(
      await readFile(
        path.join(directory, 'diagnosis', `diagnosis-result-${inputSha256.slice(7)}.json`),
        'utf8',
      ),
      /unverified_model_judgment/,
    );

    const contextPath = path.join(directory, 'mutation-context.json');
    await writeFile(contextPath, '{"selectedFindings":[]}\n');
    const variant = {
      id: 'agent-repair-v001',
      hypothesis: {
        title: 'Retain evidence',
        rationale: 'Cites the diagnosed mechanism.',
        instructions: 'Retain evidence.',
        expectedImpact: 'Better evidence-backed decisions.',
        risk: 'Over-admission.',
        findingIds: ['finding-hydration'],
      },
    } as VariantRecord;
    await runner.mutate(variant, directory, directory, contextPath);
    const mutatorCall = calls[2]!.join(' ');
    assert.match(mutatorCall, /mutation-context\.json/);
    assert.match(mutatorCall, /unverified model interpretation/);
    assert.doesNotMatch(mutatorCall, /raw log/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
