import { api } from '../api.js';
import { element, formatNumber, formatPercent, statusLabel } from '../dom.js';
import { holdoutState, isPromotionEligible, scopedQuestions } from '../models.js';
import {
  experimentHeading,
  externalTraceLink,
  questionEntry,
  replicateTable,
  routeLink,
  scoreSummary,
  sectionHeading,
  usageSummary,
} from '../ui.js';

const tabs = [
  ['summary', 'Summary'],
  ['runs', 'Runs'],
  ['questions', 'Questions'],
  ['artifacts', 'Artifacts'],
];

function tabNavigation(campaign, variant, current, questionCount) {
  return element('nav', { className: 'tabs', attributes: { 'aria-label': 'Experiment detail sections' } },
    tabs.map(([tab, label]) => {
      const link = routeLink(
        tab === 'questions' ? `${label} (${questionCount})` : label,
        `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=${tab}`,
        current === tab ? 'active' : '',
      );
      if (current === tab) link.setAttribute('aria-current', 'page');
      return link;
    }),
  );
}

function summaryPanel(campaign, variant) {
  const relationship = element('dl', { className: 'definition-list' }, [
    element('div', {}, [element('dt', { text: 'Lifecycle' }), element('dd', {}, [statusLabel(variant.status)])]),
    element('div', {}, [element('dt', { text: 'Parent' }), element('dd', {}, [
      variant.parentVariantId
        ? routeLink(variant.parentVariantId, `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.parentVariantId)}`)
        : document.createTextNode('Frozen seed'),
    ])]),
    element('div', {}, [element('dt', { text: 'Current campaign head' }), element('dd', { text: variant.id === campaign.currentParentVariantId ? 'Yes' : 'No' })]),
    element('div', {}, [element('dt', { text: 'Holdout' }), element('dd', { text: holdoutState(campaign, variant, campaign.variants) })]),
    element('div', {}, [element('dt', { text: 'Artifact collection' }), element('dd', { text: variant.artifactCollectionComplete ? 'Complete' : 'Incomplete' })]),
    element('div', {}, [element('dt', { text: 'Replicate sample' }), element('dd', { text: formatNumber(variant.facts?.sampleSize) })]),
  ]);
  return element('div', { className: 'summary-grid' }, [
    element('section', {}, [sectionHeading('Rubric', 'Accuracy and agreement'), scoreSummary(variant)]),
    element('section', {}, [sectionHeading('Telemetry', 'End-to-end and planner-only'), usageSummary(campaign, variant)]),
    element('section', { className: 'summary-wide' }, [sectionHeading('Provenance', 'Experiment position'), relationship]),
    variant.error
      ? element('section', { className: 'error-panel summary-wide' }, [element('h2', { text: 'Recorded failure' }), element('p', { text: variant.error })])
      : null,
  ]);
}

function questionsPanel(variant) {
  const questions = scopedQuestions(variant);
  if (!questions.length) {
    return element('div', { className: 'empty-state compact' }, [
      element('h2', { text: 'No planner questions' }),
      element('p', { text: 'No questions were sent to the harness for any benchmark replicate.' }),
    ]);
  }
  return element('div', { className: 'question-list' }, questions.map(questionEntry));
}

function artifactsPanel(campaign, variant, context) {
  const target = element('div', { className: 'artifact-content' }, [
    element('p', { className: 'muted', text: 'Loading experiment archive…' }),
  ]);
  const root = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}`;
  api(`${root}/artifacts`)
    .then((artifacts) => {
      const files = artifacts.files.map((file) =>
        element('a', {
          attributes: {
            href: `${root}/artifacts?path=${encodeURIComponent(file.path)}`,
            target: '_blank',
            rel: 'noreferrer',
          },
        }, [element('span', { text: file.path }), element('small', { text: `${Math.ceil(file.size / 1024)} KiB` })]),
      );
      target.replaceChildren(
        element('div', { className: 'artifact-toolbar' }, [
          element('a', {
            className: 'button button-outline',
            text: 'Open experiment Markdown',
            attributes: { href: artifacts.reportUrl, target: '_blank', rel: 'noreferrer' },
          }),
        ]),
        element('div', { className: 'artifact-list' }, files.length ? files : [element('p', { text: 'No raw artifacts have been written yet.' })]),
      );
    })
    .catch((error) => {
      target.replaceChildren(element('p', { className: 'error-text', text: error.message }));
      context.notify(error.message);
    });
  return target;
}

export function experimentPage(context, route) {
  const campaign = context.state.campaign;
  const variant = campaign.variants.find((candidate) => candidate.id === route.params.variantId);
  if (!variant) return element('div', { className: 'empty-state', text: 'Experiment not found in this campaign.' });
  const selectedTab = tabs.some(([name]) => name === route.query.get('tab')) ? route.query.get('tab') : 'summary';
  const primary = campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary');
  const actions = [
    externalTraceLink(variant),
    routeLink(
      'Review requirements',
      `/campaigns/${encodeURIComponent(campaign.id)}/review/${encodeURIComponent(variant.id)}?benchmark=${encodeURIComponent(primary?.name ?? '')}&filter=all`,
      'button button-secondary',
    ),
  ].filter(Boolean);
  if (isPromotionEligible(campaign, campaign.variants, variant)) {
    actions.push(element('button', {
      className: 'button button-primary',
      text: 'Promote experiment',
      attributes: { type: 'button', disabled: context.state.pendingAction },
      on: { click: () => context.promoteVariant(variant.id) },
    }));
  }
  const questionCount = scopedQuestions(variant).length;
  const panel = selectedTab === 'runs'
    ? element('section', {}, [
        sectionHeading('Replicates', 'Configured run matrix', 'Planner totals count each primary and holdout execution exactly once.'),
        usageSummary(campaign, variant),
        replicateTable(campaign, variant),
      ])
    : selectedTab === 'questions'
      ? questionsPanel(variant)
      : selectedTab === 'artifacts'
        ? artifactsPanel(campaign, variant, context)
        : summaryPanel(campaign, variant);
  return element('div', { className: 'page' }, [
    experimentHeading(campaign, variant, context, actions),
    tabNavigation(campaign, variant, selectedTab, questionCount),
    element('div', { className: 'tab-panel' }, [panel]),
  ]);
}
