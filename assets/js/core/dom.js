/**
 * DOM and identity helpers. The lowest layer: imports nothing, knows nothing
 * about the application.
 */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const prefers = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
export const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
export const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID()
  : 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
export const cssEscape = (s) => (self.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

/**
 * Write `text` into `parent`, wrapping every case-insensitive occurrence of
 * `needle` in a <mark>. Returns how many it found.
 *
 * Built out of nodes rather than an HTML string, so nothing has to be escaped
 * and nothing untrusted is ever parsed as markup. Every view that highlights a
 * search term goes through here, which is why they all mark the same thing.
 */
export const markInto = (parent, text, needle, cls = 'jhit') => {
  const src = String(text == null ? '' : text);
  const find = String(needle || '').toLowerCase();
  if (!find) { parent.appendChild(document.createTextNode(src)); return 0; }
  const low = src.toLowerCase();
  let at = 0, found = 0, next;
  while ((next = low.indexOf(find, at)) !== -1) {
    if (next > at) parent.appendChild(document.createTextNode(src.slice(at, next)));
    parent.appendChild(el('mark', cls, src.slice(next, next + find.length)));
    at = next + find.length;
    found++;
  }
  if (at < src.length) parent.appendChild(document.createTextNode(src.slice(at)));
  return found;
};

/** Clamp a number into a range. Used by every drag and resize interaction. */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
