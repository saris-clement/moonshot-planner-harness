import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { LangfuseReadClient } from '../src/langfuse.js';

async function fakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Langfuse server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test('Langfuse reads are filtered, capped, and redact credentials from collected output', async () => {
  const authorizations: string[] = [];
  const server = await fakeServer((request, response) => {
    authorizations.push(String(request.headers.authorization));
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/traces')) {
      response.end(
        JSON.stringify({
          data: [
            {
              id: 'trace-a',
              sessionId: 'case-a',
              metadata: { caseId: 'case-a', runId: 'run-a', secretKey: 'secret-value' },
            },
            { id: 'trace-other', sessionId: 'other-case' },
          ],
          meta: { totalPages: 1 },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        data: [
          {
            id: 'observation-a',
            traceId: 'trace-a',
            name: 'adjudicate 1/1',
            metadata: {
              caseId: 'case-a',
              runId: 'run-a',
              requirementUnitId: 'unit-a',
              authorization: 'Bearer secret-value',
            },
            output: 'public-value secret-value',
          },
          { id: 'observation-extra', traceId: 'trace-a' },
        ],
        meta: { totalPages: 1 },
      }),
    );
  });
  try {
    const client = new LangfuseReadClient(
      {
        LANGFUSE_BASE_URL: server.baseUrl,
        LANGFUSE_PUBLIC_KEY: 'public-value',
        LANGFUSE_SECRET_KEY: 'secret-value',
      },
      { limits: { maxTraces: 1, maxObservations: 1 } },
    );
    const result = await client.collect([{ caseId: 'case-a', runIds: ['run-a'] }]);
    const serialized = JSON.stringify(result);
    assert.equal(result.status, 'partial');
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]?.observations.length, 1);
    assert.ok(authorizations.every((value) => value.startsWith('Basic ')));
    assert.doesNotMatch(serialized, /public-value|secret-value|Basic\s|Bearer\s/);
    assert.match(serialized, /redacted-sensitive-value/);
    assert.match(serialized, /cap of 1/);
  } finally {
    await server.close();
  }
});

test('Langfuse failure is explicit and does not expose response or credentials', async () => {
  const server = await fakeServer((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('secret-value');
  });
  try {
    const result = await new LangfuseReadClient({
      LANGFUSE_BASE_URL: server.baseUrl,
      LANGFUSE_PUBLIC_KEY: 'public-value',
      LANGFUSE_SECRET_KEY: 'secret-value',
    }).collect([{ caseId: 'case-a', runIds: ['run-a'] }]);
    assert.equal(result.status, 'failed');
    assert.match(result.limitations[0] ?? '', /durable planner facts remain usable/);
    assert.doesNotMatch(JSON.stringify(result), /public-value|secret-value/);
  } finally {
    await server.close();
  }
});

test('Langfuse retains direct unit observations and legacy ordinal-named tool spans only', async () => {
  const server = await fakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/traces')) {
      response.end(
        JSON.stringify({
          data: [{ id: 'trace-a', sessionId: 'case-a', metadata: { runId: 'run-a' } }],
          meta: { totalPages: 1 },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        data: [
          {
            id: 'direct-unit',
            traceId: 'trace-a',
            name: 'adjudicate 4/125',
            metadata: { caseId: 'case-a', runId: 'run-a', requirementUnitId: 'unit-a' },
          },
          {
            id: 'legacy-tool',
            traceId: 'trace-a',
            name: 'adjudicate 4/125 · turn 1/5 - kb search',
            metadata: { caseId: 'case-a', runId: 'run-a' },
          },
          {
            id: 'other-unit',
            traceId: 'trace-a',
            name: 'adjudicate 5/125',
            metadata: { caseId: 'case-a', runId: 'run-a', requirementUnitId: 'unit-b' },
          },
        ],
        meta: { totalPages: 1 },
      }),
    );
  });
  try {
    const result = await new LangfuseReadClient({
      LANGFUSE_BASE_URL: server.baseUrl,
      LANGFUSE_PUBLIC_KEY: 'public-value',
      LANGFUSE_SECRET_KEY: 'secret-value',
    }).collect([
      {
        caseId: 'case-a',
        runIds: ['run-a'],
        requirementUnitIds: ['unit-a'],
        requirementOrdinals: [4],
      },
    ]);
    assert.equal(result.status, 'complete');
    assert.deepEqual(
      result.traces[0]?.observations.map((observation) =>
        typeof observation === 'object' && observation && !Array.isArray(observation)
          ? observation.id
          : null,
      ),
      ['direct-unit', 'legacy-tool'],
    );
  } finally {
    await server.close();
  }
});

test('Langfuse is optional when the frozen campaign environment has no credentials', async () => {
  const result = await new LangfuseReadClient({}).collect([]);
  assert.equal(result.status, 'not_configured');
  assert.equal(result.traces.length, 0);
});
