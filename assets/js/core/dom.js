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

/** Clamp a number into a range. Used by every drag and resize interaction. */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
