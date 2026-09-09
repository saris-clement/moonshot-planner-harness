import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { sha256File } from './config.js';
import type { HarnessDatabase } from './db.js';
import type { InvestigationState } from './investigator.js';
import { canonicalHash } from './metrics.js';
import type { CampaignConfig, CampaignRecord, VariantRecord } from './types.js';

export interface InvestigatorTokenGrant {
  id: string;
  grantedAt: string;
  additionalTokens: number;
  tokensAtGrant: number;
  previousLimit: number;
  effectiveLimit: number;
  reason: string;
}

const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const positiveTokens = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().max(8_000).refine((value) => value.trim().length > 0);
export const InvestigatorTokenGrantInputSchema = z.object({
  requestId, additionalTokens: positiveTokens, reason,
}).strict();
const grantSchema = z.object({
  id: requestId, grantedAt: z.iso.datetime(), additionalTokens: positiveTokens,
  tokensAtGrant: positiveTokens, previousLimit: positiveTokens, effectiveLimit: positiveTokens, reason,
}).strict();

type InvestigatorLimits = NonNullable<CampaignConfig['investigator']>;

export function effectiveInvestigatorLimits(
  baseConfig: InvestigatorLimits, state?: Pick<InvestigationState, 'tokenGrants'> | null,
): InvestigatorLimits {
  let maxAgentTokens = baseConfig.maxAgentTokens;
  const grants = state?.tokenGrants === undefined ? [] : state.tokenGrants;
  if (!Number.isSafeInteger(maxAgentTokens) || maxAgentTokens <= 0 || !Array.isArray(grants)) {
    throw new Error('Invalid investigator token grant chain or base limit');
  }
  const ids = new Set<string>();
  for (const grant of grants) {
    if (!grantSchema.safeParse(grant).success || ids.has(grant.id) ||
        grant.previousLimit !== maxAgentTokens || grant.tokensAtGrant < grant.previousLimit ||
        grant.effectiveLimit !== grant.tokensAtGrant + grant.additionalTokens) {
      throw new Error('Invalid investigator token grant chain');
    }
    ids.add(grant.id);
    maxAgentTokens = grant.effectiveLimit;
  }
  return { ...baseConfig, maxAgentTokens };
}

/** Receipts and their retained patches must still match the transaction's durable event binding. */
export async function verifyInvestigatorTokenGrantReceipts(
  database: HarnessDatabase, campaign: CampaignRecord, variant: VariantRecord, artifactDirectory: string,
): Promise<void> {
  const grants = variant.investigation?.tokenGrants ?? [];
  if (!grants.length) return;
  effectiveInvestigatorLimits(campaign.config.investigator!, variant.investigation);
  const events = database.listEvents(campaign.id).filter((event) =>
    event.variantId === variant.id && event.type === 'investigator.tokens_extended');
  for (const [index, grant] of grants.entries()) {
    const receiptPath = path.join(artifactDirectory, 'investigation', 'budget-grants', `${grant.id}.json`);
    const receiptBytes = await readFile(receiptPath);
    const bindings = events.filter((event) => (event.payload as { grant?: InvestigatorTokenGrant })?.grant?.id === grant.id);
    const binding = bindings[0]?.payload as { grant: InvestigatorTokenGrant; receiptHash: string } | undefined;
    if (bindings.length !== 1 || !binding || canonicalHash(binding.grant) !== canonicalHash(grant) ||
        binding.receiptHash !== `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}`) {
      throw new Error(`Investigator token grant receipt binding changed or missing: ${grant.id}`);
    }
    const receipt = JSON.parse(receiptBytes.toString('utf8')) as {
      campaignId: string; variantId: string; grant: InvestigatorTokenGrant; priorState: InvestigationState;
      priorStateHash: string; oldLimits: InvestigatorLimits; newLimits: InvestigatorLimits; patchHash: string;
    };
    const oldLimits = effectiveInvestigatorLimits(campaign.config.investigator!, { tokenGrants: grants.slice(0, index) });
    if (receipt.campaignId !== campaign.id || receipt.variantId !== variant.id ||
        canonicalHash(receipt.grant) !== canonicalHash(grant) ||
        canonicalHash(receipt.priorState) !== receipt.priorStateHash ||
        receipt.priorState.sessionId !== variant.investigation!.sessionId ||
        receipt.priorState.agentTokens !== grant.tokensAtGrant ||
        canonicalHash(receipt.priorState.tokenGrants ?? []) !== canonicalHash(grants.slice(0, index)) ||
        canonicalHash(receipt.oldLimits) !== canonicalHash(oldLimits) ||
        canonicalHash(receipt.newLimits) !== canonicalHash({ ...oldLimits, maxAgentTokens: grant.effectiveLimit }) ||
        receipt.patchHash !== await sha256File(path.join(path.dirname(receiptPath), grant.id, 'variant.patch'))) {
      throw new Error(`Investigator token grant receipt or patch changed: ${grant.id}`);
    }
  }
}
