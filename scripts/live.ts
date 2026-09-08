import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HarnessDatabase } from '../src/db.js';
import { CampaignOrchestrator } from '../src/orchestrator.js';
import { ensureHarnessPaths, type HarnessPaths } from '../src/paths.js';
import { CampaignConfigSchema } from '../src/types.js';
import { startDashboard } from '../src/server.js';

const usage = 'npm run test:live -- --live --source-config <campaign.json> --id <new-campaign-id>';

export async function runLive(args: string[], cwd = process.cwd()): Promise<number> {
  let options;
  try {
    options = parseArgs({ args, options: {
      live: { type: 'boolean' }, help: { type: 'boolean' },
      'source-config': { type: 'string' }, id: { type: 'string' }, port: { type: 'string' },
    } }).values;
  } catch {
    process.stdout.write(`[live] invalid arguments. Usage: ${usage}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage}\nExplicit --live is required. Creates a fresh .data/live/<id>/; never resumes or imports old scores.\n`);
    return 0;
  }
  const id = CampaignConfigSchema.shape.id.safeParse(options.id);
  if (!options.live || !options['source-config'] || !id.success) {
    process.stdout.write(`[live] not started. Usage: ${usage}\n`);
    return 2;
  }

  let root: string | null = null;
  let database: HarnessDatabase | undefined;
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  let phase = 'prepare';
  const progress = async (status: string) => {
    await appendFile(path.join(root!, 'live-phases.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), phase, status,
    })}\n`, { mode: 0o600 });
    process.stdout.write(`[live ${id.data}] ${phase}: ${status}\n`);
  };
  try {
    // An exclusive directory claim prevents duplicate runners, including after a crash.
    // Ignore HARNESS_DATA_DIR so a live test cannot touch another campaign database.
    const parent = path.resolve(cwd, '.data', 'live');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const destination = path.join(parent, id.data);
    await mkdir(destination, { mode: 0o700 });
    root = destination;
    await progress('started');
    const source = CampaignConfigSchema.parse(JSON.parse(
      await readFile(path.resolve(cwd, options['source-config']), 'utf8'),
    ));
    if (source.id === id.data) throw new Error('A new campaign ID is required.');
    if (!source.targetExcluded || source.evaluation.replicates !== 2) {
      throw new Error('Source must declare standard-primary-v2 with two replicates.');
    }
    if (source.agent.autoApprove) throw new Error('Source must preserve agent.autoApprove=false.');
    const config = CampaignConfigSchema.parse({
      ...source, id: id.data, mode: 'automatic',
      investigator: {
        enabled: true, maxTurns: 12, maxPrimaryEvaluations: 3,
        maxWallTimeMs: 7_200_000, maxAgentTokens: 2_000_000,
      },
      evaluation: { ...source.evaluation, replicates: 2, replicateConcurrency: 1 },
      limits: { ...source.limits, concurrency: 1, maxVariants: 1 },
    });
    const configPath = path.join(root, 'live-config.json');
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const paths: HarnessPaths = {
      root, database: path.join(root, 'harness.sqlite'), campaigns: path.join(root, 'campaigns'),
      worktrees: path.join(root, 'worktrees'), artifacts: path.join(root, 'artifacts'),
      reports: path.join(root, 'reports'),
    };
    await ensureHarnessPaths(paths);
    database = new HarnessDatabase(paths.database);
    const orchestrator = new CampaignOrchestrator(paths, database);
    if (options.port) {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid dashboard port');
      dashboard = startDashboard({ port, publicDirectory: path.resolve(cwd, 'public'), database, orchestrator });
      process.stdout.write(`[live ${id.data}] dashboard: http://127.0.0.1:${port}\n`);
      const close = () => { dashboard?.closeAllConnections(); dashboard?.close(() => database?.close()); };
      process.once('SIGTERM', close);
      process.once('SIGINT', close);
    }
    await progress('completed');
    phase = 'initialize';
    await progress('started');
    // initialize validates pins and freezes existing environment/packs; no old scores or cache copies.
    await orchestrator.initialize(configPath);
    await progress('completed');
    phase = 'baseline';
    await progress('started');
    const baseline = await orchestrator.runBaseline(id.data);
    const campaign = database.getCampaign(id.data);
    if (baseline.status !== 'completed' || !baseline.artifactCollectionComplete ||
        campaign.status !== 'ready' || campaign.currentParentVariantId !== baseline.id) {
      throw new Error('Baseline is not ready, including required V2 calibration. Automatic execution was not started.');
    }
    await progress('completed');
    phase = 'automatic';
    await progress('started');
    await orchestrator.runAutomatic(id.data);
    await orchestrator.refreshReports(id.data);
    const variants = database.listVariants(id.data);
    const generated = variants.filter((variant) => variant.round > 0);
    const campaignStatus = database.getCampaign(id.data).status;
    const failed = variants.some((variant) => variant.status === 'failed') || campaignStatus.endsWith('_failed');
    const completed = ['stopped_max_variants', 'stopped_no_improvement'].includes(campaignStatus) &&
      generated.length === 1 && generated[0]!.investigation?.status === 'finalized' &&
      ['completed', 'rejected'].includes(generated[0]!.status) &&
      generated[0]!.artifactCollectionComplete;
    const status = failed ? 'failed' : completed ? 'completed' : 'blocked';
    await writeFile(path.join(root, 'live-report.json'), `${JSON.stringify({
      id: id.data, phase, status, campaignStatus,
      variants: variants.map((variant) => ({
        id: variant.id, status: variant.status, artifactCollectionComplete: variant.artifactCollectionComplete,
        investigationStatus: variant.investigation?.status ?? null,
        turns: variant.investigation?.turnCount ?? null,
      })),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await progress(status);
    return failed ? 1 : completed ? 0 : 2;
  } catch (error) {
    if (root) {
      // Exceptions may contain model output, prompts, or command arguments. Never echo them.
      await writeFile(path.join(root, 'live-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error),
        { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(root, 'live-report.json'), `${JSON.stringify({ id: id.data, phase, status: 'failed' })}\n`,
        { flag: 'wx', mode: 0o600 });
      await progress('failed; inspect live-error.txt under .data/live/<id>/');
    } else {
      process.stdout.write('[live] failed to claim a fresh .data/live/<id>/; existing runs are never overwritten.\n');
    }
    return 1;
  } finally {
    if (!dashboard) database?.close();
  }
}

if (import.meta.main) {
  runLive(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('[live] runner failed; inspect .data/live/<id>/ locally.\n');
    process.exitCode = 1;
  });
}
