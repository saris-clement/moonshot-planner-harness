import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResearchScope } from './researchSandbox.js';

const OMIT = /^(?:\.git(?:config|-credentials)?|\.env.*|\.aws|\.ssh|\.docker|\.config|\.npmrc|\.netrc|\.data|node_modules|dist|coverage|logs?|raw|(?:secrets?|credentials?)(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|service[-_]account(?:\..*)?)(?:$)|(?:\.log(?:\..*)?|\.pem|\.key|\.p12|\.pfx|\.sqlite(?:3)?|\.db|\.zip|\.gz|\.tar|\.tgz|\.bin)$/i;

export function redactResearchText(text: string): string {
  return text
    .replace(/-----BEGIN [^-\r\n]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]{0,64}PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9+/_.=-]+/gi, '$1[REDACTED]')
    .replace(/(["']?\b[\w.-]{0,64}(?:api[_-]?key|token|secret|password|credential|authorization|cookie)[\w.-]{0,64}["']?\s{0,64}[:=]\s{0,64})("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/gi, '$1"[REDACTED]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export async function canonicalResearchScope(scope: ResearchScope): Promise<ResearchScope> {
  if (!Array.isArray(scope.sourceRoots) || scope.sourceRoots.length > 16 || scope.sourceRoots.some((root) =>
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(root.name)) ||
    new Set(scope.sourceRoots.map((root) => root.name)).size !== scope.sourceRoots.length) {
    throw new Error('sourceRoots require unique simple names');
  }
  const canonical = async (value: string) => {
    if (!path.isAbsolute(value) || /[\x00-\x1f,]/.test(value)) throw new Error('research scope requires absolute safe paths');
    const resolved = await realpath(value);
    if (/[\x00-\x1f,]/.test(resolved)) throw new Error('research scope resolved to an unsafe Docker mount path');
    if (!(await lstat(resolved)).isDirectory()) throw new Error('research scope path must be a directory');
    return resolved;
  };
  const worktreePath = await canonical(scope.worktreePath);
  const artifactDirectory = await canonical(scope.artifactDirectory);
  const scratchDirectory = await canonical(scope.scratchDirectory);
  const sourceRoots = await Promise.all(scope.sourceRoots.map(async (root) => ({ name: root.name, path: await canonical(root.path) })));
  if (!scratchDirectory.split(path.sep).includes('.data')) throw new Error('research scratchDirectory must be under ignored .data');
  const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
  for (const input of [worktreePath, artifactDirectory, ...sourceRoots.map((root) => root.path)]) {
    if (inside(input, scratchDirectory) || inside(scratchDirectory, input)) throw new Error('research input and scratch directories must not overlap');
  }
  return { ...scope, worktreePath, artifactDirectory, scratchDirectory, sourceRoots };
}

// The coordinator must freeze inputs while publishing. This is defense in depth, not a secret classifier:
// artifactDirectory must already be a curated evidence bundle, never a raw campaign directory.
export async function publishResearchSnapshot(scope: ResearchScope, destination: string): Promise<{
  sha256: string; files: number; bytes: number; omittedFiles: number;
}> {
  const canonical = await canonicalResearchScope(scope);
  const digest = createHash('sha256');
  let files = 0;
  let bytes = 0;
  let omittedFiles = 0;
  let entries = 0;
  const copy = async (source: string, target: string, relative: string, depth: number) => {
    if (depth > 32) throw new Error('research snapshot directory depth limit exceeded');
    await mkdir(target, { recursive: true, mode: 0o755 });
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 50_000) throw new Error('research snapshot file count limit exceeded');
      if (OMIT.test(entry.name) || /[\x00-\x1f]/.test(entry.name) || entry.isSymbolicLink()) { omittedFiles += 1; continue; }
      const input = path.join(source, entry.name);
      const output = path.join(target, entry.name);
      const name = `${relative}/${entry.name}`;
      if (await realpath(input) !== input) throw new Error('research snapshot input changed or contains a symlink');
      if (entry.isDirectory()) { await copy(input, output, name, depth + 1); continue; }
      if (!entry.isFile()) { omittedFiles += 1; continue; }
      const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const details = await handle.stat();
        if (!details.isFile() || details.nlink !== 1 || details.size > 2 * 1_024 * 1_024) { omittedFiles += 1; continue; }
        // Bound the read even if a concurrent native edit grows a file after stat.
        const buffer = Buffer.alloc(details.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== details.size || (await lstat(input)).ino !== details.ino || await realpath(input) !== input) {
          throw new Error('research snapshot input changed during publication');
        }
        const content = buffer.subarray(0, bytesRead);
        if (content.includes(0) || content.toString('utf8').includes('\ufffd')) { omittedFiles += 1; continue; }
        let text = content.toString('utf8');
        if (name.startsWith('artifacts/') && /\.json$/i.test(entry.name)) {
          try {
            text = JSON.stringify(JSON.parse(text, (key: string, value: unknown) => {
              // Credential fields are distinct from measured counts such as inputTokens and tokenCount.
              if (/api[_-]?key|secret|password|credential|authorization|cookie|token$|(?:access|refresh|auth)[_-]?tokens$|^tokens$/i.test(key)) {
                return '[REDACTED]';
              }
              return typeof value === 'string' ? redactResearchText(value) : value;
            }));
          } catch { throw new Error(`research artifact must contain valid JSON: ${name}`); }
        } else text = redactResearchText(text);
        const safe = Buffer.from(text);
        bytes += safe.length;
        if (bytes > 128 * 1_024 * 1_024) throw new Error('research snapshot exceeds 128 MiB');
        await writeFile(output, safe, { flag: 'wx', mode: 0o444 });
        digest.update(`${name}\0${safe.length}\0`).update(safe);
        files += 1;
      } finally { await handle.close(); }
    }
  };
  for (const root of [
    { name: 'candidate', path: canonical.worktreePath },
    { name: 'artifacts', path: canonical.artifactDirectory },
    ...canonical.sourceRoots.map((root) => ({ name: `sources/${root.name}`, path: root.path })),
  ]) await copy(root.path, path.join(destination, root.name), root.name, 0);
  await mkdir(path.join(destination, 'sources'), { recursive: true, mode: 0o755 });
  return { sha256: `sha256:${digest.digest('hex')}`, files, bytes, omittedFiles };
}
