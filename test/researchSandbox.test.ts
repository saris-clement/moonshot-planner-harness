import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { runResearchShell, readResearchUrl, readResearchOutput, type ResearchScope } from '../src/researchSandbox.js';
import { isPublicAddress, validateResearchUrl, createResearchBroker } from '../src/researchSandboxBroker.js';
import { publishResearchSnapshot, redactResearchText } from '../src/researchSandboxSnapshot.js';
import { runCommand } from '../src/process.js';

const jsonResearchEvidence = {
  usage: { calls: 3, inputTokens: 1234, outputTokens: 56, totalTokens: 1290, costUsd: 0.125, durationMs: 42,
    prompt_tokens: 1234, completion_tokens: 56, cachedTokens: 0, cacheReadInputTokens: 12, tokenCount: 1290 },
  rationale: 'token=example-value; "quoted"\nnext line',
  alreadySanitized: redactResearchText('token=already-removed'),
  metadata: { label: 'password=metadata-value', apiKey: 'private-api-value', accessToken: 'private-access-value',
    refresh_token: 'private-refresh-value', password: 12345, credentials: { nested: 'private-nested-value' } },
  nested: [{ totalTokens: 1290, values: ['secret=array-value', 42, true, null] }],
};

async function fixture() {
  await mkdir('.data', { recursive: true });
  const root = await mkdtemp(path.resolve('.data/research-test-'));
  const scope: ResearchScope = {
    worktreePath: path.join(root, 'candidate'),
    sourceRoots: [{ name: 'workflows', path: path.join(root, 'frozen-workflows') }],
    scratchDirectory: path.join(root, 'scratch'),
    artifactDirectory: path.join(root, 'published-evidence'),
    allowedHttpHosts: ['example.com'],
  };
  await Promise.all([scope.worktreePath, scope.sourceRoots[0]!.path, scope.scratchDirectory, scope.artifactDirectory]
    .map((directory) => mkdir(directory)));
  await writeFile(path.join(scope.worktreePath, 'source.txt'), 'needle\n');
  await writeFile(path.join(scope.artifactDirectory, 'facts.json'), '{"count":7}');
  await writeFile(path.join(scope.artifactDirectory, 'data.json'), JSON.stringify(jsonResearchEvidence));
  return { root, scope };
}

test('broker only allows exact operator HTTPS hosts without credentials or private addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.2', '192.168.1.1',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.0.1', '::1', '::ffff:8.8.8.8',
    'fc00::1', 'fe80::1', '2001:db8::1', '2002:0808:0808::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.215.14'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const allowed = ['example.com'];
  assert.equal(validateResearchUrl('https://example.com/docs?q=test', allowed).hostname, 'example.com');
  for (const url of ['http://example.com', 'https://example.com:8443', 'https://user:pass@example.com',
    'https://example.com.evil.test', 'https://sub.example.com', 'https://127.1', 'https://[::1]',
    'file:///etc/passwd', 'https://example.com/?token=secret', 'https://example.com/.env',
    'https://example.com/%2eenv', 'https://example.com/a#secret']) {
    assert.throws(() => validateResearchUrl(url, allowed), url);
  }
  assert.throws(() => validateResearchUrl('https://example.com', ['*']));
  assert.throws(() => validateResearchUrl('https://127.0.0.1', ['127.0.0.1']));
});

test('broker rejects mutation methods, arbitrary routes and private DNS before connecting', async () => {
  let lookups = 0;
  const server = createResearchBroker(['example.com'], async () => {
    lookups += 1;
    return [{ address: '127.0.0.1', family: 4 }];
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const status = (route: string, method = 'GET', headers = {}) => new Promise<number>((resolve, reject) => {
    const req = request(`${base}${route}`, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal(await status('/read?url=https%3A%2F%2Fexample.com', 'POST'), 405);
    assert.equal(await status('/admin'), 404);
    assert.equal(await status('/read?url=https%3A%2F%2Fexample.com', 'GET', { authorization: 'Bearer nope' }), 403);
    assert.equal(await status('/read?url=https%3A%2F%2Fexample.com'), 403);
    assert.equal(lookups, 1);
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      assert.equal(await status('/read?url=https%3A%2F%2Fexample.com', method), 405);
    }
    for (const headers of [{ cookie: 'session=secret' }, { 'x-api-key': 'secret' }, { 'content-length': '1' }]) {
      assert.equal(await status('/read?url=https%3A%2F%2Fexample.com', 'GET', headers), 403);
    }
    assert.equal(await status('/read?url=https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.com'), 404);
    for (let index = 0; index < 31; index += 1) await status('/read?url=https%3A%2F%2Fexample.com');
    assert.equal(await status('/read?url=https%3A%2F%2Fexample.com'), 429);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('published snapshot omits credentials, raw logs, git metadata, binaries and symlink escapes', async () => {
  const { root, scope } = await fixture();
  try {
    const candidate = scope.worktreePath;
    await writeFile(path.join(candidate, '.env'), 'PROVIDER_KEY=do-not-publish');
    await writeFile(path.join(candidate, '.git'), 'gitdir: /host/private/git');
    await writeFile(path.join(candidate, 'raw.log'), 'secret raw log');
    await writeFile(path.join(candidate, 'image.bin'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(candidate, 'config.json'), '{"apiKey":"secret-value","ok":1}');
    await symlink('/etc/passwd', path.join(candidate, 'escape'));
    await symlink(scope.artifactDirectory, path.join(candidate, 'outside'));
    await writeFile(path.join(root, 'private'), 'hardlink secret');
    await link(path.join(root, 'private'), path.join(candidate, 'hardlink'));
    const destination = path.join(root, 'snapshot');
    const result = await publishResearchSnapshot(scope, destination);
    assert.deepEqual((await readdir(path.join(destination, 'candidate'))).sort(), ['config.json', 'source.txt']);
    assert.match(await readFile(path.join(destination, 'candidate/config.json'), 'utf8'), /\[REDACTED\]/);
    assert.doesNotMatch(await readFile(path.join(destination, 'candidate/config.json'), 'utf8'), /secret-value/);
    assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.ok(result.omittedFiles >= 6);
    const duplicate = await publishResearchSnapshot(scope, path.join(root, 'second-snapshot'));
    assert.equal(duplicate.sha256, result.sha256);
    await writeFile(path.join(scope.sourceRoots[0]!.path, 'frozen.txt'), 'different frozen scope');
    const changed = await publishResearchSnapshot(scope, path.join(root, 'third-snapshot'));
    assert.notEqual(changed.sha256, result.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid scopes and commands fail before sandbox startup', async () => {
  const { root, scope } = await fixture();
  try {
    await assert.rejects(runResearchShell(scope, { command: 'true', timeoutMs: -1 }), /timeout/i);
    await assert.rejects(runResearchShell(scope, { command: '' }), /command/i);
    await assert.rejects(runResearchShell({ ...scope, scratchDirectory: scope.worktreePath }, { command: 'true' }), /overlap/i);
    await assert.rejects(runResearchShell({ ...scope, sourceRoots: [{ name: '../escape', path: scope.worktreePath }] }, { command: 'true' }), /name/i);
    await assert.rejects(readResearchOutput(scope, { invocationId: '../escape', stream: 'stdout' }), /invocation/i);
    await assert.rejects(readResearchUrl(scope, { url: 'https://not-allowed.com' }), /allowed/);
    await assert.rejects(runResearchShell({ ...scope, allowedHttpHosts: ['*'] }, { command: 'true' }), /hostnames/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('JSON artifacts remain parseable, preserve measured numbers and redact strings and secret fields', async () => {
  const { root, scope } = await fixture();
  try {
    const source = 'const token = "source-private-value";\nconst count = 42;\n';
    await writeFile(path.join(scope.worktreePath, 'policy.ts'), source);
    await writeFile(path.join(scope.sourceRoots[0]!.path, 'policy.ts'), source);
    const destination = path.join(root, 'snapshot');
    await publishResearchSnapshot(scope, destination);
    const text = await readFile(path.join(destination, 'artifacts/data.json'), 'utf8');
    const data = JSON.parse(text);
    assert.deepEqual(data.usage, jsonResearchEvidence.usage);
    assert.equal(data.rationale, redactResearchText(jsonResearchEvidence.rationale));
    assert.equal(data.alreadySanitized, jsonResearchEvidence.alreadySanitized);
    assert.equal(data.metadata.label, redactResearchText(jsonResearchEvidence.metadata.label));
    for (const key of ['apiKey', 'accessToken', 'refresh_token', 'password', 'credentials']) {
      assert.equal(data.metadata[key], '[REDACTED]', key);
    }
    assert.deepEqual(data.nested, [{ totalTokens: 1290, values: [redactResearchText('secret=array-value'), 42, true, null] }]);
    assert.doesNotMatch(text, /example-value|metadata-value|private-\w+-value|array-value|12345/);
    for (const directory of ['candidate', 'sources/workflows']) {
      assert.equal(await readFile(path.join(destination, directory, 'policy.ts'), 'utf8'), redactResearchText(source));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid JSON artifacts fail closed without echoing their contents', async () => {
  const { root, scope } = await fixture();
  try {
    await writeFile(path.join(scope.artifactDirectory, 'data.json'), '{"token":"private-malformed-value"');
    await assert.rejects(publishResearchSnapshot(scope, path.join(root, 'snapshot')), (error: Error) => {
      assert.match(error.message, /valid JSON/);
      assert.doesNotMatch(error.message, /private-malformed-value/);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('output pagination is UTF-8 safe and rejects symlinks and invalid ranges', async () => {
  const { root, scope } = await fixture();
  const invocationId = 'research-00000000-0000-4000-8000-000000000000';
  const directory = path.join(scope.scratchDirectory, invocationId);
  try {
    await mkdir(directory);
    const value = 'abc\u00e9\u6f22\ud83c\udf0d'.repeat(3_000);
    await writeFile(path.join(directory, 'stdout.txt'), value);
    let actual = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await readResearchOutput(scope, { invocationId, stream: 'stdout', offset });
      actual += page.content;
      offset = page.nextOffset;
    }
    assert.equal(actual, value);
    await assert.rejects(readResearchOutput(scope, { invocationId, stream: 'stdout', offset: 4 }), /UTF-8/);
    await assert.rejects(readResearchOutput(scope, { invocationId, stream: 'stdout', limit: 100_000 }), /page/);
    await symlink(path.join(directory, 'stdout.txt'), path.join(directory, 'stderr.txt'));
    await assert.rejects(readResearchOutput(scope, { invocationId, stream: 'stderr' }), /symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('redaction handles bounded adversarial output without quadratic key or PEM scanning', () => {
  const started = performance.now();
  const longWord = 'x'.repeat(4 * 1_024 * 1_024);
  assert.equal(redactResearchText(longWord).length, longWord.length);
  assert.equal(redactResearchText('-----BEGIN PRIVATE KEY-----\n'.repeat(50_000)), '[REDACTED PRIVATE KEY]');
  assert.doesNotMatch(redactResearchText('{"apiKey":"sensitive","ok":1}\nAuthorization: Bearer abcd'), /sensitive|abcd/);
  assert.ok(performance.now() - started < 5_000, 'bounded output must not monopolize the coordinator');
});

test('real Docker parses JSON artifacts with jq and Node without corrupting token usage', {
  skip: process.env.RESEARCH_DOCKER_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const { root, scope } = await fixture();
  try {
    const jq = `.usage == ${JSON.stringify(jsonResearchEvidence.usage)} and ` +
      '(.rationale | contains("[REDACTED]")) and .metadata.apiKey == "[REDACTED]" and .metadata.password == "[REDACTED]"';
    const script = [
      'const fs=require("node:fs"),assert=require("node:assert/strict")',
      'const data=JSON.parse(fs.readFileSync("/artifacts/data.json","utf8"))',
      `assert.deepEqual(data.usage,${JSON.stringify(jsonResearchEvidence.usage)})`,
      `assert.equal(data.rationale,${JSON.stringify(redactResearchText(jsonResearchEvidence.rationale))})`,
      'assert.equal(data.metadata.refresh_token,"[REDACTED]")',
      'assert.equal(data.metadata.credentials,"[REDACTED]")',
      'console.log(JSON.stringify([data.usage.inputTokens,data.usage.outputTokens,data.usage.totalTokens]))',
      'console.log("json-artifact-ok")',
    ].join(';');
    const result = await runResearchShell(scope, { command: `set -eu\njq -e '${jq}' /artifacts/data.json > /scratch/jq.txt\nnode -e '${script}'` });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '[1234,56,1290]\njson-artifact-ok\n');
    assert.deepEqual(JSON.parse(await readFile(path.join(scope.artifactDirectory, 'data.json'), 'utf8')), jsonResearchEvidence);
    assert.equal((await runCommand('docker', ['ps', '-a', '--filter', `name=${result.invocationId}`, '--format={{.Names}}'])).stdout.trim(), '');
    assert.equal((await runCommand('docker', ['volume', 'ls', '--filter', `name=${result.invocationId}`, '--format={{.Name}}'])).stdout.trim(), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Docker research shell: scripts, grep/jq, functional curl and isolation', {
  skip: process.env.RESEARCH_DOCKER_SMOKE !== '1', timeout: 180_000,
}, async () => {
  const { root, scope } = await fixture();
  try {
    await writeFile(path.join(scope.worktreePath, '.env'), 'OPENAI_API_KEY=must-not-leak');
    const result = await runResearchShell(scope, { command: [
      'set -eu',
      'grep needle /candidate/source.txt',
      'rg needle /candidate',
      'jq .count /artifacts/facts.json',
      "printf 'print(6 * 7)\\n' > /scratch/probe.py",
      'python3 /scratch/probe.py',
      "node -e 'console.log(21*2)'",
      'git diff --no-index /candidate/source.txt /candidate/source.txt',
      'test ! -e /candidate/.env && test ! -e /var/run/docker.sock',
      'test -z "${OPENAI_API_KEY:-}"',
      'if touch /candidate/forbidden 2>/dev/null; then exit 90; fi',
      'if touch /artifacts/forbidden 2>/dev/null; then exit 91; fi',
      'if curl -X POST https://example.com; then exit 92; fi',
      'if curl -sSf http://127.0.0.1:4173/.env; then exit 93; fi',
      'if /usr/bin/curl -sf --unix-socket /broker/http.sock -X POST "http://broker/read?url=https%3A%2F%2Fexample.com"; then exit 95; fi',
      'if /usr/bin/curl -sf --unix-socket /broker/http.sock "http://broker/admin"; then exit 96; fi',
      'if touch /sources/workflows/forbidden 2>/dev/null; then exit 97; fi',
      "node -e 'const n=require(\"node:net\"); const s=n.connect(443,\"1.1.1.1\");s.on(\"connect\",()=>process.exit(94));s.on(\"error\",()=>process.exit(0));setTimeout(()=>process.exit(0),1500)'",
      'curl -sSfL https://example.com | grep "Example Domain"',
      'curl -sSI https://example.com',
      "node -e 'process.stdout.write(\"x\".repeat(40000))'",
    ].join('\n'), timeoutMs: 60_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout.slice(0, 100), /needle\n\/candidate\/source.txt:needle\n7\n42\n42/);
    assert.match(result.stdout, /Example Domain/);
    assert.equal(result.truncated, true);
    const page = await readResearchOutput(scope, { invocationId: result.invocationId, stream: 'stdout', offset: 16_384 });
    assert.ok(page.content.length > 0);
    assert.equal((await readFile(path.join(scope.worktreePath, 'source.txt'), 'utf8')), 'needle\n');
    const timed = await runResearchShell(scope, { command: 'sleep 60', timeoutMs: 500 });
    assert.equal(timed.timedOut, true);
    const aborted = await runResearchShell(scope, { command: 'sleep 60', signal: AbortSignal.timeout(2_000) });
    assert.equal(aborted.aborted, true);
    const overflow = await runResearchShell(scope, { command: 'yes overflow', timeoutMs: 15_000 });
    assert.equal(overflow.outputLimitExceeded, true);
    const [docs, failure] = await Promise.all([
      readResearchUrl(scope, { url: 'https://example.com' }),
      runResearchShell(scope, { command: 'printf failed >&2; exit 7' }),
    ]);
    assert.equal(docs.exitCode, 0, docs.stderr);
    assert.match(docs.stdout, /Example Domain/);
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.stderr, 'failed');
    assert.notEqual(docs.invocationId, failure.invocationId);
    for (const invocation of [result, timed, aborted, overflow, docs, failure]) {
      const containers = await runCommand('docker', ['ps', '-a', '--filter', `name=${invocation.invocationId}`, '--format={{.Names}}']);
      assert.equal(containers.stdout.trim(), '', `containers leaked for ${invocation.invocationId}`);
      const volumes = await runCommand('docker', ['volume', 'ls', '--filter', `name=${invocation.invocationId}`, '--format={{.Name}}']);
      assert.equal(volumes.stdout.trim(), '', `volume leaked for ${invocation.invocationId}`);
      const manifest = JSON.parse(await readFile(invocation.artifacts.manifest, 'utf8'));
      assert.equal(manifest.imageId, invocation.imageId);
      assert.equal(manifest.snapshot.sha256, invocation.snapshotSha256);
    }
    const image = process.env.HARNESS_RESEARCH_IMAGE;
    try {
      process.env.HARNESS_RESEARCH_IMAGE = 'research-test-missing-image:no-pull';
      await assert.rejects(runResearchShell(scope, { command: 'true' }), /Docker setup failed/);
    } finally {
      if (image === undefined) delete process.env.HARNESS_RESEARCH_IMAGE;
      else process.env.HARNESS_RESEARCH_IMAGE = image;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
