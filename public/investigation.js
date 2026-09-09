import { api } from './api.js';
import { liveRegion, mountLiveRegions, updateLiveView } from './live.js';
import { element, formatAgreement, formatDuration, formatMoney, formatNumber, formatPercent, statusLabel, titleCase } from './dom.js';
import { primaryScreening } from './models.js';
import { routeLink, sectionHeading } from './ui.js';
import { experimentHelpButton } from './experimentHelp.js';
import { helpButton } from './help.js';
import { evidenceExplorer } from './evidence.js';
import { sanitizeDiagnosticValue } from './diagnostics.js';

export const investigatorDefaults = {
  primaryReplicates: 2,
  maxTurns: 12,
  maxPrimaryEvaluations: 3,
  maxWallTimeMs: 14_400_000,
  maxAgentTokens: 2_000_000,
};

const actionNames = { test: 'Test', probe: 'Offline diagnostic probe', evaluate_primary: 'Primary evaluation', finalize: 'Finalize', abandon: 'Abandon' };
const knownNumber = (value, format = formatNumber) => Number.isFinite(value) ? format(value) : 'Unknown';
const isPrimaryTrial = (action) => action.kind === 'evaluate_primary' && action.admitted !== false;

function actionOutcome(action) {
  if (!action) return 'No actions recorded';
  if (action.kind === 'evaluate_primary' && action.admitted === false) return sanitizeDiagnosticValue(action.error) || 'Not admitted: diagnostic review required';
  if (action.status !== 'completed') return `${actionNames[action.kind] ?? 'Action'} ${action.status ?? 'status unknown'}`;
  if (action.kind === 'probe') {
    return action.result?.executionPassed === true ? 'Execution passed (diagnostic only)' : action.result?.executionPassed === false ? 'Execution failed (diagnostic only)' : 'Diagnostic execution result unknown';
  }
  if (action.kind === 'test') {
    return action.result?.passed === true ? 'Tests passed (not correctness)' : action.result?.passed === false ? 'Tests failed' : 'Test result unknown';
  }
  if (action.kind === 'evaluate_primary') {
    return action.result?.score?.verified || action.result?.score?.provisional ? 'Primary score recorded' : 'Primary result unknown';
  }
  return `${actionNames[action.kind] ?? 'Action'} completed`;
}

export function investigationSummary(investigation) {
  if (!investigation) return 'No investigation recorded';
  const actions = investigation.actions ?? [];
  const trials = actions.filter(isPrimaryTrial).length;
  const tests = actions.filter((action) => action.kind === 'test').length;
  return `${trials} primary trial${trials === 1 ? '' : 's'} / ${tests} test${tests === 1 ? '' : 's'}; latest: ${actionOutcome(actions.at(-1))}`;
}

const disclosureVersions = new WeakMap();
const archiveVersions = new WeakMap();

function disclosure(key, label, render, version) {
  const details = element('details', { attributes: { 'data-live-key': key } }, [element('summary', { text: label })]);
  return liveRegion(details, (mounted) => {
    const show = () => {
      if (!mounted.open || (mounted.children.length > 1 && version !== undefined && disclosureVersions.get(mounted) === version)) return;
      const content = render();
      if (mounted.children.length > 1) updateLiveView(mounted.children[1], content);
      else { mounted.append(content); mountLiveRegions(content); }
      disclosureVersions.set(mounted, version);
    };
    mounted.ontoggle = show;
    show();
  });
}

export function investigationStatus(campaign, variant) {
  const investigation = variant.investigation;
  if (!investigation) return element('p', { className: 'muted', text: 'No investigation recorded for this experiment.' });
  const actions = investigation.actions ?? [];
  const current = actions.findLast((action) => action.status === 'running');
  const limits = { ...investigatorDefaults, ...campaign.config.investigator };
  const grants = investigation.tokenGrants ?? [];
  const tokenLimit = grants.at(-1)?.effectiveLimit ?? limits.maxAgentTokens;
  const screening = primaryScreening(campaign, variant);
  const start = Date.parse(investigation.startedAt);
  const end = investigation.status === 'running' ? Date.now() : Date.parse(investigation.updatedAt);
  const values = [
    ['Stage', investigation.status === 'running' ? current ? actionNames[current.kind] ?? 'Action' : 'Between actions' : titleCase(investigation.status)],
    ['Session', investigation.sessionId ?? 'Not assigned'],
    ['Current action', current ? `${current.id} / ${actionNames[current.kind] ?? current.kind}` : 'None running'],
    ['Turns', `${knownNumber(investigation.turnCount)} / ${formatNumber(limits.maxTurns)}`],
    ['Primary trials', `${actions.filter(isPrimaryTrial).length} / ${formatNumber(limits.maxPrimaryEvaluations)}`],
    ['Primary screening', `${formatNumber(screening.replicateCount)} ${screening.countSource} / trial`],
    ['Baseline and final', `${formatNumber(campaign.config.evaluation.replicates)} / benchmark`],
    ['Wall time', `${knownNumber(Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null, formatDuration)} / ${formatDuration(limits.maxWallTimeMs)}`],
    ['Agent tokens', `${knownNumber(investigation.agentTokens)} / ${knownNumber(tokenLimit)}`],
    ['Agent cost', knownNumber(investigation.agentCostUsd, formatMoney)],
  ];
  return element('div', { className: 'investigation-status', attributes: { 'data-testid': `investigator-${variant.id}` } }, [
    element('div', { className: 'investigation-heading' }, [
      statusLabel(investigation.status),
      element('p', { text: investigationSummary(investigation) }),
    ]),
    element('dl', { className: 'investigation-metrics', attributes: { 'aria-label': 'Investigator session and budgets' } }, values.map(([label, value]) =>
      element('div', {}, [element('dt', { text: label }, label === 'Wall time' ? [helpButton(label)] : []), element('dd', { text: value })]),
    )),
    grants.length ? disclosure(`${variant.id}:token-grants`, 'Operator budget extensions', () =>
      element('div', {}, [
        element('p', { className: 'muted investigation-prose', text: 'Budget authorization only, not human-verified planner truth. Cumulative usage is retained; the session clock is unchanged.' }),
        element('p', { className: 'investigation-prose', text: `Frozen base cap: ${formatNumber(limits.maxAgentTokens)} tokens.` }),
        ...grants.map((grant) => element('div', { className: 'investigation-action-detail', attributes: { 'data-live-key': `${variant.id}:token-grant:${grant.id}` } }, [
          element('p', { className: 'identifier' }, [element('time', {
            text: `${new Date(grant.grantedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`,
            attributes: { datetime: grant.grantedAt },
          })]),
          element('p', { className: 'investigation-prose', text: `+${knownNumber(grant.additionalTokens)} tokens / New cap: ${knownNumber(grant.effectiveLimit)}` }),
          element('p', { className: 'muted investigation-prose', text: `Used at grant: ${knownNumber(grant.tokensAtGrant)} / Previous cap: ${knownNumber(grant.previousLimit)}` }),
          element('p', { className: 'investigation-prose', text: `Reason: ${sanitizeDiagnosticValue(grant.reason) ?? 'Not recorded'}` }),
        ])),
      ]), JSON.stringify([limits.maxAgentTokens, grants]),
    ) : null,
    investigation.reason ? disclosure(`${variant.id}:reason`, 'Recorded reason (unverified interpretation)', () =>
      element('p', { className: 'investigation-prose', text: investigation.reason }),
      investigation.reason,
    ) : null,
  ]);
}

function evaluationResult(result, campaign) {
  const score = result?.score;
  if (!score?.verified && !score?.provisional) return element('p', { className: 'muted', text: 'No readable score recorded. No improvement can be inferred.' });
  const baseline = result.baselineScore;
  const mean = campaign.config.investigator?.enabled || score.metricMode === 'replicate_mean';
  const rows = [
    ['Verified accuracy', score.verified?.accuracy, baseline?.verified?.accuracy],
    ['Provisional accuracy (LLM suggestion)', score.provisional?.accuracy, baseline?.provisional?.accuracy],
  ];
  return element('div', { className: 'investigation-evaluation' }, [
    element('p', { text: mean ? 'Score basis: replicate mean. Consensus decisions are separate.' : 'Score basis: consensus decisions.' }),
    element('p', { className: 'muted', text: 'Recorded scores against the frozen comparison reference, not a promotion decision. Unknown values are not zero.' }),
    element('div', { className: 'table-scroll' }, [
      element('table', {}, [
        element('caption', { text: 'Primary trial score comparison' }),
        element('thead', {}, [element('tr', {}, ['Dimension', 'Trial', 'Baseline'].map((label) => element('th', { text: label, attributes: { scope: 'col' } })))]),
        element('tbody', {}, rows.map(([label, value, previous]) => element('tr', {}, [
          element('th', { text: label, attributes: { scope: 'row' } }),
          element('td', { className: 'mono', text: knownNumber(value, formatPercent) }),
          element('td', { className: 'mono', text: knownNumber(previous, formatPercent) }),
        ]))),
      ]),
    ]),
    element('p', { className: 'muted', text: `Consensus agreement: ${formatAgreement(result.facts, result.replicateFacts?.length || result.facts?.sampleSize)}. Replicates recorded: ${Array.isArray(result.replicateFacts) ? result.replicateFacts.length : 'Unknown'}.` }),
    element('p', { className: 'muted', text: 'This screening evaluates the full primary pack. Provisional labels are acceptable; human-reviewed labels are not required to screen or finalize. A single replicate cannot measure agreement or establish stability.' }),
    element('p', { className: 'muted', text: 'The runtime answer ledger freezes repeated semantic answers within a pinned context. New questions or contexts can add answers; complete decision sets are not fixed. Inspect ledger receipts and question audits, not just input pins, when comparing trials.' }),
    Array.isArray(result.transitions) ? element('p', { className: 'muted', text: `Recorded decision transitions: ${formatNumber(result.transitions.length)}. Transition details remain in the collapsed raw result; they are observations, not verified improvements.` }) : null,
    element('p', { text: `Cohort mismatches: ${Array.isArray(score.cohortMismatches) ? score.cohortMismatches.join(', ') || 'None recorded' : 'Unknown'}.` }),
    result.labelSetHash ? element('p', { className: 'identifier', text: `Label set: ${result.labelSetHash}` }) : null,
    result.comparisonNotes ? element('div', {}, [
      element('h3', { className: 'suggestion', text: 'Comparison notes / unverified interpretation' }),
      element('p', { className: 'investigation-prose', text: Array.isArray(result.comparisonNotes) ? result.comparisonNotes.join('\n') : result.comparisonNotes }),
    ]) : null,
  ]);
}

export function investigationPanel(campaign, variant) {
  const investigation = variant.investigation;
  const panel = element('section', { className: 'investigation-panel' }, [
    sectionHeading('Experiment history', 'Investigation', 'The full loop: hypotheses, tests, measured trials, revisions, and finalization or abandonment. Each trial freezes its hypothesis and patch before evaluation; later revisions do not rewrite it.', experimentHelpButton('Investigation')),
    investigationStatus(campaign, variant),
  ]);
  if (!investigation) return panel;
  const latestTrial = investigation.actions?.findLast((action) => isPrimaryTrial(action) && action.status === 'completed');
  panel.append(element('section', { className: 'investigation-comparison' }, [
    element('h3', { text: 'Latest recorded primary comparison' }),
    latestTrial ? element('p', { className: 'identifier', text: `${latestTrial.id} / ${latestTrial.hypothesis?.title ?? 'Recorded hypothesis'}` }) : null,
    latestTrial ? element('div', {}, [
      element('p', { className: 'muted', text: 'Recorded action summary, not the latest unevaluated revision or a promotion decision. Open its timeline entry for score basis and comparison notes.' }),
      element('dl', { className: 'investigation-metrics' }, [
        ['Verified accuracy', 'verified'], ['Provisional accuracy (LLM suggestion)', 'provisional'],
      ].map(([label, dimension]) => element('div', {}, [
        element('dt', { text: label }), element('dd', { text: `Trial ${knownNumber(latestTrial.result?.score?.[dimension]?.accuracy, formatPercent)} / Frozen reference ${knownNumber(latestTrial.result?.baselineScore?.[dimension]?.accuracy, formatPercent)}` }),
      ]))),
    ]) : element('p', { className: 'muted', text: 'No completed primary trial is recorded. Tests and proposed revisions are not measured improvements.' }),
    evidenceExplorer(campaign, variant), evidenceExplorer(campaign, variant, true),
  ]));
  const root = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}/artifacts`;
  const body = element('tbody');
  for (const [index, action] of (investigation.actions ?? []).entries()) {
    const key = `${variant.id}:action:${action.id}`;
    const tests = action.kind === 'finalize' ? action.result?.tests : action.result;
    const logPaths = Array.isArray(tests?.logPaths) ? tests.logPaths : [];
    const details = disclosure(key, 'Hypothesis, result and logs', () => {
      const hypothesis = action.hypothesis;
      const review = action.result?.diagnosticReview;
      const content = element('div', { className: 'investigation-action-detail' }, [
        element('p', { className: 'suggestion', text: 'Agent interpretation / unverified' }),
        ...[
          ['Action rationale', action.rationale],
          ['Hypothesis', hypothesis?.title],
          ['Rationale', hypothesis?.rationale],
          ['Instructions', hypothesis?.instructions],
          ['Expected impact', hypothesis?.expectedImpact],
          ['Risk', hypothesis?.risk],
          ['Assumptions', Array.isArray(hypothesis?.assumptions) ? hypothesis.assumptions.join('\n') : hypothesis?.assumptions],
        ].filter(([, value]) => value).map(([label, value]) => element('div', {}, [
          element('h3', { text: label }), element('p', { className: 'investigation-prose', text: value }),
        ])),
        element('p', { className: 'identifier', text: `Started: ${action.startedAt ?? 'Unknown'} / Completed: ${action.completedAt ?? 'Not recorded'}` }),
        element('p', { className: 'identifier', text: `Patch: ${action.patchHash ?? 'Not recorded'}` }),
        action.error ? element('div', { className: 'error-panel' }, [element('h3', { text: 'Recorded action error' }), element('p', { className: 'investigation-prose', text: sanitizeDiagnosticValue(action.error) })]) : null,
        action.kind === 'probe' ? element('div', {}, [
          element('p', { text: actionOutcome(action) }),
          element('p', { className: 'muted', text: 'Offline execution only: not full configured tests, primary evaluation, or promotion. Diagnostic review is required before primary screening; a passing probe is optional.' }),
          element('p', { text: `Provider calls: ${knownNumber(action.result?.providerCalls)}` }),
          element('p', { className: 'identifier', text: `Input hash: ${action.result?.inputHash ?? 'Not recorded'}` }),
          element('p', { className: 'identifier', text: `Image: ${action.result?.imageId ?? 'Not recorded'}` }),
          typeof action.result?.interpretation === 'string' ? element('p', { className: 'suggestion investigation-prose', text: `Unverified interpretation: ${sanitizeDiagnosticValue(action.result.interpretation)}` }) : null,
        ]) : null,
        review && (action.kind === 'probe' || action.kind === 'evaluate_primary') ? element('div', {}, [
          element('h3', { className: 'suggestion', text: 'Diagnostic review / unverified model judgment' }),
          element('p', { className: 'muted', text: 'Structural recording is not diagnostic truth and contributes no scores. Inspect the full qualification and citations through the archive links below.' }),
          ...[
            ['Review hash', review.reviewHash], ['Review artifact hash', review.artifactHash], ['Review artifact', review.artifactPath],
          ].map(([label, value]) => element('p', { className: 'identifier', text: `${label}: ${value ?? 'Not recorded'}` })),
        ]) : null,
        isPrimaryTrial(action) ? evaluationResult(action.result, campaign) : null,
        action.kind === 'test' ? element('p', { text: `${actionOutcome(action)}. Passing tests do not establish planner correctness.` }) : null,
        action.kind === 'finalize' ? element('div', {}, [
          element('h3', { text: 'Finalization checks' }),
          element('p', { text: `Full configured tests: ${action.result?.tests?.passed === true ? 'Passed' : action.result?.tests?.passed === false ? 'Failed' : 'Unknown'}. Semantic review: ${action.result?.compliance?.status ?? 'Unknown'} (unverified model judgment).` }),
          element('p', { className: 'muted', text: 'Finalization is not promotion. Final primary, holdout, and configured excluded cohorts remain separate from development trials.' }),
        ]) : null,
        Array.isArray(action.result?.testFiles) ? element('p', { className: 'investigation-prose', text: action.result.testFiles.length ? `Test files: ${action.result.testFiles.join(', ')}` : 'Test scope: full configured gates.' }) : null,
      ]);
      content.append(disclosure(`${key}:artifacts`, 'Artifact paths and logs', () => {
        const archive = element('div', { className: 'investigation-artifacts' }, [
          element('p', { className: 'identifier', text: `Directory: ${action.artifactDirectory ?? 'Not recorded'}` }),
          ...logPaths.map((log) => element('p', { className: 'identifier', text: log })),
          routeLink('Browse experiment artifacts', `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=artifacts`),
        ]);
        return liveRegion(archive, function refreshArchive(mounted) {
          const version = JSON.stringify([action.artifactDirectory, logPaths, action.status]);
          if (archiveVersions.get(mounted) === version) return;
          archiveVersions.set(mounted, version);
          mounted.querySelector('.archive-error')?.remove();
          // Resolve links from the archive listing, never from agent-supplied URLs.
          api(root).then(({ files }) => {
            if (!mounted.isConnected || archiveVersions.get(mounted) !== version) return;
            const directory = String(action.artifactDirectory ?? (/^action-\d+$/.test(action.id) ? `investigation/${action.id}` : '')).replace(/\/$/, '');
            const relativeDirectory = directory.includes(`/${variant.id}/`) ? directory.split(`/${variant.id}/`).at(-1) : directory;
            const matches = files.filter(({ path }) =>
              logPaths.some((log) => typeof log === 'string' && (log === path || log.endsWith(`/${path}`))) ||
              (relativeDirectory && path.startsWith(`${relativeDirectory}/`)),
            );
            const listing = archive.cloneNode(true);
            listing.append(...matches.map((file) => element('a', {
              text: file.path,
              attributes: { href: `${root}?path=${encodeURIComponent(file.path)}`, target: '_blank', rel: 'noreferrer' },
            })));
            if (!matches.length) listing.append(element('p', { className: 'muted', text: 'No matching archived files yet. Browse the experiment archive for other evidence.' }));
            updateLiveView(mounted, listing);
          }).catch((error) => {
            if (!mounted.isConnected || archiveVersions.get(mounted) !== version) return;
            mounted.append(element('div', { className: 'archive-error' }, [
              element('p', { className: 'error-text', text: `Archive unavailable: ${error.message}` }),
              element('button', {
                className: 'button button-outline', text: 'Retry archive', attributes: { type: 'button' },
                on: { click: () => { archiveVersions.delete(mounted); refreshArchive(mounted); } },
              }),
            ]));
          });
        });
      }, JSON.stringify([action.artifactDirectory, logPaths, action.status])));
      if (action.result !== null && action.result !== undefined) content.append(disclosure(`${key}:raw`, 'Raw result (unverified; may include model output)', () =>
        element('pre', { className: 'investigation-raw', text: JSON.stringify(action.result, null, 2), attributes: { tabindex: '0', 'data-live-key': `${key}:raw-scroll` } }),
      ));
      return content;
    }, JSON.stringify(action));
    body.append(element('tr', { attributes: { 'data-testid': `investigation-action-${action.id}` } }, [
      element('th', { attributes: { scope: 'row' } }, [
        element('b', { text: `${index + 1}. ${actionNames[action.kind] ?? action.kind}` }),
        element('span', { className: 'identifier', text: action.id }),
      ]),
      element('td', {}, [
        element('p', { className: 'investigation-action-title', text: action.hypothesis?.title ?? 'No revised hypothesis recorded' }),
        element('code', { text: action.patchHash ? action.patchHash.slice(0, 16) : 'Patch not recorded', attributes: { title: action.patchHash } }),
      ]),
      element('td', {}, [
        statusLabel(action.status), element('p', { text: actionOutcome(action) }),
        isPrimaryTrial(action) && action.status === 'completed' && action.result?.score ? element('p', {
          className: 'investigation-score',
          text: `Verified: ${knownNumber(action.result.score.verified?.accuracy, formatPercent)} / Provisional: ${knownNumber(action.result.score.provisional?.accuracy, formatPercent)}${campaign.config.investigator?.enabled || action.result.score.metricMode === 'replicate_mean' ? ' (replicate mean)' : ''}`,
        }) : null,
        details,
      ]),
    ]));
  }
  panel.append(element('p', { className: 'muted investigation-note', text: 'Action order is recorded order. Hypotheses and action rationales are unverified interpretations; tests and probes measure execution only. Primary trials include admitted failed attempts and historical actions without admission metadata, but exclude requests that were not admitted.' }),
    investigation.actions?.length ? element('div', { className: 'table-scroll investigation-table-wrap', attributes: { 'data-live-key': `${variant.id}:timeline-scroll` } }, [
      element('table', { className: 'investigation-table' }, [
        element('caption', { text: 'Investigation action timeline' }),
        element('thead', {}, [element('tr', {}, ['Action', 'Hypothesis / revision', 'Outcome / evidence'].map((label) => element('th', { text: label, attributes: { scope: 'col' } })))]), body,
      ]),
    ]) : element('p', { className: 'empty-row', text: 'No actions recorded yet. This view updates as the investigator persists progress.' }),
  );
  return panel;
}
