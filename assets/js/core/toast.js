/**
 * Transient status messages. A leaf module: features may call it freely.
 */
import { $, el } from './dom.js';

let toastTimer;
export function toast(message, action) {
  const t = $('#toast');
  t.innerHTML = '';
  t.appendChild(document.createTextNode(message));
  if (action) {
    const b = el('button', 'link', action.label);
    b.type = 'button';
    b.addEventListener('click', () => { hideToast(); action.run(); });
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6500 : 3400);
}
export function hideToast() { $('#toast').hidden = true; }
