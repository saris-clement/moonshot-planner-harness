import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

export interface TargetExcludedSourceManifestEntry {
  path: string;
  sha256: string;
}

export type TargetExcludedSourceExclusionReason =
  | 'git-metadata'
  | 'target-root'
  | 'bundle-catalog'
  | 'target-identity';

export interface TargetExcludedSourceExclusion {
  path: string;
  reason: TargetExcludedSourceExclusionReason;
}

export interface TargetExcludedSourceManifest {
  included: TargetExcludedSourceManifestEntry[];
  excluded: TargetExcludedSourceExclusion[];
}

export interface TargetExcludedSourceSnapshotOptions {
  sourceRoot: string;
  snapshotRoot: string;
  targetWorkflow: string;
}

interface IncludedFile extends TargetExcludedSourceManifestEntry {
  absolutePath: string;
  mode: number;
}

interface ScanResult {
  directories: string[];
  included: IncludedFile[];
  excluded: TargetExcludedSourceExclusion[];
}

const workflowPattern = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function comparePaths(left: { path: string }, right: { path: string }): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function validateTargetWorkflow(targetWorkflow: string): void {
  if (!workflowPattern.test(targetWorkflow)) {
    throw new Error(`unsafe target workflow: ${JSON.stringify(targetWorkflow)}`);
  }
}

function canonicalTargetRoot(targetWorkflow: string): string {
  return `src/customers/${targetWorkflow}/`;
}

function containsTargetIdentity(value: string, targetWorkflow: string): boolean {
  if (value.includes(canonicalTargetRoot(targetWorkflow))) return true;
  let offset = value.indexOf(targetWorkflow);
  while (offset >= 0) {
    const before = offset === 0 ? '' : value[offset - 1] ?? '';
    const after = value[offset + targetWorkflow.length] ?? '';
    if (!/[a-z0-9._\/-]/i.test(before) && !/[a-z0-9._\/-]/i.test(after)) return true;
    offset = value.indexOf(targetWorkflow, offset + 1);
  }
  return false;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function displayPath(relativePath: string, directory: boolean): string {
  return directory ? `${relativePath}/` : relativePath;
}

function explicitExclusion(
  relativePath: string,
  targetRoot: string,
): TargetExcludedSourceExclusionReason | null {
  if (relativePath.split('/').includes('.git')) return 'git-metadata';
  if (`${relativePath}/` === targetRoot) return 'target-root';
  if (relativePath === '.harness/bundle-catalog.json') return 'bundle-catalog';
  return null;
}

function textualContent(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeEntryName(name: string): void {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`unsafe source path entry: ${JSON.stringify(name)}`);
  }
}

async function readRegularFile(filePath: string, relativePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ELOOP')) throw new Error(`source symlink is not allowed: ${relativePath}`);
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`source entry is not a regular file: ${relativePath}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinks(directory: string, relativeDirectory: string): Promise<void> {
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    safeEntryName(name);
    const absolutePath = path.join(directory, name);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) throw new Error(`source symlink is not allowed: ${relativePath}`);
    if (details.isDirectory()) await assertNoSymlinks(absolutePath, relativePath);
  }
}

async function scanSource(sourceRoot: string, targetWorkflow: string): Promise<ScanResult> {
  const targetRoot = canonicalTargetRoot(targetWorkflow);
  const result: ScanResult = { directories: [], included: [], excluded: [] };

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      safeEntryName(name);
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) throw new Error(`source symlink is not allowed: ${relativePath}`);

      const exclusion = explicitExclusion(relativePath, targetRoot);
      if (exclusion) {
        if (details.isDirectory()) await assertNoSymlinks(absolutePath, relativePath);
        result.excluded.push({ path: displayPath(relativePath, details.isDirectory()), reason: exclusion });
        continue;
      }

      if (details.isDirectory()) {
        result.directories.push(relativePath);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!details.isFile()) throw new Error(`unsupported source entry: ${relativePath}`);

      const bytes = await readRegularFile(absolutePath, relativePath);
      const text = textualContent(bytes);
      if (text !== null && containsTargetIdentity(text, targetWorkflow)) {
        result.excluded.push({ path: relativePath, reason: 'target-identity' });
        continue;
      }
      result.included.push({
        absolutePath,
        mode: details.mode,
        path: relativePath,
        sha256: digest(bytes),
      });
    }
  };

  await visit(sourceRoot, '');
  result.directories.sort();
  result.included.sort(comparePaths);
  result.excluded.sort(comparePaths);
  return result;
}

async function prospectiveRealPath(absolutePath: string): Promise<string> {
  const missing: string[] = [];
  let existing = absolutePath;
  while (true) {
    try {
      const details = await lstat(existing);
      if (details.isSymbolicLink()) throw new Error(`snapshot path traverses a symlink: ${existing}`);
      return path.join(await realpath(existing), ...missing);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export async function createTargetExcludedSourceSnapshot(
  options: TargetExcludedSourceSnapshotOptions,
): Promise<TargetExcludedSourceManifest> {
  validateTargetWorkflow(options.targetWorkflow);
  const sourcePath = path.resolve(options.sourceRoot);
  const snapshotPath = path.resolve(options.snapshotRoot);
  const sourceDetails = await lstat(sourcePath);
  if (sourceDetails.isSymbolicLink()) throw new Error(`source root symlink is not allowed: ${sourcePath}`);
  if (!sourceDetails.isDirectory()) throw new Error(`source root is not a directory: ${sourcePath}`);

  const sourceRoot = await realpath(sourcePath);
  const snapshotRoot = await prospectiveRealPath(snapshotPath);
  if (isWithin(sourceRoot, snapshotRoot) || isWithin(snapshotRoot, sourceRoot)) {
    throw new Error('source root and snapshot root must not overlap');
  }
  try {
    await lstat(snapshotRoot);
    throw new Error(`snapshot root already exists: ${snapshotRoot}`);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }

  const scanned = await scanSource(sourceRoot, options.targetWorkflow);
  const snapshotParent = path.dirname(snapshotRoot);
  await mkdir(snapshotParent, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(snapshotParent, '.target-excluded-source-'));
  try {
    for (const relativePath of scanned.directories) {
      await mkdir(path.join(stagingRoot, ...relativePath.split('/')), { recursive: true });
    }
    for (const file of scanned.included) {
      const bytes = await readRegularFile(file.absolutePath, file.path);
      if (digest(bytes) !== file.sha256) throw new Error(`source changed while creating snapshot: ${file.path}`);
      const destination = path.join(stagingRoot, ...file.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
       const mode = file.mode & 0o111 ? 0o555 : 0o444;
       await writeFile(destination, bytes, { mode });
       await chmod(destination, mode);
     }
     await rename(stagingRoot, snapshotRoot);
   } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    included: scanned.included.map(({ path: relativePath, sha256 }) => ({
      path: relativePath,
      sha256,
    })),
    excluded: scanned.excluded,
  };
}

export function containsTargetIdentityLeak(evidence: unknown, targetWorkflow: string): boolean {
  validateTargetWorkflow(targetWorkflow);
  const pending: unknown[] = [evidence];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (containsTargetIdentity(value, targetWorkflow)) return true;
    } else if (typeof value === 'object' && value !== null && !visited.has(value)) {
      visited.add(value);
      if (Array.isArray(value)) {
        pending.push(...value);
      } else {
        for (const [key, child] of Object.entries(value)) {
          if (containsTargetIdentity(key, targetWorkflow)) return true;
          pending.push(child);
        }
      }
    }
  }
  return false;
}

export async function verifyTargetExcludedSourceSnapshot(input: {
  snapshotRoot: string;
  targetWorkflow: string;
  expectedManifest: TargetExcludedSourceManifest;
}): Promise<void> {
  validateTargetWorkflow(input.targetWorkflow);
  const scanned = await scanSource(await realpath(input.snapshotRoot), input.targetWorkflow);
  const included = scanned.included.map(({ path: relativePath, sha256 }) => ({
    path: relativePath,
    sha256,
  }));
  if (
    scanned.excluded.length > 0 ||
    JSON.stringify(included) !== JSON.stringify(input.expectedManifest.included)
  ) {
    throw new Error('target-excluded source snapshot failed manifest verification');
  }
}
