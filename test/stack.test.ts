import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCommand } from '../src/process.js';
import {
  captureAndGateDiff,
  captureMutationDiff,
  prepareVariantWorktree,
  stageMutationBaseline,
} from '../src/stack.js';
import { CampaignConfigSchema, type CampaignRecord, type VariantRecord } from '../src/types.js';
import type { HarnessPaths } from '../src/paths.js';

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
