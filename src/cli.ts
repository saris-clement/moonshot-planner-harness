#!/usr/bin/env node
import path from 'node:path';
import { HarnessDatabase } from './db.js';
import { CampaignOrchestrator } from './orchestrator.js';
import { ensureHarnessPaths, harnessPaths } from './paths.js';
import { startDashboard } from './server.js';

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function usage(): never {
  process.stderr.write(`Usage:
  npm run cli -- init --config <campaign.json>
  npm run cli -- baseline <campaign-id>
  npm run cli -- diagnose <campaign-id> <variant-id>
  npm run cli -- round <campaign-id>
  npm run cli -- auto <campaign-id>
  npm run cli -- promote <campaign-id> <variant-id>
  npm run cli -- target-config <campaign-id> <baseline-variant-id> <client/workflow>
  npm run cli -- target-run <campaign-id> <variant-id>
  npm run cli -- target-finalize <campaign-id> <variant-id>
  npm run cli -- serve [--port 4173]
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0];
  if (!command) usage();
  const paths = harnessPaths();
  await ensureHarnessPaths(paths);
  const database = new HarnessDatabase(paths.database);
  const orchestrator = new CampaignOrchestrator(paths, database);

  if (command === 'init') {
    const config = option(arguments_, '--config');
    if (!config) usage();
    const campaign = await orchestrator.initialize(config);
    process.stdout.write(`${JSON.stringify(campaign, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'baseline') {
    const campaignId = arguments_[1];
    if (!campaignId) usage();
    const variant = await orchestrator.runBaseline(campaignId);
    process.stdout.write(`${JSON.stringify(variant, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'diagnose') {
    const campaignId = arguments_[1];
    const variantId = arguments_[2];
    if (!campaignId || !variantId) usage();
    const variant = await orchestrator.diagnoseVariant(campaignId, variantId);
    process.stdout.write(`${JSON.stringify(variant, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'round' || command === 'auto') {
    const campaignId = arguments_[1];
    if (!campaignId) usage();
    if (command === 'auto') await orchestrator.runAutomatic(campaignId);
    else await orchestrator.runRound(campaignId);
    process.stdout.write(`${JSON.stringify(database.getCampaign(campaignId), null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'promote') {
    const campaignId = arguments_[1];
    const variantId = arguments_[2];
    if (!campaignId || !variantId) usage();
    const variant = await orchestrator.promote(campaignId, variantId);
    process.stdout.write(`${JSON.stringify(variant, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'target-config') {
    const campaignId = arguments_[1];
    const baselineVariantId = arguments_[2];
    const targetWorkflow = arguments_[3];
    if (!campaignId || !baselineVariantId || !targetWorkflow) usage();
    const config = await orchestrator.configureTargetExcluded(
      campaignId,
      baselineVariantId,
      targetWorkflow,
    );
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'target-run') {
    const campaignId = arguments_[1];
    const variantId = arguments_[2];
    if (!campaignId || !variantId) usage();
    const evaluation = await orchestrator.runTargetExcluded(campaignId, variantId);
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'target-finalize') {
    const campaignId = arguments_[1];
    const variantId = arguments_[2];
    if (!campaignId || !variantId) usage();
    const evaluation = await orchestrator.finalizeLiveTargetExcluded(campaignId, variantId);
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    database.close();
    return;
  }

  if (command === 'serve') {
    const port = Number.parseInt(option(arguments_, '--port') ?? '4173', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) usage();
    const server = startDashboard({
      port,
      publicDirectory: path.resolve(process.cwd(), 'public'),
      database,
      orchestrator,
    });
    process.stdout.write(`Planner evaluation dashboard: http://127.0.0.1:${port}\n`);
    const close = () => server.close(() => database.close());
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
