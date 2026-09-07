import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './process.js';
import { canonicalHash } from './metrics.js';
import type { TargetExcludedComparison } from './types.js';

const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const REQUIRED_ARTIFACTS = ['case-final.json', 'analysis.json', 'analysis-runs.json'] as const;

export const TARGET_EXCLUDED_COMPARISON_SCRIPT = String.raw`import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildEvidenceVisibilityComparisonReport } from '/app/server/src/experiments/evidenceVisibilityComparison.ts';
import { canonicalJson } from '/app/server/src/contracts/canonical.ts';

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(name + ' is required');
  return value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadArm(directory) {
  const [aggregate, analysis, runResponse] = await Promise.all([
    readJson(path.join(directory, 'case-final.json')),
    readJson(path.join(directory, 'analysis.json')),
    readJson(path.join(directory, 'analysis-runs.json')),
  ]);
  if (!runResponse || typeof runResponse !== 'object' || !Array.isArray(runResponse.runs)) {
    throw new Error('analysis-runs.json must contain a runs array');
  }
  return { aggregate, analysis, runs: runResponse.runs, phase3: [] };
}

function caseId(arm, name) {
  const value = arm?.aggregate?.case?.id;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' case-final.json does not contain case.id');
  }
  return value;
}

const normalDirectory = argument('--normal');
const excludedDirectory = argument('--excluded');
const outputPath = argument('--out');
const generatedAt = argument('--generated-at');
const replicate = Number(argument('--replicate'));
if (!Number.isSafeInteger(replicate) || replicate < 1) {
  throw new Error('--replicate must be a positive integer');
}

const [normal, excluded] = await Promise.all([
  loadArm(normalDirectory),
  loadArm(excludedDirectory),
]);
const comparison = buildEvidenceVisibilityComparisonReport({
  generatedAt,
  inputs: {
    baseUrl: 'artifact://target-excluded/replicate-' + replicate,
    normalCaseId: caseId(normal, 'normal'),
    excludedCaseId: caseId(excluded, 'excluded'),
    baselinePath: null,
  },
  normal,
  excluded,
  baseline: null,
});
await writeFile(outputPath, canonicalJson(comparison) + '\n');
`;

export interface TargetExcludedComparisonInput {
  normalArtifactDirectory: string;
  excludedArtifactDirectory: string;
  outputPath: string;
  imageTag: string;
  replicate: number;
}

export interface TargetExcludedComparisonDockerCommandInput
  extends TargetExcludedComparisonInput {
  scriptPath: string;
  generatedAt: string;
}

export interface TargetExcludedComparisonDockerCommand {
  command: 'docker';
  args: string[];
}

export interface TargetExcludedComparisonDependencies {
  clock?: () => Date;
  runCommand?: typeof runCommand;
}

function validateReplicate(replicate: number): void {
  if (!Number.isSafeInteger(replicate) || replicate < 1) {
    throw new Error('replicate must be a positive integer');
  }
}

function resolveRequiredPath(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required`);
  const resolved = path.resolve(value);
  if (resolved.includes(':')) throw new Error(`${name} cannot contain a colon`);
  return resolved;
}

export function buildTargetExcludedComparisonDockerCommand(
  input: TargetExcludedComparisonDockerCommandInput,
): TargetExcludedComparisonDockerCommand {
  validateReplicate(input.replicate);
  if (!IMAGE_REFERENCE.test(input.imageTag)) {
    throw new Error('invalid planner image tag or digest');
  }
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error('generatedAt must be a timestamp');

  const scriptPath = resolveRequiredPath(input.scriptPath, 'scriptPath');
  const normalDirectory = resolveRequiredPath(
    input.normalArtifactDirectory,
    'normalArtifactDirectory',
  );
  const excludedDirectory = resolveRequiredPath(
    input.excludedArtifactDirectory,
    'excludedArtifactDirectory',
  );
  const outputPath = resolveRequiredPath(input.outputPath, 'outputPath');

  return {
    command: 'docker',
    args: [
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
      `${scriptPath}:/eval/run.mts:ro`,
      '--volume',
      `${normalDirectory}:/eval/normal:ro`,
      '--volume',
      `${excludedDirectory}:/eval/excluded:ro`,
      '--volume',
      `${outputPath}:/eval/output.json`,
      '--entrypoint',
      'node',
      input.imageTag,
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
      String(input.replicate),
      '--generated-at',
      input.generatedAt,
    ],
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`comparison report ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function entries(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`comparison report ${name} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`comparison report ${name} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`comparison report ${name} must be a boolean`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`comparison report ${name} must be a nonnegative integer`);
  }
  return value;
}

function descriptionFields(
  value: unknown,
  name: string,
  firstField: 'code' | 'category',
): { first: string; path: string } {
  const item = record(value, name);
  const first = item[firstField];
  if (typeof first !== 'string' || typeof item.path !== 'string') {
    throw new Error(`comparison report ${name} is invalid`);
  }
  return { first, path: item.path };
}

export function summarizeTargetExcludedComparisonReport(
  replicate: number,
  value: unknown,
): TargetExcludedComparison {
  validateReplicate(replicate);
  const report = record(value, '$');
  if (
    report.kind !== 'ainative-planner/evidence-visibility-comparison' ||
    report.schemaVersion !== 1
  ) {
    throw new Error('comparison report kind or schema version is invalid');
  }
  const inputs = record(report.inputs, '$.inputs');
  const normalCaseId = nonEmptyString(inputs.normalCaseId, '$.inputs.normalCaseId');
  const excludedCaseId = nonEmptyString(inputs.excludedCaseId, '$.inputs.excludedCaseId');
  if (normalCaseId === excludedCaseId) {
    throw new Error('comparison report case IDs must be different');
  }
  const validity = record(report.validity, '$.validity');
  const valid = booleanValue(validity.valid, '$.validity.valid');
  const arms = record(validity.arms, '$.validity.arms');
  const normal = record(arms.normal, '$.validity.arms.normal');
  const excluded = record(arms.excluded, '$.validity.arms.excluded');
  const pair = record(validity.pair, '$.validity.pair');
  const normalAnalysis = record(normal.analysis, '$.validity.arms.normal.analysis');
  const excludedAnalysis = record(excluded.analysis, '$.validity.arms.excluded.analysis');
  const normalRunId = nonEmptyString(
    normalAnalysis.runId,
    '$.validity.arms.normal.analysis.runId',
  );
  const excludedRunId = nonEmptyString(
    excludedAnalysis.runId,
    '$.validity.arms.excluded.analysis.runId',
  );
  if (normalRunId === excludedRunId) {
    throw new Error('comparison report run IDs must be different');
  }
  const normalValid = booleanValue(normal.valid, '$.validity.arms.normal.valid');
  const excludedValid = booleanValue(excluded.valid, '$.validity.arms.excluded.valid');
  const pairValid = booleanValue(pair.valid, '$.validity.pair.valid');
  const normalErrors = entries(normal.errors, '$.validity.arms.normal.errors');
  const excludedErrors = entries(excluded.errors, '$.validity.arms.excluded.errors');
  const pairMismatches = entries(pair.mismatches, '$.validity.pair.mismatches');
  if (
    normalValid !== (normalErrors.length === 0) ||
    excludedValid !== (excludedErrors.length === 0) ||
    pairValid !== (pairMismatches.length === 0) ||
    valid !== (normalValid && excludedValid && pairValid)
  ) {
    throw new Error('comparison report validity is internally inconsistent');
  }

  const mismatches = [
    ...normalErrors.map((error, index) => {
      const item = descriptionFields(
        error,
        `$.validity.arms.normal.errors[${index}]`,
        'code',
      );
      return `normal ${item.first} at ${item.path}`;
    }),
    ...excludedErrors.map((error, index) => {
      const item = descriptionFields(
        error,
        `$.validity.arms.excluded.errors[${index}]`,
        'code',
      );
      return `excluded ${item.first} at ${item.path}`;
    }),
    ...pairMismatches.map((mismatch, index) => {
      const item = descriptionFields(mismatch, `$.validity.pair.mismatches[${index}]`, 'category');
      return `${item.first} mismatch at ${item.path}`;
    }),
  ];

  const leakage = record(report.leakage, '$.leakage');
  const leakageDetected = booleanValue(leakage.detected, '$.leakage.detected');
  const leakageCount = nonnegativeInteger(leakage.count, '$.leakage.count');
  const leakagePaths = entries(leakage.paths, '$.leakage.paths');
  if (leakagePaths.some((candidate) => typeof candidate !== 'string')) {
    throw new Error('comparison report $.leakage.paths must contain strings');
  }
  if (leakageDetected !== (leakagePaths.length > 0) || leakageCount !== leakagePaths.length) {
    throw new Error('comparison report leakage metadata is internally inconsistent');
  }
  if (typeof report.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(report.hash)) {
    throw new Error('comparison report hash is invalid');
  }
  const { hash, ...reportWithoutHash } = report;
  if (canonicalHash(reportWithoutHash) !== hash) {
    throw new Error('comparison report hash does not bind its canonical content');
  }

  return {
    replicate,
    normalCaseId,
    excludedCaseId,
    normalRunId,
    excludedRunId,
    valid,
    mismatches,
    leakagePaths: leakagePaths as string[],
    reportHash: hash,
  };
}

async function validateArtifactDirectory(directory: string): Promise<void> {
  const details = await stat(directory);
  if (!details.isDirectory()) throw new Error(`artifact path is not a directory: ${directory}`);
  await Promise.all(
    REQUIRED_ARTIFACTS.map(async (name) => {
      const artifact = path.join(directory, name);
      if (!(await stat(artifact)).isFile()) throw new Error(`artifact path is not a file: ${artifact}`);
    }),
  );
}

export async function runTargetExcludedComparison(
  input: TargetExcludedComparisonInput,
  dependencies: TargetExcludedComparisonDependencies = {},
): Promise<TargetExcludedComparison> {
  validateReplicate(input.replicate);
  const normalArtifactDirectory = path.resolve(input.normalArtifactDirectory);
  const excludedArtifactDirectory = path.resolve(input.excludedArtifactDirectory);
  const outputPath = path.resolve(input.outputPath);
  await Promise.all([
    validateArtifactDirectory(normalArtifactDirectory),
    validateArtifactDirectory(excludedArtifactDirectory),
    mkdir(path.dirname(outputPath), { recursive: true }),
  ]);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'planner-comparison-'));
  const scriptPath = path.join(temporaryDirectory, 'run.mts');
  try {
    await writeFile(scriptPath, TARGET_EXCLUDED_COMPARISON_SCRIPT, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o444,
    });
    const output = await open(outputPath, 'w', 0o600);
    await output.close();
    const command = buildTargetExcludedComparisonDockerCommand({
      ...input,
      normalArtifactDirectory,
      excludedArtifactDirectory,
      outputPath,
      scriptPath,
      generatedAt: (dependencies.clock ?? (() => new Date()))().toISOString(),
    });
    await (dependencies.runCommand ?? runCommand)(command.command, command.args, {
      timeoutMs: 120_000,
    });
    return summarizeTargetExcludedComparisonReport(
      input.replicate,
      JSON.parse(await readFile(outputPath, 'utf8')),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
