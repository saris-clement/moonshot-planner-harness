import { element } from './dom.js';

const timing = {
  'End-to-end': {
    intro: 'Elapsed time for this execution: how long the experiment takes from start to finish.',
    detail: 'Includes investigation, tests, setup, evaluation, judging, collection, and diagnosis. It excludes later human review or promotion. The clock resets when execution resumes; it is not lifetime campaign time.',
  },
  'Phase 2': {
    intro: 'Time spent running the baseline or final evaluation batch, after the planner services are ready (after stack startup).',
    detail: 'Includes waiting and configured target-excluded work. It does not include investigation trials, builds, or later judging.',
  },
  'Planner duration': {
    intro: 'Sum of planner-reported durations: model time added across the runs shown here.',
    detail: 'This is not wall-clock or active time. During screening it covers the latest trial, not every attempt; final cohorts replace that trial scope. It excludes investigator-agent and target-excluded usage.',
  },
  'Wall elapsed': {
    intro: 'Time spent on this one run, from startup through result capture, including setup and waiting.',
    detail: 'A replicate is one repeated run. This clock includes service health checks, requirements upload, and waiting for answers. A screening row belongs to the latest trial; baseline and final rows belong to their own evaluations.',
  },
  'Model duration': {
    intro: 'Model time reported for this replicate (one repeated run), rather than its total elapsed time.',
    detail: 'This is reported usage duration, not a wall-clock or active-time measurement. Read it in the scope of its row: the latest screening trial, or a baseline or final cohort.',
  },
  'Wall time': {
    intro: 'Time since the investigator session started, compared with its configured wall-time budget.',
    detail: 'Runs from session start to now while running, or to its last recorded update after it stops. Includes time between actions, tests, and screening; it is not planner model duration or the final evaluation clock.',
  },
};

const timingNote = 'A dash means missing, not zero. Parallel times overlap and cannot be added or subtracted to calculate wall time.';

function experimentContent() {
  return [
    element('section', {}, [
      element('h3', { text: 'Investigation: follow the attempts' }),
      element('p', { text: 'See each idea, code change, test, evaluation, and decision to revise or stop.' }),
      element('p', { className: 'experiment-help-example' }, [
        element('span', { text: 'Example' }),
        element('span', { text: 'Try A. Results get worse. Adjust it to B and test again.' }),
      ]),
    ]),
    element('section', {}, [
      element('h3', { text: 'Markdown: read the summary' }),
      element('p', { text: 'Read the latest approach, results, and outcome in one report. It updates as the experiment evolves; it is not automatically a final plan.' }),
      element('p', { className: 'experiment-help-example' }, [
        element('span', { text: 'Example' }),
        element('span', { text: 'A scored 33%. B is the latest revision, but has no score yet.' }),
      ]),
    ]),
    element('p', { className: 'help-note', text: 'Each evaluated trial keeps its original hypothesis and patch. Later revisions do not rewrite earlier results.' }),
    element('p', { className: 'experiment-help-scores muted', text: 'Provisional scores use AI-suggested answers; verified scores use human-reviewed answers. Agreement measures consistency between repeated runs, not accuracy.' }),
  ];
}

function guideContent() {
  const steps = [
    ['Start from evidence', 'Read the baseline diagnosis, source, and archived evidence before proposing a change.'],
    ['Investigate, edit, test, freeze, screen, inspect', 'One persistent session inspects source and edits the planner, then requests tests and full-primary screening from the coordinator. Each trial freezes its hypothesis and patch before evaluation.'],
    ['Revise, abandon, or finalize', 'Inspect the measured trial, then revise and repeat within the budgets, abandon the idea, or request finalization. Full-primary screening is development, not final validation.'],
    ['Check finalization', 'Run the full configured tests and an independent AI compliance review. Passing tests do not establish accuracy; compliance is an unverified model judgment.'],
    ['Evaluate final cohorts and score', 'Run repeated primary and holdout/regression evaluations, plus configured target-excluded evaluation. Score these final cohorts separately from development trials.'],
    ['Promote an eligible candidate or reject it', 'Finalization is not promotion. Supervised mode requires a human promotion decision for an eligible candidate. Automatic mode can promote only when the configured eligibility checks pass; an ineligible candidate is not promoted.'],
  ];
  return [
    element('section', {}, [
      element('h3', { text: 'Getting started' }),
      element('p', { text: 'Create a campaign with a research goal, planner and workflows revisions, requirements packs, models, and budgets. Check the frozen inputs, then run the baseline before starting a round.' }),
      element('p', { className: 'muted', text: 'Autonomous investigation is optional and separate from supervised or automatic campaign control. With it disabled, experiments use the standard candidate workflow.' }),
    ]),
    element('section', {}, [
      element('h3', { text: 'Where to look' }),
      element('dl', { className: 'help-locations' }, [
        ['Overview', 'Watch active work and replicate timing. Use the question-mark chips to check each clock.'],
        ['Experiments and Lineage', 'Compare candidates, their parents, and recorded outcomes.'],
        ['Investigation and Markdown', 'Follow individual attempts in Investigation; read the latest story in Markdown.'],
        ['Runs, Artifacts, and Review', 'Inspect measured output and archived evidence, then record human-reviewed labels in Review.'],
      ].map(([label, description]) => element('div', {}, [
        element('dt', { text: label }), element('dd', { text: description }),
      ]))),
    ]),
    element('section', {}, [
      element('h3', { text: 'How autonomous investigation works' }),
      element('ol', { className: 'help-steps', attributes: { 'aria-label': 'Autonomous investigation steps' } }, steps.map(([title, description]) =>
        element('li', {}, [element('h4', { text: title }), element('p', { text: description })]),
      )),
    ]),
    element('section', {}, [
      element('h3', { text: 'Reading results' }),
      element('p', { text: 'Verified scores use human-reviewed labels. Provisional scores use AI suggestions, not verified truth. Agreement measures consistency across repeated runs, not accuracy.' }),
      element('p', { className: 'muted', text: 'Check whether you are viewing the latest trial or final cohorts. Tests, model interpretations, and measured planner results are different evidence sources.' }),
      element('p', { className: 'help-note', text: timingNote }),
    ]),
  ];
}

export function helpButton(topic) {
  const global = topic === 'global';
  const experiment = topic === 'Investigation' || topic === 'Markdown';
  const content = global
    ? { title: 'Planner harness help', intro: 'Run experiments, inspect evidence, and keep measured results separate from interpretation.' }
    : experiment
      ? { title: 'One experiment, two views', intro: 'Markdown tells the story. Investigation shows how it unfolded.' }
      : { title: topic, ...timing[topic] };
  const label = global ? 'Help' : `Help with ${topic}`;
  return element('button', {
    className: global ? 'button button-ghost button-compact global-help-trigger'
      : `help-trigger ${experiment ? 'experiment-help-trigger' : 'timing-help-trigger'}`,
    attributes: {
      type: 'button', 'aria-label': label, 'aria-haspopup': 'dialog', 'data-help-topic': topic,
      'data-experiment-help': experiment ? topic : null,
      title: experiment ? 'How to read Investigation and Markdown' : label,
    },
    on: { click: (event) => {
      if (document.querySelector('.help-dialog')) return;
      const origin = event.currentTarget;
      const scope = origin.closest('[data-live-key], [data-testid]');
      const scopeAttribute = scope?.hasAttribute('data-live-key') ? 'data-live-key' : 'data-testid';
      const scopeSelector = scope ? `[${scopeAttribute}="${CSS.escape(scope.getAttribute(scopeAttribute))}"]` : null;
      const listeners = new AbortController();
      const close = element('button', {
        className: 'button button-ghost button-compact', text: 'Close',
        attributes: { type: 'button', 'aria-label': 'Close help', autofocus: true },
        on: { click: () => dialog.close() },
      });
      const dialog = element('dialog', {
        className: `help-dialog${global ? ' global-help-dialog' : experiment ? ' experiment-help-dialog' : ''}`,
        attributes: { 'aria-labelledby': 'help-title', 'aria-describedby': 'help-intro' },
        on: {
          close: () => {
            listeners.abort();
            const restoreFocus = document.activeElement === document.body || document.activeElement === origin || dialog.contains(document.activeElement);
            dialog.remove();
            // Live rendering may replace the trigger; retain its experiment/replicate scope.
            const root = scopeSelector ? document.querySelector(scopeSelector) : document;
            const trigger = origin.isConnected ? origin : root?.querySelector(`[data-help-topic="${CSS.escape(topic)}"]`);
            if (restoreFocus) trigger?.focus({ preventScroll: true });
          },
          click: (event) => {
            if (event.target !== dialog) return;
            const box = dialog.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
          },
        },
      }, [
        element('header', { className: 'help-header' }, [
          element('h2', { text: content.title, attributes: { id: 'help-title' } }), close,
        ]),
        element('div', { className: 'help-body', attributes: { tabindex: '0', 'aria-label': 'Help content' } }, [
          element('p', { className: 'help-intro muted', text: content.intro, attributes: { id: 'help-intro' } }),
          ...(global ? guideContent() : experiment ? experimentContent() : [
            element('p', { text: content.detail }),
            element('p', { className: 'help-note muted', text: timingNote }),
          ]),
        ]),
      ]);
      window.addEventListener('popstate', () => dialog.close(), { signal: listeners.signal });
      window.navigation?.addEventListener('navigate', () => dialog.close(), { signal: listeners.signal });
      document.body.append(dialog);
      dialog.showModal();
    } },
  }, [global ? element('span', { text: 'Help' }) : element('span', {
    className: 'help-icon', text: '?', attributes: { 'aria-hidden': true },
  })]);
}

export function globalHelpButton() {
  return helpButton('global');
}
