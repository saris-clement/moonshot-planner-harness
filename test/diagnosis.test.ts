import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assembleDiagnosisInput,
  verifyDiagnosisArtifacts,
} from '../src/diagnosis.js';
import { HarnessDatabase } from '../src/db.js';
import { CampaignConfigSchema, type RunFacts } from '../src/types.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function writeJson(filePath: string, value: unknown, compact = false): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, compact ? canonical(value) : `${JSON.stringify(value, null, 2)}\n`);
}

function facts(): RunFacts {
  return {
    status: 'completed',
    sampleSize: 1,
    decisionAgreement: 1,
    unitCount: 1,
    decisions: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
    shortlist: { empty: 1, nonempty: 0, candidates: 0 },
    evidence: { discovered: 0, selectedSourceRefs: 0 },
    usage: {
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.01,
      durationMs: 50,
    },
    pins: { inputSetHash: `sha256:${'1'.repeat(64)}` },
    units: [
      {
        id: 'unit-a',
        key: 'solution/main#field-a',
        ref: { entity: 'solution/main', anchor: 'field-a' },
        kind: 'field',
        semantics: 'Use the existing account alias.',
        decision: 'build',
        confidence: 'high',
        rationale: 'No evidence was admitted.',
        selectedCandidateIds: [],
        sourceRefs: [],
        discoveredEvidenceCount: 0,
        shortlistCandidateCount: 0,
        uncoveredSemantics: ['account alias'],
      },
    ],
  };
}

async function transcriptRef(
  s3Root: string,
  purpose: 'entries' | 'requests' | 'results',
  value: unknown,
): Promise<{ objectKey: string; bytes: number; mediaType: 'application/json'; artifactSha256: string }> {
  const body = canonical(value);
  const artifactSha256 = digest(body);
  const objectKey = `tool-transcripts/${purpose}/sha256/${artifactSha256.slice(7)}.json`;
  await writeJson(path.join(s3Root, objectKey), value, true);
  return { objectKey, bytes: Buffer.byteLength(body), mediaType: 'application/json', artifactSha256 };
}

async function fixture(version: 1 | 2): Promise<{
  root: string;
  database: HarnessDatabase;
  campaignId: string;
  variantId: string;
  artifacts: string;
  workflows: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `planner-diagnosis-v${version}-`));
  const artifacts = path.join(root, 'artifacts');
  const workflows = path.join(root, 'workflows');
  const replicate = path.join(artifacts, 'primary-pack', 'replicate-1');
  const s3Root = path.join(artifacts, 's3', 'fixture-prefix');
  await mkdir(path.join(workflows, 'src'), { recursive: true });
  await writeFile(
    path.join(workflows, 'src', 'right.ts'),
    'export type ExistingAccountAlias = string;\n',
  );

  const database = new HarnessDatabase(path.join(root, 'harness.sqlite'));
  const config = CampaignConfigSchema.parse({
    id: `diagnosis-v${version}`,
    goal: 'Reconstruct evidence hydration without converting model interpretation into scoring truth.',
    plannerRepo: root,
    workflowsRepo: workflows,
    environmentFile: path.join(root, 'environment.env'),
    seedRevision: 'seed',
    workflowsRevision: 'workflows',
    evaluation: { replicates: 1, replicateConcurrency: 1 },
    benchmarks: [
      { name: 'primary-pack', role: 'primary', zipPath: path.join(root, 'primary.zip') },
      { name: 'holdout-pack', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
    ],
  });
  const campaign = database.createCampaign(
    config,
    'a'.repeat(40),
    'b'.repeat(40),
    `sha256:${'c'.repeat(64)}`,
    'https://example.invalid/workflows.git',
  );
  const created = database.createVariant({
    id: `${campaign.id}-v000`,
    campaignId: campaign.id,
    parentVariantId: null,
    round: 0,
    ordinal: 0,
    hypothesis: {
      title: 'Seed',
      rationale: 'Observe the frozen planner.',
      instructions: 'Do not edit.',
      expectedImpact: 'Capture facts.',
      risk: 'Fixture.',
      findingIds: [],
    },
  });
  const runFacts = facts();
  const judgment = {
    summary: 'Source suggests this may be a planner-system error.',
    verdicts: [
      {
        unitKey: 'solution/main#field-a',
        expectedDecision: 'reuse' as const,
        classification: 'system_error' as const,
        confidence: 'medium' as const,
        rationale: 'The frozen source contains the alias.',
        evidence: ['src/right.ts:1'],
      },
    ],
  };
  const variant = database.updateVariant(created.id, {
    status: 'review',
    artifactCollectionComplete: true,
    facts: runFacts,
    replicateFacts: [runFacts],
    judgment,
    executionState: {
      executions: [
        {
          benchmark: 'primary-pack',
          role: 'primary',
          replicate: 1,
          replicateCount: 1,
          caseId: 'case-a',
          runId: 'run-a',
          status: 'completed',
          stage: 'publishing',
          progress: { completedUnits: 1, totalUnits: 1 },
          decisions: runFacts.decisions,
          questions: [],
          updatedAt: '2026-09-06T00:00:00.000Z',
        },
      ],
    },
  });
  database.upsertLabel({
    campaignId: campaign.id,
    benchmark: 'primary-pack',
    unitKey: 'solution/main#field-a',
    expectedDecision: 'reuse',
    classification: 'system_error',
    rationale: 'Human review verified the frozen alias.',
    status: 'verified',
  });

  await writeJson(path.join(replicate, 'facts.json'), runFacts);
  await writeJson(path.join(replicate, 'result.json'), {
    caseId: 'case-a',
    runId: 'run-a',
    status: 'completed',
    facts: runFacts,
  });
  await writeJson(path.join(replicate, 'analysis.json'), {
    metadata: { caseId: 'case-a', runId: 'run-a', pins: runFacts.pins },
    analysis: {
      inputSetHash: `sha256:${'1'.repeat(64)}`,
      resolvedInputs: {
        workflowResolution: { workflow: 'generic/example', status: 'existing' },
        source: [{ commit: campaign.workflowsSha }],
        knowledgeSnapshot: { snapshotSha256: `sha256:${'2'.repeat(64)}` },
      },
      requirementUnits: [
        {
          id: 'unit-a',
          ref: { entity: 'solution/main', anchor: 'field-a' },
          kind: 'field',
          semantics: 'Use the existing account alias.',
        },
      ],
      adjudications: [
        {
          requirementUnitId: 'unit-a',
          shortlist: { algorithmVersion: 'candidate-ranking-v2', candidates: [], exclusions: [] },
          result: 'build',
          confidence: 'high',
          rationale: 'No evidence was admitted.',
          selectedCandidateIds: [],
          sourceRefs: [],
          evidenceGrounding: {
            version: 'evidence-grounding-v2',
            searchRequestHashes: [`sha256:${'3'.repeat(64)}`],
            searchCalls: 1,
            toolOperationCounts: [
              { operation: 'kb_search', count: 1 },
              { operation: 'kb_get', count: 1 },
            ],
            searchHitCount: 1,
            qualifiedPointerCount: 1,
            hydrationAttemptCount: 1,
            sourceReadCount: 1,
            admittedSourceCount: 0,
            admittedTestCount: 0,
            projectedSourceBytes: 0,
            projectedTestBytes: 0,
            rejectionCounts: [{ reason: 'non_executable_declaration', count: 1 }],
            selectedDiscoveredCount: 0,
          },
        },
      ],
    },
  });

  const modelResultContent = JSON.stringify({
    ok: true,
    value: {
      hits: [{ path: 'src/right.ts', symbol: 'ExistingAccountAlias', kind: 'type_alias' }],
      sourceRead: { status: 'succeeded' },
      evidenceRejections: [
        { path: 'src/right.ts', reason: 'non_executable_declaration', admitted: false },
      ],
    },
  });
  const resultValue =
    version === 2
      ? {
          kind: 'ainative-planner/tool-model-result',
          schemaVersion: 2,
          toolUseId: 'tool-a',
          content: modelResultContent,
          contentBytes: Buffer.byteLength(modelResultContent),
          contentSha256: digest(modelResultContent),
          metadata: { toolName: 'kb_get', isError: false },
        }
      : {
          kind: 'ainative-planner/tool-model-result',
          schemaVersion: 1,
          toolUseId: 'tool-a',
          content: modelResultContent,
          metadata: { toolName: 'kb_get', isError: false },
        };
  const resultRef = await transcriptRef(s3Root, 'results', resultValue);
  const commonEntry = {
    kind: 'ainative-planner/tool-transcript-entry',
    schemaVersion: version,
    caseId: 'case-a',
    runId: 'run-a',
    contextHash: `sha256:${'4'.repeat(64)}`,
    role: 'adjudicator',
    stage: 'adjudication',
    attempt: 1,
    turn: 1,
    ordinal: 1,
    toolName: 'kb_research',
    toolVersion: 'kb-research-v1',
    modelResultArtifact: resultRef,
    status: 'succeeded',
    startedAt: '2026-09-06T00:00:00.000Z',
    completedAt: '2026-09-06T00:00:01.000Z',
    durationMs: 1_000,
    previousCumulativeHash: null,
    previousEntryRef: null,
  };
  let entry: Record<string, unknown>;
  if (version === 2) {
    const provider = {
      kind: 'ainative-planner/tool-request',
      schemaVersion: 2,
      requestType: 'provider',
      operation: 'kb_research',
      input: { query: 'account alias' },
      requestHash: digest(canonical({ operation: 'kb_research', input: { query: 'account alias' } })),
    };
    const effective = {
      kind: 'ainative-planner/tool-request',
      schemaVersion: 2,
      requestType: 'effective',
      operation: 'kb_get',
      input: { node: 'src/right.ts::ExistingAccountAlias' },
      requestHash: digest(
        canonical({ operation: 'kb_get', input: { node: 'src/right.ts::ExistingAccountAlias' } }),
      ),
    };
    const providerRef = await transcriptRef(s3Root, 'requests', provider);
    const effectiveRef = await transcriptRef(s3Root, 'requests', effective);
    entry = {
      ...commonEntry,
      requirementUnitId: 'unit-a',
      requirementOrdinal: 1,
      toolUseId: 'tool-a',
      providerRequestHash: provider.requestHash,
      providerRequestArtifact: providerRef,
      effectiveRequestHash: effective.requestHash,
      effectiveRequestArtifact: effectiveRef,
    };
  } else {
    entry = { ...commonEntry, canonicalRequestHash: `sha256:${'5'.repeat(64)}` };
  }
  entry.cumulativeHash = digest(canonical(entry));
  const entryRef = await transcriptRef(s3Root, 'entries', entry);
  const head = {
    kind: 'ainative-planner/tool-transcript-head',
    schemaVersion: version,
    caseId: 'case-a',
    runId: 'run-a',
    contextHash: `sha256:${'4'.repeat(64)}`,
    entryCount: 1,
    previousCumulativeHash: null,
    cumulativeHash: entry.cumulativeHash,
    latestEntryRef: entryRef,
    knowledgeToolUse: 'used',
  };
  await writeJson(path.join(replicate, 'analysis-run-latest.json'), {
    checkpointMetadata: { caseId: 'case-a', runId: 'run-a', toolTranscriptHead: head },
  });

  return {
    root,
    database,
    campaignId: campaign.id,
    variantId: variant.id,
    artifacts,
    workflows,
  };
}

test('diagnosis assembly deterministically reconstructs and verifies V2 hydration lineage', async () => {
  const value = await fixture(2);
  try {
    const campaign = value.database.getCampaign(value.campaignId);
    const variant = value.database.getVariant(value.variantId);
    const assemble = async () =>
      await assembleDiagnosisInput({
        artifactDirectory: value.artifacts,
        campaign,
        variant,
        labels: value.database.listLabels(value.campaignId),
        workflowsSource: value.workflows,
        environment: {},
      });
    const first = await assemble();
    const second = await assemble();
    assert.equal(first.inputSha256, second.inputSha256);
    assert.equal(await readFile(first.inputPath, 'utf8'), await readFile(second.inputPath, 'utf8'));
    assert.deepEqual(await verifyDiagnosisArtifacts(value.artifacts, first.inputSha256), first.input);

    const signal = first.input.reconstructionSignals.find(
      (item) => item.category === 'evidence_hydration',
    );
    assert.ok(signal);
    assert.match(signal.summary, /source reads but no admitted evidence/);
    assert.match(signal.summary, /not KB availability/);
    const transcript = first.input.evidence.find(
      (item) => item.kind === 'tool_transcript_entry',
    );
    assert.deepEqual(transcript?.affectedUnitKeys, ['solution/main#field-a']);
    assert.equal(transcript?.provenance.integrity, 'verified');
    assert.match(JSON.stringify(transcript?.data), /"operation":"kb_get"/);
    assert.match(JSON.stringify(transcript?.data), /non_executable_declaration/);
    assert.ok(first.input.evidence.some((item) => item.kind === 'frozen_source_reference'));
    assert.doesNotMatch(JSON.stringify(first.input.reconstructionSignals), /kb unavailable/i);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('diagnosis assembly preserves explicit V1 hash-only and unavailable fields', async () => {
  const value = await fixture(1);
  try {
    const campaign = value.database.getCampaign(value.campaignId);
    const variant = value.database.getVariant(value.variantId);
    const assembled = await assembleDiagnosisInput({
      artifactDirectory: value.artifacts,
      campaign,
      variant,
      labels: value.database.listLabels(value.campaignId),
      workflowsSource: value.workflows,
      environment: {},
    });
    const transcript = assembled.input.evidence.find(
      (item) => item.kind === 'tool_transcript_entry',
    );
    const serialized = JSON.stringify(transcript);
    assert.match(serialized, /"availability":"hash_only"/);
    assert.match(serialized, /"availability":"not_captured"/);
    assert.deepEqual(transcript?.affectedUnitKeys, []);
    assert.match(transcript?.provenance.limitation ?? '', /no durable requirement-unit join/);
    const requests = assembled.input.completeness.items.find(
      (item) => item.component === 'transcript_requests',
    );
    assert.equal(requests?.status, 'unavailable');
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
