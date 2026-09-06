import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { HarnessDatabase } from './db.js';
import type { CampaignOrchestrator } from './orchestrator.js';
import { DecisionSchema } from './types.js';
import { campaignReportDirectory, variantArtifactDirectory } from './paths.js';
import { parseSourceLineRanges, readFrozenSourceFile, renderSourceViewer } from './sourceViewer.js';

const LabelInputSchema = z.object({
  benchmark: z.string().min(1),
  unitKey: z.string().min(1),
  expectedDecision: DecisionSchema,
  classification: z.enum(['system_error', 'real_gap', 'uncertain']),
  rationale: z.string().min(1).max(4_000),
});

const TargetExcludedConfigInputSchema = z.object({
  baselineVariantId: z.string().min(1).max(256),
  targetImplementationWorkflow: z
    .string()
    .min(3)
    .max(512)
    .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/),
});

const TargetExcludedLabelInputSchema = LabelInputSchema.omit({ benchmark: true });

const TargetExcludedAnswerInputSchema = z.object({
  answer: z.string().min(1).max(20_000),
  selectedOptionId: z.string().min(1).max(256).optional(),
});

const REQUIREMENTS_ZIP_MAX_BYTES = 512 * 1_024 * 1_024;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, status: number, body: string, headOnly = false): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(headOnly ? undefined : body);
}

function requireSameOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const expected = `http://${request.headers.host ?? '127.0.0.1'}`;
  if (origin && origin !== expected) throw new Error('cross-origin mutation rejected');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new Error('cross-site mutation rejected');
}

function requireSameOriginJson(request: IncomingMessage): void {
  requireSameOrigin(request);
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new Error('mutations require application/json');
  }
}

async function stageRequirementsZip(
  request: IncomingMessage,
  uploadsDirectory: string,
): Promise<{ path: string; sha256: string; size: number; name: string }> {
  requireSameOrigin(request);
  if (request.headers['content-type']?.toLowerCase() !== 'application/zip') {
    throw new Error('requirements uploads require application/zip');
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > REQUIREMENTS_ZIP_MAX_BYTES) {
    throw new Error('requirements ZIP exceeds 512 MiB');
  }
  await mkdir(uploadsDirectory, { recursive: true });
  const filePath = path.join(uploadsDirectory, `${randomUUID()}.zip`);
  const digest = createHash('sha256');
  let size = 0;
  let prefix = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > REQUIREMENTS_ZIP_MAX_BYTES) {
        callback(new Error('requirements ZIP exceeds 512 MiB'));
        return;
      }
      if (prefix.byteLength < 4) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.byteLength)]);
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(request, meter, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
    const zipSignature = prefix.toString('hex');
    if (!['504b0304', '504b0506', '504b0708'].includes(zipSignature)) {
      throw new Error('uploaded file is not a ZIP archive');
    }
    const encodedName = request.headers['x-file-name'];
    const name = decodeURIComponent(Array.isArray(encodedName) ? encodedName[0] ?? '' : encodedName ?? 'requirements.zip');
    return { path: filePath, sha256: `sha256:${digest.digest('hex')}`, size, name };
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 1_048_576) throw new Error('request body exceeds 1 MiB');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function background(
  database: HarnessDatabase,
  campaignId: string,
  action: () => Promise<unknown>,
): void {
  action().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    database.addEvent(campaignId, null, 'operation.failed', { error: message });
  });
}

async function serveStatic(
  requestPath: string,
  publicDirectory: string,
  response: ServerResponse,
  headOnly = false,
): Promise<boolean> {
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = path.resolve(publicDirectory, relative);
  if (!filePath.startsWith(`${path.resolve(publicDirectory)}${path.sep}`)) return false;
  const details = await stat(filePath).catch(() => null);
  if (!details?.isFile()) return false;
  const extension = path.extname(filePath);
  const contentType =
    extension === '.html'
      ? 'text/html; charset=utf-8'
      : extension === '.css'
        ? 'text/css; charset=utf-8'
        : extension === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
  if (headOnly) response.end();
  else createReadStream(filePath).pipe(response);
  return true;
}

function isUiRoute(requestPath: string): boolean {
  return (
    requestPath === '/' ||
    requestPath === '/campaigns/new' ||
    /^\/campaigns\/[^/]+\/(?:overview|experiments|lineage)$/.test(requestPath) ||
    /^\/campaigns\/[^/]+\/experiments\/[^/]+$/.test(requestPath) ||
    /^\/campaigns\/[^/]+\/review\/[^/]+$/.test(requestPath)
  );
}

function acceptsHtml(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}

async function listFiles(root: string, relative = ''): Promise<Array<{ path: string; size: number }>> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: Array<{ path: string; size: number }> = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push({ path: child, size: (await stat(path.join(root, child))).size });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function streamLocalFile(
  root: string,
  relative: string,
  response: ServerResponse,
): Promise<void> {
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('unsafe artifact path');
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error('artifact is not a file');
  const text = ['.json', '.jsonl', '.log', '.txt', '.md', '.patch', '.env'].includes(
    path.extname(filePath),
  );
  response.writeHead(200, {
    'Content-Type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Length': details.size,
    'Content-Disposition': `${text ? 'inline' : 'attachment'}; filename="${path.basename(filePath).replaceAll('"', '')}"`,
  });
  createReadStream(filePath).pipe(response);
}

export function startDashboard(input: {
  port: number;
  host?: string;
  publicDirectory: string;
  database: HarnessDatabase;
  orchestrator: CampaignOrchestrator;
}) {
  const server = createServer(async (request, response) => {
    try {
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        segments[0] === 'campaigns' &&
        segments[1] &&
        segments[2] === 'source' &&
        segments.length === 3
      ) {
        const campaign = input.database.getCampaign(segments[1]);
        const relativePath = url.searchParams.get('path');
        if (!relativePath) throw new Error('source path is required');
        const ranges = parseSourceLineRanges(url.searchParams.get('lines'));
        const targetExcluded = url.searchParams.get('scope') === 'target-excluded';
        const sourceRoot = path.join(
          input.orchestrator.paths.worktrees,
          campaign.id,
          targetExcluded ? 'target-excluded-workflows' : 'frozen-workflows',
        );
        const source = await readFrozenSourceFile(sourceRoot, relativePath);
        sendHtml(
          response,
          200,
          renderSourceViewer({
            campaignId: campaign.id,
            workflowsSha: campaign.workflowsSha,
            relativePath,
            source,
            ranges,
            sourceLabel: targetExcluded
              ? 'Target-excluded workflows source'
              : 'Frozen workflows source',
          }),
          request.method === 'HEAD',
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/uploads/requirements-pack') {
        const upload = await stageRequirementsZip(
          request,
          path.join(input.orchestrator.paths.root, 'uploads'),
        );
        sendJson(response, 201, upload);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/defaults') {
        const plannerRepo = path.resolve(process.cwd(), '../ainative-planner');
        sendJson(response, 200, {
          plannerRepo,
          workflowsRepo: path.resolve(process.cwd(), '../workflows'),
          environmentFile: path.join(plannerRepo, '.env'),
          seedRevision: 'a0dac3ec7b416b27dd3b4260717cdfea7dd8232a',
          workflowsRevision: 'HEAD',
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/campaigns') {
        requireSameOriginJson(request);
        const campaignInput = await readJson(request);
        const campaign = await input.orchestrator.initializeFromInput(campaignInput);
        if (typeof campaignInput === 'object' && campaignInput !== null && 'benchmarks' in campaignInput) {
          const benchmarks = (campaignInput as { benchmarks?: unknown }).benchmarks;
          if (Array.isArray(benchmarks)) {
            const uploadsRoot = path.resolve(input.orchestrator.paths.root, 'uploads');
            await Promise.all(
              benchmarks.map(async (benchmark) => {
                if (!benchmark || typeof benchmark !== 'object' || !('zipPath' in benchmark)) return;
                const zipPath = (benchmark as { zipPath?: unknown }).zipPath;
                if (
                  typeof zipPath === 'string' &&
                  path.resolve(zipPath).startsWith(`${uploadsRoot}${path.sep}`)
                ) {
                  await rm(zipPath, { force: true });
                }
              }),
            );
          }
        }
        sendJson(response, 201, campaign);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/campaigns') {
        sendJson(
          response,
          200,
          input.database.listCampaigns().map((campaign) => ({
            ...campaign,
            variants: input.database.listVariants(campaign.id),
            targetExcludedConfig: input.database.getTargetExcludedConfig(campaign.id),
            targetExcludedEvaluations: input.database.listTargetExcludedEvaluations(campaign.id),
          })),
        );
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'campaigns' && segments[2]) {
        const campaignId = segments[2];
        input.database.getCampaign(campaignId);
        if (request.method === 'GET' && segments.length === 3) {
          const events = input.database.listEvents(campaignId);
          const eventCursor = events.at(-1)?.id ?? 0;
          const variants = input.database.listVariants(campaignId);
          sendJson(response, 200, {
            campaign: input.database.getCampaign(campaignId),
            variants,
            labels: input.database.listLabels(campaignId),
            targetExcludedConfig: input.database.getTargetExcludedConfig(campaignId),
            targetExcludedEvaluations: input.database.listTargetExcludedEvaluations(campaignId),
            targetExcludedLabels: input.database.listTargetExcludedLabels(campaignId),
            eventCursor,
          });
          return;
        }
        if (request.method === 'GET' && segments[3] === 'variants' && segments[4]) {
          const variant = input.database.getVariant(segments[4]);
          if (variant.campaignId !== campaignId) throw new Error('variant belongs to another campaign');
          const artifactRoot = variantArtifactDirectory(
            input.orchestrator.paths,
            campaignId,
            variant.id,
          );
          if (segments[5] === 'artifacts' && !url.searchParams.has('path')) {
            sendJson(response, 200, {
              files: await listFiles(artifactRoot),
              reportUrl: `/api/campaigns/${encodeURIComponent(campaignId)}/variants/${encodeURIComponent(variant.id)}/report`,
            });
            return;
          }
          if (segments[5] === 'artifacts' && url.searchParams.has('path')) {
            await streamLocalFile(artifactRoot, url.searchParams.get('path') ?? '', response);
            return;
          }
          if (segments[5] === 'report') {
            const reportRoot = campaignReportDirectory(input.orchestrator.paths, campaignId);
            await streamLocalFile(
              reportRoot,
              `${String(variant.ordinal).padStart(3, '0')}-${variant.id}.md`,
              response,
            );
            return;
          }
        }
        if (request.method === 'GET' && segments[3] === 'events') {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const explicitCursor = request.headers['last-event-id'] ?? url.searchParams.get('after');
          const existing = input.database.listEvents(campaignId);
          let after = explicitCursor
            ? Number.parseInt(Array.isArray(explicitCursor) ? explicitCursor[0] ?? '0' : explicitCursor, 10) || 0
            : existing.at(-1)?.id ?? 0;
          const flush = () => {
            for (const event of input.database.listEvents(campaignId, after)) {
              after = event.id;
              response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            }
          };
          flush();
          const timer = setInterval(flush, 1_000);
          const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
          request.once('close', () => {
            clearInterval(timer);
            clearInterval(heartbeat);
          });
          return;
        }
        if (request.method === 'POST' && segments[3] === 'baseline') {
          requireSameOriginJson(request);
          if (input.orchestrator.isActive(campaignId)) {
            sendJson(response, 409, { error: 'CampaignAlreadyActive' });
            return;
          }
          background(input.database, campaignId, () => input.orchestrator.runBaseline(campaignId));
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (request.method === 'POST' && segments[3] === 'target-excluded' && segments.length === 4) {
          requireSameOriginJson(request);
          if (input.orchestrator.isActive(campaignId)) {
            sendJson(response, 409, { error: 'CampaignAlreadyActive' });
            return;
          }
          const target = TargetExcludedConfigInputSchema.parse(await readJson(request));
          const config = await input.orchestrator.configureTargetExcluded(
            campaignId,
            target.baselineVariantId,
            target.targetImplementationWorkflow,
          );
          sendJson(response, 201, config);
          return;
        }
        if (
          request.method === 'POST' &&
          segments[3] === 'variants' &&
          segments[4] &&
          segments[5] === 'diagnose' &&
          segments.length === 6
        ) {
          requireSameOriginJson(request);
          if (input.orchestrator.isActive(campaignId)) {
            sendJson(response, 409, { error: 'CampaignAlreadyActive' });
            return;
          }
          const variantId = segments[4];
          background(input.database, campaignId, () =>
            input.orchestrator.diagnoseVariant(campaignId, variantId),
          );
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (
          request.method === 'POST' &&
          segments[3] === 'variants' &&
          segments[4] &&
          segments[5] === 'target-excluded' &&
          segments.length === 6
        ) {
          requireSameOriginJson(request);
          if (input.orchestrator.isActive(campaignId)) {
            sendJson(response, 409, { error: 'CampaignAlreadyActive' });
            return;
          }
          const variantId = segments[4];
          background(input.database, campaignId, () =>
            input.orchestrator.runTargetExcluded(campaignId, variantId),
          );
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (
          request.method === 'PUT' &&
          segments[3] === 'variants' &&
          segments[4] &&
          segments[5] === 'target-excluded' &&
          segments[6] === 'questions' &&
          segments[7] &&
          segments[8] === 'answer'
        ) {
          requireSameOriginJson(request);
          const answer = TargetExcludedAnswerInputSchema.parse(await readJson(request));
          input.orchestrator.answerTargetExcludedQuestion(
            campaignId,
            segments[4],
            segments[7],
            answer.answer,
            answer.selectedOptionId,
          );
          sendJson(response, 200, { saved: true });
          return;
        }
        if (
          request.method === 'PUT' &&
          segments[3] === 'target-excluded' &&
          segments[4] === 'label'
        ) {
          requireSameOriginJson(request);
          const label = TargetExcludedLabelInputSchema.parse(await readJson(request));
          await input.orchestrator.saveTargetExcludedVerifiedLabel({ campaignId, ...label });
          sendJson(response, 200, { saved: true });
          return;
        }
        if (request.method === 'POST' && segments[3] === 'round') {
          requireSameOriginJson(request);
          if (input.orchestrator.isActive(campaignId)) {
            sendJson(response, 409, { error: 'CampaignAlreadyActive' });
            return;
          }
          const campaign = input.database.getCampaign(campaignId);
          background(input.database, campaignId, () =>
            campaign.config.mode === 'automatic'
              ? input.orchestrator.runAutomatic(campaignId)
              : input.orchestrator.runRound(campaignId),
          );
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (request.method === 'POST' && segments[3] === 'promote' && segments[4]) {
          requireSameOriginJson(request);
          if (input.orchestrator.isActive(campaignId)) {
            sendJson(response, 409, { error: 'CampaignAlreadyActive' });
            return;
          }
          background(input.database, campaignId, () =>
            input.orchestrator.promote(campaignId, segments[4]!),
          );
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (request.method === 'POST' && segments[3] === 'stop') {
          requireSameOriginJson(request);
          sendJson(response, 200, input.orchestrator.stop(campaignId));
          return;
        }
        if (request.method === 'POST' && segments[3] === 'resume') {
          requireSameOriginJson(request);
          sendJson(response, 200, input.orchestrator.resume(campaignId));
          return;
        }
        if (request.method === 'PUT' && segments[3] === 'label') {
          requireSameOriginJson(request);
          const label = LabelInputSchema.parse(await readJson(request));
          await input.orchestrator.saveVerifiedLabel({ campaignId, ...label });
          sendJson(response, 200, { saved: true });
          return;
        }
      }

      const readsUi = request.method === 'GET' || request.method === 'HEAD';
      if (
        readsUi &&
        (await serveStatic(
          url.pathname,
          input.publicDirectory,
          response,
          request.method === 'HEAD',
        ))
      ) {
        return;
      }
      if (
        readsUi &&
        acceptsHtml(request) &&
        isUiRoute(url.pathname) &&
        (await serveStatic('/', input.publicDirectory, response, request.method === 'HEAD'))
      ) {
        return;
      }
      sendJson(response, 404, { error: 'NotFound' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  server.listen(input.port, input.host ?? '127.0.0.1');
  return server;
}
