import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface HarnessPaths {
  root: string;
  database: string;
  campaigns: string;
  worktrees: string;
  artifacts: string;
  reports: string;
}

export function harnessPaths(cwd = process.cwd()): HarnessPaths {
  const root = path.resolve(process.env.HARNESS_DATA_DIR ?? path.join(cwd, '.data'));
  return {
    root,
    database: path.join(root, 'harness.sqlite'),
    campaigns: path.join(root, 'campaigns'),
    worktrees: path.join(root, 'worktrees'),
    artifacts: path.join(root, 'artifacts'),
    reports: path.resolve(cwd, 'docs/experiments'),
  };
}

export async function ensureHarnessPaths(paths: HarnessPaths): Promise<void> {
  await Promise.all(
    [paths.root, paths.campaigns, paths.worktrees, paths.artifacts, paths.reports].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
}

export function campaignDirectory(paths: HarnessPaths, campaignId: string): string {
  return path.join(paths.campaigns, campaignId);
}

export function variantArtifactDirectory(
  paths: HarnessPaths,
  campaignId: string,
  variantId: string,
): string {
  return path.join(paths.artifacts, campaignId, variantId);
}

export function variantWorktreePath(
  paths: HarnessPaths,
  campaignId: string,
  variantId: string,
): string {
  return path.join(paths.worktrees, campaignId, variantId);
}

export function campaignReportDirectory(paths: HarnessPaths, campaignId: string): string {
  return path.join(paths.reports, campaignId);
}
