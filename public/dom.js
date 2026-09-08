const listeners = new WeakMap();

export function syncListeners(target, source) {
  for (const [name, listener] of Object.entries(listeners.get(target) ?? {})) target.removeEventListener(name, listener);
  const next = listeners.get(source) ?? {};
  for (const [name, listener] of Object.entries(next)) target.addEventListener(name, listener);
  listeners.set(target, next);
}

export function element(tag, options = {}, children = []) {
  const value = document.createElement(tag);
  if (options.className) value.className = options.className;
  if (options.text !== undefined) value.textContent = String(options.text);
  for (const [name, attribute] of Object.entries(options.attributes ?? {})) {
    if (attribute !== undefined && attribute !== null && attribute !== false) {
      value.setAttribute(name, attribute === true ? '' : String(attribute));
    }
  }
  for (const [name, listener] of Object.entries(options.on ?? {})) {
    value.addEventListener(name, listener);
  }
  listeners.set(value, options.on ?? {});
  value.append(...children.filter(Boolean));
  return value;
}

export const text = (value) => document.createTextNode(String(value));

export function replace(target, children) {
  target.replaceChildren(...children.filter(Boolean));
}

export function option(value, label, selected = false) {
  const item = element('option', { text: label, attributes: { value } });
  item.selected = selected;
  return item;
}

export function tableCell(value, className = '') {
  return element('td', { text: value, className });
}

export function statusLabel(value) {
  return element('span', {
    className: `status status-${String(value).replaceAll('_', '-')}`,
    text: String(value).replaceAll('_', ' '),
  });
}

export function formatDuration(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export const formatNumber = (value) =>
  value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US');

export const formatMoney = (value) =>
  value === null || value === undefined ? '—' : `$${Number(value).toFixed(2)}`;

export const formatPercent = (value) =>
  value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`;

export const formatMeanScore = (score) =>
  `${formatPercent(score?.accuracy)} · ${formatNumber(score?.correct)}/${formatNumber(score?.labeled)} mean correct`;

export const formatAgreement = (facts, sampleSize = facts?.sampleSize) =>
  sampleSize === 1 ? 'Not measured (n=1)' : formatPercent(facts?.decisionAgreement);

export const shortSha = (value) => (value ? `${String(value).slice(0, 9)}…` : '—');

export const titleCase = (value) =>
  String(value ?? 'unknown')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
