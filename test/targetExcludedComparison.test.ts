import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TARGET_EXCLUDED_COMPARISON_SCRIPT,
  buildTargetExcludedComparisonDockerCommand,
  runTargetExcludedComparison,
  summarizeTargetExcludedComparisonReport,
} from '../src/targetExcludedComparison.js';
import { canonicalHash } from '../src/metrics.js';

const digest = `planner-eval@sha256:${'a'.repeat(64)}`;
const generatedAt = '2026-09-06T12:00:00.000Z';

function comparisonArm(
  arm: 'normal' | 'excluded',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    valid: true,
    errors: [],
    analysis: { runId: `${arm}-run-1` },
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = {
    kind: 'ainative-planner/evidence-visibility-comparison',
    schemaVersion: 1,
    inputs: {
      normalCaseId: 'normal-case-1',
      excludedCaseId: 'excluded-case-1',
    },
    validity: {
      valid: true,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [] },
    },
    leakage: { detected: false, count: 0, paths: [] },
    ...overrides,
  };
  return { ...value, hash: canonicalHash(value) };
}

test('buildTargetExcludedComparisonDockerCommand isolates inputs and preserves arguments', () => {
  const command = buildTargetExcludedComparisonDockerCommand({
    normalArtifactDirectory: '/tmp/normal artifacts; untouched',
    excludedArtifactDirectory: '/tmp/excluded artifacts',
    outputPath: '/tmp/comparison output/report.json',
    imageTag: digest,
    replicate: 2,
    scriptPath: '/tmp/generated script.mts',
    generatedAt,
  });

  assert.equal(command.command, 'docker');
  assert.deepEqual(command.args.slice(0, 13), [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--volume',
    `${path.resolve('/tmp/generated script.mts')}:/eval/run.mts:ro`,
  ]);
  assert.ok(
    command.args.includes(
      `${path.resolve('/tmp/normal artifacts; untouched')}:/eval/normal:ro`,
    ),
  );
  assert.ok(
    command.args.includes(`${path.resolve('/tmp/excluded artifacts')}:/eval/excluded:ro`),
  );
  assert.ok(
    command.args.includes(`${path.resolve('/tmp/comparison output/report.json')}:/eval/output.json`),
  );
  assert.ok(!command.args.includes('--privileged'));

  const imageIndex = command.args.indexOf(digest);
  assert.ok(imageIndex > 0);
  assert.deepEqual(command.args.slice(imageIndex - 2, imageIndex), ['--entrypoint', 'node']);
  assert.deepEqual(command.args.slice(imageIndex + 1), [
    '--import',
    'tsx',
    '/eval/run.mts',
    '--normal',
    '/eval/normal',
    '--excluded',
    '/eval/excluded',
    '--out',
    '/eval/output.json',
    '--replicate',
    '2',
    '--generated-at',
    generatedAt,
  ]);
});

test('buildTargetExcludedComparisonDockerCommand rejects unsafe image and replicate arguments', () => {
  const base = {
    normalArtifactDirectory: '/tmp/normal',
    excludedArtifactDirectory: '/tmp/excluded',
    outputPath: '/tmp/report.json',
    scriptPath: '/tmp/run.mts',
    generatedAt,
  };

  assert.throws(
    () =>
      buildTargetExcludedComparisonDockerCommand({
        ...base,
        imageTag: '--privileged',
        replicate: 1,
      }),
    /invalid planner image tag or digest/,
  );
  assert.throws(
    () =>
      buildTargetExcludedComparisonDockerCommand({
        ...base,
        imageTag: digest,
        replicate: 0,
      }),
    /replicate must be a positive integer/,
  );
});

test('generated script calls the planner authority with runs and no Phase 3 resources', () => {
  assert.match(
    TARGET_EXCLUDED_COMPARISON_SCRIPT,
    /from '\/app\/server\/src\/experiments\/evidenceVisibilityComparison\.ts'/,
  );
  assert.match(
    TARGET_EXCLUDED_COMPARISON_SCRIPT,
    /from '\/app\/server\/src\/contracts\/canonical\.ts'/,
  );
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /analysis-runs\.json/);
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /runs: runResponse\.runs/);
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /phase3: \[\]/);
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /normalCaseId: caseId\(normal, 'normal'\)/);
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /excludedCaseId: caseId\(excluded, 'excluded'\)/);
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /canonicalJson\(comparison\)/);
});

test('summarizeTargetExcludedComparisonReport describes arm and pair mismatches', () => {
  const value = report({
    validity: {
      valid: false,
      arms: {
        normal: comparisonArm('normal', {
          valid: false,
          errors: [{ code: 'CURRENT_ANALYSIS_INCOMPLETE', path: '$.analysis' }],
        }),
        excluded: comparisonArm('excluded', {
          valid: false,
          errors: [{ code: 'CASE_ID_MISMATCH', path: '$.case.id' }],
        }),
      },
      pair: {
        valid: false,
        mismatches: [
          { category: 'renderer', path: '$.rendererVersion', normal: 'v1', excluded: 'v2' },
        ],
      },
    },
    leakage: {
      detected: true,
      count: 1,
      paths: ['$.analysis.analysis.adjudications[0].sourceRefs[0].path'],
    },
  });
  const summary = summarizeTargetExcludedComparisonReport(
    2,
    value,
  );

  assert.deepEqual(summary, {
    replicate: 2,
    normalCaseId: 'normal-case-1',
    excludedCaseId: 'excluded-case-1',
    normalRunId: 'normal-run-1',
    excludedRunId: 'excluded-run-1',
    valid: false,
    mismatches: [
      'normal CURRENT_ANALYSIS_INCOMPLETE at $.analysis',
      'excluded CASE_ID_MISMATCH at $.case.id',
      'renderer mismatch at $.rendererVersion',
    ],
    leakagePaths: ['$.analysis.analysis.adjudications[0].sourceRefs[0].path'],
    reportHash: value.hash,
  });
});

test('summarizeTargetExcludedComparisonReport requires component validity booleans', () => {
  for (const validity of [
    {
      valid: true,
      arms: {
        normal: comparisonArm('normal', { valid: undefined }),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: true,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded', { valid: 'yes' }),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: true,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded'),
      },
      pair: { mismatches: [] },
    },
  ]) {
    assert.throws(
      () => summarizeTargetExcludedComparisonReport(1, report({ validity })),
      /comparison report \$\.validity\.(arms\.(normal|excluded)|pair)\.valid must be a boolean/,
    );
  }
});

test('summarizeTargetExcludedComparisonReport rejects contradictory validity', () => {
  const error = { code: 'INVALID_ARM', path: '$.analysis' };
  const mismatch = { category: 'renderer', path: '$.rendererVersion' };
  const contradictions = [
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal', { errors: [error] }),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal', { valid: false }),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded', { errors: [error] }),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded', { valid: false }),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [mismatch] },
    },
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: false, mismatches: [] },
    },
    {
      valid: true,
      arms: {
        normal: comparisonArm('normal', { valid: false, errors: [error] }),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [] },
    },
    {
      valid: false,
      arms: {
        normal: comparisonArm('normal'),
        excluded: comparisonArm('excluded'),
      },
      pair: { valid: true, mismatches: [] },
    },
  ];

  for (const validity of contradictions) {
    assert.throws(
      () => summarizeTargetExcludedComparisonReport(1, report({ validity })),
      /comparison report validity is internally inconsistent/,
    );
  }
});

test('summarizeTargetExcludedComparisonReport requires valid leakage metadata', () => {
  for (const leakage of [
    { count: 0, paths: [] },
    { detected: 'no', count: 0, paths: [] },
    { detected: false, paths: [] },
    { detected: false, count: -1, paths: [] },
    { detected: false, count: 0.5, paths: [] },
  ]) {
    assert.throws(
      () => summarizeTargetExcludedComparisonReport(1, report({ leakage })),
      /comparison report \$\.leakage\.(detected must be a boolean|count must be a nonnegative integer)/,
    );
  }
});

test('summarizeTargetExcludedComparisonReport rejects contradictory leakage metadata', () => {
  for (const leakage of [
    { detected: true, count: 0, paths: [] },
    { detected: false, count: 1, paths: ['$.analysis'] },
    { detected: true, count: 2, paths: ['$.analysis'] },
  ]) {
    assert.throws(
      () => summarizeTargetExcludedComparisonReport(1, report({ leakage })),
      /comparison report leakage metadata is internally inconsistent/,
    );
  }
});

test('summarizeTargetExcludedComparisonReport requires non-empty case IDs', () => {
  for (const inputs of [
    {},
    { normalCaseId: 'normal-case-1' },
    { normalCaseId: 42, excludedCaseId: 'excluded-case-1' },
    { normalCaseId: 'normal-case-1', excludedCaseId: '' },
  ]) {
    assert.throws(
      () => summarizeTargetExcludedComparisonReport(1, report({ inputs })),
      /comparison report \$\.inputs\.(normalCaseId|excludedCaseId) must be a non-empty string/,
    );
  }
});

test('summarizeTargetExcludedComparisonReport rejects a same-case pair', () => {
  assert.throws(
    () =>
      summarizeTargetExcludedComparisonReport(
        1,
        report({
          inputs: {
            normalCaseId: 'same-case',
            excludedCaseId: 'same-case',
          },
        }),
      ),
    /comparison report case IDs must be different/,
  );
});

test('summarizeTargetExcludedComparisonReport requires non-empty arm run IDs', () => {
  for (const arms of [
    {
      normal: comparisonArm('normal', { analysis: {} }),
      excluded: comparisonArm('excluded'),
    },
    {
      normal: comparisonArm('normal', { analysis: { runId: 42 } }),
      excluded: comparisonArm('excluded'),
    },
    {
      normal: comparisonArm('normal'),
      excluded: comparisonArm('excluded', { analysis: {} }),
    },
    {
      normal: comparisonArm('normal'),
      excluded: comparisonArm('excluded', { analysis: { runId: '' } }),
    },
  ]) {
    assert.throws(
      () =>
        summarizeTargetExcludedComparisonReport(
          1,
          report({
            validity: {
              valid: true,
              arms,
              pair: { valid: true, mismatches: [] },
            },
          }),
        ),
      /comparison report \$\.validity\.arms\.(normal|excluded)\.analysis\.runId must be a non-empty string/,
    );
  }
});

test('summarizeTargetExcludedComparisonReport rejects a same-run pair', () => {
  assert.throws(
    () =>
      summarizeTargetExcludedComparisonReport(
        1,
        report({
          validity: {
            valid: true,
            arms: {
              normal: comparisonArm('normal', { analysis: { runId: 'same-run' } }),
              excluded: comparisonArm('excluded', { analysis: { runId: 'same-run' } }),
            },
            pair: { valid: true, mismatches: [] },
          },
        }),
      ),
    /comparison report run IDs must be different/,
  );
});

test('summarizeTargetExcludedComparisonReport rejects content tampered after hashing', () => {
  const value = report();
  const inputs = value.inputs as Record<string, unknown>;
  inputs.normalCaseId = 'tampered-normal-case';

  assert.throws(
    () => summarizeTargetExcludedComparisonReport(1, value),
    /comparison report hash does not bind its canonical content/,
  );
});

test('summarizeTargetExcludedComparisonReport rejects a run ID tampered after hashing', () => {
  const value = report();
  const validity = value.validity as Record<string, unknown>;
  const arms = validity.arms as Record<string, unknown>;
  const normal = arms.normal as Record<string, unknown>;
  const analysis = normal.analysis as Record<string, unknown>;
  analysis.runId = 'tampered-normal-run';

  assert.throws(
    () => summarizeTargetExcludedComparisonReport(1, value),
    /comparison report hash does not bind its canonical content/,
  );
});

test('runTargetExcludedComparison mounts a generated read-only script and returns its summary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'target-excluded-comparison-'));
  const normalArtifactDirectory = path.join(directory, 'normal');
  const excludedArtifactDirectory = path.join(directory, 'excluded');
  const outputPath = path.join(directory, 'output', 'comparison.json');
  await Promise.all([
    mkdir(normalArtifactDirectory),
    mkdir(excludedArtifactDirectory),
    mkdir(path.dirname(outputPath)),
  ]);
  for (const artifactDirectory of [normalArtifactDirectory, excludedArtifactDirectory]) {
    await Promise.all(
      ['case-final.json', 'analysis.json', 'analysis-runs.json'].map((name) =>
        writeFile(path.join(artifactDirectory, name), '{}\n'),
      ),
    );
  }

  let generatedScriptPath = '';
  const reportValue = report();
  try {
    const summary = await runTargetExcludedComparison(
      {
        normalArtifactDirectory,
        excludedArtifactDirectory,
        outputPath,
        imageTag: digest,
        replicate: 1,
      },
      {
        clock: () => new Date(generatedAt),
        runCommand: async (command, args) => {
          assert.equal(command, 'docker');
          const scriptMount = args.find((argument) => argument.endsWith(':/eval/run.mts:ro'));
          assert.ok(scriptMount);
          generatedScriptPath = scriptMount.slice(0, -':/eval/run.mts:ro'.length);
          assert.equal((await stat(generatedScriptPath)).mode & 0o777, 0o444);
          assert.equal(await readFile(generatedScriptPath, 'utf8'), TARGET_EXCLUDED_COMPARISON_SCRIPT);
          await writeFile(outputPath, `${JSON.stringify(reportValue)}\n`);
          return {
            command,
            args: [...args],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
          };
        },
      },
    );

    assert.deepEqual(summary, {
      replicate: 1,
      normalCaseId: 'normal-case-1',
      excludedCaseId: 'excluded-case-1',
      normalRunId: 'normal-run-1',
      excludedRunId: 'excluded-run-1',
      valid: true,
      mismatches: [],
      leakagePaths: [],
      reportHash: reportValue.hash,
    });
    await assert.rejects(stat(generatedScriptPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
