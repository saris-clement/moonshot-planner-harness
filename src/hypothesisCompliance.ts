import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './config.js';
import {
  HypothesisComplianceOutputSchema,
  type HypothesisComplianceOutput,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
