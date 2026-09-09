import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCommand } from '../src/process.js';
import {
  captureAndGateDiff,
  captureMutationDiff,
  prepareVariantWorktree,
  runInvestigatorProbe,
  runInvestigatorTests,
  runVariantGates,
  stageMutationBaseline,
  startVariantStack,
} from '../src/stack.js';
import { CampaignConfigSchema, type CampaignRecord, type VariantRecord } from '../src/types.js';
import type { HarnessPaths } from '../src/paths.js';
import { archiveHypothesisComplianceAttemptInputs } from '../src/hypothesisCompliance.js';

async function fixture(): Promise<{
  directory: string;
  artifacts: string;
  campaign: CampaignRecord;
  variant: VariantRecord;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-gate-'));
  await mkdir(path.join(directory, 'server/src'), { recursive: true });
  await mkdir(path.join(directory, 'server/test'), { recursive: true });
  await writeFile(path.join(directory, 'server/src/policy.ts'), 'export const policy = "generic";\n');
  await writeFile(path.join(directory, 'Dockerfile'), 'FROM scratch\n');
  await runCommand('git', ['init'], { cwd: directory });
  await runCommand('git', ['add', '.'], { cwd: directory });
  await runCommand(
    'git',
    [
      '-c',
      'user.name=Harness Test',
      '-c',
      'user.email=harness@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
    { cwd: directory },
  );
  const seedSha = (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim();
  const artifacts = path.join(directory, 'artifacts');
  await mkdir(artifacts);
  const config = CampaignConfigSchema.parse({
    id: 'gate-test',
    goal: 'Keep generated planner experiments generic and bounded.',
    plannerRepo: directory,
    workflowsRepo: directory,
    environmentFile: path.join(directory, 'environment.env'),
    seedRevision: seedSha,
    workflowsRevision: seedSha,
    benchmarks: [
      { name: 'primary-pack', role: 'primary', zipPath: '/tmp/a.zip' },
      { name: 'holdout-pack', role: 'holdout', zipPath: '/tmp/b.zip' },
    ],
    gates: { commands: [], allowedPathPrefixes: ['server/src/', 'server/test/'] },
  });
  const campaign: CampaignRecord = {
    id: config.id,
    status: 'ready',
    config,
    seedSha,
    workflowsSha: seedSha,
    environmentSha: `sha256:${'a'.repeat(64)}`,
    workflowsRemoteUrl: 'https://github.com/Saris-AI/workflows.git',
    currentParentVariantId: 'gate-test-v000',
    noImprovementRounds: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const variant: VariantRecord = {
    id: 'gate-test-v001',
    campaignId: config.id,
    parentVariantId: 'gate-test-v000',
    round: 1,
    ordinal: 1,
    hypothesis: {
      title: 'Generic policy',
      rationale: 'Exercise the gate.',
      instructions: 'Change policy.',
      expectedImpact: 'A generic improvement.',
      risk: 'Fixture only.',
      findingIds: [],
      assumptions: [],
    },
    status: 'gating',
    worktreePath: directory,
    imageTag: null,
    composeProject: null,
    baseUrl: null,
    patchPath: null,
    patchHash: null,
    hypothesisComplianceStatus: 'not_started',
    hypothesisCompliancePatchHash: null,
    hypothesisComplianceCandidatePatchHash: null,
    hypothesisComplianceResultHash: null,
    hypothesisCompliance: null,
    hypothesisComplianceError: null,
    hypothesisComplianceAttempts: [],
    artifactCollectionComplete: false,
    facts: null,
    replicateFacts: null,
    holdoutFacts: null,
    holdoutReplicateFacts: null,
    holdoutJudgments: null,
    holdoutScores: null,
    judgment: null,
    score: null,
    questionResolutions: null,
    executionState: null,
    diagnosisStatus: 'not_started',
    diagnosisInputHash: null,
    diagnosisResultHash: null,
    diagnosis: null,
    diagnosisError: null,
    error: null,
    startedAt: null,
    completedAt: null,
    elapsedMs: null,
    phase2StartedAt: null,
    phase2CompletedAt: null,
    phase2ElapsedMs: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { directory, artifacts, campaign, variant };
}

test('diff gate permits bounded generic server changes', async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.directory, 'server/src/policy.ts'), 'export const policy = "evidence-first";\n');
    const result = await captureAndGateDiff(
      value.campaign,
      value.variant,
      value.directory,
      value.artifacts,
    );
    assert.deepEqual(result.result.changedFiles, ['server/src/policy.ts']);
    assert.equal(result.result.forbiddenAdditions.length, 0);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test('diff gate rejects candidate-controlled infrastructure', async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.directory, 'Dockerfile'), 'FROM alpine\n');
    await assert.rejects(
      captureAndGateDiff(value.campaign, value.variant, value.directory, value.artifacts),
      /outside the allowed paths: Dockerfile/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test('diff gate rejects privileged or customer-specific production additions', async () => {
  const value = await fixture();
  try {
    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      'export const leak = () => fetch(process.env.SECRET);\n',
    );
    await assert.rejects(
      captureAndGateDiff(value.campaign, value.variant, value.directory, value.artifacts),
      /privileged production logic/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test('mutation diff isolates current treatment from staged parent changes and represents no-ops', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-mutation-artifacts-'));
  try {
    await writeFile(path.join(value.directory, 'server/src/parent.ts'), 'export const parent = true;\n');
    const baselineTree = await stageMutationBaseline(value.directory);
    const noOp = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.deepEqual(noOp.result.changedFiles, []);
    assert.equal(noOp.patch, '');
    const noOpCumulative = await captureAndGateDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
    );
    assert.deepEqual(noOpCumulative.result.changedFiles, ['server/src/parent.ts']);

    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      'export const policy = "current-treatment";\n',
    );
    const treatment = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.deepEqual(treatment.result.changedFiles, ['server/src/policy.ts']);
    assert.match(treatment.patch, /current-treatment/);
    assert.doesNotMatch(treatment.patch, /server\/src\/parent\.ts/);

    const cumulative = await captureAndGateDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
    );
    assert.deepEqual(cumulative.result.changedFiles, [
      'server/src/parent.ts',
      'server/src/policy.ts',
    ]);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('cumulative diff leaves a first-round no-op for the compliance lifecycle', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-noop-artifacts-'));
  try {
    const baselineTree = await stageMutationBaseline(value.directory);
    const treatment = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.equal(treatment.patch, '');
    const cumulative = await captureAndGateDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
    );
    assert.deepEqual(cumulative.result.changedFiles, []);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('mutation diff preserves a current-treatment deletion against the staged parent baseline', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-deletion-artifacts-'));
  try {
    const baselineTree = await stageMutationBaseline(value.directory);
    await rm(path.join(value.directory, 'server/src/policy.ts'));
    const treatment = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.deepEqual(treatment.result.changedFiles, ['server/src/policy.ts']);
    assert.match(treatment.patch, /deleted file mode/);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('mutation diff rejects mutator index flags that hide treatment changes', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-index-artifacts-'));
  try {
    const baselineTree = await stageMutationBaseline(value.directory);
    await runCommand('git', ['update-index', '--assume-unchanged', 'server/src/policy.ts'], {
      cwd: value.directory,
    });
    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      'export const policy = "staged-treatment";\n',
    );
    await assert.rejects(
      captureMutationDiff(
        value.campaign,
        value.variant,
        value.directory,
        mutationArtifacts,
        baselineTree,
      ),
      /mutator altered the staged parent baseline/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('mutation diff rejects Git configuration changes that hide file-mode treatment', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-config-artifacts-'));
  try {
    const baselineTree = await stageMutationBaseline(value.directory);
    await runCommand('git', ['config', 'core.fileMode', 'false'], { cwd: value.directory });
    await chmod(path.join(value.directory, 'server/src/policy.ts'), 0o755);
    await assert.rejects(
      captureMutationDiff(
        value.campaign,
        value.variant,
        value.directory,
        mutationArtifacts,
        baselineTree,
      ),
      /mutator altered the staged parent baseline/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('mutation diff includes untracked source even when Git exclude metadata hides it', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-exclude-artifacts-'));
  try {
    const baselineTree = await stageMutationBaseline(value.directory);
    const excludePath = path.join(value.directory, '.git/info/exclude');
    await writeFile(
      excludePath,
      `${await readFile(excludePath, 'utf8')}\nserver/src/hidden.ts\n`,
    );
    await Promise.all([
      writeFile(path.join(value.directory, 'server/src/hidden.ts'), 'export const hidden = true;\n'),
      writeFile(
        path.join(value.directory, 'server/src/policy.ts'),
        'export const policy = "visible-change";\n',
      ),
    ]);
    const treatment = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.deepEqual(treatment.result.changedFiles, [
      'server/src/hidden.ts',
      'server/src/policy.ts',
    ]);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('temporary intent-to-add preserves a parent deletion when the mutation re-adds the path', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-readd-artifacts-'));
  try {
    await rm(path.join(value.directory, 'server/src/policy.ts'));
    const baselineTree = await stageMutationBaseline(value.directory);
    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      'export const policy = "reintroduced";\n',
    );
    const first = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    const second = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.deepEqual(first.result.changedFiles, ['server/src/policy.ts']);
    assert.match(first.patch, /new file mode/);
    assert.equal(second.patch, first.patch);
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('mutation diff captures treatment bytes above the process default up to the campaign limit', async () => {
  const value = await fixture();
  const mutationArtifacts = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-large-patch-'));
  try {
    const baselineTree = await stageMutationBaseline(value.directory);
    const marker = 'treatment-tail-marker';
    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      `export const payload = "${'x'.repeat(5 * 1_024 * 1_024)}${marker}";\n`,
    );
    const treatment = await captureMutationDiff(
      value.campaign,
      value.variant,
      value.directory,
      mutationArtifacts,
      baselineTree,
    );
    assert.ok(Buffer.byteLength(treatment.patch) > 5 * 1_024 * 1_024);
    assert.match(treatment.patch, new RegExp(marker));
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(mutationArtifacts, { recursive: true, force: true });
  }
});

test('variant worktree verifies the parent patch hash at the point of application', async () => {
  const value = await fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-parent-patch-'));
  try {
    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      'export const policy = "parent";\n',
    );
    const patch = (
      await runCommand('git', ['diff', '--binary', 'HEAD'], { cwd: value.directory })
    ).stdout;
    await writeFile(
      path.join(value.directory, 'server/src/policy.ts'),
      'export const policy = "generic";\n',
    );
    const patchPath = path.join(root, 'parent.patch');
    await writeFile(patchPath, patch);
    const patchSha256 = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
    const paths: HarnessPaths = {
      root,
      database: path.join(root, 'harness.sqlite'),
      campaigns: path.join(root, 'campaigns'),
      worktrees: path.join(root, 'worktrees'),
      artifacts: path.join(root, 'artifacts'),
      reports: path.join(root, 'reports'),
    };
    const firstVariant = { ...value.variant, id: 'gate-test-v010' };
    const first = await prepareVariantWorktree(
      paths,
      value.campaign,
      firstVariant,
      patchPath,
      patchSha256,
    );
    assert.match(await readFile(path.join(first, 'server/src/policy.ts'), 'utf8'), /parent/);
    await writeFile(path.join(first, 'server/src/residue.ts'), 'export const residue = true;\n');
    await assert.rejects(
      prepareVariantWorktree(
        paths,
        value.campaign,
        firstVariant,
        patchPath,
        patchSha256,
      ),
      /existing variant worktree differs from the hash-bound parent state/,
    );

    await writeFile(patchPath, `${patch}\n# tampered\n`);
    await assert.rejects(
      prepareVariantWorktree(
        paths,
        value.campaign,
        { ...value.variant, id: 'gate-test-v011' },
        patchPath,
        patchSha256,
      ),
      /parent patch hash changed before application/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('diff gate rejects embedded repositories whose dirty bytes are not patch-bound', async () => {
  const value = await fixture();
  try {
    const embedded = path.join(value.directory, 'server/src/embedded');
    await mkdir(embedded, { recursive: true });
    await writeFile(path.join(embedded, 'payload.ts'), 'export const payload = "committed";\n');
    await runCommand('git', ['init'], { cwd: embedded });
    await runCommand('git', ['add', '.'], { cwd: embedded });
    await runCommand(
      'git',
      [
        '-c',
        'user.name=Harness Test',
        '-c',
        'user.email=harness@example.invalid',
        'commit',
        '-m',
        'embedded fixture',
      ],
      { cwd: embedded },
    );
    await writeFile(path.join(embedded, 'payload.ts'), 'export const payload = "dirty";\n');
    await assert.rejects(
      captureAndGateDiff(
        value.campaign,
        value.variant,
        value.directory,
        value.artifacts,
      ),
      /changed paths cannot be directories or embedded repositories/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test('compliance attempt inputs are immutable across later mutation captures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-attempt-inputs-'));
  const treatmentPath = path.join(root, 'mutation.patch');
  const candidatePath = path.join(root, 'variant.patch');
  const contextPath = path.join(root, 'mutation-context.json');
  await Promise.all([
    writeFile(treatmentPath, 'treatment one'),
    writeFile(candidatePath, 'candidate one'),
    writeFile(contextPath, '{"selectedFindings":[]}\n'),
  ]);
  try {
    const first = await archiveHypothesisComplianceAttemptInputs(
      root,
      1,
      treatmentPath,
      candidatePath,
      contextPath,
    );
    const repeated = await archiveHypothesisComplianceAttemptInputs(
      root,
      1,
      treatmentPath,
      candidatePath,
      contextPath,
    );
    assert.deepEqual(repeated, first);
    await writeFile(treatmentPath, 'treatment two');
    await assert.rejects(
      archiveHypothesisComplianceAttemptInputs(
        root,
        1,
        treatmentPath,
        candidatePath,
        contextPath,
      ),
      /immutable compliance attempt input changed/,
    );
    assert.equal(await readFile(first.treatmentPatchPath, 'utf8'), 'treatment one');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function dockerFixture(t: TestContext) {
  const value = await fixture();
  t.after(async () => await rm(value.directory, { recursive: true, force: true }));
  const bin = path.join(value.directory, 'bin');
  const image = path.join(value.directory, 'image');
  const callsPath = path.join(value.directory, 'docker-calls.jsonl');
  await mkdir(bin);
  await mkdir(path.join(image, 'server/test/nested'), { recursive: true });
  await writeFile(path.join(image, 'server/test/policy.test.ts'), 'export {};\n');
  await writeFile(path.join(image, 'server/test/nested/other.test.ts'), 'export {};\n');
  await writeFile(path.join(bin, 'docker'), `#!${process.execPath} --
const fs = require('node:fs');
const { appendFileSync, readFileSync } = fs;
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
appendFileSync(${JSON.stringify(path.join(value.directory, 'docker-environments.jsonl'))}, JSON.stringify(process.env) + '\\n');
const control = fs.existsSync(${JSON.stringify(path.join(value.directory, 'docker-control.json'))})
  ? JSON.parse(readFileSync(${JSON.stringify(path.join(value.directory, 'docker-control.json'))}, 'utf8')) : {};
if (args[0] === 'image' && args[1] === 'inspect') {
  console.log(control.imageId ?? 'sha256:' + 'a'.repeat(64));
  process.exit(0);
}
const entrypoint = args.indexOf('--entrypoint');
const command = args[entrypoint + 1];
const commandArgs = args.slice(entrypoint + 3);
if (args.includes('HARNESS_DIAGNOSTIC_INPUT=/harness/diagnostic-input.json')) {
  const mount = args[args.indexOf('--mount') + 1];
  const file = mount.match(/source=([^,]+)/)[1];
  const tamper = () => {
    if (control.tamper === 'content') { fs.chmodSync(file, 0o600); fs.writeFileSync(file, '{}'); }
    if (control.tamper === 'symlink') { fs.unlinkSync(file); fs.symlinkSync(${JSON.stringify(callsPath)}, file); }
    if (control.tamper === 'hardlink') fs.linkSync(file, file + '.link');
    if (control.tamper === 'replacement') { const bytes = fs.readFileSync(file); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, bytes, { mode: 0o400 }); }
    if (control.tamper === 'parent-symlink') { const dir = require('node:path').dirname(file); fs.renameSync(dir, dir + '.old'); fs.symlinkSync(dir + '.old', dir); }
  };
  if (control.tamperAt === 'mount') tamper();
  const containerFs = new Proxy(fs, { get(target, key) {
    if (['lstatSync', 'readFileSync'].includes(key)) return (name, ...rest) => target[key](name === '/harness/diagnostic-input.json' ? file : name, ...rest);
    return target[key];
  }});
  require('node:vm').runInNewContext(commandArgs[commandArgs.indexOf('-e') + 1], {
    require: (name) => name === 'node:fs' ? containerFs : name === 'node:child_process' ? {
      spawnSync: (cmd, argv, options) => {
        if (cmd === 'node') return spawnSync(process.execPath, argv, { ...options, cwd: ${JSON.stringify(image)} });
        appendFileSync(${JSON.stringify(path.join(value.directory, 'probe-executed'))}, 'tests\\n');
        console.log('docker fixture output');
        if (control.fail) console.error('fixture gate failed');
        return { status: control.fail ? 7 : 0 };
      },
    } : require(name),
    process: { argv: ['node', ...commandArgs.slice(commandArgs.indexOf('--') + 1)], env: { CI: '1', HARNESS_DIAGNOSTIC_INPUT: '/harness/diagnostic-input.json' },
      exit: (code) => { if (control.tamperAt !== 'mount') tamper(); process.exit(code); } },
    console, Buffer,
  });
  process.exit(0);
}
if (entrypoint !== -1 && command === 'node') {
  const result = spawnSync(process.execPath, commandArgs, { cwd: ${JSON.stringify(image)}, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
console.log('docker fixture output');
if (process.env.FAIL_GATE && commandArgs.includes(process.env.FAIL_GATE)) {
  console.error('fixture gate failed');
  process.exit(7);
}
`);
  await chmod(path.join(bin, 'docker'), 0o755);
  const environment = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    DOCKER_CALLS: callsPath,
    TEST_IMAGE: image,
    PLANNER_KB_MODE: 'disabled',
  };
  return {
    ...value,
    image,
    environment,
    control: async (input: unknown) => await writeFile(path.join(value.directory, 'docker-control.json'), JSON.stringify(input)),
    calls: async (): Promise<string[][]> => (await readFile(callsPath, 'utf8').catch(() => ''))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
  };
}

function assertGateSandbox(args: string[]): void {
  assert.deepEqual(args.slice(0, args.indexOf('--entrypoint')), [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '512',
    '--memory', '4g', '--cpus', '4',
    '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
    '--tmpfs', '/root/.npm:rw,noexec,nosuid,size=128m',
    '--tmpfs', '/app/.local:rw,noexec,nosuid,size=1g',
    '--tmpfs', '/app/server/node_modules/.vite-temp:rw,noexec,nosuid,size=256m',
    '--env', 'CI=1',
  ]);
}

async function probeFixture(t: TestContext) {
  const value = await dockerFixture(t);
  const artifacts = path.join(await realpath(value.directory), '.data', 'probe');
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  return { ...value, artifacts };
}

const diagnosticInput = {
  schema: 'diagnostic_review', units: [{ id: 'unit-1', inputTokens: 42, tokenCount: 12, token: 7 }],
  source: { complete: false, excerpts: [{ citation: 'source:one:1-2', text: 'const count = 42;' }] },
};

test('diagnostic probe pins the inspected image, mounts only redacted immutable JSON and never runs full gates', async (t) => {
  const value = await probeFixture(t);
  value.campaign.config.gates.commands = [{ command: 'sh', args: ['-c', 'untrusted'], timeoutMs: 1 }];
  const timeouts: number[] = [];
  const set = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof set>) => { timeouts.push(args[1] ?? 0); return set(...args); });
  const files = ['server/test/policy.test.ts', 'server/test/nested/other.test.ts'];
  const input = { ...diagnosticInput, secret: 'private-value', note: 'Bearer abcdefgh',
    nested: { apiKey: 'private-key', calls: 3 }, argv: ['--network=host', '--volume=/:/root'],
    env: { HARNESS_DIAGNOSTIC_INPUT: '/etc/passwd' }, entrypoint: 'sh', sourceRoot: '/etc' };
  const result = await runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts,
    { ...value.environment, OPENAI_API_KEY: 'runtime-provider-secret', NODE_OPTIONS: '--require=/bad', HARNESS_DIAGNOSTIC_INPUT: '/bad' }, files, input);
  const fixturePath = path.join(value.artifacts, 'diagnostic-input.json');
  const bytes = await readFile(fixturePath);
  const parsed = JSON.parse(bytes.toString());
  assert.deepEqual(parsed.units, diagnosticInput.units);
  assert.deepEqual(parsed.source, diagnosticInput.source);
  assert.equal(parsed.secret, '[REDACTED]');
  assert.equal(parsed.nested.apiKey, '[REDACTED]');
  assert.equal(parsed.nested.calls, 3);
  assert.doesNotMatch(bytes.toString(), /private-value|private-key|abcdefgh/);
  assert.equal(result.kind, 'diagnostic_probe');
  assert.equal(result.executionPassed, true);
  assert.equal(result.providerCalls, 0);
  assert.equal(result.imageId, `sha256:${'a'.repeat(64)}`);
  assert.equal(result.inputHash, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.deepEqual(result.testFiles, files);
  assert.match(result.interpretation, /Offline fixture-backed/);
  assert.match(result.interpretation, /does not establish diagnosis correctness/);
  assert.match(result.interpretation, /full primary score/);
  assert.match(result.interpretation, /test\/full validation gates/);
  const calls = await value.calls();
  assert.deepEqual(calls[0], ['image', 'inspect', '--format={{.Id}}', '--', 'trusted:test']);
  assert.equal(calls.length, 3);
  const environments = (await readFile(path.join(value.directory, 'docker-environments.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  for (const environment of environments) {
    for (const key of ['OPENAI_API_KEY', 'NODE_OPTIONS', 'HARNESS_DIAGNOSTIC_INPUT', 'DOCKER_CALLS', 'TEST_IMAGE', 'PLANNER_KB_MODE']) {
      assert.equal(environment[key], undefined, `${key} must not reach the Docker client`);
    }
  }
  for (const args of calls.slice(1)) {
    const fixtureFlag = args.indexOf('--pull=never');
    assertGateSandbox([...args.slice(0, fixtureFlag), '--entrypoint']);
    assert.deepEqual(args.slice(fixtureFlag, args.indexOf('--entrypoint')), [
      '--pull=never', '--mount', `type=bind,source=${fixturePath},target=/harness/diagnostic-input.json,readonly`,
      '--env', 'HARNESS_DIAGNOSTIC_INPUT=/harness/diagnostic-input.json',
    ]);
    assert.equal(args[args.indexOf('--entrypoint') + 1], 'node');
    assert.equal(args[args.indexOf('--entrypoint') + 2], result.imageId);
    assert.ok(!args.includes('trusted:test'));
    assert.ok(!args.includes('typecheck'));
    assert.doesNotMatch(args.join('\n'), /runtime-provider-secret|\/etc|untrusted|\/bad/);
  }
  assert.deepEqual(calls[2]!.slice(-9), ['npm', 'exec', '--workspace', '@ainative-planner/server', '--', 'vitest', 'run',
    'test/policy.test.ts', 'test/nested/other.test.ts']);
  assert.ok(timeouts.includes(30_000));
  assert.ok(timeouts.includes(300_000));
  assert.ok(!timeouts.includes(1_800_000));
  assert.equal((await lstat(value.artifacts)).mode & 0o777, 0o700);
  for (const file of [fixturePath, ...result.logPaths]) assert.equal((await lstat(file)).mode & 0o777, 0o400);
  assert.equal(result.logPaths.length, 3);
  const logs = await Promise.all(result.logPaths.map((file) => readFile(file, 'utf8')));
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment, files, input), /exist|immutable/i);
  assert.deepEqual(await Promise.all(result.logPaths.map((file) => readFile(file, 'utf8'))), logs);
  assert.equal((await value.calls()).length, 3);
});

test('diagnostic probe refuses absent, malformed and unsafe selectors without a full-suite fallback', async (t) => {
  const value = await probeFixture(t);
  const invalid: unknown[] = [undefined, null, [], 'server/test/policy.test.ts', [1],
    ['server/test/policy.test.ts', 'server/test/policy.test.ts'],
    Array.from({ length: 31 }, (_, i) => `server/test/${i}.test.ts`),
    ...['../server/test/policy.test.ts', '/server/test/policy.test.ts', 'server/test/../policy.test.ts',
      'server/test/*.test.ts', '--config=evil', 'server/test/a;touch.test.ts', 'server/test/a\nb.test.ts',
      'server/test/policy.test.ts\n', 'server/test/node_modules/a.test.ts', 'server/src/a.test.ts',
      'server\\test\\policy.test.ts'].map((file) => [file])];
  for (const files of invalid) await assert.rejects(
    runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment, files as string[], diagnosticInput),
    /testFiles|test file/i,
  );
  assert.deepEqual(await value.calls(), []);
});

test('diagnostic probe bounds serialized UTF-8 JSON before publication and rejects unserializable input', async (t) => {
  const value = await probeFixture(t);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const input of [undefined, 1n, cyclic, { text: 'x'.repeat(2 * 1_024 * 1_024) }, { text: '\u00e9'.repeat(1_024 * 1_024) }]) {
    await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
      ['server/test/policy.test.ts'], input), /JSON|serializ|2 MiB|2097152|BigInt|circular/i);
  }
  assert.deepEqual(await value.calls(), []);
  await assert.rejects(readFile(path.join(value.artifacts, 'diagnostic-input.json')), /ENOENT/);
});

test('diagnostic probe accepts exactly 2 MiB of serialized fixture JSON', async (t) => {
  const value = await probeFixture(t);
  const input = { text: 'x'.repeat(2 * 1_024 * 1_024 - Buffer.byteLength(JSON.stringify({ text: '' }))) };
  const result = await runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
    ['server/test/policy.test.ts'], input);
  assert.equal(result.executionPassed, true);
  assert.equal((await lstat(path.join(value.artifacts, 'diagnostic-input.json'))).size, 2 * 1_024 * 1_024);
});

test('diagnostic probe rejects image option injection and refuses to append preexisting logs', async (t) => {
  const value = await probeFixture(t);
  for (const image of ['--format={{json .}}', 'trusted:test\n', 'trusted:test --network=host', 'trusted:test;touch']) {
    await assert.rejects(runInvestigatorProbe(value.campaign, image, value.artifacts, value.environment,
      ['server/test/policy.test.ts'], diagnosticInput), /image reference/i);
  }
  const log = path.join(value.artifacts, 'image-inspect.log');
  await writeFile(log, 'existing evidence', { flag: 'wx', mode: 0o400 });
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
    ['server/test/policy.test.ts'], diagnosticInput), /exist/i);
  assert.equal(await readFile(log, 'utf8'), 'existing evidence');
  assert.deepEqual(await value.calls(), []);
});

test('diagnostic probe rejects unsafe artifact paths and preexisting fixture links without touching their targets', async (t) => {
  const value = await probeFixture(t);
  const outside = path.join(value.directory, 'outside.json');
  await writeFile(outside, 'untouched');
  const alias = path.join(path.dirname(value.artifacts), 'alias');
  await symlink(value.artifacts, alias);
  for (const directory of [value.directory, '.data/relative', `${value.artifacts}/../probe`, `${value.artifacts},target=/etc`, alias]) {
    await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', directory, value.environment,
      ['server/test/policy.test.ts'], diagnosticInput), /path|\.data|canonical|symlink|symbolic/i);
  }
  const file = path.join(value.artifacts, 'diagnostic-input.json');
  await symlink(outside, file);
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
    ['server/test/policy.test.ts'], diagnosticInput), /exist|immutable|symbolic/i);
  await rm(file);
  await link(outside, file);
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
    ['server/test/policy.test.ts'], diagnosticInput), /exist|immutable|link/i);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  assert.deepEqual(await value.calls(), []);
});

for (const tamper of ['content', 'symlink', 'hardlink', 'replacement', 'parent-symlink']) {
  test(`diagnostic probe rejects ${tamper} fixture tampering between validation and tests`, async (t) => {
    const value = await probeFixture(t);
    await value.control({ tamper });
    await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
      ['server/test/policy.test.ts'], diagnosticInput), /changed|tamper|immutable|symbolic|link|canonical/i);
    assert.equal((await value.calls()).length, 2);
    await assert.rejects(readFile(path.join(value.directory, 'probe-executed')), /ENOENT/);
  });
}

test('diagnostic probe validates mounted fixture bytes inside the image before executing tests', async (t) => {
  const value = await probeFixture(t);
  await value.control({ tamper: 'content', tamperAt: 'mount' });
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', value.artifacts, value.environment,
    ['server/test/policy.test.ts'], diagnosticInput), /changed|immutable|command failed/i);
  await assert.rejects(readFile(path.join(value.directory, 'probe-executed')), /ENOENT/);
});

test('diagnostic probe refuses invalid image IDs and preserves inspection failure evidence', async (t) => {
  const value = await probeFixture(t);
  for (const [index, imageId] of ['trusted:test', `sha256:${'a'.repeat(63)}`, `sha256:${'g'.repeat(64)}`,
    `sha256:${'a'.repeat(64)}\nsha256:${'b'.repeat(64)}`].entries()) {
    await value.control({ imageId });
    const directory = path.join(value.artifacts, String(index));
    await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', directory, value.environment,
      ['server/test/policy.test.ts'], diagnosticInput), /immutable image|image ID/i);
    assert.equal((await lstat(path.join(directory, 'image-inspect.log'))).mode & 0o777, 0o400);
    await readFile(path.join(directory, 'diagnostic-input.json'));
  }
  assert.ok((await value.calls()).every((args) => args[0] === 'image'));
});

test('diagnostic probe validates image files, preserves failed tests and accepts 30 selected tests', async (t) => {
  const value = await probeFixture(t);
  await writeFile(path.join(value.directory, 'server/test/missing.test.ts'), 'host-only');
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', path.join(value.artifacts, 'missing'), value.environment,
    ['server/test/missing.test.ts'], diagnosticInput), /command failed/);
  await symlink('policy.test.ts', path.join(value.image, 'server/test/link.test.ts'));
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', path.join(value.artifacts, 'link'), value.environment,
    ['server/test/link.test.ts'], diagnosticInput), /command failed/);
  const files = Array.from({ length: 30 }, (_, i) => `server/test/test-${i}.test.ts`);
  await Promise.all(files.map((file) => writeFile(path.join(value.image, file), 'export {};')));
  const result = await runInvestigatorProbe(value.campaign, 'trusted:test', path.join(value.artifacts, 'max'), value.environment, files, diagnosticInput);
  assert.deepEqual(result.testFiles, files);
  await value.control({ fail: true });
  const directory = path.join(value.artifacts, 'failed');
  await assert.rejects(runInvestigatorProbe(value.campaign, 'trusted:test', directory, value.environment, files, diagnosticInput), /command failed \(7\)/);
  const log = path.join(directory, 'tests.log');
  assert.match(await readFile(log, 'utf8'), /fixture gate failed/);
  assert.equal((await lstat(log)).mode & 0o777, 0o400);
  await readFile(path.join(directory, 'diagnostic-input.json'));
});

test('investigator selected tests validate image files, then run fixed typecheck and workspace Vitest', async (t) => {
  const value = await dockerFixture(t);
  value.campaign.config.gates.commands = [{ command: 'sh', args: ['-c', 'untrusted'], timeoutMs: 1_000 }];
  const files = ['server/test/policy.test.ts', 'server/test/nested/other.test.ts'];
  const result = await runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, value.environment, files);
  assert.deepEqual(result, {
    passed: true,
    testFiles: files,
    logPaths: ['test-files.log', 'typecheck.log', 'tests.log'].map((file) => path.join(value.artifacts, file)),
  });
  const calls = await value.calls();
  assert.equal(calls.length, 3);
  calls.forEach(assertGateSandbox);
  const commands = calls.map((args) => args.slice(args.indexOf('--entrypoint') + 1));
  assert.equal(commands[0]![0], 'node');
  assert.deepEqual(commands[0]!.slice(-files.length), files);
  assert.deepEqual(commands[1], ['npm', 'trusted:test', 'run', 'typecheck']);
  assert.deepEqual(commands[2], [
    'npm', 'trusted:test', 'exec', '--workspace', '@ainative-planner/server', '--',
    'vitest', 'run', 'test/policy.test.ts', 'test/nested/other.test.ts',
  ]);
  for (const logPath of result.logPaths) await readFile(logPath);
});

test('omitted investigator test selection preserves configured full gates and legacy server test rewrite', async (t) => {
  const value = await dockerFixture(t);
  value.campaign.config.gates.commands = [
    { command: 'npm', args: ['run', 'typecheck'], timeoutMs: 1_000 },
    { command: 'npm', args: ['run', 'test', '--workspace', '@ainative-planner/server'], timeoutMs: 1_000 },
  ];
  await runVariantGates(value.campaign, 'trusted:test', value.artifacts, value.environment);
  const original = await value.calls();
  const result = await runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, value.environment);
  assert.deepEqual((await value.calls()).slice(original.length), original);
  original.forEach(assertGateSandbox);
  assert.deepEqual(original[1]!.slice(original[1]!.indexOf('--entrypoint') + 1), [
    'npm', 'trusted:test', 'exec', '--workspace', '@ainative-planner/server', '--',
    'vitest', 'run', '--exclude', 'test/deployment.integration.test.ts',
  ]);
  assert.deepEqual(result, {
    passed: true, testFiles: [],
    logPaths: [path.join(value.artifacts, 'gate-1.log'), path.join(value.artifacts, 'gate-2.log')],
  });
});

test('investigator rejects unsafe, empty, duplicate, and oversized test selections before Docker', async (t) => {
  const value = await dockerFixture(t);
  const invalid: unknown[] = [
    [], null, 'server/test/policy.test.ts', [null], [1],
    ['server/test/policy.test.ts', 'server/test/policy.test.ts'],
    Array.from({ length: 31 }, (_, i) => `server/test/test-${i}.test.ts`),
    ...[
      '../server/test/policy.test.ts', '/server/test/policy.test.ts',
      './server/test/policy.test.ts', 'server/test/../policy.test.ts',
      'server/test/./policy.test.ts', 'server/test//policy.test.ts',
      'server/test/*.test.ts', 'server/test/[a].test.ts', 'server/test/{a,b}.test.ts',
      'server/test/?a.test.ts', '--config=server/test/policy.test.ts',
      'server/test/-policy.test.ts', 'server/test/policy.test.ts;touch-x',
      'server/test/$(touch-x).test.ts', 'server/test/a b.test.ts',
      'server/test/a\nb.test.ts', 'server/test/a\0b.test.ts',
      'server/test/policy.test.ts\n', 'server/test/policy.test.ts\r',
      'server\\test\\policy.test.ts', 'C:/server/test/policy.test.ts',
      'server/src/policy.test.ts', 'server/tests/policy.test.ts',
      'server/test/policy.spec.ts', 'server/test/policy.test.ts/',
      'server/test/.git/policy.test.ts', 'server/test/node_modules/policy.test.ts',
      'server/test/nested/node_modules/policy.test.ts',
    ].map((file) => [file]),
  ];
  for (const files of invalid) {
    await assert.rejects(
      runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, value.environment, files as string[]),
      /testFiles|test file/i,
      JSON.stringify(files),
    );
  }
  assert.deepEqual(await value.calls(), []);
});

test('investigator accepts the maximum of 30 unique canonical files', async (t) => {
  const value = await dockerFixture(t);
  const files = Array.from({ length: 30 }, (_, i) => `server/test/test-${i}.test.ts`);
  await Promise.all(files.map((file) => writeFile(path.join(value.image, file), 'export {};\n')));
  const result = await runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, value.environment, files);
  assert.deepEqual(result.testFiles, files);
});

test('investigator accepts safe test subdirectories even when named after infrastructure', async (t) => {
  const value = await dockerFixture(t);
  const files = ['server/test/scripts/docker.test.ts'];
  await mkdir(path.join(value.image, 'server/test/scripts'));
  await writeFile(path.join(value.image, files[0]!), 'export {};\n');
  const result = await runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, value.environment, files);
  assert.deepEqual(result.testFiles, files);
});

test('investigator full gate failures retain configured gate logs', async (t) => {
  const value = await dockerFixture(t);
  value.campaign.config.gates.commands = [{ command: 'npm', args: ['run', 'typecheck'], timeoutMs: 1_000 }];
  await assert.rejects(
    runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, { ...value.environment, FAIL_GATE: 'typecheck' }),
    /command failed \(7\)/,
  );
  assert.match(await readFile(path.join(value.artifacts, 'gate-1.log'), 'utf8'), /fixture gate failed/);
});

for (const kind of ['missing', 'directory', 'symlink', 'symlink-parent', 'embedded-repo'] as const) {
  test(`investigator rejects ${kind} selected image files with a validation log and no test execution`, async (t) => {
    const value = await dockerFixture(t);
    const file = kind === 'symlink-parent' || kind === 'embedded-repo'
      ? 'server/test/link/policy.test.ts' : 'server/test/rejected.test.ts';
    // A matching host file must not satisfy image validation.
    await mkdir(path.dirname(path.join(value.directory, file)), { recursive: true });
    await writeFile(path.join(value.directory, file), 'export {};\n');
    if (kind === 'directory') await mkdir(path.join(value.image, file));
    if (kind === 'symlink') await symlink('policy.test.ts', path.join(value.image, file));
    if (kind === 'symlink-parent') await symlink('.', path.join(value.image, 'server/test/link'));
    if (kind === 'embedded-repo') {
      await mkdir(path.join(value.image, 'server/test/link/.git'), { recursive: true });
      await writeFile(path.join(value.image, file), 'export {};\n');
    }
    await assert.rejects(
      runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, value.environment, [file]),
      /command failed/,
    );
    assert.equal((await value.calls()).length, 1);
    assert.match(await readFile(path.join(value.artifacts, 'test-files.log'), 'utf8'), /ENOENT|regular file|symbolic link|embedded repository/i);
  });
}

for (const gate of ['typecheck', 'vitest']) {
  test(`investigator propagates ${gate} failure and retains its log`, async (t) => {
    const value = await dockerFixture(t);
    await assert.rejects(
      runInvestigatorTests(value.campaign, 'trusted:test', value.artifacts, { ...value.environment, FAIL_GATE: gate }, ['server/test/policy.test.ts']),
      /command failed \(7\)/,
    );
    assert.equal((await value.calls()).length, gate === 'typecheck' ? 2 : 3);
    assert.match(await readFile(path.join(value.artifacts, gate === 'typecheck' ? 'typecheck.log' : 'tests.log'), 'utf8'), /fixture gate failed/);
  });
}

test('diff gate rejects execution surfaces even with permissive allowed prefixes and includes ignored caches', async (t) => {
  for (const file of [
    'Dockerfile', 'package.json', 'server/package.json', 'server/package-lock.json',
    'server/.npmrc', 'server/vitest.config.ts', 'server/test/tsconfig.json',
    'scripts/build.ts', '.dockerignore', 'docker-compose.yml', '.gitattributes',
    'server/node_modules/.vite/results.json', 'server/src/nested/node_modules/payload.ts',
  ]) {
    await t.test(file, async () => {
      const value = await fixture();
      try {
        value.campaign.config.gates.allowedPathPrefixes = ['server/', 'scripts/', 'Dockerfile', 'package', '.docker', 'docker-', '.git'];
        await writeFile(path.join(value.directory, '.git/info/exclude'), 'node_modules/\n');
        await mkdir(path.dirname(path.join(value.directory, file)), { recursive: true });
        await writeFile(path.join(value.directory, file), '// modified execution surface\n');
        await assert.rejects(
          captureAndGateDiff(value.campaign, value.variant, value.directory, value.artifacts),
          /protected execution surface/,
        );
        assert.match(await readFile(path.join(value.artifacts, 'variant.patch'), 'utf8'), /modified execution surface/);
      } finally {
        await rm(value.directory, { recursive: true, force: true });
      }
    });
  }
});

test('diff gate checks whitespace after archiving the patch and logs failures', async (t) => {
  for (const file of ['server/src/policy.ts', 'server/test/new.test.ts']) {
    await t.test(file, async () => {
      const value = await fixture();
      try {
        await writeFile(path.join(value.directory, file), 'export const policy = "generic";  \n');
        await assert.rejects(
          captureAndGateDiff(value.campaign, value.variant, value.directory, value.artifacts),
          /command failed/,
        );
        assert.match(await readFile(path.join(value.artifacts, 'variant.patch'), 'utf8'), /generic/);
        assert.match(await readFile(path.join(value.artifacts, 'diff-check.log'), 'utf8'), /trailing whitespace/);
      } finally {
        await rm(value.directory, { recursive: true, force: true });
      }
    });
  }
});

test('stack startup creates and retains the caller-supplied isolated artifact directory', async (t) => {
  const value = await dockerFixture(t);
  const paths: HarnessPaths = {
    root: value.directory,
    database: path.join(value.directory, 'harness.sqlite'),
    campaigns: path.join(value.directory, 'campaigns'),
    worktrees: path.join(value.directory, 'worktrees'),
    artifacts: value.artifacts,
    reports: path.join(value.directory, 'reports'),
  };
  const actionArtifacts = path.join(value.artifacts, 'trial-1/action-1');
  const stack = await startVariantStack(
    paths, value.campaign, value.variant, value.directory, actionArtifacts,
    'trusted:runtime', value.environment, value.directory, 'trial-1',
  );
  assert.equal(stack.artifactDirectory, actionArtifacts);
  assert.equal(stack.generatedEnvironmentFile, path.join(actionArtifacts, 'stack.env'));
  assert.match(await readFile(stack.generatedEnvironmentFile, 'utf8'), /PLANNER_IMAGE=trusted:runtime/);
  assert.match(await readFile(path.join(actionArtifacts, 'stack-up.log'), 'utf8'), /docker fixture output/);
  assert.ok(stack.composeArgs.includes(stack.generatedEnvironmentFile));
});
