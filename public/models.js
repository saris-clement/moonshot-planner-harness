const ACTIVE_STATUSES = new Set(['queued', 'mutating', 'gating', 'building', 'starting', 'running', 'judging']);
const STABLE_PROGRESS_STAGES = new Set(['adjudicating', 'waiting_for_input', 'completed']);
const LANGFUSE_TRACES_URL =
  'https://langfuse.staging.saris.ai/project/cmt941f0r005ank07hhyq0s50/traces';

export { ACTIVE_STATUSES, STABLE_PROGRESS_STAGES };

export function executionsFor(variant) {
  return variant?.executionState?.executions ?? [];
}

export function factsForBenchmark(variant, benchmark) {
  return benchmark.role === 'primary'
    ? variant?.facts
    : variant?.holdoutFacts?.[benchmark.name] ?? null;
}

export function replicateFactsForBenchmark(variant, benchmark) {
  return benchmark.role === 'primary'
    ? variant?.replicateFacts ?? []
    : variant?.holdoutReplicateFacts?.[benchmark.name] ?? [];
}

export function scopedQuestions(variant, benchmark, replicate) {
  const byScopeAndId = new Map();
  for (const execution of executionsFor(variant)) {
    if (benchmark && execution.benchmark !== benchmark) continue;
    if (replicate && execution.replicate !== replicate) continue;
    for (const question of execution.questions ?? []) {
      const key = `${execution.benchmark}\u0000${execution.replicate}\u0000${question.id}`;
      const existing = byScopeAndId.get(key);
      const currentTime = Date.parse(question.updatedAt ?? question.createdAt ?? '') || 0;
      const existingTime = Date.parse(existing?.updatedAt ?? existing?.createdAt ?? '') || 0;
      if (!existing || currentTime >= existingTime) {
        byScopeAndId.set(key, {
          ...question,
          benchmark: execution.benchmark,
          replicate: execution.replicate,
        });
      }
    }
  }
  return [...byScopeAndId.values()].sort(
    (left, right) =>
      left.benchmark.localeCompare(right.benchmark) ||
      left.replicate - right.replicate ||
      (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0),
  );
}

export function langfuseUrlForCase(caseId) {
  if (!caseId) return null;
  const url = new URL(LANGFUSE_TRACES_URL);
  url.searchParams.set(
    'filter',
    `traceTags;arrayOptions;;any of;${encodeURIComponent(`case:${caseId}`)}`,
  );
  return url.toString();
}

export function langfuseUrlForVariant(variant) {
  const caseIds = [...new Set(executionsFor(variant).map((execution) => execution.caseId).filter(Boolean))];
  if (caseIds.length === 0) return null;
  const url = new URL(LANGFUSE_TRACES_URL);
  const tags = caseIds.map((caseId) => `case:${caseId}`).join('|');
  url.searchParams.set('filter', `traceTags;arrayOptions;;any of;${encodeURIComponent(tags)}`);
  return url.toString();
}

export function replicateMatrix(campaign, variant) {
  const rows = [];
  for (const benchmark of campaign.config.benchmarks) {
    const finalFacts = replicateFactsForBenchmark(variant, benchmark);
    const observedCount = Math.max(
      finalFacts.length,
      ...executionsFor(variant)
        .filter((execution) => execution.benchmark === benchmark.name)
        .map((execution) => execution.replicateCount ?? execution.replicate),
    );
    const replicateCount = observedCount ||
      (campaign.targetExcludedConfig && variant.round > 0
        ? campaign.targetExcludedConfig.replicates
        : campaign.config.evaluation.replicates);
    for (let replicate = 1; replicate <= replicateCount; replicate += 1) {
      const execution = executionsFor(variant).find(
        (candidate) =>
          candidate.benchmark === benchmark.name && candidate.replicate === replicate,
      ) ?? null;
      const facts = finalFacts[replicate - 1] ?? null;
      const failed = execution?.status === 'failed';
      const state = failed
        ? 'failed'
        : facts || execution?.status === 'completed'
          ? 'completed'
          : execution
            ? 'current'
            : 'pending';
      rows.push({
        benchmark: benchmark.name,
        role: benchmark.role,
        replicate,
        replicateCount,
        execution,
        facts,
        state,
        observed: Boolean(execution || facts),
        usage: facts?.usage ?? execution?.usage ?? null,
        questions: scopedQuestions(variant, benchmark.name, replicate),
        traceUrl: langfuseUrlForCase(execution?.caseId),
        stableProgress: Boolean(
          execution?.progress &&
            (execution.status === 'completed' || STABLE_PROGRESS_STAGES.has(execution.stage)),
        ),
      });
    }
  }
  return rows;
}

export function targetExcludedReplicateMatrix(campaign, variant) {
  const config = campaign.targetExcludedConfig ?? (campaign.config.targetExcluded
    ? { ...campaign.config.targetExcluded, replicates: 2 }
    : null);
  const primary = campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary');
  if (!config || !primary || (variant.round === 0 && config.protocol !== 'standard-primary-v2')) {
    return [];
  }
  const evaluation = (campaign.targetExcludedEvaluations ?? []).find(
    (candidate) => candidate.variantId === variant.id,
  );
  const executions = evaluation?.executionState?.executions ?? [];
  const rows = [];
  const arms = config.protocol === 'standard-primary-v2' ? ['excluded'] : ['control', 'excluded'];
  for (const arm of arms) {
    const benchmark = `${primary.name}:${arm}`;
    const finalFacts = arm === 'control'
      ? evaluation?.controlReplicateFacts ?? []
      : evaluation?.excludedReplicateFacts ?? [];
    for (let replicate = 1; replicate <= config.replicates; replicate += 1) {
      const execution = executions.find(
        (candidate) => candidate.benchmark === benchmark && candidate.replicate === replicate,
      ) ?? null;
      const facts = finalFacts[replicate - 1] ?? null;
      const failed = execution?.status === 'failed';
      const state = failed
        ? 'failed'
        : facts || execution?.status === 'completed'
          ? 'completed'
          : execution
            ? 'current'
            : 'pending';
      rows.push({
        benchmark,
        role: arm === 'control' ? 'target control' : 'target excluded',
        replicate,
        replicateCount: config.replicates,
        execution,
        facts,
        state,
        observed: Boolean(execution || facts),
        usage: facts?.usage ?? execution?.usage ?? null,
        questions: execution?.questions ?? [],
        traceUrl: langfuseUrlForCase(execution?.caseId),
        stableProgress: Boolean(
          execution?.progress &&
            (execution.status === 'completed' || STABLE_PROGRESS_STAGES.has(execution.stage)),
        ),
      });
    }
  }
  return rows;
}

export function plannerTotals(campaign, variant) {
  const values = replicateMatrix(campaign, variant)
    .map((row) => row.usage)
    .filter(Boolean);
  return values.reduce(
    (total, usage) => ({
      observations: total.observations + 1,
      calls: total.calls + usage.calls,
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      costUsd: total.costUsd + usage.costUsd,
      durationMs: total.durationMs + usage.durationMs,
    }),
    { observations: 0, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, durationMs: 0 },
  );
}

export function effectiveElapsed(persisted, startedAt, completedAt) {
  const started = Date.parse(startedAt ?? '');
  if (!completedAt && Number.isFinite(started)) return Math.max(0, Date.now() - started);
  if (persisted !== null && persisted !== undefined) return persisted;
  if (!Number.isFinite(started)) return null;
  const completed = Date.parse(completedAt ?? '');
  return Math.max(0, (Number.isFinite(completed) ? completed : Date.now()) - started);
}

export function experimentDescription(variant) {
  if (!variant) return '';
  return [
    `Rationale\n${variant.hypothesis.rationale}`,
    `Instructions\n${variant.hypothesis.instructions}`,
    `Expected impact\n${variant.hypothesis.expectedImpact}`,
    `Risk\n${variant.hypothesis.risk}`,
  ].join('\n\n');
}

export function compareScores(left, right) {
  const leftVerified = left?.verified.accuracy ?? -1;
  const rightVerified = right?.verified.accuracy ?? -1;
  if (leftVerified !== rightVerified) return rightVerified - leftVerified;
  if ((left?.verified.errors ?? 0) !== (right?.verified.errors ?? 0)) {
    return (left?.verified.errors ?? 0) - (right?.verified.errors ?? 0);
  }
  const leftProvisional = left?.provisional.accuracy ?? -1;
  const rightProvisional = right?.provisional.accuracy ?? -1;
  if (leftProvisional !== rightProvisional) return rightProvisional - leftProvisional;
  return (left?.provisional.errors ?? 0) - (right?.provisional.errors ?? 0);
}

export function currentPathIds(campaign, variants) {
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const path = new Set();
  let current = campaign.currentParentVariantId ? byId.get(campaign.currentParentVariantId) : null;
  while (current && !path.has(current.id)) {
    path.add(current.id);
    current = current.parentVariantId ? byId.get(current.parentVariantId) : null;
  }
  return path;
}

export function siblingScoreRanks(variants) {
  const groups = new Map();
  for (const variant of variants) {
    const key = variant.parentVariantId ?? '__root__';
    if (!groups.has(key)) groups.set(key, []);
    if (variant.score) groups.get(key).push(variant);
  }
  const ranks = new Map();
  for (const siblings of groups.values()) {
    siblings.sort((left, right) => compareScores(left.score, right.score));
    siblings.forEach((variant, index) => ranks.set(variant.id, index + 1));
  }
  return ranks;
}

export function resultState(variant) {
  if (variant.facts?.status === 'consensus') return 'consensus';
  if (['failed', 'rejected', 'stopped'].includes(variant.status)) return 'failed';
  if (ACTIVE_STATUSES.has(variant.status)) return 'live';
  return 'unscored';
}

export function holdoutState(campaign, variant, variants = campaign.variants ?? []) {
  const required = campaign.config.benchmarks
    .filter((benchmark) => benchmark.role === 'holdout')
    .map((benchmark) => benchmark.name);
  if (required.length === 0) return 'not configured';
  const scoreEntries = Object.entries(variant.holdoutScores ?? {});
  const scores = scoreEntries.map(([, score]) => score);
  const facts = Object.values(variant.holdoutFacts ?? {});
  if (required.some((benchmark) => !variant.holdoutFacts?.[benchmark] || !variant.holdoutScores?.[benchmark])) {
    return scoreEntries.length || facts.length ? 'incomplete' : 'pending';
  }
  if (scores.some((value) => value?.cohortMismatches?.length)) return 'cohort drift';
  const parent = variants.find((candidate) => candidate.id === variant.parentVariantId);
  if (parent && scores.length > 0) {
    const comparisons = scoreEntries.map(([benchmark, score]) => {
      const parentScore = parent.holdoutScores?.[benchmark];
      return parentScore ? compareScores(score, parentScore) : null;
    });
    if (comparisons.some((result) => result === null)) return 'incomplete';
    return comparisons.some((result) => result > 0) ? 'regressed' : 'passed';
  }
  if (scores.length > 0) return 'complete';
  if (facts.length > 0) return 'incomplete';
  return 'pending';
}

// UI eligibility is advisory; server promotion re-verifies archived artifacts and recomputes the gate.
function hasValidStandardPrimaryTargetLineage(campaign, variant, config, evaluation) {
  const primary = campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary');
  const binding = evaluation?.normalArmBinding;
  const resolvedArtifactSha = config.primaryResolvedArtifactSha;
  if (
    !primary ||
    !/^sha256:[a-f0-9]{64}$/.test(resolvedArtifactSha ?? '') ||
    variant.questionResolutions?.[primary.name]?.resolvedArtifactSha !== resolvedArtifactSha ||
    evaluation?.questionResolution?.resolvedArtifactSha !== resolvedArtifactSha ||
    binding?.source !== 'standard_primary' ||
    binding.benchmark !== primary.name ||
    binding.resolvedArtifactSha !== resolvedArtifactSha ||
    !Array.isArray(binding.replicates) ||
    binding.replicates.length !== 2
  ) return false;

  const standardExecutions = (variant.executionState?.executions ?? [])
    .filter((execution) => execution.role === 'primary' && execution.benchmark === primary.name);
  const excludedExecutions = (evaluation.executionState?.executions ?? [])
    .filter((execution) => execution.benchmark === `${primary.name}:excluded`);
  if (standardExecutions.length !== 2 || excludedExecutions.length !== 2) return false;

  for (let index = 0; index < 2; index += 1) {
    const replicate = index + 1;
    const bindingEntry = binding.replicates[index];
    const standardExecution = standardExecutions[index];
    const excludedExecution = excludedExecutions[index];
    if (
      bindingEntry?.replicate !== replicate ||
      standardExecution?.replicate !== replicate ||
      standardExecution.replicateCount !== 2 ||
      standardExecution.status !== 'completed' ||
      !bindingEntry.caseId ||
      !bindingEntry.runId ||
      !standardExecution.caseId ||
      !standardExecution.runId ||
      bindingEntry.caseId !== standardExecution.caseId ||
      bindingEntry.runId !== standardExecution.runId ||
      excludedExecution?.replicate !== replicate ||
      excludedExecution.replicateCount !== 2 ||
      excludedExecution.status !== 'completed' ||
      !excludedExecution.caseId ||
      !excludedExecution.runId
    ) return false;
  }

  const comparisons = evaluation.comparisons ?? [];
  if (comparisons.length !== 2) return false;
  return [1, 2].every((replicate, index) => {
    const comparison = comparisons.find((candidate) => candidate.replicate === replicate);
    return Boolean(
      comparison &&
      comparison.valid &&
      Array.isArray(comparison.leakagePaths) &&
      comparison.leakagePaths.length === 0 &&
      /^sha256:[a-f0-9]{64}$/.test(comparison.reportHash ?? '') &&
      comparison.normalCaseId === binding.replicates[index]?.caseId &&
      comparison.excludedCaseId === excludedExecutions[index]?.caseId &&
      comparison.normalRunId === binding.replicates[index]?.runId &&
      comparison.excludedRunId === excludedExecutions[index]?.runId
    );
  });
}

export function isPromotionEligible(campaign, variants, variant) {
  if (
    variant.status !== 'review' ||
    variant.parentVariantId !== campaign.currentParentVariantId ||
    !variant.artifactCollectionComplete ||
    !variant.facts ||
    !variant.score ||
    variant.diagnosisStatus !== 'completed' ||
    !variant.diagnosisInputHash ||
    !variant.diagnosisResultHash ||
    variant.score.cohortMismatches.includes('requirement units')
  ) return false;
  if (
    campaign.config.targetExcluded?.protocol === 'standard-primary-v2' &&
    !campaign.targetExcludedConfig
  ) return false;
  if (campaign.targetExcludedConfig) {
    const targetConfig = campaign.targetExcludedConfig;
    const usesStandardPrimary = targetConfig.protocol === 'standard-primary-v2';
    const targetEvaluation = (campaign.targetExcludedEvaluations ?? []).find(
      (candidate) => candidate.variantId === variant.id,
    );
    if (usesStandardPrimary) {
      const holdoutsComplete = campaign.config.benchmarks
        .filter((benchmark) => benchmark.role === 'holdout')
        .every((benchmark) => variant.holdoutReplicateFacts?.[benchmark.name]?.length === 2);
      if (
        targetConfig.replicates !== 2 ||
        targetEvaluation?.status !== 'completed' ||
        !targetEvaluation.artifactCollectionComplete ||
        variant.replicateFacts?.length !== 2 ||
        targetEvaluation.excludedReplicateFacts?.length !== 2 ||
        !holdoutsComplete ||
        !targetEvaluation.judgment ||
        !targetEvaluation.score ||
        !targetEvaluation.questionResolution ||
        !hasValidStandardPrimaryTargetLineage(
          campaign,
          variant,
          targetConfig,
          targetEvaluation,
        ) ||
        !['passed', 'warning'].includes(targetEvaluation.gate?.status)
      ) return false;
    } else {
      const comparisonOrdinals = targetEvaluation?.comparisons
        ?.map((comparison) => comparison.replicate)
        .sort((left, right) => left - right);
      const holdoutsComplete = campaign.config.benchmarks
        .filter((benchmark) => benchmark.role === 'holdout')
        .every((benchmark) =>
          targetEvaluation?.holdoutReplicateFacts?.[benchmark.name]?.length === targetConfig.replicates
        );
      if (
        targetEvaluation?.status !== 'completed' ||
        !targetEvaluation.artifactCollectionComplete ||
        targetEvaluation.controlReplicateFacts?.length !== targetConfig.replicates ||
        targetEvaluation.excludedReplicateFacts?.length !== targetConfig.replicates ||
        !holdoutsComplete ||
        !targetEvaluation.judgment ||
        !targetEvaluation.score ||
        !targetEvaluation.questionResolution ||
        targetEvaluation.comparisons?.length !== targetConfig.replicates ||
        JSON.stringify(comparisonOrdinals) !== JSON.stringify([1, 2]) ||
        targetEvaluation.comparisons.some((comparison) =>
          !comparison.valid || comparison.leakagePaths.length > 0
        ) ||
        !['passed', 'warning'].includes(targetEvaluation.gate?.status)
      ) return false;
    }
  }
  const latestRound = Math.max(...variants.map((candidate) => candidate.round));
  if (variant.round !== latestRound) return false;
  const requiredHoldouts = campaign.config.benchmarks
    .filter((benchmark) => benchmark.role === 'holdout')
    .map((benchmark) => benchmark.name);
  if (requiredHoldouts.some((benchmark) =>
    !variant.holdoutFacts?.[benchmark] ||
    !variant.holdoutJudgments?.[benchmark] ||
    !variant.holdoutScores?.[benchmark]
  )) return false;
  const parent = variants.find((candidate) => candidate.id === campaign.currentParentVariantId);
  if (!parent?.score) return true;
  if (
    parent.score.verified.labeled !== variant.score.verified.labeled ||
    parent.score.provisional.labeled !== variant.score.provisional.labeled
  ) return false;
  return requiredHoldouts.every((benchmark) => {
    const score = variant.holdoutScores?.[benchmark];
    const parentScore = parent.holdoutScores?.[benchmark];
    return Boolean(
      score &&
      parentScore &&
      !score.cohortMismatches.includes('requirement units') &&
      score.verified.labeled === parentScore.verified.labeled &&
      score.provisional.labeled === parentScore.provisional.labeled &&
      compareScores(score, parentScore) <= 0
    );
  });
}

function lifecycleMatches(status, filter) {
  if (filter === 'all') return true;
  if (filter === 'active') return ACTIVE_STATUSES.has(status);
  if (filter === 'finished') return ['completed', 'rejected'].includes(status);
  if (filter === 'failed') return ['failed', 'stopped'].includes(status);
  return status === filter;
}

export function filterAndSortVariants(campaign, variants, filters) {
  const branch = currentPathIds(campaign, variants);
  const currentCandidates = new Set(
    variants
      .filter((variant) => variant.parentVariantId === campaign.currentParentVariantId)
      .map((variant) => variant.id),
  );
  const query = filters.search.trim().toLowerCase();
  const visible = variants.filter((variant) => {
    if (
      query &&
      !`${variant.id} ${variant.hypothesis.title} ${variant.hypothesis.rationale}`
        .toLowerCase()
        .includes(query)
    ) return false;
    if (!lifecycleMatches(variant.status, filters.status)) return false;
    if (filters.round !== 'all' && variant.round !== Number(filters.round)) return false;
    if (filters.lineage === 'current-branch' && !branch.has(variant.id)) return false;
    if (filters.lineage === 'roots' && variant.parentVariantId) return false;
    if (filters.lineage === 'current-candidates' && !currentCandidates.has(variant.id)) return false;
    if (filters.result !== 'all' && resultState(variant) !== filters.result) return false;
    return true;
  });
  const numeric = (value, fallback = -1) => value ?? fallback;
  return visible.sort((left, right) => {
    if (filters.sort === 'activity') return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (filters.sort === 'verified') return numeric(right.score?.verified.accuracy) - numeric(left.score?.verified.accuracy);
    if (filters.sort === 'provisional') return numeric(right.score?.provisional.accuracy) - numeric(left.score?.provisional.accuracy);
    if (filters.sort === 'agreement') return numeric(right.facts?.decisionAgreement) - numeric(left.facts?.decisionAgreement);
    if (filters.sort === 'elapsed') {
      return numeric(effectiveElapsed(left.elapsedMs, left.startedAt, left.completedAt), Infinity) -
        numeric(effectiveElapsed(right.elapsedMs, right.startedAt, right.completedAt), Infinity);
    }
    if (filters.sort === 'tokens') return plannerTotals(campaign, left).totalTokens - plannerTotals(campaign, right).totalTokens;
    if (filters.sort === 'cost') return plannerTotals(campaign, left).costUsd - plannerTotals(campaign, right).costUsd;
    return left.ordinal - right.ordinal;
  });
}
