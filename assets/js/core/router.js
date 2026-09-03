/**
 * Which of the three views is on screen, reflected in the URL hash so the
 * browser's Back button works. Emits VIEW; it never renders anything itself.
 */
import { $ } from './dom.js';
import { emit, EVENTS } from './bus.js';

export const VIEWS = {
  home:  { tab: 'tab-home',  view: 'view-home' },
  read:  { tab: 'tab-read',  view: 'view-read' },
  notes: { tab: 'tab-notes', view: 'view-notes' },
  canvas: { tab: 'tab-canvas', view: 'view-canvas' }
};
export const tabOrder = ['home', 'read', 'notes', 'canvas'];
let current = 'home';

export function route(name, opts) {
  const options = opts || {};
  if (!VIEWS[name]) name = 'home';
  current = name;
  tabOrder.forEach(key => {
    const on = key === name;
    const tab = $('#' + VIEWS[key].tab);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $('#' + VIEWS[key].view).hidden = !on;
  });
  document.body.dataset.view = name;
  if (options.focusTab) $('#' + VIEWS[name].tab).focus();
  const hash = '#' + name;
  if (location.hash !== hash) {
    if (options.replace) history.replaceState(null, '', hash);
    else location.hash = name;
  }
  emit(EVENTS.VIEW, name);
}
export function hashView() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return VIEWS[h] ? h : null;
}
addEventListener('hashchange', () => {
  const v = hashView();
  if (v && v !== current) route(v);
});




/** The view currently on screen. */
export function currentView() { return current; }
