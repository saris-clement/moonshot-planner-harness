import { syncListeners } from './dom.js';

const updates = new WeakMap();
const deferred = new WeakMap();

// Async panels own their contents and refresh only after their container is mounted.
export function liveRegion(node, update) {
  updates.set(node, update);
  return node;
}

export function mountLiveRegions(node) {
  if (updates.has(node)) updates.get(node)(node);
  else for (const child of node.children ?? []) mountLiveRegions(child);
}

function key(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return node.nodeType;
  const identity = node.getAttribute('data-live-key') || node.id;
  return `${node.tagName}:${identity || node.getAttribute('data-testid') || node.getAttribute('data-lineage-id') || node.getAttribute('href') || node.getAttribute('for') || node.classList[0] || ''}`;
}

// Reconcile rendered data without replacing the controls, disclosures or scroll wrappers
// that the browser is currently interacting with. Form values belong to the user on polls.
export function updateLiveView(current, next, preserveInputs = true) {
  if (current === next) return current;
  if (current.nodeType !== Node.ELEMENT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return current;
  }
  const field = current.matches('input, textarea, select');
  const nextValue = field ? next.value : null;
  const nextChecked = next.checked;
  const preserveField = preserveInputs && (current === document.activeElement || !current.closest('[data-live-pristine]'));
  const preserveAttribute = (name) => (name === 'open' && current.tagName === 'DETAILS') ||
    (preserveField && ((field && ['value', 'checked'].includes(name)) || (current.tagName === 'OPTION' && name === 'selected')));
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name) && !preserveAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (!preserveAttribute(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
  syncListeners(current, next);
  if (updates.has(next)) {
    updates.set(current, updates.get(next));
    updates.get(current)(current);
    return current;
  }
  if (field && preserveField && (current.tagName !== 'SELECT' || current === document.activeElement)) {
    // Do not touch a native select's option list while it may be open.
    if (current === document.activeElement) {
      current.onblur = () => {
        current.onblur = null;
        if (current.isConnected) updateLiveView(current, next);
      };
    }
    return current;
  }
  const value = field ? current.value : null;
  if (field) current.onblur = null;
  const available = [...current.childNodes];
  const children = [...next.childNodes].map((child) => {
    const index = available.findIndex((candidate) => key(candidate) === key(child));
    return [child, index === -1 ? null : available.splice(index, 1)[0]];
  });
  const active = document.activeElement;
  const structural = available.length || children.some(([, retained], index) => retained !== current.childNodes[index]);
  if (structural && active?.matches('select:open') && current.contains(active)) {
    // Even a layout shift can close a native popup. Defer this small subtree;
    // unrelated telemetry still updates while the menu is open.
    let pending = deferred.get(current);
    if (!pending) {
      pending = { timer: setInterval(() => {
        if (current.isConnected && document.activeElement?.matches('select:open')) return;
        clearInterval(pending.timer);
        deferred.delete(current);
        if (current.isConnected) updateLiveView(current, pending.next, pending.preserveInputs);
      }, 100) };
      deferred.set(current, pending);
    }
    pending.next = next;
    pending.preserveInputs = preserveInputs;
    return current;
  }
  if (deferred.has(current)) {
    clearInterval(deferred.get(current).timer);
    deferred.delete(current);
  }
  // Removing obsolete siblings first avoids moving (and blurring) a retained form.
  for (const removed of available) removed.remove();
  let position = current.firstChild;
  for (const [child, retained] of children) {
    if (!retained) {
      current.insertBefore(child, position);
      mountLiveRegions(child);
    } else {
      if (retained !== position) {
        if (current.moveBefore && current.isConnected) current.moveBefore(retained, position);
        else current.insertBefore(retained, position);
      }
      updateLiveView(retained, child, preserveInputs);
      position = retained.nextSibling;
    }
  }
  if (field) {
    const desired = preserveField ? value : nextValue;
    if (current.value !== desired) current.value = desired;
    if (!preserveField && current.tagName === 'INPUT') current.checked = nextChecked;
  }
  return current;
}
