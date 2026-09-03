/**
 * Light/dark. Follows the system by default; the toggle lasts for the session
 * and is deliberately not persisted.
 */
import { $, prefers } from '../core/dom.js';

const SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>';
const MOON = '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/>';
let theme = prefers('(prefers-color-scheme: dark)') ? 'dark' : 'light';

export function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#themeIcon').innerHTML = theme === 'dark' ? SUN : MOON;
  const next = theme === 'dark' ? 'light' : 'dark';
  $('#themeBtn').setAttribute('aria-label', 'Switch to ' + next + ' theme');
  $('#themeBtn').title = 'Switch to ' + next + ' theme';
}
/** Flip the theme. Wired up by main.js. */
export function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme();
}
