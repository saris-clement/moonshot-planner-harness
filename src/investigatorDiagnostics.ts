import { z } from 'zod';
import { DecisionSchema, type Decision } from './types.js';

const text = z.string().trim().min(1).max(2_000);
export const DiagnosticReviewSchema = z.object({
  schemaVersion: z.literal(1),
  observationRef: z.string().regex(/^snapshot_[a-f0-9]{64}$/),
  selectionRationale: z.string().trim().min(1).max(4_000),
  // A safety cap, not a sampling quota or a requirement to find errors.
  examples: z.array(z.object({
    unitRef: z.string().regex(/^unit_[a-f0-9]{64}$/),
    assessment: z.enum(['useful', 'uncertain', 'not_useful']),
    whyThisExample: text,
    requirementUnderstanding: text,
    expectedDecision: DecisionSchema.nullable(),
    codeAssessment: text,
    citations: z.array(z.object({
      evidenceRef: z.string().regex(/^evidence_[a-f0-9]{64}$/),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(16_384).optional(),
    }).strict()).min(1).max(8),
    limitations: text,
    discriminatingCheck: text,
  }).strict()).min(1).max(20),
  mechanism: text,
  falsificationCriterion: text,
}).strict().superRefine((review, context) => {
  const seen = new Set<string>();
  review.examples.forEach((example, index) => {
    if (seen.has(example.unitRef)) context.addIssue({ code: 'custom', path: ['examples', index, 'unitRef'], message: 'Duplicate unit reference' });
    seen.add(example.unitRef);
  });
  if (review.examples.every((example) => example.assessment === 'not_useful')) {
    context.addIssue({ code: 'custom', path: ['examples'], message: 'At least one example must be useful or uncertain' });
  }
});

export type DiagnosticReview = z.infer<typeof DiagnosticReviewSchema>;

export interface PreparedDiagnosticReview {
  schemaVersion: 1;
  kind: 'diagnostic_review';
  interpretationStatus: 'unverified_model_judgment';
  structuralStatus: 'recorded';
  /** Normalized, redacted model interpretation, not a verified reference label. */
  review: DiagnosticReview;
  /** SHA-256 of JSON.stringify(review), after normalization and redaction. */
  reviewHash: string;
  binding: {
    campaignId: string;
    variantId: string;
    observationRef: string;
    benchmark: string;
    arm: 'standard';
    observationBenchmark: string | null;
    benchmarkBinding: 'observation' | 'coordinator_primary_frozen_reference';
    referenceRef: string | null;
    referenceHash: string | null;
    labelSetHash: string | null;
    workflowsSourceRef: string | null;
    artifactBindings: Array<{ evidenceRef: string; sha256: string; bytes: number; integrity: 'verified_content_hash' }>;
  };
  examples: Array<{
    unitRef: string;
    unitKey: string;
    replicates: Array<{
      replicate: number;
      artifactRef: string;
      availability: 'available' | 'partial' | 'not_captured';
      requirementSemantics: string | null;
      observedDecision: Decision | null;
    }>;
    referenceLabel: { expectedDecision: Decision; status: 'suggested' | 'verified'; artifactRef: string } | null;
    citations: Array<{
      evidenceRef: string;
      sha256: string;
      originalBytes: number;
      offset: number;
      endOffset: number;
      offsetUnit: 'utf8_bytes';
      complete: boolean;
      truncated: boolean;
      text: string;
      copyKind: 'redacted_research_copy';
      integrity: 'verified_content_hash';
    }>;
    limitations: string[];
  }>;
  limitations: string[];
}
