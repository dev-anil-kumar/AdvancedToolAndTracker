/**
 * The colour notes are highlighted in. Chosen on Home, stored with the other
 * preferences, and exposed to CSS as the --hl custom property.
 */
import { HIGHLIGHTS } from '../core/config.js';
import { prefs } from '../core/state.js';

export function highlightHex() {
  const h = HIGHLIGHTS.find(x => x.key === prefs.highlight);
  return (h || HIGHLIGHTS[0]).hex;
}
export function applyHighlight() {
  document.documentElement.style.setProperty('--hl', highlightHex());
}
