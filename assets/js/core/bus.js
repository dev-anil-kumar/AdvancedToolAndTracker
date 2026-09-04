/**
 * A very small publish/subscribe bus.
 *
 * Features own data and emit when it changes; views subscribe and re-render.
 * This is what keeps the dependency graph one-directional — a feature never
 * has to import a view in order to refresh it.
 */

const listeners = new Map();

/** Subscribe to an event. Returns an unsubscribe function. */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

/** Publish an event. A throwing listener never breaks the others. */
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  set.forEach(fn => {
    try { fn(payload); }
    catch (err) { console.error('Folio: listener for "' + event + '" failed', err); }
  });
}

/** The events this app uses, named in one place to avoid typo-driven bugs. */
export const EVENTS = {
  LIBRARY: 'library',      // documents added, opened, or removed
  NOTES: 'notes',          // a note was saved, edited, or deleted
  PANES: 'panes',          // panes or reading tabs changed
  PREFS: 'prefs',          // a setting changed
  VIEW: 'view',            // the active view changed
  DRAWINGS: 'drawings',    // a drawing was created, saved, or removed
  JSONDOCS: 'jsondocs',    // a JSON document was added, edited, or removed
  REVEAL_FILE: 'reveal-file' // jump to a document's notes group
};
