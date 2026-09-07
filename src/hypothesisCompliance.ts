import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './config.js';
import {
  HypothesisComplianceOutputSchema,
  type HypothesisComplianceOutput,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hypothesisComplianceAttemptDirectory(
  artifactDirectory: string,
  attempt: number,
): string {
  return path.join(
    artifactDirectory,
    'hypothesis-compliance',
    `attempt-${String(attempt).padStart(2, '0')}`,
  );
}

async function writeImmutableBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readFile(filePath).catch(() => null);
  if (existing !== null) {
    if (!existing.equals(bytes)) throw new Error('immutable compliance attempt input changed');
    return;
  }
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
}

export async function archiveHypothesisComplianceAttemptInputs(
  artifactDirectory: string,
  attempt: number,
  treatmentPatchPath: string,
  candidatePatchPath: string,
  mutationContextPath: string,
): Promise<{
  directory: string;
  treatmentPatchPath: string;
  candidatePatchPath: string;
  mutationContextPath: string;
  treatmentPatchSha256: string;
  candidatePatchSha256: string;
  mutationContextSha256: string;
}> {
  const directory = hypothesisComplianceAttemptDirectory(artifactDirectory, attempt);
  const [treatment, candidate, context] = await Promise.all([
    readFile(treatmentPatchPath),
    readFile(candidatePatchPath),
    readFile(mutationContextPath),
  ]);
  const archivedTreatment = path.join(directory, 'mutation.patch');
  const archivedCandidate = path.join(directory, 'variant.patch');
  const archivedContext = path.join(directory, 'mutation-context.json');
  await Promise.all([
    writeImmutableBytes(archivedTreatment, treatment),
    writeImmutableBytes(archivedCandidate, candidate),
    writeImmutableBytes(archivedContext, context),
  ]);
  return {
    directory,
    treatmentPatchPath: archivedTreatment,
    candidatePatchPath: archivedCandidate,
    mutationContextPath: archivedContext,
    treatmentPatchSha256: await sha256File(archivedTreatment),
    candidatePatchSha256: await sha256File(archivedCandidate),
    mutationContextSha256: await sha256File(archivedContext),
  };
}

export async function archivePartialHypothesisComplianceAttemptInputs(
  artifactDirectory: string,
  attempt: number,
  treatmentPatchPath: string | null,
  candidatePatchPath: string | null,
  mutationContextPath: string,
): Promise<{
  directory: string;
  treatmentPatchPath: string | null;
  candidatePatchPath: string | null;
  mutationContextPath: string;
  treatmentPatchSha256: string | null;
  candidatePatchSha256: string | null;
  mutationContextSha256: string;
}> {
  const directory = hypothesisComplianceAttemptDirectory(artifactDirectory, attempt);
  const [treatment, candidate, context] = await Promise.all([
    treatmentPatchPath ? readFile(treatmentPatchPath) : null,
    candidatePatchPath ? readFile(candidatePatchPath) : null,
    readFile(mutationContextPath),
  ]);
  const archivedTreatment = treatment ? path.join(directory, 'mutation.patch') : null;
  const archivedCandidate = candidate ? path.join(directory, 'variant.patch') : null;
  const archivedContext = path.join(directory, 'mutation-context.json');
  await Promise.all([
    ...(archivedTreatment && treatment
      ? [writeImmutableBytes(archivedTreatment, treatment)]
      : []),
    ...(archivedCandidate && candidate
      ? [writeImmutableBytes(archivedCandidate, candidate)]
      : []),
    writeImmutableBytes(archivedContext, context),
  ]);
  return {
    directory,
    treatmentPatchPath: archivedTreatment,
    candidatePatchPath: archivedCandidate,
    mutationContextPath: archivedContext,
    treatmentPatchSha256: archivedTreatment ? await sha256File(archivedTreatment) : null,
    candidatePatchSha256: archivedCandidate ? await sha256File(archivedCandidate) : null,
    mutationContextSha256: await sha256File(archivedContext),
  };
}

export async function mutationContextRequiresFalsification(
  mutationContextPath: string,
): Promise<boolean> {
  const context = JSON.parse(await readFile(mutationContextPath, 'utf8')) as unknown;
  if (!isRecord(context) || !Array.isArray(context.selectedFindings)) {
    throw new Error('mutation context has no valid selectedFindings array');
  }
  return context.selectedFindings.some(
    (finding) =>
      isRecord(finding) &&
      typeof finding.falsificationTest === 'string' &&
      finding.falsificationTest.trim().length > 0,
  );
}

export function hypothesisComplianceResultPath(
  artifactDirectory: string,
  patchSha256: string,
  mutationContextSha256: string,
): string {
  return path.join(
    artifactDirectory,
    'hypothesis-compliance',
    `result-${patchSha256.slice('sha256:'.length)}-${mutationContextSha256.slice('sha256:'.length)}.json`,
  );
}

export async function verifyHypothesisComplianceResult(
  resultPath: string,
  variantId: string,
  patchSha256: string,
  mutationContextSha256: string,
  resultSha256?: string,
  falsificationRequired = false,
): Promise<HypothesisComplianceOutput> {
  if (resultSha256 && (await sha256File(resultPath)) !== resultSha256) {
    throw new Error('persisted hypothesis compliance result hash does not match');
  }
  const result = HypothesisComplianceOutputSchema.parse(
    JSON.parse(await readFile(resultPath, 'utf8')) as unknown,
  );
  if (
    result.variantId !== variantId ||
    result.patchSha256 !== patchSha256 ||
    result.mutationContextSha256 !== mutationContextSha256
  ) {
    throw new Error('hypothesis compliance result is bound to another mutation');
  }
  if (falsificationRequired && result.falsificationTest.status === 'not_applicable') {
    throw new Error('hypothesis compliance falsification check cannot be not_applicable');
  }
  return result;
}
