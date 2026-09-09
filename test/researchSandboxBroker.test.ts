import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fetchResearchUrl } from '../src/researchSandboxBroker.js';

test('broker pins DNS and revalidates every redirect, bounds response bodies and redirect count', async (t) => {
  const responses: Array<{ status: number; location?: string; contentLength?: number; bytes?: number }> = [];
  let connections = 0;
  let requestOptions: https.RequestOptions | undefined;
  const replacement = (_url: URL, options: https.RequestOptions, callback: (res: PassThrough) => void) => {
    connections += 1;
    requestOptions = options;
    const response = responses.shift();
    assert.ok(response, 'unexpected outbound request');
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => queueMicrotask(() => {
      const res = Object.assign(new PassThrough(), {
        statusCode: response.status,
        headers: {
          ...(response.location ? { location: response.location } : {}),
          ...(response.contentLength ? { 'content-length': String(response.contentLength) } : {}),
          'content-type': 'text/plain',
        },
      });
      callback(res);
      if (!res.destroyed) res.end(Buffer.alloc(response.bytes ?? 0, 'x'));
    });
    return req;
  };
  const mock = t.mock.method(https, 'request', replacement as unknown as typeof https.request);
  syncBuiltinESMExports();
  const resolver = async () => [{ address: '93.184.215.14', family: 4 }];
  try {
    responses.push({ status: 200, bytes: 5 });
    assert.equal((await fetchResearchUrl('https://example.com/docs', ['example.com'], 'GET', true, resolver)).body.toString(), 'xxxxx');
    assert.equal(requestOptions!.agent, false);
    assert.equal(requestOptions!.family, 4);
    assert.deepEqual(requestOptions!.headers, { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'HarnessResearch/1' });
    let pinned = '';
    requestOptions!.lookup!('example.com', {}, (_error, address) => { pinned = String(address); });
    assert.equal(pinned, '93.184.215.14');

    for (const location of ['https://127.0.0.1/admin', 'https://not-allowed.com/', 'http://example.com', 'https://user:pass@example.com']) {
      const before = connections;
      responses.push({ status: 302, location });
      await assert.rejects(fetchResearchUrl('https://example.com', ['example.com'], 'GET', true, resolver));
      assert.equal(connections, before + 1, 'redirect must be blocked before a second connection');
    }
    responses.push({ status: 302, location: '/next' });
    let lookups = 0;
    const before = connections;
    await assert.rejects(fetchResearchUrl('https://example.com', ['example.com'], 'GET', true, async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? '93.184.215.14' : '10.0.0.1', family: 4 }];
    }), /private/);
    assert.equal(connections, before + 1, 'DNS rebinding on an allowed-host redirect is blocked');

    await assert.rejects(fetchResearchUrl('https://example.com', ['example.com'], 'GET', true,
      async () => [...await resolver(), { address: '::1', family: 6 }]), /private/);
    for (const response of [{ status: 200, bytes: 2_097_153 }, { status: 200, contentLength: 2_097_153 }]) {
      responses.push(response);
      await assert.rejects(fetchResearchUrl('https://example.com', ['example.com'], 'GET', true, resolver), /exceeds/);
    }
    responses.push(...Array.from({ length: 6 }, () => ({ status: 302, location: '/loop' })));
    await assert.rejects(fetchResearchUrl('https://example.com', ['example.com'], 'GET', true, resolver), /redirect limit/);
    responses.push({ status: 302, location: '/next' });
    assert.equal((await fetchResearchUrl('https://example.com', ['example.com'], 'HEAD', false, resolver)).status, 302);
    assert.equal(requestOptions!.method, 'HEAD');
    assert.equal(responses.length, 0);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});
