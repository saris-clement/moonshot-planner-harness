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
  | 'target-identity'
  | 'opaque-content';

export interface TargetExcludedSourceExclusion {
  path: string;
  reason: TargetExcludedSourceExclusionReason;
}

export interface TargetExcludedSourceManifest {
  policyVersion?: 2;
  included: TargetExcludedSourceManifestEntry[];
  excluded: TargetExcludedSourceExclusion[];
}

export interface TargetExcludedSourceSnapshotOptions {
  sourceRoot: string;
  snapshotRoot: string;
  targetWorkflow: string;
  policyVersion?: 1 | 2;
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
const javascriptOrTypeScriptPattern = /\.[cm]?[jt]sx?$/i;
const staticRelativeModulePatterns = [
  /\b(?:import|export)\s+(?:type\s+)?[^;'"]*?\bfrom\s*(['"])(\.\.?\/[^'"\r\n]+)\1/g,
  /\bimport\s*(['"])(\.\.?\/[^'"\r\n]+)\1/g,
  /\b(?:require|import)\s*\(\s*(['"])(\.\.?\/[^'"\r\n]+)\1\s*\)/g,
];

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

function requestedPolicyVersion(value: unknown, fallback: 1 | 2): 1 | 2 {
  if (value === undefined) return fallback;
  if (value === 1 || value === 2) return value;
  throw new Error(`unsupported policy version: ${JSON.stringify(value)}`);
}

function manifestPolicyVersion(manifest: TargetExcludedSourceManifest): 1 | 2 {
  const value: unknown = manifest.policyVersion;
  if (value === undefined) return 1;
  if (value === 2) return 2;
  throw new Error(`unsupported manifest policy version: ${JSON.stringify(value)}`);
}

function canonicalTargetRoot(targetWorkflow: string): string {
  return `src/customers/${targetWorkflow}/`;
}

function containsTargetIdentity(
  value: string,
  targetWorkflow: string,
  policyVersion: 1 | 2,
): boolean {
  const normalizedValue = policyVersion === 2 ? value.toLowerCase() : value;
  const normalizedWorkflow = policyVersion === 2 ? targetWorkflow.toLowerCase() : targetWorkflow;
  const identityTokenPattern = policyVersion === 1 ? /[a-z0-9._\/-]/i : /[a-z0-9._-]/i;
  if (normalizedValue.includes(canonicalTargetRoot(normalizedWorkflow))) return true;
  let offset = normalizedValue.indexOf(normalizedWorkflow);
  while (offset >= 0) {
    const before = offset === 0 ? '' : normalizedValue[offset - 1] ?? '';
    const after = normalizedValue[offset + normalizedWorkflow.length] ?? '';
    if (!identityTokenPattern.test(before) && !identityTokenPattern.test(after)) return true;
    offset = normalizedValue.indexOf(normalizedWorkflow, offset + 1);
  }
  return false;
}

function pathContainsTargetIdentity(relativePath: string, targetWorkflow: string): boolean {
  if (containsTargetIdentity(relativePath, targetWorkflow, 2)) return true;
  const pathSegments = relativePath.toLowerCase().split('/');
  const targetSegments = targetWorkflow.toLowerCase().split('/');
  for (let offset = 0; offset <= pathSegments.length - targetSegments.length; offset += 1) {
    if (targetSegments.every((segment, index) => pathSegments[offset + index] === segment)) {
      return true;
    }
  }
  return false;
}

function containsRelativeTargetReference(
  value: string,
  relativePath: string,
  targetRoot: string,
): boolean {
  if (!javascriptOrTypeScriptPattern.test(relativePath)) return false;
  const containingDirectory = path.posix.dirname(path.posix.resolve('/', relativePath));
  const normalizedTargetRoot = path.posix.resolve('/', targetRoot).toLowerCase();

  for (const pattern of staticRelativeModulePatterns) {
    for (const match of value.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier === undefined) continue;
      const resolved = path.posix.resolve(containingDirectory, specifier).toLowerCase();
      const relative = path.posix.relative(normalizedTargetRoot, resolved);
      if (relative === '' || (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative))) {
        return true;
      }
    }
  }
  return false;
}

export function isV2TargetIdentitySourceCandidate(input: {
  relativePath: string;
  text: string;
  targetWorkflow: string;
}): boolean {
  validateTargetWorkflow(input.targetWorkflow);
  return (
    pathContainsTargetIdentity(input.relativePath, input.targetWorkflow) ||
    containsTargetIdentity(input.text, input.targetWorkflow, 2) ||
    containsRelativeTargetReference(
      input.text,
      input.relativePath,
      canonicalTargetRoot(input.targetWorkflow),
    )
  );
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
  policyVersion: 1 | 2,
): TargetExcludedSourceExclusionReason | null {
  if (relativePath.split('/').includes('.git')) return 'git-metadata';
  const candidateRoot = `${relativePath}/`;
  if (
    policyVersion === 1
      ? candidateRoot === targetRoot
      : candidateRoot.toLowerCase() === targetRoot.toLowerCase()
  ) {
    return 'target-root';
  }
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

async function scanSource(
  sourceRoot: string,
  targetWorkflow: string,
  policyVersion: 1 | 2,
): Promise<ScanResult> {
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

      const exclusion = explicitExclusion(relativePath, targetRoot, policyVersion);
      if (exclusion) {
        if (details.isDirectory()) await assertNoSymlinks(absolutePath, relativePath);
        result.excluded.push({ path: displayPath(relativePath, details.isDirectory()), reason: exclusion });
        continue;
      }

      if (
        policyVersion === 2 &&
        details.isDirectory() &&
        pathContainsTargetIdentity(relativePath, targetWorkflow)
      ) {
        result.excluded.push({ path: displayPath(relativePath, true), reason: 'target-identity' });
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
      if (policyVersion === 2) {
        if (
          (text === null && pathContainsTargetIdentity(relativePath, targetWorkflow)) ||
          (text !== null &&
            isV2TargetIdentitySourceCandidate({ relativePath, text, targetWorkflow }))
        ) {
          result.excluded.push({ path: relativePath, reason: 'target-identity' });
          continue;
        }
        if (text === null) {
          result.excluded.push({ path: relativePath, reason: 'opaque-content' });
          continue;
        }
      } else if (text !== null && containsTargetIdentity(text, targetWorkflow, policyVersion)) {
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

function manifestFromScan(
  scanned: ScanResult,
  policyVersion: 1 | 2,
): TargetExcludedSourceManifest {
  const manifest = {
    included: scanned.included.map(({ path: relativePath, sha256 }) => ({
      path: relativePath,
      sha256,
    })),
    excluded: scanned.excluded,
  };
  return policyVersion === 1 ? manifest : { policyVersion: 2, ...manifest };
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
  const policyVersion = requestedPolicyVersion(options.policyVersion, 2);
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

  const scanned = await scanSource(sourceRoot, options.targetWorkflow, policyVersion);
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

  return manifestFromScan(scanned, policyVersion);
}

export function containsTargetIdentityLeak(evidence: unknown, targetWorkflow: string): boolean {
  validateTargetWorkflow(targetWorkflow);
  const pending: unknown[] = [evidence];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (containsTargetIdentity(value, targetWorkflow, 2)) return true;
    } else if (typeof value === 'object' && value !== null && !visited.has(value)) {
      visited.add(value);
      if (Array.isArray(value)) {
        pending.push(...value);
      } else {
        for (const [key, child] of Object.entries(value)) {
          if (containsTargetIdentity(key, targetWorkflow, 2)) return true;
          pending.push(child);
        }
      }
    }
  }
  return false;
}

export async function verifyTargetExcludedSourceSnapshot(input: {
  sourceRoot: string;
  snapshotRoot: string;
  targetWorkflow: string;
  policyVersion?: 1 | 2;
  expectedManifest: TargetExcludedSourceManifest;
}): Promise<void> {
  validateTargetWorkflow(input.targetWorkflow);
  const expectedPolicyVersion = manifestPolicyVersion(input.expectedManifest);
  const policyVersion = requestedPolicyVersion(input.policyVersion, expectedPolicyVersion);
  if (policyVersion !== expectedPolicyVersion) {
    throw new Error(
      `target-excluded source policy version mismatch: requested ${policyVersion}, manifest ${expectedPolicyVersion}`,
    );
  }
  const sourcePath = path.resolve(input.sourceRoot);
  const sourceDetails = await lstat(sourcePath);
  if (sourceDetails.isSymbolicLink()) throw new Error(`source root symlink is not allowed: ${sourcePath}`);
  if (!sourceDetails.isDirectory()) throw new Error(`source root is not a directory: ${sourcePath}`);
  const sourceRoot = await realpath(sourcePath);
  const snapshotRoot = await realpath(input.snapshotRoot);
  if (isWithin(sourceRoot, snapshotRoot) || isWithin(snapshotRoot, sourceRoot)) {
    throw new Error('source root and snapshot root must not overlap');
  }

  const authoritativeManifest = manifestFromScan(
    await scanSource(sourceRoot, input.targetWorkflow, policyVersion),
    policyVersion,
  );
  if (JSON.stringify(authoritativeManifest) !== JSON.stringify(input.expectedManifest)) {
    throw new Error('target-excluded manifest differs from frozen source manifest');
  }

  const scanned = await scanSource(
    snapshotRoot,
    input.targetWorkflow,
    policyVersion,
  );
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
