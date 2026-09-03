/**
 * Focus mode. Hides every piece of chrome so only the documents remain;
 * a dim corner button and Escape bring it back.
 *
 * It listens for view changes rather than being called by the router, which
 * keeps the router free of feature knowledge.
 */
import { on, EVENTS } from '../core/bus.js';
import { $ } from '../core/dom.js';
import { currentView, route } from '../core/router.js';
import { hideSelPop } from './notes.js';

let zen = false;
export function setZen(wanted) {
  zen = !!wanted;
  document.body.classList.toggle('zen', zen);
  $('#zenExit').hidden = !zen;
  $('#zenBtn').setAttribute('aria-pressed', String(zen));
  $('#zenBtn').title = zen ? 'Show the interface again' : 'Hide everything but the documents';
  hideSelPop();
  if (zen && currentView() !== 'read') route('read');
}

/** Whether focus mode is on. */
export function isZen() { return zen; }

/* Leaving the reading view must never strand the user without chrome. */
on(EVENTS.VIEW, name => { if (name !== 'read' && zen) setZen(false); });

/* Escape is the way out. Owned here rather than in the notes key handler, so
   the two features stay independent. */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && zen) setZen(false);
});
