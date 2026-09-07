import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EMPTY_FROZEN_RESEARCH_CONTEXT,
  FROZEN_RESEARCH_INTERPRETATION_POLICY,
  FrozenResearchContextSchema,
  FrozenResearchManifestSchema,
  type FrozenResearchContext,
  type FrozenResearchManifest,
} from './types.js';

const MAX_RESEARCH_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_RESEARCH_CONTEXT_BYTES = 40_000;

export interface ResearchInputPin {
  sourcePath: string;
  name: string;
  sha256: string;
  bytes: number;
}

export interface CapturedResearchInput extends ResearchInputPin {
  content: Uint8Array;
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function readRegularFile(
  filePath: string,
  label: string,
  maximumBytes = MAX_RESEARCH_FILE_BYTES,
): Promise<Uint8Array> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new Error(`${label} is not a regular file: ${filePath}`);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`${label} is not a regular file: ${filePath}`);
    if (details.size > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes: ${filePath}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readRegularResearchFile(filePath: string): Promise<Uint8Array> {
  return await readRegularFile(filePath, 'research input');
}

export async function resolveResearchInputPins(
  researchPaths: readonly string[],
): Promise<ResearchInputPin[]> {
  return await Promise.all(
    researchPaths.map(async (sourcePath) => {
      const content = await readRegularResearchFile(sourcePath);
      return {
        sourcePath,
        name: path.basename(sourcePath),
        sha256: sha256Bytes(content),
        bytes: content.byteLength,
      };
    }),
  );
}

export async function captureResearchInputs(
  pins: readonly ResearchInputPin[],
): Promise<CapturedResearchInput[]> {
  return await Promise.all(
    pins.map(async (pin) => {
      const content = await readRegularResearchFile(pin.sourcePath);
      const sha256 = sha256Bytes(content);
      if (sha256 !== pin.sha256 || content.byteLength !== pin.bytes) {
        throw new Error(
          `research input SHA mismatch during frozen copy: expected ${pin.sha256}, got ${sha256}`,
        );
      }
      return { ...pin, content };
    }),
  );
}

function frozenResearchName(index: number, name: string): string {
  const safeName = name.replaceAll(/[^A-Za-z0-9._-]/g, '_') || 'research.txt';
  return `${String(index + 1).padStart(3, '0')}-${safeName}`;
}

export async function freezeResearchInputs(
  campaignRoot: string,
  inputs: readonly CapturedResearchInput[],
): Promise<string[]> {
  if (inputs.length === 0) return [];
  const directory = path.join(campaignRoot, 'research');
  await mkdir(directory, { recursive: true });
  const materials: FrozenResearchManifest['materials'] = [];
  const frozenPaths: string[] = [];
  for (const [index, input] of inputs.entries()) {
    const relativePath = frozenResearchName(index, input.name);
    const frozenPath = path.join(directory, relativePath);
    await writeFile(frozenPath, input.content, { flag: 'wx', mode: 0o600 });
    materials.push({
      name: input.name,
      path: relativePath,
      sha256: input.sha256,
      bytes: input.bytes,
    });
    frozenPaths.push(frozenPath);
  }
  const manifest = FrozenResearchManifestSchema.parse({
    kind: 'ainative-planner-eval/frozen-research-manifest',
    schemaVersion: 1,
    materials,
  });
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return frozenPaths;
}

export async function readFrozenResearchContext(
  researchPaths: readonly string[],
  expectedSha256: readonly string[],
): Promise<FrozenResearchContext> {
  if (researchPaths.length === 0) return EMPTY_FROZEN_RESEARCH_CONTEXT;
  if (expectedSha256.length !== researchPaths.length) {
    throw new Error('frozen research hashes do not match campaign research paths');
  }
  const directory = path.dirname(researchPaths[0]!);
  const directoryDetails = await lstat(directory).catch(() => null);
  if (!directoryDetails?.isDirectory() || directoryDetails.isSymbolicLink()) {
    throw new Error('frozen research root must be a real directory');
  }
  if (researchPaths.some((filePath) => path.dirname(filePath) !== directory)) {
    throw new Error('frozen research paths must share one manifest directory');
  }
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = FrozenResearchManifestSchema.parse(
    JSON.parse(
      Buffer.from(await readRegularFile(manifestPath, 'frozen research manifest')).toString('utf8'),
    ) as unknown,
  );
  if (
    manifest.materials.length !== researchPaths.length ||
    manifest.materials.some(
      (material, index) =>
        path.resolve(directory, material.path) !== path.resolve(researchPaths[index]!) ||
        frozenResearchName(index, material.name) !== material.path ||
        material.sha256 !== expectedSha256[index],
    )
  ) {
    throw new Error('frozen research manifest does not match campaign research paths');
  }
  const materials = await Promise.all(
    manifest.materials.map(async (material, index) => {
      const frozenPath = researchPaths[index]!;
      const content = await readRegularResearchFile(frozenPath);
      const sha256 = sha256Bytes(content);
      if (
        content.byteLength !== material.bytes ||
        sha256 !== material.sha256 ||
        sha256 !== expectedSha256[index]
      ) {
        throw new Error(`frozen research material hash changed: ${material.path}`);
      }
      return {
        ...material,
        name: material.path.replace(/^\d{3}-/, ''),
        content: Buffer.from(content.subarray(0, MAX_RESEARCH_CONTEXT_BYTES)).toString('utf8'),
        contentTruncated: content.byteLength > MAX_RESEARCH_CONTEXT_BYTES,
      };
    }),
  );
  return FrozenResearchContextSchema.parse({
    authority: 'historical_context_only',
    interpretationPolicy: FROZEN_RESEARCH_INTERPRETATION_POLICY,
    materials,
  });
}
