import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CampaignConfigSchema, type CampaignConfig } from './types.js';
import { runCommand } from './process.js';
import { resolveResearchInputPins } from './research.js';

export async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const details = await stat(directory).catch(() => null);
  if (!details?.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
}

export async function resolveGitRevision(repo: string, revision: string): Promise<string> {
  const result = await runCommand('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: repo });
  const sha = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`revision did not resolve to a commit: ${revision}`);
  return sha;
}

export async function loadCampaignConfig(filePath: string): Promise<{
  config: CampaignConfig;
  seedSha: string;
  workflowsSha: string;
  researchInputs: Awaited<ReturnType<typeof resolveResearchInputPins>>;
}> {
  const absolutePath = path.resolve(filePath);
  const input = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  return await resolveCampaignConfig(input);
}

export async function resolveCampaignConfig(input: unknown): Promise<{
  config: CampaignConfig;
  seedSha: string;
  workflowsSha: string;
  researchInputs: Awaited<ReturnType<typeof resolveResearchInputPins>>;
}> {
  const config = CampaignConfigSchema.parse(input);
  await Promise.all([
    assertDirectory(config.plannerRepo, 'plannerRepo'),
    assertDirectory(config.workflowsRepo, 'workflowsRepo'),
    assertFile(config.environmentFile, 'environmentFile'),
    ...config.benchmarks.map((benchmark) => assertFile(benchmark.zipPath, benchmark.name)),
  ]);

  const [seedSha, workflowsSha, benchmarks, researchInputs] = await Promise.all([
    resolveGitRevision(config.plannerRepo, config.seedRevision),
    resolveGitRevision(config.workflowsRepo, config.workflowsRevision),
    Promise.all(
      config.benchmarks.map(async (benchmark) => {
        const sha256 = await sha256File(benchmark.zipPath);
        if (benchmark.sha256 && benchmark.sha256 !== sha256) {
          throw new Error(`${benchmark.name} SHA mismatch: expected ${benchmark.sha256}, got ${sha256}`);
        }
        return { ...benchmark, sha256 };
      }),
    ),
    resolveResearchInputPins(config.researchPaths),
  ]);
  if (
    config.researchSha256.length > 0 &&
    researchInputs.some((material, index) => material.sha256 !== config.researchSha256[index])
  ) {
    throw new Error('configured researchSha256 does not match the research input bytes');
  }

  return {
    config: {
      ...config,
      benchmarks,
      researchSha256: researchInputs.map(({ sha256 }) => sha256),
    },
    seedSha,
    workflowsSha,
    researchInputs,
  };
}

export async function writeResolvedCampaignConfig(
  outputPath: string,
  config: CampaignConfig,
  seedSha: string,
  workflowsSha: string,
): Promise<void> {
  const output = {
    ...config,
    seedRevision: seedSha,
    workflowsRevision: workflowsSha,
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
}

export async function readEnvironmentFile(filePath: string): Promise<NodeJS.ProcessEnv> {
  const content = await readFile(filePath, 'utf8');
  const values: NodeJS.ProcessEnv = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function withPlannerAnalysisLimits(
  content: string,
  timeoutMs: number,
  maxCostUsd: number,
): string {
  const retained = content
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*PLANNER_ANALYSIS_TIMEOUT_MS\s*=/.test(line) &&
        !/^\s*PLANNER_ANALYSIS_MAX_COST_USD\s*=/.test(line),
    );
  while (retained.at(-1) === '') retained.pop();
  return `${retained.join('\n')}\nPLANNER_ANALYSIS_TIMEOUT_MS=${timeoutMs}\nPLANNER_ANALYSIS_MAX_COST_USD=${maxCostUsd}\n`;
}
