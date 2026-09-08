import { api, apiText } from '../api.js';
import { element, formatNumber, formatPercent, statusLabel } from '../dom.js';
import { holdoutState, isPromotionEligible, primaryScreening, scopedQuestions } from '../models.js';
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
import { targetExcludedPanel } from './targetExcluded.js';
import { investigationPanel, investigationSummary } from '../investigation.js';
import { experimentHelpButton } from '../experimentHelp.js';
import { liveRegion, updateLiveView } from '../live.js';

const tabs = [
  ['summary', 'Summary'],
  ['investigation', 'Investigation'],
  ['markdown', 'Markdown'],
  ['runs', 'Runs'],
  ['questions', 'Questions'],
  ['target-excluded', 'Target excluded'],
  ['artifacts', 'Artifacts'],
];

const markdownCache = new Map();
const markdownViewState = new Map();
const reportedMarkdownFailures = new Set();
const appliedMarkdownHashes = new Map();
const reportGenerations = new Map();
const markdownPanels = new WeakMap();
const artifactPanels = new WeakMap();
const markdownHeadingSelector = '[data-markdown-level="1"], [data-markdown-level="2"], [data-markdown-level="3"]';

export function invalidateExperimentMarkdown(campaignId) {
  reportGenerations.set(campaignId, (reportGenerations.get(campaignId) ?? 0) + 1);
  const prefix = `/api/campaigns/${encodeURIComponent(campaignId)}/`;
  for (const key of markdownCache.keys()) {
    if (key.startsWith(prefix)) markdownCache.delete(key);
  }
  for (const key of reportedMarkdownFailures) {
    if (key.startsWith(prefix)) reportedMarkdownFailures.delete(key);
  }
}

function reportRevision(campaign, variant) {
  return JSON.stringify([
    variant.updatedAt, variant.artifactCollectionComplete, variant.investigation?.updatedAt,
    reportGenerations.get(campaign.id) ?? 0,
  ]);
}

function loadExperimentMarkdown(reportUrl, revision) {
  const cached = markdownCache.get(reportUrl);
  if (cached?.revision === revision && !cached.failed) return cached.request;
  const request = apiText(reportUrl);
  const entry = { revision, request, failed: false };
  markdownCache.set(reportUrl, entry);
  request.catch(() => { entry.failed = true; });
  return request;
}

function scrollToMarkdownHeading(content, heading, behavior) {
  const top = heading.getBoundingClientRect().top
    - content.getBoundingClientRect().top
    + content.scrollTop
    - 14;
  content.scrollTo({ top, behavior });
}

function updateMarkdownSection(region) {
  const content = region.querySelector('.experiment-markdown');
  const headings = [...content.querySelectorAll(markdownHeadingSelector)];
  const links = [...region.querySelectorAll('.markdown-toc-link')];
  const contentTop = content.getBoundingClientRect().top;
  let active = 0;
  for (const [index, heading] of headings.entries()) {
    if (heading.getBoundingClientRect().top - contentTop <= 28) active = index;
  }
  for (const [index, link] of links.entries()) {
    link.classList.toggle('active', index === active);
    if (index === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
  const activeLink = links[active];
  const navigation = region.querySelector('.markdown-toc');
  if (activeLink) {
    const linkBox = activeLink.getBoundingClientRect();
    const navigationBox = navigation.getBoundingClientRect();
    if (linkBox.top < navigationBox.top) navigation.scrollTop -= navigationBox.top - linkBox.top;
    else if (linkBox.bottom > navigationBox.bottom) navigation.scrollTop += linkBox.bottom - navigationBox.bottom;
  }
}

function applyMarkdownHash(region, reportKey) {
  if (!region.isConnected || appliedMarkdownHashes.get(reportKey) === location.hash) return;
  const content = region.querySelector('.experiment-markdown');
  const heading = [...content.querySelectorAll(markdownHeadingSelector)]
    .find((candidate) => `#${candidate.id}` === location.hash);
  if (!heading) return;
  appliedMarkdownHashes.set(reportKey, location.hash);
  heading.focus({ preventScroll: true });
  scrollToMarkdownHeading(content, heading, 'auto');
  updateMarkdownSection(region);
}

function renderMarkdownContents(region, html, reportKey) {
  const content = region.querySelector('.experiment-markdown');
  const navigation = region.querySelector('.markdown-toc');
  const navigationLinks = navigation.querySelector('.markdown-toc-links');
  const firstRender = markdownPanels.get(region).html === undefined;
  const viewState = firstRender ? markdownViewState.get(reportKey) : null;
  const scrollTop = viewState?.scrollTop ?? content.scrollTop;
  const scrollLeft = viewState?.scrollLeft ?? content.scrollLeft;
  const tocTop = viewState?.tocTop ?? navigation.scrollTop;
  const tocLeft = viewState?.tocLeft ?? navigation.scrollLeft;
  const focused = document.activeElement;
  const focusedHere = region.contains(focused);
  const focusedHref = focusedHere ? focused.getAttribute('href') : null;
  const focusScope = navigation.contains(focused) ? navigationLinks : content;
  const focusedOccurrence = focusedHref ? [...focusScope.querySelectorAll('a')]
    .filter((link) => link.getAttribute('href') === focusedHref).indexOf(focused) : -1;
  const focusedHeadingId = focusedHere && focused.matches('[data-markdown-level]') ? focused.id : null;
  const nestedScroll = [...content.querySelectorAll('*')]
    .filter((node) => node.scrollTop || node.scrollLeft)
    .map((node) => [node, node.scrollTop, node.scrollLeft]);
  // The server sanitizes HTML and assigns stable heading ids; keep the native parsing pipeline.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const nextContent = content.cloneNode(false);
  nextContent.append(...parsed.body.childNodes);
  const headings = [...nextContent.querySelectorAll(markdownHeadingSelector)];
  for (const heading of headings) heading.setAttribute('tabindex', '-1');
  const links = headings.map((heading) => {
    const level = heading.getAttribute('data-markdown-level') ?? '1';
    return element('a', {
      className: `markdown-toc-link markdown-toc-level-${level}`,
      text: heading.textContent,
      attributes: { href: `#${heading.id}` },
    });
  });
  updateLiveView(content, nextContent);
  updateLiveView(navigationLinks, element('div', { className: 'markdown-toc-links' }, links));
  if (focusedHere && document.activeElement !== focused) {
    const target = focused.isConnected ? focused : focusedHeadingId
      ? [...content.querySelectorAll(markdownHeadingSelector)].find((heading) => heading.id === focusedHeadingId)
      : focusedHref ? [...focusScope.querySelectorAll('a')]
        .filter((link) => link.getAttribute('href') === focusedHref)[focusedOccurrence] : content;
    (target ?? content).focus({ preventScroll: true });
  }
  for (const [node, top, left] of nestedScroll) {
    if (node.isConnected) node.scrollTo({ top, left, behavior: 'instant' });
  }
  content.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'instant' });
  updateMarkdownSection(region);
  navigation.scrollTop = tocTop;
  navigation.scrollLeft = tocLeft;
  applyMarkdownHash(region, reportKey);
}

function markdownPanel(campaign, variant, context) {
  const reportUrl = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}/report`;
  const renderedUrl = `${reportUrl}?format=html`;
  const routeKey = `${location.pathname}${location.search}`;
  const content = element('article', {
    className: 'experiment-markdown markdown-body',
    attributes: {
      'aria-busy': 'true',
      'aria-label': 'Rendered experiment Markdown',
      'data-report-url': renderedUrl,
      'data-testid': 'experiment-markdown',
      tabindex: '0',
    },
  }, [element('p', { className: 'muted', text: 'Loading experiment Markdown…' })]);
  const navigationLinks = element('div', { className: 'markdown-toc-links' }, [
    element('p', { className: 'muted', text: 'Loading sections…' }),
  ]);
  const navigation = element('nav', {
    className: 'markdown-toc',
    attributes: { 'aria-label': 'On this page' },
  }, [element('p', { className: 'overline', text: 'On this page' }), navigationLinks]);
  const layout = liveRegion(element('div', {
    className: 'markdown-layout', attributes: { 'data-live-key': renderedUrl },
  }, [navigation, content]), (region) => {
    if (!region.isConnected || `${location.pathname}${location.search}` !== routeKey) return;
    let state = markdownPanels.get(region);
    if (!state) {
      state = { generation: 0, html: undefined, request: null };
      markdownPanels.set(region, state);
      // Install once on the mounted region, and resolve headings/links from its current DOM.
      region.addEventListener('scroll', (event) => {
        if (!region.isConnected) return;
        const article = region.querySelector('.experiment-markdown');
        const toc = region.querySelector('.markdown-toc');
        if (event.target === article) updateMarkdownSection(region);
        if (state.html !== undefined) markdownViewState.set(renderedUrl, {
          scrollTop: article.scrollTop, scrollLeft: article.scrollLeft,
          tocTop: toc.scrollTop, tocLeft: toc.scrollLeft,
        });
      }, { capture: true, passive: true });
      region.addEventListener('click', (event) => {
        const link = event.target.closest('.markdown-toc-link');
        if (!link || !region.contains(link) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const article = region.querySelector('.experiment-markdown');
        const hash = link.getAttribute('href');
        const heading = [...article.querySelectorAll(markdownHeadingSelector)].find((node) => `#${node.id}` === hash);
        if (!heading) return;
        event.preventDefault();
        if (location.hash !== hash) history.pushState(history.state, '', `${location.pathname}${location.search}${hash}`);
        appliedMarkdownHashes.set(renderedUrl, hash);
        heading.focus({ preventScroll: true });
        scrollToMarkdownHeading(article, heading, matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
      });
    }
    applyMarkdownHash(region, renderedUrl);
    const revision = reportRevision(campaign, variant);
    const request = loadExperimentMarkdown(renderedUrl, revision);
    if (state.request === request) return;
    state.request = request;
    const generation = ++state.generation;
    const reportGeneration = reportGenerations.get(campaign.id) ?? 0;
    const isCurrent = () => region.isConnected && state.generation === generation &&
      `${location.pathname}${location.search}` === routeKey &&
      (reportGenerations.get(campaign.id) ?? 0) === reportGeneration &&
      markdownCache.get(renderedUrl)?.request === request;
    const article = region.querySelector('.experiment-markdown');
    if (state.html === undefined) article.setAttribute('aria-busy', 'true');
    request.then((html) => {
      if (!isCurrent()) return;
      if (state.html !== html) renderMarkdownContents(region, html, renderedUrl);
      state.html = html;
      if (article.getAttribute('aria-busy') !== 'false') article.setAttribute('aria-busy', 'false');
      reportedMarkdownFailures.delete(renderedUrl);
    }).catch((error) => {
      if (!isCurrent()) return;
      markdownCache.delete(renderedUrl);
      const message = 'Experiment Markdown is unavailable.';
      if (state.html === undefined) {
        article.replaceChildren(element('code', { className: 'error-text', text: message }));
        region.querySelector('.markdown-toc-links').replaceChildren();
      }
      article.setAttribute('aria-busy', 'false');
      if (!reportedMarkdownFailures.has(renderedUrl)) {
        reportedMarkdownFailures.add(renderedUrl);
        context.notify(`${message} ${error.message}`);
      }
    });
  });
  const rawLink = element('a', {
    className: 'button button-outline markdown-raw-link',
    text: 'Open raw Markdown',
    attributes: { href: reportUrl, target: '_blank', rel: 'noreferrer' },
  });
  return element('section', { className: 'markdown-panel' }, [
    sectionHeading(
      'Research record',
      'Experiment Markdown',
       variant.investigation
         ? 'Living experiment report: the latest hypothesis, recorded trials, results, and outcome. This is not a finalized plan; finalization, when reached, is recorded explicitly. Investigation contains the detailed history.'
         : 'Assumptions and model interpretations remain labeled separately from measured and human-verified evidence.',
       experimentHelpButton('Markdown'),
    ),
    element('div', { className: 'artifact-toolbar' }, [rawLink]),
    layout,
  ]);
}

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
    element('div', {}, [element('dt', { text: 'Investigation' }), element('dd', {}, [
      routeLink(investigationSummary(variant.investigation), `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=investigation`),
    ])]),
  ]);
  return element('div', { className: 'summary-grid' }, [
    element('section', {}, [sectionHeading('Rubric', 'Accuracy and agreement'), scoreSummary(variant, campaign)]),
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
  const root = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}`;
  const routeKey = `${location.pathname}${location.search}`;
  return liveRegion(element('div', {
    className: 'artifact-content', attributes: { 'data-live-key': `${root}/artifacts` },
  }, [
    element('p', { className: 'muted', text: 'Loading experiment archive…' }),
  ]), (target) => {
    if (!target.isConnected || `${location.pathname}${location.search}` !== routeKey) return;
    let state = artifactPanels.get(target);
    if (!state) {
      state = { generation: 0, revision: null, listing: null, pending: false, loaded: false };
      artifactPanels.set(target, state);
    }
    const revision = reportRevision(campaign, variant);
    if (state.revision === revision && (state.pending || state.loaded)) return;
    state.revision = revision;
    state.pending = true;
    state.loaded = false;
    const generation = ++state.generation;
    const reportGeneration = reportGenerations.get(campaign.id) ?? 0;
    const isCurrent = () => target.isConnected && state.generation === generation &&
      `${location.pathname}${location.search}` === routeKey &&
      (reportGenerations.get(campaign.id) ?? 0) === reportGeneration;
    api(`${root}/artifacts`)
      .then((artifacts) => {
        if (!isCurrent()) return;
        state.pending = false;
        const listing = JSON.stringify(artifacts);
        if (state.listing !== listing) {
          const files = artifacts.files.map((file) =>
            element('a', {
              attributes: {
                href: `${root}/artifacts?path=${encodeURIComponent(file.path)}`,
                target: '_blank',
                rel: 'noreferrer',
              },
            }, [element('span', { text: file.path }), element('small', { text: `${Math.ceil(file.size / 1024)} KiB` })]),
          );
          const focused = document.activeElement;
          const focusedHere = target.contains(focused);
          updateLiveView(target, element('div', {
            className: 'artifact-content', attributes: { 'data-live-key': `${root}/artifacts` },
          }, [
            element('div', { className: 'artifact-toolbar' }, [
              element('a', {
                className: 'button button-outline',
                text: 'Open experiment Markdown',
                attributes: { href: artifacts.reportUrl, target: '_blank', rel: 'noreferrer' },
              }),
            ]),
            element('div', { className: 'artifact-list' }, files.length ? files : [element('p', { text: 'No raw artifacts have been written yet.' })]),
          ]));
          if (focusedHere && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
          state.listing = listing;
        }
        state.loaded = true;
        state.error = null;
      })
      .catch((error) => {
        if (!isCurrent()) return;
        state.pending = false;
        if (state.listing === null) target.replaceChildren(element('p', { className: 'error-text', text: error.message }));
        if (state.error !== error.message) context.notify(error.message);
        state.error = error.message;
      });
  });
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
  const screening = primaryScreening(campaign, variant);
  const panel = selectedTab === 'runs'
    ? element('section', {}, [
        sectionHeading(
          'Replicates',
          screening.active ? 'Full-primary screening' : 'Configured run matrix',
          screening.active
            ? `${screening.replicateCount} ${screening.countSource} replicate(s) for the latest primary screening. These are full-pack development runs, not final results. Holdout and excluded cohorts run after finalization.`
            : 'Planner totals count standard primary and holdout executions only; target-excluded guard runs are excluded from totals.',
        ),
        usageSummary(campaign, variant),
        replicateTable(campaign, variant),
      ])
    : selectedTab === 'investigation'
      ? investigationPanel(campaign, variant)
    : selectedTab === 'markdown'
      ? markdownPanel(campaign, variant, context)
      : selectedTab === 'questions'
      ? questionsPanel(variant)
      : selectedTab === 'target-excluded'
        ? targetExcludedPanel(context, campaign, variant)
      : selectedTab === 'artifacts'
        ? artifactsPanel(campaign, variant, context)
        : summaryPanel(campaign, variant);
  return element('div', { className: 'page' }, [
    experimentHeading(campaign, variant, context, actions),
    tabNavigation(campaign, variant, selectedTab, questionCount),
    element('div', { className: 'tab-panel' }, [panel]),
  ]);
}
