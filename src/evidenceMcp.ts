import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EVIDENCE_SERVER_NAME, evidenceHelperEnvironment, evidenceToolSchemas, loadEvidenceInvocation } from './evidenceAccess.js';

export async function startEvidenceMcp(manifestPath: string, sha256: string) {
  const access = await loadEvidenceInvocation(manifestPath, sha256);
  const server = new Server({ name: EVIDENCE_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } });
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(evidenceToolSchemas).map(([name, schema]) => ({
    name, description: name.startsWith('research_')
      ? `${name}: scoped observation research. Use an observation snapshotRef from list_observations. Shell runs only in isolated Docker; /artifacts/data.json is sanitized evidence, /candidate is read-only, and /sources contains only this arm's source. HTTP allows approved public documentation only. Output is measured, not verified truth.`
      : `${name}: bounded, read-only evidence query. Use opaque references returned by the catalog or previous queries; no filesystem paths or scope overrides. Measurements and human-reviewed labels remain distinct.`,
    inputSchema: z.toJSONSchema(schema) as { type: 'object'; [key: string]: unknown },
    annotations: { readOnlyHint: !name.startsWith('research_'), destructiveHint: false, openWorldHint: name === 'research_http' || name === 'research_shell' },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const task = access.callTool(request.params.name, request.params.arguments ?? {}, AbortSignal.any([shutdown.signal, extra.signal]));
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    shutdown.abort();
    await Promise.allSettled([...pending]);
    await server.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdin.removeListener('end', stop);
  })();
  const stop = () => { void close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdin.once('end', stop);
  server.onclose = stop;
  await server.connect(new StdioServerTransport());
  return { server, access, close };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // stdio must contain protocol messages only. Do not inherit provider keys or Node injection flags.
  const environment = evidenceHelperEnvironment();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--sha256') {
    process.stderr.write('Usage: evidenceMcp.ts --manifest <coordinator manifest> --sha256 <hash>\n');
    process.exitCode = 1;
  } else {
    startEvidenceMcp(args[1]!, args[3]!).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
