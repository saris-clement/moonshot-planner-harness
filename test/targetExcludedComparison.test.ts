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

const digest = `planner-eval@sha256:${'a'.repeat(64)}`;
const generatedAt = '2026-09-06T12:00:00.000Z';

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ainative-planner/evidence-visibility-comparison',
    schemaVersion: 1,
    validity: {
      valid: true,
      arms: {
        normal: { valid: true, errors: [] },
        excluded: { valid: true, errors: [] },
      },
      pair: { valid: true, mismatches: [] },
    },
    leakage: { detected: false, count: 0, paths: [] },
    hash: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
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
  assert.deepEqual(command.args.slice(0, 11), [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
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
  assert.match(TARGET_EXCLUDED_COMPARISON_SCRIPT, /canonicalJson\(comparison\)/);
});

test('summarizeTargetExcludedComparisonReport describes arm and pair mismatches', () => {
  const summary = summarizeTargetExcludedComparisonReport(
    2,
    report({
      validity: {
        valid: false,
        arms: {
          normal: {
            valid: false,
            errors: [{ code: 'CURRENT_ANALYSIS_INCOMPLETE', path: '$.analysis' }],
          },
          excluded: {
            valid: false,
            errors: [{ code: 'CASE_ID_MISMATCH', path: '$.case.id' }],
          },
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
    }),
  );

  assert.deepEqual(summary, {
    replicate: 2,
    valid: false,
    mismatches: [
      'normal CURRENT_ANALYSIS_INCOMPLETE at $.analysis',
      'excluded CASE_ID_MISMATCH at $.case.id',
      'renderer mismatch at $.rendererVersion',
    ],
    leakagePaths: ['$.analysis.analysis.adjudications[0].sourceRefs[0].path'],
    reportHash: `sha256:${'b'.repeat(64)}`,
  });
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
          await writeFile(outputPath, `${JSON.stringify(report())}\n`);
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
      valid: true,
      mismatches: [],
      leakagePaths: [],
      reportHash: `sha256:${'b'.repeat(64)}`,
    });
    await assert.rejects(stat(generatedScriptPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
