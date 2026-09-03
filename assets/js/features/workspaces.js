/**
 * Reading tabs. Each tab owns an independent grid of panes; only the active
 * tab's grid is in the layout. This module owns the tab strip's DOM.
 */
import { emit, EVENTS } from '../core/bus.js';
import { $, cssEscape, el, uid } from '../core/dom.js';
import {
  activeWs, panes, workspaces,
  panesIn, setActiveWs, setPanes, setWorkspaces, wsById
} from '../core/state.js';
import { toast } from '../core/toast.js';

export function wsEl(id) { return $('.workspace[data-ws="' + cssEscape(id) + '"]'); }

export function addWorkspace(name, opts) {
  const ws = { id: uid(), name: name || ('Tab ' + (workspaces.length + 1)) };
  workspaces.push(ws);
  const box = el('div', 'workspace');
  box.dataset.ws = ws.id;
  box.setAttribute('role', 'tabpanel');
  box.setAttribute('aria-label', ws.name);
  $('#wsStack').appendChild(box);
  if (!(opts && opts.quiet)) selectWorkspace(ws.id);
  renderWsTabs();
  return ws;
}

export function selectWorkspace(id) {
  if (!wsById(id)) return;
  setActiveWs(id);
  workspaces.forEach(w => { const box = wsEl(w.id); if (box) box.hidden = w.id !== id; });
  /* A floated document belongs to the tab it was opened in. */
  panes.forEach(p => { if (p.floating) p.el.hidden = p.wsId !== id; });
  renderWsTabs();
  updateWorkspaceState();
}

export function closeWorkspace(id) {
  if (workspaces.length <= 1) { toast('Keep at least one reading tab.'); return; }
  panesIn(id).forEach(p => p.el.remove());
  setPanes(panes.filter(p => p.wsId !== id));
  const box = wsEl(id);
  if (box) box.remove();
  const i = workspaces.findIndex(w => w.id === id);
  setWorkspaces(workspaces.filter(w => w.id !== id));
  if (activeWs === id) selectWorkspace(workspaces[Math.max(0, i - 1)].id);
  else { renderWsTabs(); updateWorkspaceState(); }
  emit(EVENTS.LIBRARY);
}

export function renderWsTabs() {
  const bar = $('#wsTabs');
  bar.innerHTML = '';
  workspaces.forEach(w => {
    const wrap = el('span', 'ws-tab' + (w.id === activeWs ? ' current' : ''));
    wrap.setAttribute('role', 'presentation');

    const tab = el('button', null);
    tab.type = 'button';
    tab.id = 'wstab-' + w.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(w.id === activeWs));
    tab.tabIndex = w.id === activeWs ? 0 : -1;
    tab.appendChild(document.createTextNode(w.name));
    const count = panesIn(w.id).length;
    if (count) tab.appendChild(el('span', 'n', '· ' + count));
    tab.addEventListener('click', () => selectWorkspace(w.id));
    tab.addEventListener('keydown', e => {
      const i = workspaces.findIndex(x => x.id === w.id);
      if (e.key === 'ArrowRight') { e.preventDefault(); const n = workspaces[(i + 1) % workspaces.length]; selectWorkspace(n.id); $('#wstab-' + n.id).focus(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); const n = workspaces[(i - 1 + workspaces.length) % workspaces.length]; selectWorkspace(n.id); $('#wstab-' + n.id).focus(); }
    });
    wrap.appendChild(tab);

    if (workspaces.length > 1) {
      const x = el('button', 'ws-close', '✕');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close ' + w.name);
      x.title = 'Close this reading tab';
      x.addEventListener('click', e => { e.stopPropagation(); closeWorkspace(w.id); });
      wrap.appendChild(x);
    }
    bar.appendChild(wrap);
  });
}

export const workspace = () => wsEl(activeWs);

/**
 * Show or hide the active tab's grid and its empty state. Lives here rather
 * than in panes.js so that workspaces has no dependency on pane internals.
 */
export function updateWorkspaceState() {
  const mine = panesIn(activeWs);
  const box = workspace();
  if (box) box.hidden = mine.filter(p => !p.floating).length === 0;
  $('#readEmpty').hidden = mine.length > 0;
  renderWsTabs();
  emit(EVENTS.PANES);
}
