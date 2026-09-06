import { api, uploadRequirementsZip } from '../api.js';
import { element, option, text } from '../dom.js';
import { pageHeading } from '../ui.js';

function field(labelText, name, attributes = {}, className = '') {
  const tag = attributes.multiline ? 'textarea' : attributes.options ? 'select' : 'input';
  const control = element(tag, {
    attributes: { name, id: `campaign-${name}`, ...attributes, multiline: null, options: null },
  });
  if (attributes.options) {
    for (const [value, label] of attributes.options) control.append(option(value, label));
  }
  return element('label', { className, attributes: { for: `campaign-${name}` } }, [
    element('span', { text: labelText }),
    control,
  ]);
}

function section(label) {
  return element('p', { className: 'form-section', text: label });
}

export function newCampaignPage(context) {
  const form = element('form', { className: 'campaign-form', attributes: { id: 'campaign-form' } }, [
    section('Identity'),
    field('Campaign ID', 'id', {
      required: true,
      pattern: '[a-z0-9]+(?:-[a-z0-9]+)*',
      placeholder: 'phase2-source-search',
    }),
    field('Control mode', 'mode', { options: [['supervised', 'Supervised'], ['automatic', 'Automatic']] }),
    field('Research goal', 'goal', {
      required: true,
      minlength: 20,
      multiline: true,
      placeholder: 'Improve generic source-backed adjudication without workflow-specific production rules.',
    }, 'wide'),
    section('Frozen inputs'),
    field('Planner repository', 'plannerRepo', { required: true }, 'wide'),
    field('Workflows repository', 'workflowsRepo', { required: true }, 'wide'),
    field('Planner environment file', 'environmentFile', { required: true }, 'wide'),
    field('Planner seed revision', 'seedRevision', { required: true }),
    field('Workflows revision', 'workflowsRevision', { required: true }),
    section('Benchmarks'),
    field('Primary benchmark name', 'primaryName', { required: true, value: 'deceased-account' }),
    field('Primary requirements ZIP', 'primaryFile', { required: true, type: 'file', accept: '.zip,application/zip' }),
    field('Holdout benchmark name', 'holdoutName', { required: true, value: 'unrelated-holdout' }),
    field('Holdout requirements ZIP', 'holdoutFile', { required: true, type: 'file', accept: '.zip,application/zip' }),
    section('Execution limits'),
    field('Replicates per benchmark', 'replicates', { required: true, type: 'number', min: 1, max: 10, value: 3 }),
    field('Concurrent replicates', 'replicateConcurrency', { required: true, type: 'number', min: 1, max: 3, value: 2 }),
    field('Parallel variants', 'concurrency', { required: true, type: 'number', min: 1, max: 3, value: 3 }),
    field('Maximum variants', 'maxVariants', { required: true, type: 'number', min: 1, max: 50, value: 9 }),
    element('label', { className: 'checkbox wide', attributes: { for: 'campaign-autoApprove' } }, [
      element('input', { attributes: { id: 'campaign-autoApprove', name: 'autoApprove', type: 'checkbox' } }),
      text('Allow unattended OpenCode tools'),
    ]),
  ]);
  const submit = element('button', {
    className: 'button button-primary',
    text: 'Create frozen campaign',
    attributes: { type: 'submit' },
  });
  const cancel = element('button', {
    className: 'button button-ghost',
    text: 'Cancel',
    attributes: { type: 'button' },
    on: { click: () => context.navigate('/') },
  });
  form.append(element('div', { className: 'form-actions wide' }, [submit, cancel]));

  api('/api/defaults')
    .then((defaults) => {
      for (const [name, value] of Object.entries(defaults)) {
        const input = form.elements.namedItem(name);
        if (input && !input.value) input.value = value;
      }
    })
    .catch((error) => context.notify(error.message));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const primaryFile = values.get('primaryFile');
    const holdoutFile = values.get('holdoutFile');
    if (!(primaryFile instanceof File) || !(holdoutFile instanceof File)) {
      context.notify('Select both requirements ZIP files');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Uploading benchmark packs…';
    try {
      const [primaryUpload, holdoutUpload] = await Promise.all([
        uploadRequirementsZip(primaryFile),
        uploadRequirementsZip(holdoutFile),
      ]);
      submit.textContent = 'Freezing campaign inputs…';
      const campaign = await api('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          id: values.get('id'),
          goal: values.get('goal'),
          plannerRepo: values.get('plannerRepo'),
          workflowsRepo: values.get('workflowsRepo'),
          environmentFile: values.get('environmentFile'),
          seedRevision: values.get('seedRevision'),
          workflowsRevision: values.get('workflowsRevision'),
          benchmarks: [
            { name: values.get('primaryName'), role: 'primary', zipPath: primaryUpload.path, sha256: primaryUpload.sha256 },
            { name: values.get('holdoutName'), role: 'holdout', zipPath: holdoutUpload.path, sha256: holdoutUpload.sha256 },
          ],
          mode: values.get('mode'),
          evaluation: {
            replicates: Number(values.get('replicates')),
            replicateConcurrency: Number(values.get('replicateConcurrency')),
          },
          limits: {
            concurrency: Number(values.get('concurrency')),
            maxVariants: Number(values.get('maxVariants')),
          },
          agent: { autoApprove: values.get('autoApprove') === 'on' },
        }),
      });
      await context.reloadCampaigns();
      context.notify('Frozen campaign created');
      context.navigate(`/campaigns/${encodeURIComponent(campaign.id)}/overview`, { force: true });
    } catch (error) {
      context.notify(error.message);
      submit.disabled = false;
      submit.textContent = 'Create frozen campaign';
    }
  });

  return element('div', { className: 'page new-campaign-page' }, [
    pageHeading(
      'Campaign setup',
      'Create an evaluation campaign',
      'Freeze planner, source, benchmark packs, model profile, and search limits before running.',
    ),
    element('div', { className: 'setup-layout' }, [
      element('aside', { className: 'setup-note' }, [
        element('strong', { text: 'Local-only coordinator' }),
        element('p', {}, [text('No planner branches are pushed. Raw outputs remain under '), element('code', { text: '.data/' }), text('.')]),
      ]),
      form,
    ]),
  ]);
}
