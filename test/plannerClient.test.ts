import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PlannerClient } from '../src/plannerClient.js';
import type { Phase2RunSnapshot } from '../src/types.js';

test('PlannerClient drives upload through completed Phase 2 without Phase 3', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-client-'));
  const zipPath = path.join(directory, 'pack.zip');
  const bytes = Buffer.from('fixed-pack');
  await writeFile(zipPath, bytes);
  const artifactSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const requests: string[] = [];
  const snapshots: Phase2RunSnapshot[] = [];
  let runPolls = 0;
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    for await (const _chunk of request) {
      // Consume request bodies so the client can reuse the connection.
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/readyz') response.end('{"status":"ready"}');
    else if (request.url === '/api/requirements-packs') response.end(JSON.stringify({ metadata: { artifactSha256: artifactSha } }));
    else if (request.url === '/api/planning-cases' && request.method === 'POST') response.end('{"case":{"id":"case-a"}}');
    else if (request.url?.endsWith('/analysis-readiness')) response.end('{"ready":true}');
    else if (request.url?.endsWith('/runs') && request.method === 'POST') response.end('{"run":{"id":"run-a","status":"queued"},"runtime":{"status":"queued"}}');
    else if (request.url?.endsWith('/runs/run-a')) {
      runPolls += 1;
      if (runPolls === 1) {
        response.statusCode = 400;
        response.end('{"error":"InvalidRequest"}');
        return;
      }
      response.end(JSON.stringify({
        run: { id: 'run-a', status: 'completed' },
        runtime: {
          status: runPolls > 0 ? 'completed' : 'running',
          stage: 'completed',
          progress: { completedUnits: 1, totalUnits: 1 },
          pins: { source: 'sha' },
          aggregateUsage: { calls: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.1, durationMs: 25 },
        },
        checkpoint: {
          completedAdjudications: [{ requirementUnitId: 'unit-a', result: 'build' }],
        },
      }));
    } else if (request.url?.endsWith('/analysis')) response.end(JSON.stringify({ analysis: {
      requirementUnits: [{ id: 'unit-a', ref: { entity: 'workflow', anchor: 'a' }, kind: 'field', semantics: 'Capture A' }],
      adjudications: [{ requirementUnitId: 'unit-a', result: 'build', confidence: 'high', rationale: 'No source', selectedCandidateIds: [], sourceRefs: [], uncoveredSemantics: ['A'], shortlist: { candidates: [] } }],
    } }));
    else if (request.url?.endsWith('/events')) response.end('{"events":[]}');
    else if (request.url?.endsWith('/analyses')) response.end('{"analyses":[]}');
    else if (request.url?.endsWith('/runs')) response.end('{"runs":[]}');
    else response.end('{"case":{"id":"case-a"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const client = new PlannerClient(`http://127.0.0.1:${address.port}`, directory);
    await client.health();
    const result = await client.runPhase2(
      zipPath,
      'test',
      10_000,
      artifactSha,
      undefined,
      (snapshot) => {
        snapshots.push(snapshot);
      },
    );
    assert.equal(result.status, 'completed');
    assert.equal(runPolls, 2);
    assert.equal(result.facts?.decisions.build, 1);
    assert.equal(result.facts?.usage.totalTokens, 12);
    assert.deepEqual(result.facts?.pins, { source: 'sha' });
    assert.equal(requests.some((request) => request.includes('plan-runs')), false);
    assert.deepEqual(snapshots.at(-1)?.progress, { completedUnits: 1, totalUnits: 1 });
    assert.deepEqual(snapshots.at(-1)?.usage, {
      calls: 1,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      costUsd: 0.1,
      durationMs: 25,
    });
    assert.equal(JSON.parse(await readFile(path.join(directory, 'facts.json'), 'utf8')).unitCount, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('PlannerClient answers a planner question and follows the successor run', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-client-question-'));
  const zipPath = path.join(directory, 'pack.zip');
  const bytes = Buffer.from('fixed-pack');
  await writeFile(zipPath, bytes);
  const artifactSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let answeredBody: Record<string, unknown> | null = null;
  const snapshots: Phase2RunSnapshot[] = [];
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/readyz') response.end('{"status":"ready"}');
    else if (request.url === '/api/requirements-packs') {
      response.end(JSON.stringify({ metadata: { artifactSha256: artifactSha } }));
    } else if (request.url === '/api/planning-cases' && request.method === 'POST') {
      response.end('{"case":{"id":"case-q"}}');
    } else if (request.url?.endsWith('/analysis-readiness')) response.end('{"ready":true}');
    else if (request.url?.endsWith('/runs') && request.method === 'POST') {
      response.end('{"run":{"id":"run-first","status":"queued"},"runtime":{"status":"queued"}}');
    } else if (request.url?.endsWith('/runs/run-first')) {
      response.end('{"run":{"id":"run-first","status":"waiting_for_input"},"runtime":{"status":"waiting"}}');
    } else if (request.url?.endsWith('/planner-questions')) {
      response.end(
        JSON.stringify({
          questions: [
            {
              id: 'question-a',
              createdByRunId: 'run-first',
              responseKind: 'free_text',
              prompt: 'Which behavior is correct?',
              rationale: 'The advisor raised this question.',
              context: { inputSetHash: 'hash', decisionSetVersion: 0, anchorHash: 'anchor' },
              status: 'open',
            },
          ],
        }),
      );
    } else if (request.url?.endsWith('/requirements-consultations')) {
      response.end('{"consultations":[{"outcome":{"resolution":"unresolved"}}]}');
    } else if (request.url?.endsWith('/planner-questions/question-a/answer')) {
      answeredBody = JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>;
      response.end('{"run":{"id":"run-second","status":"queued"},"runtime":{"status":"queued"}}');
    } else if (request.url?.endsWith('/runs/run-second')) {
      response.end(
        JSON.stringify({
          run: { id: 'run-second', status: 'completed' },
          runtime: {
            status: 'completed',
            pins: { source: 'sha' },
            aggregateUsage: {
              calls: 1,
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
              costUsd: 0.1,
              durationMs: 25,
            },
          },
        }),
      );
    } else if (request.url?.endsWith('/analysis')) {
      response.end(
        JSON.stringify({
          analysis: {
            requirementUnits: [
              {
                id: 'unit-a',
                ref: { entity: 'workflow', anchor: 'a' },
                kind: 'field',
                semantics: 'Capture A',
              },
            ],
            adjudications: [
              {
                requirementUnitId: 'unit-a',
                result: 'build',
                confidence: 'high',
                rationale: 'No source',
                selectedCandidateIds: [],
                sourceRefs: [],
                uncoveredSemantics: ['A'],
                shortlist: { candidates: [] },
              },
            ],
          },
        }),
      );
    } else if (request.url?.endsWith('/events')) response.end('{"events":[]}');
    else if (request.url?.endsWith('/analyses')) response.end('{"analyses":[]}');
    else if (request.url?.endsWith('/runs')) response.end('{"runs":[]}');
    else response.end('{"case":{"id":"case-q"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const client = new PlannerClient(`http://127.0.0.1:${address.port}`, directory);
    const result = await client.runPhase2(
      zipPath,
      'question-test',
      10_000,
      artifactSha,
      async () => ({
        answer: 'Use the source-backed behavior.',
        resolution: 'source_fallback',
        evidence: ['src/workflow.ts:1'],
        requirementsAgentRequests: 1,
      }),
      (snapshot) => {
        snapshots.push(snapshot);
      },
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.questions.length, 1);
    assert.equal(snapshots.at(-1)?.questions[0]?.status, 'answered');
    assert.equal(snapshots.at(-1)?.questions[0]?.resolution, 'source_fallback');
    assert.equal(snapshots.at(-1)?.questions[0]?.answer, 'Use the source-backed behavior.');
    assert.deepEqual(answeredBody, {
      idempotencyKey: 'question-test-question-1',
      expectedContext: { inputSetHash: 'hash', decisionSetVersion: 0, anchorHash: 'anchor' },
      responseKind: 'free_text',
      freeText: 'Use the source-backed behavior.',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('PlannerClient resumes an explicitly retryable provider failure from its checkpoint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-client-provider-retry-'));
  const zipPath = path.join(directory, 'pack.zip');
  const bytes = Buffer.from('fixed-pack');
  await writeFile(zipPath, bytes);
  const artifactSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let retryBody: unknown;
  let retryIdempotencyKey: string | undefined;
  const completedRun = {
    run: { id: 'run-retry', status: 'completed' },
    runtime: {
      status: 'completed',
      pins: {
        inputSetHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        decisionSetVersion: 0,
        decisionSetHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      aggregateUsage: {
        calls: 2,
        inputTokens: 20,
        outputTokens: 4,
        totalTokens: 24,
        costUsd: 0.2,
        durationMs: 50,
      },
    },
  };
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/requirements-packs') {
      response.end(JSON.stringify({ metadata: { artifactSha256: artifactSha } }));
    } else if (request.url === '/api/planning-cases' && request.method === 'POST') {
      response.end('{"case":{"id":"case-retry"}}');
    } else if (request.url?.endsWith('/analysis-readiness')) {
      response.end('{"ready":true}');
    } else if (request.url?.endsWith('/runs') && request.method === 'POST') {
      response.end(
        JSON.stringify({
          run: { id: 'run-failed', status: 'failed' },
          runtime: {
            status: 'failed',
            pins: {
              inputSetHash:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              decisionSetVersion: 0,
              decisionSetHash:
                'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            failureCode: 'model_invalid_response',
            providerRetryBudgetAvailable: true,
          },
          checkpointMetadata: {
            id: 'checkpoint-a',
            version: 17,
            checkpointRef: {
              artifactSha256:
                'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            },
          },
        }),
      );
    } else if (request.url?.endsWith('/runs/run-failed/retry-provider-failure')) {
      retryBody = JSON.parse(Buffer.concat(body).toString('utf8'));
      const header = request.headers['idempotency-key'];
      retryIdempotencyKey = Array.isArray(header) ? header[0] : header;
      response.end(JSON.stringify(completedRun));
    } else if (request.url?.endsWith('/analysis')) {
      response.end(
        '{"analysis":{"requirementUnits":[{"id":"unit-a","ref":{"entity":"workflow","anchor":"a"},"kind":"field","semantics":"Capture A"}],"adjudications":[{"requirementUnitId":"unit-a","result":"build","confidence":"high","rationale":"No source","selectedCandidateIds":[],"sourceRefs":[],"uncoveredSemantics":["A"],"shortlist":{"candidates":[]}}]}}',
      );
    } else if (request.url?.endsWith('/runs/run-retry')) response.end(JSON.stringify(completedRun));
    else if (request.url?.endsWith('/events')) response.end('{"events":[]}');
    else if (request.url?.endsWith('/analyses')) response.end('{"analyses":[]}');
    else if (request.url?.endsWith('/runs')) response.end('{"runs":[]}');
    else response.end('{"case":{"id":"case-retry"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const client = new PlannerClient(`http://127.0.0.1:${address.port}`, directory);
    const result = await client.runPhase2(
      zipPath,
      'provider-retry-test',
      10_000,
      artifactSha,
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.runId, 'run-retry');
    assert.equal(retryIdempotencyKey, 'provider-retry-test-provider-retry-1');
    assert.deepEqual(retryBody, {
      expectedContext: {
        inputSetHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        decisionSetVersion: 0,
        decisionSetHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      expectedCheckpoint: {
        id: 'checkpoint-a',
        version: 17,
        artifactSha256:
          'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
      expectedFailureCode: 'model_invalid_response',
      acknowledgeUncertainProviderBilling: true,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('PlannerClient creates and validates an explicit target-excluded case', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-client-excluded-'));
  const zipPath = path.join(directory, 'pack.zip');
  const bytes = Buffer.from('fixed-pack');
  await writeFile(zipPath, bytes);
  const artifactSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let createdBody: unknown;
  const sourcePolicy = {
    workflow: 'trumark/deceased-accounts',
    root: 'src/customers/trumark/deceased-accounts/',
    targetSelection: 'explicit_override',
  };
  const server = createServer(async (request, response) => {
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/requirements-packs') {
      response.end(JSON.stringify({ metadata: { artifactSha256: artifactSha } }));
    } else if (request.url === '/api/planning-cases' && request.method === 'POST') {
      createdBody = JSON.parse(Buffer.concat(body).toString('utf8'));
      response.end(JSON.stringify({
        case: { id: 'case-excluded', mode: 'greenfield' },
        resolvedInputSet: { inputSet: {
          caseOptions: ['exclude-target-implementation'],
          sourcePolicy,
          workflowPlanningView: {
            status: 'new',
            implementationStatus: 'absent_by_policy',
            harnessStatus: 'missing_by_policy',
            requiresWorkflowEstablishment: true,
          },
        } },
      }));
    } else if (request.url?.endsWith('/analysis-readiness')) response.end('{"ready":true}');
    else if (request.url?.endsWith('/runs') && request.method === 'POST') {
      response.end('{"run":{"id":"run-excluded"},"runtime":{"status":"completed","pins":{"source":"sha"},"aggregateUsage":{"calls":1,"inputTokens":10,"outputTokens":2,"totalTokens":12,"costUsd":0.1,"durationMs":25}}}');
    } else if (request.url?.endsWith('/analysis')) {
      response.end('{"analysis":{"requirementUnits":[{"id":"unit-a","ref":{"entity":"workflow","anchor":"a"},"kind":"field","semantics":"Capture A"}],"adjudications":[{"requirementUnitId":"unit-a","result":"build","confidence":"high","rationale":"Target absent","selectedCandidateIds":[],"sourceRefs":[],"uncoveredSemantics":["A"],"shortlist":{"candidates":[]}}]}}');
    } else if (request.url?.endsWith('/events')) response.end('{"events":[]}');
    else if (request.url?.endsWith('/analyses')) response.end('{"analyses":[]}');
    else if (request.url?.endsWith('/runs')) response.end('{"runs":[]}');
    else response.end(JSON.stringify({ case: { id: 'case-excluded' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    const client = new PlannerClient(`http://127.0.0.1:${address.port}`, directory);
    const result = await client.runPhase2(
      zipPath,
      'excluded-test',
      10_000,
      artifactSha,
      undefined,
      undefined,
      { targetImplementationWorkflow: 'trumark/deceased-accounts' },
    );
    assert.equal(result.caseId, 'case-excluded');
    assert.deepEqual(createdBody, {
      requirementsArtifactSha256: artifactSha,
      caseOptions: ['exclude-target-implementation'],
      targetImplementationWorkflow: 'trumark/deceased-accounts',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('PlannerClient emits a terminal failure before collection and returns it when collection fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-client-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const zipPath = path.join(directory, 'pack.zip');
  await writeFile(zipPath, 'fixed-pack');
  const snapshots: Phase2RunSnapshot[] = [];
  const requests: string[] = [];
  const code = 'model_boundary_violation_candidate_outside_shortlist';
  const unownedId = 'sk-SECRET-model-output';
  const details = {
    version: 1, kind: 'candidate_outside_shortlist', requirementUnitId: 'unit-failed', disposition: 'reuse',
    selected: [
      { index: 0, id: 'candidate:a', allowed: true, origin: 'shortlist' },
      { index: 1, id: 'candidate:b', allowed: true, origin: 'discovered' },
      { index: 2, id: 'candidate:c', allowed: false, origin: 'supporting' },
      { index: 3, sha256: `sha256:${createHash('sha256').update(unownedId).digest('hex')}`,
        utf8Bytes: Buffer.byteLength(unownedId), allowed: false, origin: 'unknown' },
    ],
    allowedIds: ['candidate:a', 'candidate:b'],
    counts: { selected: 4, allowed: 2, shortlist: 1, discovered: 1, supporting: 1 },
    truncated: false,
  };
  let emittedBeforeCollection = false;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request body. */ }
    requests.push(request.url!);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/requirements-packs') response.end('{"metadata":{"artifactSha256":"fixed-sha"}}');
    else if (request.url === '/api/planning-cases') response.end('{"case":{"id":"case-failed"}}');
    else if (request.url?.endsWith('/analysis-readiness')) response.end('{"ready":true}');
    else if (request.url?.endsWith('/runs') && request.method === 'POST') response.end(JSON.stringify({
      run: { id: 'run-failed', caseId: 'case-failed', status: 'failed' },
      runtime: { status: 'failed', failureCode: code, failureMessage: 'SECRET model response', providerRetryBudgetAvailable: false },
      checkpoint: { failedRequirementUnitIds: ['unit-failed'] },
    }));
    else {
      emittedBeforeCollection ||= snapshots.some((snapshot) => snapshot.failure?.code === code);
      if (request.url?.endsWith('/events')) response.end(JSON.stringify({ events: [{
        schemaVersion: 1, eventId: 'event-failed', sequence: 8, actor: null,
        caseId: 'case-failed', name: 'run.failed', occurredAt: '2026-09-08T10:00:00.000Z',
        payload: { runId: 'run-failed', code, message: 'SECRET raw model response', details },
      }] }));
      else { response.statusCode = 503; response.end('{"error":"SECRET","message":"SECRET body"}'); }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const result = await new PlannerClient(`http://127.0.0.1:${address.port}`, directory).runPhase2(
    zipPath, 'failure-test', 10_000, undefined, undefined, (snapshot) => { snapshots.push(snapshot); },
  );
  assert.equal(emittedBeforeCollection, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.facts, null);
  assert.equal(result.failure?.code, code);
  assert.deepEqual(result.failure?.details, details);
  assert.equal(snapshots.at(-1)?.failure?.code, code);
  assert.deepEqual(snapshots.at(-1)?.failure?.details, details);
  assert.equal(JSON.stringify(snapshots).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(requests.some((url) => url.includes('retry-provider-failure')), false);
});

test('PlannerClient withholds HTTP error bodies including invalid JSON', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-client-http-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const zipPath = path.join(directory, 'pack.zip');
  await writeFile(zipPath, 'fixed-pack');
  let body = '{"error":"SECRET","message":"SECRET body"}';
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the request body. */ }
    response.statusCode = 500;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const client = new PlannerClient(`http://127.0.0.1:${address.port}`, directory);
  for (const responseBody of [body, 'SECRET raw invalid JSON']) {
    body = responseBody;
    await assert.rejects(client.runPhase2(zipPath, 'http-test', 10_000), (error: Error) => {
      assert.equal(error.message.includes('SECRET'), false);
      assert.match(error.message, /unavailable/);
      const failure = (error as Error & { failure: { origin: string; httpStatus: number } }).failure;
      assert.equal(failure.origin, 'http');
      assert.equal(failure.httpStatus, 500);
      return true;
    });
  }
});
