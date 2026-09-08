import { element } from './dom.js';

export function experimentHelpButton(view) {
  return element('button', {
    className: 'experiment-help-trigger',
    attributes: {
      type: 'button', 'aria-label': `Help with ${view}`, 'aria-haspopup': 'dialog',
      'data-experiment-help': view, title: 'How to read Investigation and Markdown',
    },
    on: { click: (event) => {
      if (document.querySelector('.experiment-help-dialog')) return;
      const origin = event.currentTarget;
      const listeners = new AbortController();
      const close = element('button', {
        className: 'button button-ghost button-compact', text: 'Close',
        attributes: { type: 'button', 'aria-label': 'Close help', autofocus: true },
        on: { click: () => dialog.close() },
      });
      const dialog = element('dialog', {
        className: 'experiment-help-dialog',
        attributes: { 'aria-labelledby': 'experiment-help-title', 'aria-describedby': 'experiment-help-intro' },
        on: {
          close: () => {
            listeners.abort();
            dialog.remove();
            // A live refresh may have replaced the original button while help was open.
            const trigger = origin.isConnected ? origin
              : document.querySelector(`[data-experiment-help="${CSS.escape(view)}"]`);
            trigger?.focus({ preventScroll: true });
          },
          click: (event) => {
            if (event.target !== dialog) return;
            const box = dialog.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
          },
        },
      }, [
        element('header', { className: 'experiment-help-header' }, [
          element('h2', { text: 'One experiment, two views', attributes: { id: 'experiment-help-title' } }), close,
        ]),
        element('p', { className: 'muted', text: 'Markdown tells the story. Investigation shows how it unfolded.', attributes: { id: 'experiment-help-intro' } }),
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
        element('p', { className: 'experiment-help-note', text: 'Each evaluated trial keeps its original hypothesis and patch. Later revisions do not rewrite earlier results.' }),
        element('p', { className: 'experiment-help-scores muted', text: 'Provisional scores use AI-suggested answers; verified scores use human-reviewed answers. Agreement measures consistency between repeated runs, not accuracy.' }),
      ]);
      window.addEventListener('popstate', () => dialog.close(), { signal: listeners.signal });
      document.body.append(dialog);
      dialog.showModal();
    } },
  }, [element('span', { className: 'experiment-help-icon', text: '?', attributes: { 'aria-hidden': true } })]);
}
