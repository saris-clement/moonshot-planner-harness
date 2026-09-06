import { createHash } from 'node:crypto';
import {
  DecisionSchema,
  type Decision,
  type JudgeOutput,
  type LabelRecord,
  type PlannerUsage,
  type RequirementUnitFact,
  type RunFacts,
  type Score,
} from './types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function findAnalysisContent(value: unknown): JsonRecord {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!isRecord(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (Array.isArray(candidate.requirementUnits) && Array.isArray(candidate.adjudications)) {
      return candidate;
    }
    for (const key of ['analysis', 'aggregate', 'content', 'value']) {
      if (candidate[key] !== undefined) queue.push(candidate[key]);
    }
  }
  throw new Error('analysis response does not contain requirementUnits and adjudications');
}

function sourceRefs(value: unknown): RequirementUnitFact['sourceRefs'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((sourceRef) => ({
    ...(typeof sourceRef.capabilityId === 'string' ? { capabilityId: sourceRef.capabilityId } : {}),
    ...(typeof sourceRef.path === 'string' ? { path: sourceRef.path } : {}),
    ...(typeof sourceRef.symbol === 'string' ? { symbol: sourceRef.symbol } : {}),
  }));
}

function emptyDecisions(): Record<Decision, number> {
  return { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 };
}

export function extractPlannerUsage(runResponse: unknown): PlannerUsage | null {
  const run =
    isRecord(runResponse) && isRecord(runResponse.runtime)
      ? runResponse.runtime
      : isRecord(runResponse) && isRecord(runResponse.run)
        ? runResponse.run
        : runResponse;
  const runRecord = isRecord(run) ? run : {};
  if (!isRecord(runRecord.aggregateUsage)) return null;
  const usage = {
    calls: numberValue(runRecord.aggregateUsage.calls),
    inputTokens: numberValue(runRecord.aggregateUsage.inputTokens),
    outputTokens: numberValue(runRecord.aggregateUsage.outputTokens),
    totalTokens: numberValue(runRecord.aggregateUsage.totalTokens),
    costUsd: numberValue(runRecord.aggregateUsage.costUsd),
    durationMs: numberValue(runRecord.aggregateUsage.durationMs),
  };
  return Object.values(usage).some((value) => value !== 0) ? usage : null;
}

export function extractRunFacts(analysisResponse: unknown, runResponse: unknown): RunFacts {
  const analysis = findAnalysisContent(analysisResponse);
  const run =
    isRecord(runResponse) && isRecord(runResponse.runtime)
      ? runResponse.runtime
      : isRecord(runResponse) && isRecord(runResponse.run)
        ? runResponse.run
        : runResponse;
  const runRecord = isRecord(run) ? run : {};
  const rawUnits = Array.isArray(analysis.requirementUnits)
    ? analysis.requirementUnits.filter(isRecord)
    : [];
  const rawAdjudications = Array.isArray(analysis.adjudications)
    ? analysis.adjudications.filter(isRecord)
    : [];
  const adjudications = new Map(
    rawAdjudications.map((item) => [stringValue(item.requirementUnitId), item]),
  );
  const decisions = emptyDecisions();
  const shortlist = { empty: 0, nonempty: 0, candidates: 0 };
  const evidence = { discovered: 0, selectedSourceRefs: 0 };

  const units = rawUnits.map((unit): RequirementUnitFact => {
    const id = stringValue(unit.id);
    const adjudication = adjudications.get(id);
    if (!id || !adjudication) throw new Error(`completed analysis is missing adjudication for unit ${id}`);
    const decision = DecisionSchema.parse(adjudication.result);
    decisions[decision] += 1;
    const shortlistRecord = isRecord(adjudication.shortlist) ? adjudication.shortlist : {};
    const candidates = Array.isArray(shortlistRecord.candidates) ? shortlistRecord.candidates : [];
    shortlist.candidates += candidates.length;
    if (candidates.length === 0) shortlist.empty += 1;
    else shortlist.nonempty += 1;
    const discovered = Array.isArray(adjudication.discoveredEvidence)
      ? adjudication.discoveredEvidence.length
      : 0;
    const selectedRefs = sourceRefs(adjudication.sourceRefs);
    evidence.discovered += discovered;
    evidence.selectedSourceRefs += selectedRefs.length;
    const ref = isRecord(unit.ref)
      ? { entity: stringValue(unit.ref.entity), anchor: stringValue(unit.ref.anchor) }
      : { entity: '', anchor: '' };
    return {
      id,
      key: id,
      ref,
      kind: stringValue(unit.kind),
      semantics: stringValue(unit.semantics),
      decision,
      confidence: stringValue(adjudication.confidence),
      rationale: stringValue(adjudication.rationale),
      selectedCandidateIds: stringArray(adjudication.selectedCandidateIds),
      sourceRefs: selectedRefs,
      discoveredEvidenceCount: discovered,
      shortlistCandidateCount: candidates.length,
      uncoveredSemantics: stringArray(adjudication.uncoveredSemantics),
    };
  });

  const usage = extractPlannerUsage(runResponse) ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
  const pins = isRecord(runRecord.pins) ? runRecord.pins : {};
  return {
    status: stringValue(runRecord.status, 'completed'),
    sampleSize: 1,
    decisionAgreement: 1,
    unitCount: rawUnits.length,
    decisions,
    shortlist,
    evidence,
    usage,
    pins,
    units,
  };
}

export function validateMeaningfulFacts(facts: RunFacts): void {
  const decisionTotal = Object.values(facts.decisions).reduce((sum, count) => sum + count, 0);
  if (facts.status !== 'completed' && facts.status !== 'consensus') {
    throw new Error(`evaluation facts are not complete: status=${facts.status}`);
  }
  if (facts.unitCount === 0 || facts.units.length !== facts.unitCount) {
    throw new Error('evaluation produced no complete requirement-unit cohort');
  }
  if (decisionTotal !== facts.unitCount) {
    throw new Error(`decision total ${decisionTotal} does not match ${facts.unitCount} units`);
  }
  if (Object.keys(facts.pins).length === 0) throw new Error('evaluation omitted runtime pins');
  if (facts.usage.calls <= 0 || facts.usage.totalTokens <= 0) {
    throw new Error('evaluation omitted substantive model usage');
  }
  for (const unit of facts.units) {
    if (!unit.id || !unit.ref.entity || !unit.ref.anchor || !unit.semantics || !unit.rationale) {
      throw new Error(`evaluation unit ${unit.id || '<missing>'} lacks meaningful content`);
    }
    if ((unit.decision === 'reuse' || unit.decision === 'extend') && unit.sourceRefs.length === 0) {
      throw new Error(`${unit.decision} unit ${unit.id} has no committed source reference`);
    }
  }
}

export function consensusRunFacts(runs: readonly RunFacts[]): RunFacts {
  if (runs.length === 0) throw new Error('cannot build consensus without replicate facts');
  for (const facts of runs) validateMeaningfulFacts(facts);
  const reference = runs[0]!;
  for (const candidate of runs.slice(1)) {
    const mismatches = compareCohort(reference, candidate);
    if (mismatches.length > 0) {
      throw new Error(`replicate cohort drift: ${mismatches.join(', ')}`);
    }
  }
  const decisionOrder: Decision[] = ['question', 'defer', 'build', 'extend', 'reuse'];
  let unanimous = 0;
  const units = reference.units.map((referenceUnit) => {
    const candidates = runs.map(
      (facts) => facts.units.find((unit) => unit.key === referenceUnit.key)!,
    );
    const counts = new Map<Decision, number>();
    for (const unit of candidates) counts.set(unit.decision, (counts.get(unit.decision) ?? 0) + 1);
    if (counts.size === 1) unanimous += 1;
    const decision = [...counts.entries()].sort(
      ([leftDecision, leftCount], [rightDecision, rightCount]) =>
        rightCount - leftCount ||
        decisionOrder.indexOf(leftDecision) - decisionOrder.indexOf(rightDecision),
    )[0]![0];
    return candidates.find((unit) => unit.decision === decision) ?? referenceUnit;
  });
  const decisions = emptyDecisions();
  for (const unit of units) decisions[unit.decision] += 1;
  const sum = (read: (facts: RunFacts) => number): number =>
    runs.reduce((total, facts) => total + read(facts), 0);
  const average = (read: (facts: RunFacts) => number): number => Math.round(sum(read) / runs.length);
  return {
    ...reference,
    status: 'consensus',
    sampleSize: runs.length,
    decisionAgreement: unanimous / reference.unitCount,
    decisions,
    shortlist: {
      empty: average((facts) => facts.shortlist.empty),
      nonempty: average((facts) => facts.shortlist.nonempty),
      candidates: average((facts) => facts.shortlist.candidates),
    },
    evidence: {
      discovered: average((facts) => facts.evidence.discovered),
      selectedSourceRefs: average((facts) => facts.evidence.selectedSourceRefs),
    },
    usage: {
      calls: sum((facts) => facts.usage.calls),
      inputTokens: sum((facts) => facts.usage.inputTokens),
      outputTokens: sum((facts) => facts.usage.outputTokens),
      totalTokens: sum((facts) => facts.usage.totalTokens),
      costUsd: sum((facts) => facts.usage.costUsd),
      durationMs: sum((facts) => facts.usage.durationMs),
    },
    pins: {
      ...reference.pins,
      replicateDecisionSets: runs.map((facts) => ({
        decisionSetVersion: facts.pins.decisionSetVersion,
        decisionSetHash: facts.pins.decisionSetHash,
      })),
    },
    units,
  };
}

export function computeScore(
  facts: RunFacts,
  labels: readonly LabelRecord[],
  judgment: JudgeOutput | null,
): Score {
  const units = new Map(facts.units.map((unit) => [unit.key, unit]));
  const verifiedLabels = labels.filter((label) => label.status === 'verified');
  const verifiedKeys = new Set(verifiedLabels.map((label) => label.unitKey));
  const suggestedByKey = new Map<string, { unitKey: string; expectedDecision: Decision }>(
    labels
      .filter((label) => label.status === 'suggested' && !verifiedKeys.has(label.unitKey))
      .map((label) => [label.unitKey, label]),
  );
  for (const verdict of judgment?.verdicts ?? []) {
    if (!verifiedKeys.has(verdict.unitKey) && !suggestedByKey.has(verdict.unitKey)) {
      suggestedByKey.set(verdict.unitKey, verdict);
    }
  }
  const decisionErrors = emptyDecisions();

  const evaluate = (expected: Array<{ unitKey: string; expectedDecision: Decision }>) => {
    let correct = 0;
    let errors = 0;
    for (const label of expected) {
      const unit = units.get(label.unitKey);
      if (!unit) continue;
      if (unit.decision === label.expectedDecision) correct += 1;
      else {
        errors += 1;
        decisionErrors[unit.decision] += 1;
      }
    }
    const labeled = correct + errors;
    return { labeled, correct, errors, accuracy: labeled === 0 ? null : correct / labeled };
  };

  return {
    cohortMismatches: [],
    verified: evaluate(verifiedLabels),
    provisional: evaluate([...suggestedByKey.values()]),
    decisionErrors,
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex')}`;
}

export function compareCohort(reference: RunFacts, candidate: RunFacts): string[] {
  const mismatches: string[] = [];
  const comparablePins = (facts: RunFacts): unknown =>
    typeof facts.pins.inputSetHash === 'string'
      ? { inputSetHash: facts.pins.inputSetHash }
      : facts.pins;
  if (canonicalHash(comparablePins(reference)) !== canonicalHash(comparablePins(candidate))) {
    mismatches.push('analysis pins');
  }
  const unitSignature = (unit: RequirementUnitFact): unknown => ({
    key: unit.key,
    ref: unit.ref,
    kind: unit.kind,
    semantics: unit.semantics,
  });
  const referenceUnits = reference.units.map(unitSignature).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  const candidateUnits = candidate.units.map(unitSignature).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  if (canonicalHash(referenceUnits) !== canonicalHash(candidateUnits)) mismatches.push('requirement units');
  return mismatches;
}

export function compareScores(left: Score, right: Score): number {
  const leftVerified = left.verified.accuracy ?? -1;
  const rightVerified = right.verified.accuracy ?? -1;
  if (leftVerified !== rightVerified) return rightVerified - leftVerified;
  if (left.verified.errors !== right.verified.errors) return left.verified.errors - right.verified.errors;
  const leftProvisional = left.provisional.accuracy ?? -1;
  const rightProvisional = right.provisional.accuracy ?? -1;
  if (leftProvisional !== rightProvisional) return rightProvisional - leftProvisional;
  return left.provisional.errors - right.provisional.errors;
}
