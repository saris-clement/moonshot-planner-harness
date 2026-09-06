import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCommand } from '../src/process.js';
import { captureAndGateDiff } from '../src/stack.js';
import { CampaignConfigSchema, type CampaignRecord, type VariantRecord } from '../src/types.js';

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
    },
    status: 'gating',
    worktreePath: directory,
    imageTag: null,
    composeProject: null,
    baseUrl: null,
    patchPath: null,
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
