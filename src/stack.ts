import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { CampaignRecord, VariantRecord } from './types.js';
import type { HarnessPaths } from './paths.js';
import { variantArtifactDirectory, variantWorktreePath } from './paths.js';
import { readEnvironmentFile, sha256File } from './config.js';
import { runCommand } from './process.js';

export interface DiffGateResult {
  changedFiles: string[];
  addedLines: number;
  removedLines: number;
  forbiddenAdditions: Array<{ file: string; line: string }>;
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

export async function prepareVariantWorktree(
  paths: HarnessPaths,
  campaign: CampaignRecord,
  variant: VariantRecord,
  parentPatchPath: string | null,
): Promise<string> {
  const worktree = variantWorktreePath(paths, campaign.id, variant.id);
  if (await pathIsDirectory(worktree)) return worktree;
  await mkdir(path.dirname(worktree), { recursive: true });
  await runCommand('git', ['worktree', 'add', '--detach', worktree, campaign.seedSha], {
    cwd: campaign.config.plannerRepo,
  });
  if (parentPatchPath) {
    const patch = await readFile(parentPatchPath);
    if (patch.byteLength > 0) {
      await runCommand('git', ['apply', '--binary', parentPatchPath], { cwd: worktree });
    }
  }
  return worktree;
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

export async function captureAndGateDiff(
  campaign: CampaignRecord,
  variant: VariantRecord,
  worktree: string,
  artifactDirectory: string,
): Promise<{ patchPath: string; result: DiffGateResult }> {
  await runCommand('git', ['add', '--intent-to-add', '--all'], { cwd: worktree });
  const [patch, names, numstat] = await Promise.all([
    runCommand('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
      cwd: worktree,
      maxCapturedBytes: campaign.config.limits.maxPatchBytes + 1,
    }),
    runCommand('git', ['diff', '--name-only', 'HEAD'], { cwd: worktree }),
    runCommand('git', ['diff', '--numstat', 'HEAD'], { cwd: worktree }),
  ]);
  const patchPath = path.join(artifactDirectory, 'variant.patch');
  if (Buffer.byteLength(patch.stdout) > campaign.config.limits.maxPatchBytes) {
    throw new Error(`patch exceeds ${campaign.config.limits.maxPatchBytes} bytes`);
  }
  await writeFile(patchPath, patch.stdout);
  const changedFiles = names.stdout.split(/\r?\n/).filter(Boolean);
  const disallowedFiles = changedFiles.filter(
    (file) => !campaign.config.gates.allowedPathPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (disallowedFiles.length > 0) {
    throw new Error(`diff changes files outside the allowed paths: ${disallowedFiles.join(', ')}`);
  }
  const head = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim();
  if (head !== campaign.seedSha) throw new Error('mutator changed HEAD; commits are not allowed');
  for (const file of changedFiles) {
    const details = await lstat(path.join(worktree, file)).catch(() => null);
    if (details?.isSymbolicLink()) {
      throw new Error(`changed files cannot be symbolic links: ${file}`);
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
  if (variant.round > 0 && changedFiles.length === 0) throw new Error('mutator produced no code changes');
  return { patchPath, result };
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
    await runCommand('docker', [
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
      '--entrypoint',
      gate.command,
      testImageTag,
      ...gateArgs,
    ], {
      timeoutMs: gate.timeoutMs,
      logPath: path.join(artifactDirectory, `gate-${index + 1}.log`),
      env: environment,
    });
  }
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
