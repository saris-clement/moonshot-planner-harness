import { lookup } from 'node:dns/promises';
import { chmod, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(address, prefix, 'ipv6');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && publicV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function validateResearchHosts(hosts: readonly string[]): void {
  if (hosts.length > 64 || hosts.some((host) => host.length > 253 || host !== host.toLowerCase() ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host) ||
    isIP(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host))) {
    throw new Error('allowedHttpHosts must be exact public DNS hostnames, not URLs, IPs or wildcards');
  }
}

export function validateResearchUrl(value: string, hosts: readonly string[]): URL {
  validateResearchHosts(hosts);
  if (value.length > 8_192 || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('invalid research URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    !hosts.includes(url.hostname) || isIP(url.hostname.replace(/[\[\]]/g, ''))) {
    throw new Error('research URL must use HTTPS on an explicitly allowed public host without credentials');
  }
  let decoded = url.pathname + url.search;
  for (let count = 0; count < 4; count += 1) {
    if (/(?:^|[\/])\.(?:env|git|aws|ssh)(?:[\/.?]|$)|(?:token|secret|password|credential|api[_-]?key|signature|authorization)\s*=/i.test(decoded)) {
      throw new Error('credential URLs are not permitted');
    }
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return url;
}

export type ResearchResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const MAX_RESPONSE = 2 * 1_024 * 1_024;

// Pin the checked DNS answer into the TLS connection. Redirects go through this entire check again.
export async function fetchResearchUrl(
  value: string,
  hosts: readonly string[],
  method: 'GET' | 'HEAD',
  follow: boolean,
  resolver: ResearchResolver = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const canceled = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('research HTTP deadline exceeded')), { once: true });
  });
  try {
    let next = value;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const url = validateResearchUrl(next, hosts);
      const addresses = await Promise.race([resolver(url.hostname), canceled]);
      if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
        throw new Error('private or special-use DNS address blocked');
      }
      const pinned = addresses[0]!;
      const result = await new Promise<{ status: number; contentType: string; body: Buffer; location?: string }>((resolve, reject) => {
        const req = request(url, {
          method, agent: false, signal: controller.signal, family: pinned.family,
          headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'HarnessResearch/1' },
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
        }, (res) => {
          const status = res.statusCode ?? 502;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location) {
            res.destroy();
            resolve({ status, contentType: 'text/plain', body: Buffer.alloc(0), location });
            return;
          }
          if (Number(res.headers['content-length'] ?? 0) > MAX_RESPONSE && method !== 'HEAD') {
            res.destroy(new Error('research HTTP response exceeds 2 MiB'));
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE) res.destroy(new Error('research HTTP response exceeds 2 MiB'));
            else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => resolve({ status, contentType: res.headers['content-type'] ?? 'application/octet-stream', body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
      if (!result.location) return result;
      next = validateResearchUrl(new URL(result.location, url).href, hosts).href;
      if (!follow) return { status: result.status, contentType: 'text/plain', body: Buffer.alloc(0) };
    }
    throw new Error('research HTTP redirect limit exceeded');
  } finally { clearTimeout(timeout); }
}

export function createResearchBroker(hosts: readonly string[], resolver?: ResearchResolver): Server {
  validateResearchHosts(hosts);
  let requests = 0;
  let active = 0;
  let remainingBytes = 8 * 1_024 * 1_024;
  const server = createServer({ maxHeaderSize: 12_288, requestTimeout: 20_000, headersTimeout: 5_000 }, async (req, res) => {
    const fail = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
      res.end(message);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'only GET and HEAD are permitted');
    if (Object.keys(req.headers).some((name) => !['host', 'connection', 'accept', 'user-agent'].includes(name))) {
      return fail(403, 'custom headers, credentials and request bodies are not permitted');
    }
    let route: URL;
    try { route = new URL(req.url ?? '/', 'http://broker'); }
    catch { return fail(400, 'invalid research broker route'); }
    if (route.pathname !== '/read' || [...route.searchParams.keys()].some((key) => !['url', 'follow'].includes(key)) ||
      route.searchParams.getAll('url').length !== 1 || route.searchParams.getAll('follow').length > 1) {
      return fail(404, 'only the read route is available');
    }
    if (++requests > 32 || active >= 4 || remainingBytes <= 0) return fail(429, 'research HTTP budget exhausted');
    active += 1;
    try {
      const result = await fetchResearchUrl(route.searchParams.get('url')!, hosts, req.method,
        route.searchParams.get('follow') === '1', resolver);
      remainingBytes -= result.body.length;
      if (remainingBytes < 0) return fail(429, 'research HTTP byte budget exhausted');
      res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length, connection: 'close' });
      res.end(result.body);
    } catch {
      // Do not echo URLs, upstream response headers, or connection diagnostics back into evidence.
      fail(403, 'research HTTP request blocked or failed (host, DNS, redirect, deadline or response limit)');
    } finally { active -= 1; }
  });
  server.maxConnections = 8;
  server.timeout = 20_000;
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = JSON.parse(await readFile('/policy/hosts.json', 'utf8')) as { allowedHttpHosts: string[] };
  const server = createResearchBroker(config.allowedHttpHosts);
  server.listen('/broker/http.sock', () => { void chmod('/broker/http.sock', 0o666); });
}
