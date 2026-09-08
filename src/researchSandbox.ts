import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { validateResearchHosts, validateResearchUrl } from './researchSandboxBroker.js';
import { canonicalResearchScope, publishResearchSnapshot, redactResearchText } from './researchSandboxSnapshot.js';

export interface ResearchScope {
  worktreePath: string;
  /** Explicit frozen arm snapshots. Never infer these from a live checkout or current campaign. */
  sourceRoots: Array<{ name: string; path: string }>;
  scratchDirectory: string;
  /** Coordinator-published, sanitized evidence ONLY. Not a raw campaign/log directory. */
  artifactDirectory: string;
  allowedHttpHosts?: string[];
}

export interface ResearchShellResult {
  invocationId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  truncated: boolean;
  imageId: string;
  snapshotSha256: string;
  artifacts: { stdout: string; stderr: string; manifest: string };
  pagination: Array<{ invocationId: string; stream: 'stdout' | 'stderr'; nextOffset: number; totalBytes: number }>;
}

const INLINE_BYTES = 16_384;
const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const IMAGE = 'ainative-planner-research:local';

// Only Docker receives host execution privileges. Agent text is a single argv value to /bin/sh IN the worker.
async function docker(args: string[], options: { timeoutMs?: number; signal?: AbortSignal; outputLimit?: number } = {}) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; outputLimitExceeded: boolean }>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    const stop = () => { aborted = true; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
      const limit = options.outputLimit ?? MAX_OUTPUT_BYTES;
      const available = Math.max(0, limit - sizes[stream]);
      chunks[stream].push(chunk.subarray(0, available));
      sizes[stream] += Math.min(available, chunk.length);
      if (chunk.length > available) { outputLimitExceeded = true; child.kill('SIGKILL'); }
    });
    const clear = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); };
    child.on('error', (error) => { clear(); reject(error); });
    child.on('close', (code) => {
      clear();
      resolve({ exitCode: code ?? 137, stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'), timedOut, aborted, outputLimitExceeded });
    });
  });
}

export async function runResearchShell(scope: ResearchScope, input: {
  command: string; timeoutMs?: number; signal?: AbortSignal;
}): Promise<ResearchShellResult> {
  if (typeof input.command !== 'string' || !input.command.trim() || Buffer.byteLength(input.command) > 65_536 || input.command.includes('\0')) {
    throw new Error('research command must contain 1..65536 bytes without NUL');
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error('research timeoutMs must be 100..300000');
  validateResearchHosts(scope.allowedHttpHosts ?? []);
  const canonical = await canonicalResearchScope(scope);
  const invocationId = `research-${randomUUID()}`;
  const directory = path.join(canonical.scratchDirectory, invocationId);
  await mkdir(directory, { mode: 0o700 });
  const snapshot = await publishResearchSnapshot(canonical, path.join(directory, 'inputs'));
  const policy = path.join(directory, 'policy');
  await mkdir(policy, { mode: 0o755 });
  await writeFile(path.join(policy, 'hosts.json'), JSON.stringify({ allowedHttpHosts: canonical.allowedHttpHosts ?? [] }), { flag: 'wx', mode: 0o444 });
  const worker = `${invocationId}-worker`;
  const broker = `${invocationId}-broker`;
  const volume = `${invocationId}-socket`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const artifacts = { stdout: path.join(directory, 'stdout.txt'), stderr: path.join(directory, 'stderr.txt'), manifest: path.join(directory, 'manifest.json') };
  const checked = async (args: string[]) => {
    const result = await docker(args, { signal: controller.signal });
    if (controller.signal.aborted) throw new Error('research invocation aborted during setup');
    if (result.exitCode !== 0) throw new Error(`research Docker setup failed: ${redactResearchText(result.stderr).slice(0, 2_000)}`);
    return result.stdout.trim();
  };
  const harden = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534',
    '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--init', '--log-driver=none',
    '--ulimit=nofile=256:256', '--ulimit=fsize=67108864:67108864',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777',
    '--tmpfs=/scratch:rw,nosuid,nodev,size=128m,mode=1777'];
  let imageId = '';
  let outcome;
  let setupError: unknown;
  const resources = new Set<string>();
  try {
    // A trusted operator builds this image. Never pull/install/build on an agent's behalf.
    imageId = await checked(['image', 'inspect', '--format={{.Id}}', process.env.HARNESS_RESEARCH_IMAGE ?? IMAGE]);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('research image must resolve to one immutable image ID');
    resources.add(volume);
    await checked(['volume', 'create', '--label=ainative.research=true', volume]);
    resources.add(broker);
    await checked(['run', '-d', '--pull=never', '--name', broker, '--label=ainative.research=true', ...harden,
      '--network=bridge', '--mount', `type=volume,source=${volume},target=/broker`,
      '--mount', `type=bind,source=${policy},target=/policy,readonly`, imageId,
      'timeout', '360', 'node', '/opt/research/researchSandboxBroker.ts']);
    await checked(['exec', broker, 'node', '-e',
      'const fs=require("node:fs");let n=0;const t=setInterval(()=>{if(fs.existsSync("/broker/http.sock")){clearInterval(t)}else if(++n>100){process.exit(1)}},50)']);
    resources.add(worker);
    await checked(['create', '--pull=never', '--name', worker, '--label=ainative.research=true', ...harden,
      '--network=none', '--workdir=/scratch', '--env=HOME=/scratch', '--env=GIT_CONFIG_NOSYSTEM=1',
      '--mount', `type=volume,source=${volume},target=/broker,readonly`,
      ...['candidate', 'sources', 'artifacts'].flatMap((name) => ['--mount', `type=bind,source=${path.join(directory, 'inputs', name)},target=/${name},readonly`]),
      imageId, '/bin/sh', '-c', input.command]);
    outcome = await docker(['start', '-a', worker], { timeoutMs, signal: controller.signal });
  } catch (error) { setupError = error; }
  finally {
    // Removing the Docker client does not stop a container. Always remove BOTH containers explicitly.
    const errors: string[] = [];
    for (const name of [worker, broker]) {
      if (!resources.has(name)) continue;
      try {
        const result = await docker(['rm', '-f', name]);
        if (result.exitCode !== 0 && !result.stderr.includes('No such container')) errors.push(name);
      } catch { errors.push(name); }
    }
    if (resources.has(volume)) {
      try {
        const removed = await docker(['volume', 'rm', volume]);
        if (removed.exitCode !== 0 && !removed.stderr.includes('no such volume')) errors.push(volume);
      } catch { errors.push(volume); }
    }
    input.signal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (errors.length) throw new Error(`research cleanup failed; operator must remove: ${errors.join(', ')}`);
  }
  if (!outcome && controller.signal.aborted) {
    outcome = { exitCode: 137, stdout: '', stderr: 'research invocation aborted', timedOut: false, aborted: true, outputLimitExceeded: false };
  }
  if (!outcome) throw setupError ?? new Error('research sandbox did not run');
  const full = { stdout: '', stderr: '' };
  const preview = { stdout: '', stderr: '' };
  const pagination: ResearchShellResult['pagination'] = [];
  for (const stream of ['stdout', 'stderr'] as const) {
    const redacted = Buffer.from(redactResearchText(outcome[stream]));
    if (redacted.length > MAX_OUTPUT_BYTES) outcome.outputLimitExceeded = true;
    full[stream] = new StringDecoder('utf8').write(redacted.subarray(0, MAX_OUTPUT_BYTES));
    preview[stream] = new StringDecoder('utf8').write(Buffer.from(full[stream]).subarray(0, INLINE_BYTES));
    await writeFile(artifacts[stream], full[stream], { flag: 'wx', mode: 0o600 });
    const totalBytes = Buffer.byteLength(full[stream]);
    if (totalBytes > INLINE_BYTES) pagination.push({ invocationId, stream, nextOffset: Buffer.byteLength(preview[stream]), totalBytes });
  }
  await writeFile(artifacts.manifest, JSON.stringify({ invocationId, imageId, snapshot,
    scope: { ...canonical, allowedHttpHosts: canonical.allowedHttpHosts ?? [] },
    command: redactResearchText(input.command), timeoutMs, createdAt: new Date().toISOString(),
    exitCode: outcome.exitCode, timedOut: outcome.timedOut, aborted: outcome.aborted,
    outputLimitExceeded: outcome.outputLimitExceeded, artifacts,
  }, null, 2), { flag: 'wx', mode: 0o600 });
  await chmod(artifacts.manifest, 0o400);
  return { ...outcome, invocationId, imageId, snapshotSha256: snapshot.sha256, artifacts,
    stdout: preview.stdout, stderr: preview.stderr,
    truncated: pagination.length > 0 || outcome.outputLimitExceeded, pagination };
}

export async function readResearchUrl(scope: ResearchScope, input: {
  url: string; method?: 'GET' | 'HEAD'; followRedirects?: boolean; timeoutMs?: number; signal?: AbortSignal;
}): Promise<ResearchShellResult> {
  validateResearchUrl(input.url, scope.allowedHttpHosts ?? []);
  if (input.method !== undefined && input.method !== 'GET' && input.method !== 'HEAD') throw new Error('only GET and HEAD are permitted');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return runResearchShell(scope, { ...input,
    command: `curl -sSf${input.followRedirects === false ? '' : 'L'}${input.method === 'HEAD' ? 'I' : ''} --url ${quote(input.url)}` });
}

export async function readResearchOutput(scope: ResearchScope, input: {
  invocationId: string; stream: 'stdout' | 'stderr'; offset?: number; limit?: number;
}): Promise<{ content: string; nextOffset: number | null; totalBytes: number }> {
  if (!/^research-[a-f0-9-]{36}$/.test(input.invocationId)) throw new Error('invalid research invocation ID');
  if (input.stream !== 'stdout' && input.stream !== 'stderr') throw new Error('invalid research output stream');
  const offset = input.offset ?? 0;
  const limit = input.limit ?? INLINE_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > INLINE_BYTES) throw new Error('invalid research output page');
  const canonical = await canonicalResearchScope(scope);
  const file = path.join(canonical.scratchDirectory, input.invocationId, `${input.stream}.txt`);
  if (await realpath(file) !== file) throw new Error('research output symlinks are forbidden');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * MAX_OUTPUT_BYTES) throw new Error('invalid research output artifact');
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, offset);
    if (bytesRead && (buffer[0]! & 0xc0) === 0x80) throw new Error('research output offset must be a UTF-8 boundary');
    const content = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
    const next = offset + Buffer.byteLength(content);
    return { content, nextOffset: next < stat.size ? next : null, totalBytes: stat.size };
  } finally { await handle.close(); }
}
