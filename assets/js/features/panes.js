/**
 * Panes: one open document each.
 *
 * Responsibilities
 *   - open a document into the active reading tab (or focus it if already open)
 *   - lay panes out as rows of N, per tab, restoring scroll across relayouts
 *   - pop a pane out into a freely resizable floating window, and dock it back
 *
 * A pane's identity is its own `key`, never the file id, so one document can
 * be open in several reading tabs at once.
 */
import { emit, EVENTS } from '../core/bus.js';
import {
  DRAG_THRESHOLD, FLOAT_MIN_H, FLOAT_MIN_W,
  PER_ROW_DEFAULT, PER_ROW_MAX, PER_ROW_MIN
} from '../core/config.js';
import { dbPut, persist } from '../core/db.js';
import { $, clamp, cssEscape, el, prefers, uid } from '../core/dom.js';
import { formatBytes, formatWhen, kindLabel, plural } from '../core/format.js';
import {
  activeWs, panes, prefs, workspaces,
  fileById, findPane, noteCountFor, paneByKey, panesIn, setPanes, wsById
} from '../core/state.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { renderMarkdown } from '../md/renderer.js';
import { makeGutter, makeRowGutter } from './pane-resize.js';
import { selectWorkspace, updateWorkspaceState, wsEl } from './workspaces.js';

/* Open a document in the active reading tab (or focus it if already there). */
export function openDoc(id, wsId) {
  const rec = fileById(id);
  if (!rec) { toast('That document is no longer in your library.'); return null; }
  const target = wsId && wsById(wsId) ? wsId : activeWs;
  rec.openedAt = Date.now();
  persist(dbPut('files', rec));

  if (target !== activeWs) selectWorkspace(target);
  let pane = findPane(id, target);
  if (!pane) pane = createPane(rec, target);
  route('read');
  emit(EVENTS.LIBRARY);
  focusPane(pane);
  return pane;
}

function createPane(rec, wsId) {
  const key = uid();
  const node = el('section', 'pane');
  node.dataset.key = key;
  node.dataset.fileId = rec.id;
  node.dataset.ws = wsId;
  node.style.flexGrow = '1';
  node.setAttribute('aria-label', rec.name);

  const prog = el('div', 'pane-prog');
  const head = el('div', 'pane-head');
  const title = el('div', 'pane-title');
  const nameEl = el('div', 'pane-name', rec.name);
  nameEl.title = rec.kind === 'url' ? rec.source : rec.name;
  const sub = el('div', 'pane-sub');
  title.append(nameEl, sub);

  const notesBtn = el('button', 'btn tiny ghost pane-notes', '');
  notesBtn.type = 'button';
  notesBtn.addEventListener('click', () => emit(EVENTS.REVEAL_FILE, rec.id));

  const floatBtn = el('button', 'btn tiny ghost pane-float', 'Float');
  floatBtn.type = 'button';
  floatBtn.addEventListener('click', () => { pane.floating ? dockPane(pane) : floatPane(pane); });

  const closeBtn = el('button', 'btn tiny ghost pane-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close “' + rec.name + '”');
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => closePane(key));

  head.append(title, notesBtn, floatBtn, closeBtn);
  head.addEventListener('pointerdown', e => headDrag(e, pane));

  const body = el('div', 'pane-body');
  body.tabIndex = 0;
  const article = el('article', 'md');
  body.appendChild(article);
  node.append(prog, head, body);

  try {
    renderMarkdown(article, rec.content);
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('p', 'pane-err', 'This document could not be rendered.'));
  }

  body.addEventListener('scroll', () => {
    pane.scrollTop = body.scrollTop;
    const max = body.scrollHeight - body.clientHeight;
    prog.style.width = (max > 40 ? Math.min(1, body.scrollTop / max) * 100 : 0).toFixed(2) + '%';
  }, { passive: true });

  node.addEventListener('pointerdown', () => { focusPane(pane); bringToFront(pane); }, true);
  node.addEventListener('focusin', () => focusPane(pane));

  /* In-document anchors scroll this pane rather than navigating the app. */
  article.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    const target = id && article.querySelector('#' + cssEscape(id));
    if (!target) return;
    e.preventDefault();
    scrollPaneTo(body, target);
  });

  const pane = { key: key, fileId: rec.id, wsId: wsId, el: node, floating: false, geom: null, scrollTop: 0 };
  panes.push(pane);
  layoutPanes(wsId);
  syncFloatBtn(pane);
  syncPaneHead(rec.id);
  return pane;
}

export function closePane(key) {
  const pane = paneByKey(key);
  if (!pane) return;
  const ws = pane.wsId;
  pane.el.remove();
  setPanes(panes.filter(p => p.key !== key));
  layoutPanes(ws);
  emit(EVENTS.LIBRARY);
}

export function closeAllPanes() {
  panesIn(activeWs).forEach(p => p.el.remove());
  setPanes(panes.filter(p => p.wsId !== activeWs));
  layoutPanes(activeWs);
  emit(EVENTS.LIBRARY);
}

export function focusPane(pane) {
  panes.forEach(p => p.el.classList.toggle('focused', p === pane));
}

/* One file can be open in several tabs, so update every pane showing it. */
export function syncPaneHead(fileId) {
  const rec = fileById(fileId);
  if (!rec) return;
  panes.filter(p => p.fileId === fileId).forEach(pane => {
    const bits = [kindLabel(rec)];
    if (rec.size) bits.push(formatBytes(rec.size));
    bits.push('opened ' + formatWhen(rec.openedAt));
    $('.pane-sub', pane.el).textContent = bits.join(' · ');

    const n = noteCountFor(fileId);
    const btn = $('.pane-notes', pane.el);
    btn.textContent = n ? plural(n, 'note', 'notes') : '';
    btn.hidden = n === 0;
    btn.title = n ? 'See these notes' : '';
  });
}

export function scrollPaneTo(body, target, offset) {
  const top = body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top - (offset == null ? 18 : offset);
  body.scrollTo({ top: Math.max(0, top), behavior: prefers('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' });
}

/* ---------- Layout: rows of panes, N per row, per reading tab ---------- */
export function layoutPanes(wsId) {
  const id = wsId || activeWs;
  const box = wsEl(id);
  if (!box) return;
  const docked = panesIn(id).filter(p => !p.floating);

  /* Re-parenting a pane resets its inner scroll, so carry it across. */
  docked.forEach(p => { const b = $('.pane-body', p.el); if (b) p.scrollTop = b.scrollTop; });

  box.innerHTML = '';
  const per = clamp(prefs.perRow || PER_ROW_DEFAULT, PER_ROW_MIN, PER_ROW_MAX);
  for (let i = 0; i < docked.length; i += per) {
    if (i > 0) box.appendChild(makeRowGutter());
    const row = el('div', 'pane-row');
    docked.slice(i, i + per).forEach((p, j) => {
      if (j > 0) row.appendChild(makeGutter());
      p.el.style.flexGrow = '1';
      row.appendChild(p.el);
    });
    box.appendChild(row);
  }

  docked.forEach(p => {
    const b = $('.pane-body', p.el);
    if (b && p.scrollTop) b.scrollTop = p.scrollTop;
  });
  updateWorkspaceState();
}
export function layoutAll() { workspaces.forEach(w => layoutPanes(w.id)); }

/* ---------- Floating panes: move freely, resize to any size ---------- */
let zTop = 60;

export function bringToFront(pane) {
  if (!pane.floating) return;
  pane.el.style.zIndex = String(++zTop);
}

function applyGeom(pane) {
  const g = pane.geom;
  pane.el.style.left = Math.round(g.x) + 'px';
  pane.el.style.top = Math.round(g.y) + 'px';
  pane.el.style.width = Math.round(g.w) + 'px';
  pane.el.style.height = Math.round(g.h) + 'px';
}

export function floatPane(pane, geom) {
  if (pane.floating) return;
  const r = pane.el.getBoundingClientRect();
  const w = clamp(geom ? geom.w : (r.width || 620), FLOAT_MIN_W, Math.max(FLOAT_MIN_W + 20, innerWidth - 24));
  const h = clamp(geom ? geom.h : (r.height || 520), FLOAT_MIN_H, Math.max(FLOAT_MIN_H + 20, innerHeight - 80));
  pane.geom = {
    x: clamp(geom ? geom.x : (r.left || 40), 8, Math.max(8, innerWidth - w - 8)),
    y: clamp(geom ? geom.y : (r.top || 90), 8, Math.max(8, innerHeight - 60)),
    w: w, h: h
  };
  pane.floating = true;
  document.body.appendChild(pane.el);
  pane.el.classList.add('floating');
  applyGeom(pane);
  bringToFront(pane);
  syncFloatBtn(pane);
  layoutPanes(pane.wsId);
}

export function dockPane(pane) {
  if (!pane.floating) return;
  pane.floating = false;
  pane.el.classList.remove('floating');
  ['left', 'top', 'width', 'height', 'zIndex'].forEach(k => { pane.el.style[k] = ''; });
  pane.el.hidden = false;
  syncFloatBtn(pane);
  layoutPanes(pane.wsId);
}

export function syncFloatBtn(pane) {
  const b = $('.pane-float', pane.el);
  if (!b) return;
  b.textContent = pane.floating ? 'Dock' : 'Float';
  b.title = pane.floating ? 'Return this document to the grid' : 'Float this document as a free window';
  b.setAttribute('aria-pressed', String(!!pane.floating));
}

/* Drag the title bar: a docked pane floats once you pull it, a floating one moves. */
export function headDrag(e, pane) {
  if (e.button != null && e.button !== 0) return;
  if (e.target.closest && e.target.closest('button')) return;

  const head = e.currentTarget;
  const rect = pane.el.getBoundingClientRect();
  const startX = e.clientX, startY = e.clientY;
  const offX = startX - rect.left, offY = startY - rect.top;
  let moving = pane.floating;

  if (pane.floating) {
    pane.geom = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    bringToFront(pane);
  }
  try { head.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }

  const move = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moving) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      moving = true;
      floatPane(pane, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      pane.el.classList.add('dragging');
    }
    const g = pane.geom;
    g.x = clamp(ev.clientX - offX, 20 - g.w, innerWidth - 60);
    g.y = clamp(ev.clientY - offY, 0, innerHeight - 40);
    applyGeom(pane);
  };
  const done = () => {
    pane.el.classList.remove('dragging');
    if (pane.floating) {
      const r = pane.el.getBoundingClientRect();
      pane.geom = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', done);
    head.removeEventListener('pointercancel', done);
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', done);
  head.addEventListener('pointercancel', done);
}
