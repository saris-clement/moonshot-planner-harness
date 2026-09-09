import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { CampaignRecord, VariantRecord } from './types.js';
import type { HarnessPaths } from './paths.js';
import { variantArtifactDirectory, variantWorktreePath } from './paths.js';
import { readEnvironmentFile, sha256File } from './config.js';
import { runCommand } from './process.js';
import { redactResearchText } from './researchSandboxSnapshot.js';

export interface DiffGateResult {
  changedFiles: string[];
  addedLines: number;
  removedLines: number;
  forbiddenAdditions: Array<{ file: string; line: string }>;
}

export interface MutationDiffResult {
  changedFiles: string[];
  addedLines: number;
  removedLines: number;
}

export interface StackHandle {
  campaignId: string;
  variantId: string;
  worktreePath: string;
  artifactDirectory: string;
  imageTag: string;
  composeProject: string;
  generatedEnvironmentFile: string;
  baseUrl: string;
  s3Endpoint: string;
  environment: NodeJS.ProcessEnv;
  composeArgs: string[];
}

export async function loadCampaignEnvironment(campaign: CampaignRecord): Promise<NodeJS.ProcessEnv> {
  const actualHash = await sha256File(campaign.config.environmentFile);
  if (actualHash !== campaign.environmentSha) {
    throw new Error(`frozen environment hash changed: expected ${campaign.environmentSha}, got ${actualHash}`);
  }
  const loaded = await readEnvironmentFile(campaign.config.environmentFile);
  const ambient = Object.fromEntries(
    ['PATH', 'HOME', 'DOCKER_HOST', 'XDG_CONFIG_HOME', 'TMPDIR'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return { ...ambient, ...loaded };
}

async function pathIsDirectory(value: string): Promise<boolean> {
  return (await stat(value).catch(() => null))?.isDirectory() ?? false;
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a local port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${normalized.slice(0, 36)}-${suffix}`;
}

function gitDiffArguments(...args: string[]): string[] {
  return [
    '-c',
    'core.fileMode=true',
    '-c',
    'core.attributesFile=/dev/null',
    'diff',
    ...args,
  ];
}

export async function prepareVariantWorktree(
  paths: HarnessPaths,
  campaign: CampaignRecord,
  variant: VariantRecord,
  parentPatchPath: string | null,
  parentPatchSha256: string | null,
): Promise<string> {
  const worktree = variantWorktreePath(paths, campaign.id, variant.id);
  let parentPatch: Buffer | null = null;
  if (parentPatchPath) {
    parentPatch = await readFile(parentPatchPath);
    const actualSha256 = `sha256:${createHash('sha256').update(parentPatch).digest('hex')}`;
    if (!parentPatchSha256 || actualSha256 !== parentPatchSha256) {
      throw new Error('parent patch hash changed before application');
    }
  }
  if (await pathIsDirectory(worktree)) {
    await verifyVariantWorktreeState(
      worktree,
      campaign,
      parentPatchSha256,
      'existing variant worktree differs from the hash-bound parent state',
    );
    return worktree;
  }
  await mkdir(path.dirname(worktree), { recursive: true });
  await runCommand('git', ['worktree', 'add', '--detach', worktree, campaign.seedSha], {
    cwd: campaign.config.plannerRepo,
  });
  if (parentPatchPath && parentPatch) {
    if (parentPatch.byteLength > 0) {
      await runCommand('git', ['apply', '--binary', '-'], {
        cwd: worktree,
        input: parentPatch.toString('utf8'),
      });
    }
  }
  await verifyVariantWorktreeState(
    worktree,
    campaign,
    parentPatchSha256,
    'prepared variant worktree differs from the hash-bound parent state',
  );
  return worktree;
}

export async function stageMutationBaseline(worktree: string): Promise<string> {
  await runCommand('git', ['add', '--all'], { cwd: worktree });
  return await mutationIndexFingerprint(worktree);
}

async function mutationIndexFingerprint(worktree: string): Promise<string> {
  const [tree, flags, config] = await Promise.all([
    runCommand('git', ['write-tree'], { cwd: worktree }),
    runCommand('git', ['ls-files', '-v', '-z'], { cwd: worktree, maxCapturedBytes: 16 * 1_024 * 1_024 }),
    runCommand('git', ['config', '--null', '--list', '--show-origin', '--show-scope'], {
      cwd: worktree,
      maxCapturedBytes: 16 * 1_024 * 1_024,
    }),
  ]);
  return `sha256:${createHash('sha256')
    .update(tree.stdout.trim())
    .update('\0')
    .update(flags.stdout)
    .update('\0')
    .update(config.stdout)
    .digest('hex')}`;
}

async function temporaryDiffIndex(
  worktree: string,
): Promise<{ environment: NodeJS.ProcessEnv; dispose: () => Promise<void> }> {
  const indexLocation = (
    await runCommand('git', ['rev-parse', '--git-path', 'index'], { cwd: worktree })
  ).stdout.trim();
  const sourceIndex = path.isAbsolute(indexLocation)
    ? indexLocation
    : path.resolve(worktree, indexLocation);
  const temporaryIndex = path.join(os.tmpdir(), `ainative-planner-diff-index-${randomUUID()}`);
  await copyFile(sourceIndex, temporaryIndex);
  const environment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    const untracked = await runCommand(
      'git',
      ['ls-files', '--others', '-z'],
      { cwd: worktree, env: environment, maxCapturedBytes: 16 * 1_024 * 1_024 },
    );
    const files = untracked.stdout.split('\0').filter(Boolean);
    if (files.length > 0) {
      await runCommand('git', ['add', '--intent-to-add', '--force', '--', ...files], {
        cwd: worktree,
        env: environment,
      });
    }
  } catch (error) {
    await rm(temporaryIndex, { force: true });
    throw error;
  }
  return {
    environment,
    dispose: async () => await rm(temporaryIndex, { force: true }),
  };
}

async function verifyVariantWorktreeState(
  worktree: string,
  campaign: CampaignRecord,
  parentPatchSha256: string | null,
  message: string,
): Promise<void> {
  const indexFlags = (
    await runCommand('git', ['ls-files', '-v', '-z'], {
      cwd: worktree,
      maxCapturedBytes: 16 * 1_024 * 1_024,
    })
  ).stdout.split('\0').filter(Boolean);
  if (indexFlags.some((entry) => /^[a-zS] /.test(entry))) {
    throw new Error(message);
  }
  const temporaryIndex = await temporaryDiffIndex(worktree);
  let patch: Awaited<ReturnType<typeof runCommand>>;
  try {
    patch = await runCommand('git', gitDiffArguments('--binary', '--no-ext-diff', 'HEAD'), {
      cwd: worktree,
      env: temporaryIndex.environment,
      maxCapturedBytes: campaign.config.limits.maxPatchBytes + 1,
    });
  } finally {
    await temporaryIndex.dispose();
  }
  const [head, patchSha256] = await Promise.all([
    runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree }),
    Promise.resolve(`sha256:${createHash('sha256').update(patch.stdout).digest('hex')}`),
  ]);
  const expectedPatchSha256 =
    parentPatchSha256 ?? `sha256:${createHash('sha256').update('').digest('hex')}`;
  if (head.stdout.trim() !== campaign.seedSha || patchSha256 !== expectedPatchSha256) {
    throw new Error(message);
  }
}

export async function captureMutationDiff(
  campaign: CampaignRecord,
  variant: VariantRecord,
  worktree: string,
  artifactDirectory: string,
  expectedIndexTree: string,
): Promise<{ patchPath: string; patch: string; result: MutationDiffResult }> {
  const actualIndexTree = await mutationIndexFingerprint(worktree);
  if (actualIndexTree !== expectedIndexTree) {
    throw new Error('mutator altered the staged parent baseline');
  }
  const temporaryIndex = await temporaryDiffIndex(worktree);
  let patch: Awaited<ReturnType<typeof runCommand>>;
  let names: Awaited<ReturnType<typeof runCommand>>;
  let numstat: Awaited<ReturnType<typeof runCommand>>;
  try {
    [patch, names, numstat] = await Promise.all([
      runCommand('git', gitDiffArguments('--binary', '--no-ext-diff'), {
        cwd: worktree,
        env: temporaryIndex.environment,
        maxCapturedBytes: campaign.config.limits.maxPatchBytes + 1,
      }),
      runCommand('git', gitDiffArguments('--name-only'), { cwd: worktree, env: temporaryIndex.environment }),
      runCommand('git', gitDiffArguments('--numstat'), { cwd: worktree, env: temporaryIndex.environment }),
    ]);
  } finally {
    await temporaryIndex.dispose();
  }
  if (Buffer.byteLength(patch.stdout) > campaign.config.limits.maxPatchBytes) {
    throw new Error(`mutation patch exceeds ${campaign.config.limits.maxPatchBytes} bytes`);
  }
  const changedFiles = names.stdout.split(/\r?\n/).filter(Boolean);
  let addedLines = 0;
  let removedLines = 0;
  for (const line of numstat.stdout.split(/\r?\n/)) {
    const [added, removed] = line.split('\t');
    if (added === '-' || removed === '-') throw new Error('binary mutation changes are not allowed');
    addedLines += Number.parseInt(added ?? '0', 10) || 0;
    removedLines += Number.parseInt(removed ?? '0', 10) || 0;
  }
  const patchPath = path.join(artifactDirectory, 'mutation.patch');
  const result = { changedFiles, addedLines, removedLines };
  await Promise.all([
    writeFile(patchPath, patch.stdout),
    writeFile(
      path.join(artifactDirectory, 'mutation-diff.json'),
      `${JSON.stringify({ variantId: variant.id, ...result }, null, 2)}\n`,
    ),
  ]);
  return {
    patchPath,
    patch: patch.stdout,
    result,
  };
}

function productionFile(file: string): boolean {
  return !(
    file.startsWith('docs/') ||
    file.startsWith('acceptance/') ||
    file.includes('/test/') ||
    file.includes('/tests/') ||
    file.includes('/fixtures/') ||
    file.includes('.test.') ||
    file.endsWith('.md')
  );
}

function forbiddenDiffAdditions(diff: string): Array<{ file: string; line: string }> {
  const matches: Array<{ file: string; line: string }> = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      continue;
    }
    if (
      file &&
      productionFile(file) &&
      line.startsWith('+') &&
      !line.startsWith('+++') &&
      /trumark|deceased[-_ ]?accounts?|src\/customers\/|saris:|process\.env|node:(?:child_process|net|http|https)|\bfetch\s*\(|https?:\/\//i.test(
        line,
      )
    ) {
      matches.push({ file, line: line.slice(1, 500) });
    }
  }
  return matches;
}

function protectedExecutionPath(file: string): boolean {
  return file.split('/').some((part) =>
    /^(?:node_modules|\.git|\.github|\.husky|\.yarn|scripts|docker|infrastructure)$/i.test(part) ||
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-(?:lock\.yaml|workspace\.yaml)|\.npmrc|\.yarnrc(?:\.yml)?|\.pnp\..+|\.pnpmfile\..+)$/i.test(part) ||
    /^(?:Dockerfile(?:\..+)?|.+\.dockerfile|(?:docker-)?compose(?:\..+)?\.ya?ml|\.dockerignore|\.git(?:attributes|ignore|modules)|\.env(?:\..+)?)$/i.test(part) ||
    /^(?:[jt]sconfig(?:\..+)?\.json|(?:vite|vitest|webpack|rollup|esbuild|babel|jest|eslint|playwright)\.config\..+)$/i.test(part),
  );
}

export async function captureAndGateDiff(
  campaign: CampaignRecord,
  _variant: VariantRecord,
  worktree: string,
  artifactDirectory: string,
): Promise<{ patchPath: string; result: DiffGateResult }> {
  const patchPath = path.join(artifactDirectory, 'variant.patch');
  const temporaryIndex = await temporaryDiffIndex(worktree);
  let patch: Awaited<ReturnType<typeof runCommand>>;
  let names: Awaited<ReturnType<typeof runCommand>>;
  let numstat: Awaited<ReturnType<typeof runCommand>>;
  try {
    [patch, names, numstat] = await Promise.all([
      runCommand('git', gitDiffArguments('--binary', '--no-ext-diff', 'HEAD'), {
        cwd: worktree,
        env: temporaryIndex.environment,
        maxCapturedBytes: campaign.config.limits.maxPatchBytes + 1,
      }),
      runCommand('git', gitDiffArguments('--name-only', 'HEAD'), {
        cwd: worktree,
        env: temporaryIndex.environment,
      }),
      runCommand('git', gitDiffArguments('--numstat', 'HEAD'), {
        cwd: worktree,
        env: temporaryIndex.environment,
      }),
    ]);
    if (Buffer.byteLength(patch.stdout) > campaign.config.limits.maxPatchBytes) {
      throw new Error(`patch exceeds ${campaign.config.limits.maxPatchBytes} bytes`);
    }
    await writeFile(patchPath, patch.stdout);
    await runCommand('git', gitDiffArguments('--check', '--no-ext-diff', 'HEAD'), {
      cwd: worktree,
      env: temporaryIndex.environment,
      logPath: path.join(artifactDirectory, 'diff-check.log'),
    });
  } finally {
    await temporaryIndex.dispose();
  }
  const changedFiles = names.stdout.split(/\r?\n/).filter(Boolean);
  const disallowedFiles = changedFiles.filter(
    (file) => !campaign.config.gates.allowedPathPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (disallowedFiles.length > 0) {
    throw new Error(`diff changes files outside the allowed paths: ${disallowedFiles.join(', ')}`);
  }
  const protectedFiles = changedFiles.filter(protectedExecutionPath);
  if (protectedFiles.length > 0) {
    throw new Error(`diff changes a protected execution surface: ${protectedFiles.join(', ')}`);
  }
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  if (head !== campaign.seedSha) throw new Error('mutator changed HEAD; commits are not allowed');
  for (const file of changedFiles) {
    const details = await lstat(path.join(worktree, file)).catch(() => null);
    if (details?.isSymbolicLink()) {
      throw new Error(`changed files cannot be symbolic links: ${file}`);
    }
    if (details?.isDirectory()) {
      throw new Error(`changed paths cannot be directories or embedded repositories: ${file}`);
    }
  }
  let addedLines = 0;
  let removedLines = 0;
  for (const line of numstat.stdout.split(/\r?\n/)) {
    const [added, removed] = line.split('\t');
    if (added === '-' || removed === '-') throw new Error('binary changes are not allowed');
    addedLines += Number.parseInt(added ?? '0', 10) || 0;
    removedLines += Number.parseInt(removed ?? '0', 10) || 0;
  }
  const result = {
    changedFiles,
    addedLines,
    removedLines,
    forbiddenAdditions: forbiddenDiffAdditions(patch.stdout),
  };
  await writeFile(path.join(artifactDirectory, 'diff-gate.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (changedFiles.length > campaign.config.limits.maxChangedFiles) {
    throw new Error(
      `diff changes ${changedFiles.length} files; limit is ${campaign.config.limits.maxChangedFiles}`,
    );
  }
  if (addedLines + removedLines > campaign.config.limits.maxChangedLines) {
    throw new Error(
      `diff changes ${addedLines + removedLines} lines; limit is ${campaign.config.limits.maxChangedLines}`,
    );
  }
  if (result.forbiddenAdditions.length > 0) {
    throw new Error('diff adds customer-specific or privileged production logic; see diff-gate.json');
  }
  return { patchPath, result };
}

interface DiagnosticFixture {
  path: string;
  inputHash: string;
  validate: () => Promise<void>;
}

async function runDiagnosticCommand(
  args: string[],
  timeoutMs: number,
  logPath: string,
  environment: NodeJS.ProcessEnv,
  fixture: DiagnosticFixture,
): Promise<Awaited<ReturnType<typeof runCommand>>> {
  await fixture.validate();
  // Reserve each log exclusively before runCommand appends; never append to a previous action's evidence.
  const log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    return await runCommand('docker', args, { timeoutMs, logPath, env: environment });
  } finally {
    try { await log.chmod(0o400); } finally { await log.close(); }
    await fixture.validate();
  }
}

async function runDockerGate(
  testImageTag: string,
  command: string,
  args: string[],
  timeoutMs: number,
  logPath: string,
  environment: NodeJS.ProcessEnv,
  fixture?: DiagnosticFixture,
): Promise<void> {
  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '512',
    '--memory',
    '4g',
    '--cpus',
    '4',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,size=1g',
    '--tmpfs',
    '/root/.npm:rw,noexec,nosuid,size=128m',
    '--tmpfs',
    '/app/.local:rw,noexec,nosuid,size=1g',
    '--tmpfs',
    '/app/server/node_modules/.vite-temp:rw,noexec,nosuid,size=256m',
    '--env',
    'CI=1',
    ...(fixture ? [
      '--pull=never',
      '--mount', `type=bind,source=${fixture.path},target=/harness/diagnostic-input.json,readonly`,
      '--env', 'HARNESS_DIAGNOSTIC_INPUT=/harness/diagnostic-input.json',
    ] : []),
    '--entrypoint',
    fixture ? 'node' : command,
    testImageTag,
    ...(fixture ? ['--input-type=commonjs', '-e', `
const { lstatSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const [expectedHash, timeoutMs, command, ...args] = process.argv.slice(1);
const file = '/harness/diagnostic-input.json';
const details = lstatSync(file);
if (!details.isFile() || details.nlink !== 1 || details.size > 2097152 || (details.mode & 0o222)) {
  throw new Error('diagnostic fixture must be an immutable bounded regular file');
}
const hash = 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
if (hash !== expectedHash) throw new Error('diagnostic fixture hash changed at mount');
// The in-container timeout also bounds execution if the host Docker client is interrupted.
const result = spawnSync(command, args, { stdio: 'inherit', timeout: Number(timeoutMs), killSignal: 'SIGKILL' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, '--', fixture.inputHash, String(timeoutMs), command, ...args] : args),
  ];
  if (fixture) await runDiagnosticCommand(dockerArgs, timeoutMs, logPath, environment, fixture);
  else await runCommand('docker', dockerArgs, { timeoutMs, logPath, env: environment });
}

export async function runVariantGates(
  campaign: CampaignRecord,
  testImageTag: string,
  artifactDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const [index, gate] of campaign.config.gates.commands.entries()) {
    const gateArgs =
      gate.command === 'npm' &&
      gate.args.join('\0') ===
        ['run', 'test', '--workspace', '@ainative-planner/server'].join('\0')
        ? [
            'exec',
            '--workspace',
            '@ainative-planner/server',
            '--',
            'vitest',
            'run',
            '--exclude',
            'test/deployment.integration.test.ts',
          ]
        : gate.args;
    await runDockerGate(
      testImageTag, gate.command, gateArgs, gate.timeoutMs,
      path.join(artifactDirectory, `gate-${index + 1}.log`), environment,
    );
  }
}

export async function runInvestigatorTests(
  campaign: CampaignRecord,
  testImageTag: string,
  artifactDirectory: string,
  environment: NodeJS.ProcessEnv,
  testFiles?: string[],
): Promise<{ passed: true; testFiles: string[]; logPaths: string[] }> {
  if (testFiles === undefined) {
    await runVariantGates(campaign, testImageTag, artifactDirectory, environment);
    return {
      passed: true,
      testFiles: [],
      logPaths: campaign.config.gates.commands.map((_, index) => path.join(artifactDirectory, `gate-${index + 1}.log`)),
    };
  }
  return await runSelectedInvestigatorTests(testImageTag, artifactDirectory, environment, selectedInvestigatorTestFiles(testFiles));
}

function selectedInvestigatorTestFiles(testFiles: unknown): string[] {
  if (!Array.isArray(testFiles) || testFiles.length < 1 || testFiles.length > 30 || new Set(testFiles).size !== testFiles.length) {
    throw new Error('testFiles must contain between 1 and 30 unique test files');
  }
  for (const file of testFiles) {
    if (
      typeof file !== 'string' ||
      !/^server\/test\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.test\.ts$/.test(file) ||
      file.split('/').some((part) => part.toLowerCase() === 'node_modules')
    ) {
      throw new Error(`unsafe test file: ${JSON.stringify(file)}`);
    }
  }
  return [...testFiles];
}

async function runSelectedInvestigatorTests(
  testImageTag: string,
  artifactDirectory: string,
  environment: NodeJS.ProcessEnv,
  selectedFiles: string[],
  fixture?: DiagnosticFixture,
): Promise<{ passed: true; testFiles: string[]; logPaths: string[] }> {
  const validationLog = path.join(artifactDirectory, 'test-files.log');
  const typecheckLog = path.join(artifactDirectory, 'typecheck.log');
  const testsLog = path.join(artifactDirectory, 'tests.log');
  // Validate in the built image, not the host worktree, without interpreting agent input as code.
  await runDockerGate(testImageTag, 'node', ['--input-type=commonjs', '-e', `
const { lstatSync, existsSync } = require('node:fs');
const path = require('node:path');
for (const file of process.argv.slice(1)) {
  let current = '';
  for (const part of file.split('/')) {
    current = path.join(current, part);
    const details = lstatSync(current);
    if (details.isSymbolicLink()) throw new Error('test file cannot traverse a symbolic link: ' + file);
    if (details.isDirectory() && existsSync(path.join(current, '.git'))) {
      throw new Error('test file cannot traverse an embedded repository: ' + file);
    }
    if (current === file && !details.isFile()) throw new Error('test file must be a regular file: ' + file);
  }
}
`, '--', ...selectedFiles], 30_000, validationLog, environment, fixture);
  if (!fixture) await runDockerGate(testImageTag, 'npm', ['run', 'typecheck'], 1_800_000, typecheckLog, environment);
  await runDockerGate(testImageTag, 'npm', [
    'exec', '--workspace', '@ainative-planner/server', '--', 'vitest', 'run',
    ...selectedFiles.map((file) => file.slice('server/'.length)),
  ], fixture ? 300_000 : 1_800_000, testsLog, environment, fixture);
  return { passed: true, testFiles: selectedFiles, logPaths: [validationLog, ...(!fixture ? [typecheckLog] : []), testsLog] };
}

/** Executes coordinator-curated JSON only; it never exports source roots or runs the primary evaluation. */
export async function runInvestigatorProbe(
  _campaign: CampaignRecord,
  testImageTag: string,
  artifactDirectory: string,
  environment: NodeJS.ProcessEnv,
  testFiles: string[],
  input: unknown,
): Promise<{
  kind: 'diagnostic_probe'; executionPassed: true; providerCalls: 0; imageId: string;
  inputHash: string; testFiles: string[]; logPaths: string[]; interpretation: string;
}> {
  const selectedFiles = selectedInvestigatorTestFiles(testFiles);
  if (typeof testImageTag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(testImageTag)) {
    throw new Error('diagnostic probe requires a safe built image reference');
  }
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error('diagnostic input must be serializable JSON');
  if (Buffer.byteLength(serialized) > 2 * 1_024 * 1_024) throw new Error('diagnostic input exceeds 2 MiB');
  // Redact string values, not serialized text, so measured numeric token/call counts remain numbers.
  const bytes = Buffer.from(JSON.stringify(JSON.parse(serialized, (key: string, value: unknown) => {
    if (typeof value !== 'string') return value;
    if (/api[_-]?key|secret|password|credential|authorization|cookie|token$|(?:access|refresh|auth)[_-]?tokens$|^tokens$/i.test(key)) {
      return '[REDACTED]';
    }
    return redactResearchText(value);
  })));
  if (bytes.length > 2 * 1_024 * 1_024) throw new Error('redacted diagnostic input exceeds 2 MiB');
  if (typeof artifactDirectory !== 'string' || !path.isAbsolute(artifactDirectory) ||
    /[\x00-\x1f\x7f,"\\]/.test(artifactDirectory) || path.resolve(artifactDirectory) !== artifactDirectory ||
    !artifactDirectory.split(path.sep).includes('.data')) {
    throw new Error('diagnostic artifacts require a canonical safe absolute path under ignored .data');
  }
  // macOS exposes its system temporary root through /var. Canonicalize that trusted root only;
  // every caller-supplied component beneath it must be a real directory, never a symlink.
  const temporaryRoot = path.resolve(os.tmpdir());
  const base = artifactDirectory.startsWith(`${temporaryRoot}${path.sep}`) ? temporaryRoot : path.parse(artifactDirectory).root;
  let directory = await realpath(base);
  let underData = false;
  for (const part of path.relative(base, artifactDirectory).split(path.sep)) {
    underData ||= part === '.data';
    directory = path.join(directory, part);
    if (underData) {
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
      throw new Error('diagnostic artifact path must be canonical without symbolic links');
    }
  }
  if (/[\x00-\x1f\x7f,"\\]/.test(directory)) throw new Error('unsafe canonical diagnostic mount path');
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await directoryHandle.chmod(0o700);
    const directoryDetails = await directoryHandle.stat();
    const fixturePath = path.join(directory, 'diagnostic-input.json');
    const handle = await open(fixturePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o400);
      const initial = await handle.stat();
      const inputHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const fixture: DiagnosticFixture = {
        path: fixturePath,
        inputHash,
        validate: async () => {
          const parent = await lstat(directory);
          const current = await lstat(fixturePath);
          const details = await handle.stat();
          if (!parent.isDirectory() || parent.dev !== directoryDetails.dev || parent.ino !== directoryDetails.ino ||
            (parent.mode & 0o777) !== 0o700 || await realpath(fixturePath) !== fixturePath ||
            !current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino ||
            current.nlink !== 1 || details.nlink !== 1 || details.size !== bytes.length ||
            details.mtimeMs !== initial.mtimeMs || details.ctimeMs !== initial.ctimeMs || (details.mode & 0o777) !== 0o400) {
            throw new Error('immutable diagnostic fixture or canonical parent changed');
          }
          const buffer = Buffer.alloc(bytes.length + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== bytes.length || !buffer.subarray(0, bytesRead).equals(bytes)) {
            throw new Error('immutable diagnostic fixture bytes changed');
          }
        },
      };
      // Runtime provider credentials and execution hooks are never inherited by the Docker client or container.
      const dockerEnvironment = Object.fromEntries(
        ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'TMPDIR']
          .flatMap((key) => environment[key] === undefined ? [] : [[key, environment[key]]]),
      );
      const imageLog = path.join(directory, 'image-inspect.log');
      const inspection = await runDiagnosticCommand(
        ['image', 'inspect', '--format={{.Id}}', '--', testImageTag], 30_000, imageLog, dockerEnvironment, fixture,
      );
      const imageId = inspection.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('diagnostic test image must resolve to one immutable image ID');
      const result = await runSelectedInvestigatorTests(imageId, directory, dockerEnvironment, selectedFiles, fixture);
      return {
        kind: 'diagnostic_probe', executionPassed: true, providerCalls: 0, imageId, inputHash,
        testFiles: result.testFiles, logPaths: [imageLog, ...result.logPaths],
        interpretation: 'Offline fixture-backed execution of selected trusted tests only; does not establish diagnosis correctness or a full primary score, or satisfy test/full validation gates.',
      };
    } finally { await handle.close(); }
  } finally { await directoryHandle.close(); }
}

export async function buildVariantImage(
  campaign: CampaignRecord,
  variant: VariantRecord,
  worktree: string,
  artifactDirectory: string,
  trustedPlannerPath: string,
): Promise<{ imageTag: string; testImageTag: string; environment: NodeJS.ProcessEnv }> {
  const environment = await loadCampaignEnvironment(campaign);
  if (!environment.GITHUB_TOKEN) {
    const githubToken = await runCommand('gh', ['auth', 'token'], {
      env: environment,
      timeoutMs: 30_000,
      maxCapturedBytes: 16 * 1_024,
    });
    const token = githubToken.stdout.trim();
    if (!token) throw new Error('GitHub CLI returned an empty build token');
    environment.GITHUB_TOKEN = token;
  }
  if (!environment.PACKAGES_TOKEN && environment.GITHUB_TOKEN) {
    environment.PACKAGES_TOKEN = environment.GITHUB_TOKEN;
  }
  const hasGithubApp = Boolean(
    environment.PLANNER_GITHUB_APP_ID &&
      environment.PLANNER_GITHUB_APP_INSTALLATION_ID &&
      environment.PLANNER_GITHUB_APP_PRIVATE_KEY,
  );
  const runtimeSourceAuth = hasGithubApp ? 'github-app' : 'github-cli-token';
  if (!hasGithubApp) {
    environment.PLANNER_GITHUB_TOKEN = environment.GITHUB_TOKEN;
  }
  await writeFile(
    path.join(artifactDirectory, 'runtime-auth.json'),
    `${JSON.stringify({ workflows: runtimeSourceAuth }, null, 2)}\n`,
  );
  const imageTag = `ainative-planner-eval:${safeName(campaign.id)}-${variant.ordinal}`;
  const args = [
    'buildx',
    'build',
    '--load',
    '--tag',
    imageTag,
    '--file',
    path.join(trustedPlannerPath, 'Dockerfile'),
    '--build-arg',
    `PLANNER_BUILD_REVISION=${campaign.seedSha}`,
    '--build-arg',
    'PLANNER_BUILD_SOURCE=https://github.com/Saris-AI/moonshot-planner-poc',
  ];
  const buildArguments: Array<[string, string]> = [
    ['PLANNER_PUBLIC_BASE', environment.PLANNER_PUBLIC_BASE ?? ''],
    ['SARIS_KB_VERSION', environment.PLANNER_KB_ENGINE_VERSION ?? ''],
    ['SARIS_KB_AMD64_SHA256', environment.PLANNER_KB_ENGINE_AMD64_SHA256 ?? ''],
    ['SARIS_KB_ARM64_SHA256', environment.PLANNER_KB_ENGINE_ARM64_SHA256 ?? ''],
    ['KB_CONSUMER_REF', environment.PLANNER_KB_CONSUMER_REF ?? ''],
    ['KB_CONSUMER_LOCK_SHA256', environment.PLANNER_KB_CONSUMER_LOCK_SHA256 ?? ''],
    ['KB_CONSUMER_VERSION', environment.PLANNER_KB_CONSUMER_VERSION ?? ''],
  ];
  for (const [name, value] of buildArguments) {
    if (value || name === 'PLANNER_PUBLIC_BASE') args.push('--build-arg', `${name}=${value}`);
  }
  if (environment.GITHUB_TOKEN) args.push('--secret', 'id=github_token,env=GITHUB_TOKEN');
  if (environment.PACKAGES_TOKEN) args.push('--secret', 'id=packages_token,env=PACKAGES_TOKEN');
  args.push(worktree);
  await runCommand('docker', args, {
    cwd: worktree,
    env: environment,
    timeoutMs: 3_600_000,
    logPath: path.join(artifactDirectory, 'image-build.log'),
  });
  const builderImageTag = `${imageTag}-builder`;
  const testArgs = [...args];
  testArgs[4] = builderImageTag;
  testArgs.splice(testArgs.length - 1, 0, '--target', 'builder');
  await runCommand('docker', testArgs, {
    cwd: worktree,
    env: environment,
    timeoutMs: 3_600_000,
    logPath: path.join(artifactDirectory, 'test-image-build.log'),
  });
  const testImageTag = `${imageTag}-test`;
  await runCommand(
    'docker',
    [
      'buildx',
      'build',
      '--load',
      '--tag',
      testImageTag,
      '--build-arg',
      `BUILDER_IMAGE=${builderImageTag}`,
      '--file',
      path.resolve(process.cwd(), 'Dockerfile.test-runner'),
      trustedPlannerPath,
    ],
    {
      cwd: trustedPlannerPath,
      env: environment,
      timeoutMs: 1_800_000,
      logPath: path.join(artifactDirectory, 'test-runner-image-build.log'),
    },
  );
  return { imageTag, testImageTag, environment };
}

export async function startVariantStack(
  paths: HarnessPaths,
  campaign: CampaignRecord,
  variant: VariantRecord,
  worktree: string,
  artifactDirectory: string,
  imageTag: string,
  environment: NodeJS.ProcessEnv,
  trustedPlannerPath: string,
  scope = 'evaluation',
): Promise<StackHandle> {
  await mkdir(artifactDirectory, { recursive: true });
  const ports = await Promise.all([availablePort(), availablePort(), availablePort(), availablePort(), availablePort()]);
  const [plannerPort, redisPort, s3Port, s3ConsolePort, ddbPort] = ports as [
    number,
    number,
    number,
    number,
    number,
  ];
  const composeProject = safeName(`eval-${campaign.id}-${variant.ordinal}-${scope}`);
  const generatedEnvironmentFile = path.join(artifactDirectory, 'stack.env');
  const generatedEnvironment = {
    PLANNER_IMAGE: imageTag,
    PLANNER_HOST_IP: '127.0.0.1',
    PLANNER_HOST_PORT: String(plannerPort),
    PLANNER_REDIS_HOST_PORT: String(redisPort),
    PLANNER_S3_HOST_PORT: String(s3Port),
    PLANNER_S3_CONSOLE_HOST_PORT: String(s3ConsolePort),
    PLANNER_DDB_HOST_PORT: String(ddbPort),
    PLANNER_DDB_VOLUME: `${composeProject}-ddb`,
    PLANNER_KB_VOLUME: `${composeProject}-kb`,
    PLANNER_MINIO_VOLUME: `${composeProject}-minio`,
    PLANNER_DDB_TABLE: composeProject,
    PLANNER_S3_BUCKET: composeProject,
    PLANNER_S3_KEY_PREFIX: `${variant.id}/${scope}`,
    PLANNER_SOURCE_REF: campaign.workflowsSha,
    PLANNER_SOURCE_REMOTE_URL: campaign.workflowsRemoteUrl,
  };
  await writeFile(
    generatedEnvironmentFile,
    `${Object.entries(generatedEnvironment)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
  const composeArgs = [
    'compose',
    '--env-file',
    campaign.config.environmentFile,
    '--env-file',
    generatedEnvironmentFile,
    '--project-name',
    composeProject,
    '--project-directory',
    worktree,
    '--file',
    path.join(trustedPlannerPath, 'docker-compose.yml'),
  ];
  const handle: StackHandle = {
    campaignId: campaign.id,
    variantId: variant.id,
    worktreePath: worktree,
    artifactDirectory,
    imageTag,
    composeProject,
    generatedEnvironmentFile,
    baseUrl: `http://127.0.0.1:${plannerPort}${environment.PLANNER_PUBLIC_BASE ?? ''}`,
    s3Endpoint: `http://127.0.0.1:${s3Port}`,
    environment: { ...environment, ...generatedEnvironment },
    composeArgs,
  };
  try {
    await seedKbVolume(handle);
    await runCommand('docker', [...composeArgs, 'up', '-d', '--no-build', '--wait', '--wait-timeout', String(Math.ceil(campaign.config.limits.stackReadyTimeoutMs / 1_000))], {
      cwd: worktree,
      env: handle.environment,
      timeoutMs: campaign.config.limits.stackReadyTimeoutMs,
      logPath: path.join(artifactDirectory, 'stack-up.log'),
    });
  } catch (error) {
    try {
      await collectStackArtifacts(handle);
    } catch {
      // Startup may leave only a subset of services available; each command keeps its own log.
    }
    await stopVariantStack(handle, false);
    throw error;
  }
  return handle;
}

export async function reattachVariantStack(
  campaign: CampaignRecord,
  variant: VariantRecord,
  artifactDirectory: string,
  trustedPlannerPath: string,
): Promise<StackHandle> {
  if (!variant.worktreePath || !variant.imageTag) {
    throw new Error('variant worktree and image are required to reattach a stack');
  }
  const generatedEnvironmentFile = path.join(artifactDirectory, 'stack.env');
  const generatedEnvironment = await readEnvironmentFile(generatedEnvironmentFile);
  const environment = {
    ...(await loadCampaignEnvironment(campaign)),
    ...generatedEnvironment,
  };
  const composeProject = generatedEnvironment.PLANNER_DDB_TABLE;
  const plannerPort = generatedEnvironment.PLANNER_HOST_PORT;
  const s3Port = generatedEnvironment.PLANNER_S3_HOST_PORT;
  if (!composeProject || !plannerPort || !s3Port) {
    throw new Error('persisted stack environment is incomplete');
  }
  const composeArgs = [
    'compose',
    '--env-file',
    campaign.config.environmentFile,
    '--env-file',
    generatedEnvironmentFile,
    '--project-name',
    composeProject,
    '--project-directory',
    variant.worktreePath,
    '--file',
    path.join(trustedPlannerPath, 'docker-compose.yml'),
  ];
  return {
    campaignId: campaign.id,
    variantId: variant.id,
    worktreePath: variant.worktreePath,
    artifactDirectory,
    imageTag: variant.imageTag,
    composeProject,
    generatedEnvironmentFile,
    baseUrl: `http://127.0.0.1:${plannerPort}${environment.PLANNER_PUBLIC_BASE ?? ''}`,
    s3Endpoint: `http://127.0.0.1:${s3Port}`,
    environment,
    composeArgs,
  };
}

async function seedKbVolume(handle: StackHandle): Promise<void> {
  if (handle.environment.PLANNER_KB_MODE === 'disabled') return;
  const sourceVolume = handle.environment.PLANNER_EVAL_KB_SEED_VOLUME ?? 'ainative-planner-kb';
  const targetVolume = handle.environment.PLANNER_KB_VOLUME;
  if (!targetVolume || sourceVolume === targetVolume) return;
  const source = await runCommand('docker', ['volume', 'inspect', sourceVolume], {
    env: handle.environment,
    allowFailure: true,
    timeoutMs: 30_000,
  });
  if (source.exitCode !== 0) {
    if (handle.environment.PLANNER_KB_PULL_ACCESS_KEY_ID) return;
    throw new Error(
      `KB seed volume ${sourceVolume} is unavailable and no pull credentials are configured`,
    );
  }
  await runCommand(
    'docker',
    [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${handle.composeProject}`,
      '--label',
      'com.docker.compose.volume=planner-kb',
      targetVolume,
    ],
    { env: handle.environment, timeoutMs: 30_000 },
  );
  await runCommand(
    'docker',
    [
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--cap-add',
      'FOWNER',
      '--security-opt',
      'no-new-privileges:true',
      '--volume',
      `${sourceVolume}:/source:ro`,
      '--volume',
      `${targetVolume}:/target`,
      'busybox:1.37.0',
      'sh',
      '-c',
      'cp -a /source/. /target/ && chown 1001:1001 /target',
    ],
    {
      env: handle.environment,
      timeoutMs: 600_000,
      logPath: path.join(handle.artifactDirectory, 'kb-seed-copy.log'),
    },
  );
  await runCommand(
    'docker',
    [
      'run',
      '--rm',
      '--read-only',
      '--entrypoint',
      'saris-kb',
      '--volume',
      `${targetVolume}:/kb:ro`,
      handle.imageTag,
      '--dir',
      '/kb/current',
      'stats',
    ],
    {
      env: handle.environment,
      timeoutMs: 120_000,
      logPath: path.join(handle.artifactDirectory, 'kb-seed-stats.log'),
    },
  );
}

export async function collectStackArtifacts(handle: StackHandle): Promise<void> {
  const results = await Promise.allSettled([
    runCommand('docker', [...handle.composeArgs, 'ps', '--all', '--format', 'json'], {
      cwd: handle.worktreePath,
      env: handle.environment,
      timeoutMs: 120_000,
      logPath: path.join(handle.artifactDirectory, 'compose-ps.jsonl'),
    }),
    runCommand('docker', [...handle.composeArgs, 'logs', '--no-color', '--timestamps'], {
      cwd: handle.worktreePath,
      env: handle.environment,
      timeoutMs: 300_000,
      logPath: path.join(handle.artifactDirectory, 'compose.log'),
      maxCapturedBytes: 1_024,
    }),
    runCommand('docker', ['image', 'inspect', handle.imageTag], {
      cwd: handle.worktreePath,
      env: handle.environment,
      timeoutMs: 120_000,
      logPath: path.join(handle.artifactDirectory, 'image.json'),
    }),
    collectS3Objects(handle),
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'one or more required stack artifacts could not be collected',
    );
  }
}

async function collectS3Objects(handle: StackHandle): Promise<void> {
  const bucket = handle.environment.PLANNER_S3_BUCKET;
  if (!bucket) return;
  const outputRoot = path.join(handle.artifactDirectory, 's3');
  await mkdir(outputRoot, { recursive: true });
  const client = new S3Client({
    endpoint: handle.s3Endpoint,
    region: handle.environment.PLANNER_S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: handle.environment.PLANNER_S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: handle.environment.PLANNER_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    },
  });
  try {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        const destination = path.resolve(outputRoot, object.Key);
        if (!destination.startsWith(`${path.resolve(outputRoot)}${path.sep}`)) {
          throw new Error(`unsafe S3 object key: ${object.Key}`);
        }
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }), {
          abortSignal: AbortSignal.timeout(120_000),
        });
        const body = await response.Body?.transformToByteArray();
        if (!body) continue;
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, body);
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  } finally {
    client.destroy();
  }
}

export async function stopVariantStack(handle: StackHandle, removeVolumes = true): Promise<void> {
  try {
    await runCommand('docker', [...handle.composeArgs, 'stop', '--timeout', '600', 'planner'], {
      cwd: handle.worktreePath,
      env: handle.environment,
      allowFailure: true,
      timeoutMs: 660_000,
      logPath: path.join(handle.artifactDirectory, 'stack-stop.log'),
    });
  } finally {
    await runCommand(
      'docker',
      [
        ...handle.composeArgs,
        'down',
        ...(removeVolumes ? ['--volumes'] : []),
        '--remove-orphans',
        '--timeout',
        '60',
      ],
      {
        cwd: handle.worktreePath,
        env: handle.environment,
        allowFailure: true,
        timeoutMs: 180_000,
        logPath: path.join(handle.artifactDirectory, 'stack-down.log'),
      },
    );
  }
}

export async function ensureVariantArtifactDirectory(
  paths: HarnessPaths,
  campaignId: string,
  variantId: string,
): Promise<string> {
  const directory = variantArtifactDirectory(paths, campaignId, variantId);
  await mkdir(directory, { recursive: true });
  return directory;
}
