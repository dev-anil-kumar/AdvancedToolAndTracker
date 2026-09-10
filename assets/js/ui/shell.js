/**
 * The application shell: the three view tabs in the header and the counts
 * they carry. Everything else on screen belongs to a view or a feature.
 */
import { on, EVENTS } from '../core/bus.js';
import { $ } from '../core/dom.js';
import { compares, drawings, jsondocs, notes, panes } from '../core/state.js';
import { route, tabOrder, VIEWS } from '../core/router.js';

/** Badge counts on the Reading and Notes tabs. */
export function updateCounts() {
  $('#tabReadN').textContent = panes.length ? String(panes.length) : '';
  $('#tabNotesN').textContent = notes.length ? String(notes.length) : '';
  $('#tabCanvasN').textContent = drawings.length ? String(drawings.length) : '';
  $('#tabJsonN').textContent = jsondocs.length ? String(jsondocs.length) : '';
  $('#tabCompareN').textContent = compares.length ? String(compares.length) : '';
}

/** Wire the header tabs, including arrow-key navigation. */
export function initShell() {
  tabOrder.forEach(key => {
    const tab = $('#' + VIEWS[key].tab);
    tab.addEventListener('click', () => route(key));
    tab.addEventListener('keydown', e => {
      const i = tabOrder.indexOf(key);
      const go = (n) => { e.preventDefault(); route(tabOrder[n], { focusTab: true }); };
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go((i + 1) % tabOrder.length);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go((i - 1 + tabOrder.length) % tabOrder.length);
      if (e.key === 'Home') go(0);
      if (e.key === 'End') go(tabOrder.length - 1);
    });
  });

  [EVENTS.LIBRARY, EVENTS.NOTES, EVENTS.PANES, EVENTS.DRAWINGS, EVENTS.JSONDOCS, EVENTS.COMPARES]
    .forEach(evt => on(evt, updateCounts));
  updateCounts();
}
