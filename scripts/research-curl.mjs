#!/usr/bin/env node
import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';

// This is a GET/HEAD client, not the security boundary: the broker enforces the same policy.
let method = 'GET';
let follow = false;
let fail = false;
let include = false;
let output;
let url;
try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') {
      console.log('Research curl: HTTPS GET/HEAD via trusted broker. Supports -sSfLIi, -o FILE, --url URL, -X GET|HEAD. No headers, credentials, uploads, proxies or curlrc. Limits: 2 MiB/response, 15s, 5 redirects, 32 requests/invocation.');
      process.exit(0);
    } else if (arg === '-o' || arg === '--output') {
      output = args[++index];
      if (!output) throw new Error('missing output path');
    } else if (arg === '-X' || arg === '--request') {
      method = args[++index];
      if (!['GET', 'HEAD'].includes(method)) throw new Error('only GET and HEAD are permitted');
    } else if (arg === '--url') {
      if (url) throw new Error('only one URL per call');
      url = args[++index];
    } else if (arg === '--silent' || arg === '--show-error') {
      // There is no progress meter; errors are always reported.
    } else if (arg === '--fail' || arg === '--fail-with-body') fail = true;
    else if (arg === '--location') follow = true;
    else if (arg === '--head') { method = 'HEAD'; include = true; }
    else if (arg === '--include') include = true;
    else if (/^-[sSfLIi]+$/.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === 'f') fail = true;
        if (flag === 'L') follow = true;
        if (flag === 'I') { method = 'HEAD'; include = true; }
        if (flag === 'i') include = true;
      }
    } else if (arg.startsWith('-')) throw new Error(`unsupported research curl flag: ${arg}; see curl --help`);
    else {
      if (url) throw new Error('only one URL per call');
      url = arg;
    }
  }
  if (!url) throw new Error('a URL is required');
  const params = new URLSearchParams({ url, follow: follow ? '1' : '0' });
  const result = await new Promise((resolve, reject) => {
    const req = request({ socketPath: '/broker/http.sock', path: `/read?${params}`, method,
      signal: AbortSignal.timeout(20_000) }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024 + 1024) res.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  if (fail && result.status >= 400) throw new Error(`HTTP ${result.status}: research read failed or blocked`);
  const headers = include || method === 'HEAD'
    ? Buffer.from(`HTTP/1.1 ${result.status}\r\n${Object.entries(result.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
    : Buffer.alloc(0);
  const body = Buffer.concat([headers, result.body]);
  if (output && output !== '-') await writeFile(output, body);
  else process.stdout.write(body);
} catch (error) {
  console.error(`curl: ${error.message}`);
  process.exitCode = 22;
}
