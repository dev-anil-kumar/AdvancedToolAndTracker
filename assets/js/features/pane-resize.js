/**
 * The draggable dividers. Column gutters resize neighbouring panes within a
 * row; row gutters resize the rows themselves. Both are real ARIA separators,
 * so they work from the keyboard as well as from the pointer.
 *
 * Sizes are proportional (flex-grow), never absolute, so a grid keeps its
 * shape when the window changes size.
 */
import { MIN_PANE, MIN_ROW, RESIZE_STEP, RESIZE_STEP_BIG } from '../core/config.js';
import { $$, clamp, el, prefers } from '../core/dom.js';
import { panes } from '../core/state.js';
import { workspace } from './workspaces.js';

export function makeGutter() {
  const g = el('button', 'gutter');
  g.type = 'button';
  g.setAttribute('role', 'separator');
  g.setAttribute('aria-orientation', 'vertical');
  g.setAttribute('aria-label', 'Resize the panes on either side');
  g.title = 'Drag to resize — or use the arrow keys';
  g.addEventListener('pointerdown', startResize);
  g.addEventListener('keydown', keyResize);
  return g;
}

export function grow(node) { return parseFloat(node.style.flexGrow) || 1; }

function resizeBy(g, deltaPx) {
  const a = g.previousElementSibling, b = g.nextElementSibling;
  if (!a || !b) return;
  const wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width;
  const total = wa + wb, growTotal = grow(a) + grow(b);
  if (total < 2 * MIN_PANE) return;
  const na = Math.max(MIN_PANE, Math.min(total - MIN_PANE, wa + deltaPx));
  a.style.flexGrow = (na / total * growTotal).toFixed(4);
  b.style.flexGrow = ((total - na) / total * growTotal).toFixed(4);
}

function startResize(e) {
  if (prefers('(max-width: 820px)')) return;      // panes stack; they resize by height instead
  const g = e.currentTarget;
  const a = g.previousElementSibling, b = g.nextElementSibling;
  if (!a || !b) return;
  e.preventDefault();

  const startX = e.clientX;
  const wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width;
  const total = wa + wb, growTotal = grow(a) + grow(b);

  g.classList.add('dragging');
  document.body.classList.add('resizing');
  try { g.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }

  const move = (ev) => {
    if (total < 2 * MIN_PANE) return;
    const na = Math.max(MIN_PANE, Math.min(total - MIN_PANE, wa + (ev.clientX - startX)));
    a.style.flexGrow = (na / total * growTotal).toFixed(4);
    b.style.flexGrow = ((total - na) / total * growTotal).toFixed(4);
  };
  const done = () => {
    g.classList.remove('dragging');
    document.body.classList.remove('resizing');
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', done);
    g.removeEventListener('pointercancel', done);
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', done);
  g.addEventListener('pointercancel', done);
}

export function makeRowGutter() {
  const g = el('button', 'rgutter');
  g.type = 'button';
  g.setAttribute('role', 'separator');
  g.setAttribute('aria-orientation', 'horizontal');
  g.setAttribute('aria-label', 'Resize the rows above and below');
  g.title = 'Drag to resize — or use the arrow keys';
  g.addEventListener('pointerdown', startRowResize);
  g.addEventListener('keydown', keyRowResize);
  return g;
}

function rowResizeBy(g, deltaPx) {
  const a = g.previousElementSibling, b = g.nextElementSibling;
  if (!a || !b) return;
  const ha = a.getBoundingClientRect().height, hb = b.getBoundingClientRect().height;
  const total = ha + hb, growTotal = grow(a) + grow(b);
  if (total < 2 * MIN_ROW) return;
  const na = clamp(ha + deltaPx, MIN_ROW, total - MIN_ROW);
  a.style.flexGrow = (na / total * growTotal).toFixed(4);
  b.style.flexGrow = ((total - na) / total * growTotal).toFixed(4);
}

function startRowResize(e) {
  if (prefers('(max-width: 820px)')) return;
  const g = e.currentTarget;
  const a = g.previousElementSibling, b = g.nextElementSibling;
  if (!a || !b) return;
  e.preventDefault();

  const startY = e.clientY;
  const ha = a.getBoundingClientRect().height, hb = b.getBoundingClientRect().height;
  const total = ha + hb, growTotal = grow(a) + grow(b);

  g.classList.add('dragging');
  document.body.classList.add('resizing-v');
  try { g.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }

  const move = (ev) => {
    if (total < 2 * MIN_ROW) return;
    const na = clamp(ha + (ev.clientY - startY), MIN_ROW, total - MIN_ROW);
    a.style.flexGrow = (na / total * growTotal).toFixed(4);
    b.style.flexGrow = ((total - na) / total * growTotal).toFixed(4);
  };
  const done = () => {
    g.classList.remove('dragging');
    document.body.classList.remove('resizing-v');
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', done);
    g.removeEventListener('pointercancel', done);
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', done);
  g.addEventListener('pointercancel', done);
}

function keyRowResize(e) {
  const step = e.shiftKey ? RESIZE_STEP_BIG : RESIZE_STEP;
  if (e.key === 'ArrowUp') { e.preventDefault(); rowResizeBy(e.currentTarget, -step); }
  if (e.key === 'ArrowDown') { e.preventDefault(); rowResizeBy(e.currentTarget, step); }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $$('.pane-row', workspace()).forEach(r => { r.style.flexGrow = '1'; });
  }
}

function keyResize(e) {
  const step = e.shiftKey ? RESIZE_STEP_BIG : RESIZE_STEP;
  if (e.key === 'ArrowLeft') { e.preventDefault(); resizeBy(e.currentTarget, -step); }
  if (e.key === 'ArrowRight') { e.preventDefault(); resizeBy(e.currentTarget, step); }
  if (e.key === 'Enter' || e.key === ' ') {                        // even out
    e.preventDefault();
    panes.forEach(p => { p.el.style.flexGrow = '1'; });
  }
}
