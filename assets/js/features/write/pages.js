/**
 * Extension hook — page styles (Phase 2, Agent C).
 *
 * Owns: the page-style picker with live thumbnails (Blank, Lined, Graph,
 * Grid, Dotted, Legal pad), page tint and width — persisted per document on
 * `doc.page` (see features/writedocs.js) — plus hovering a ruled line or a
 * grid cell to copy just that line/cell, and an optional "cell mode" where
 * the page becomes a real editable grid.
 *
 * `ctx.pageEl` is the `.write-page` element; it already carries
 * `data-page-style` / `data-tint` / `data-width` attributes that assets/css/
 * write.css keys its backgrounds off, sized from `--line-h` so text snaps to
 * the ruling. This module is what changes those attributes (assets/css/
 * write-pages.css supplies the actual ruling backgrounds, keyed off the same
 * attributes) and persists the choice via features/writedocs.js.
 *
 * `init(ctx)` is called once, when ui/write-view.js builds its DOM — see the
 * ctx contract documented at the top of that file.
 */
import { el } from '../../core/dom.js';
import { updateWriteDoc } from '../writedocs.js';

const DEFAULT_PAGE = { style: 'blank', tint: 'white', width: 'normal' };

const PAGE_STYLES = [
  { key: 'blank', label: 'Blank' },
  { key: 'lined', label: 'Lined' },
  { key: 'graph', label: 'Graph' },
  { key: 'grid', label: 'Grid' },
  { key: 'dotted', label: 'Dotted' },
  { key: 'legal', label: 'Legal pad' }
];
const PAGE_TINTS = [
  { key: 'white', label: 'White' },
  { key: 'cream', label: 'Cream' },
  { key: 'dark', label: 'Dark paper' },
  { key: 'yellow', label: 'Yellow pad' }
];
const PAGE_WIDTHS = [
  { key: 'narrow', label: 'Narrow' },
  { key: 'normal', label: 'Normal' },
  { key: 'wide', label: 'Wide' },
  { key: 'full', label: 'Full' }
];
const CELL_MODE_STYLES = ['grid', 'graph'];

/* ---------------------------------------------------------------
   Pure helpers — no DOM, safe for tests/smoke.mjs to call directly.
   --------------------------------------------------------------- */

/**
 * The class list for a small "mini" swatch that previews a page config —
 * used on the toolbar button and the popover's style thumbnails. Kept pure
 * (same input, same output, no globals) so it is easy to test and easy to
 * reuse anywhere a miniature preview of a page is needed.
 */
export function pageClasses(page) {
  const p = { ...DEFAULT_PAGE, ...(page || {}) };
  return 'wp-mini wp-mini-' + p.style + ' wp-mini-tint-' + p.tint + ' wp-mini-width-' + p.width;
}

/** Round a pixel offset to the nearest multiple of the line height, so a
    ruling-aligned element never drifts a stray pixel off the grid. */
export function snapToLine(px, lineH) {
  const h = Number(lineH) || 0;
  if (!h) return px;
  return Math.round(px / h) * h;
}

/* ---------------------------------------------------------------
   Module state
   --------------------------------------------------------------- */
let ctx = null;
let popEl = null, pageBtn = null, miniSwatch = null;
let cellSection = null;
let lineChip = null, paraChip = null;
let cellOverlay = null, cellChip = null;
let currentLineBand = null;   // { top, bottom, block } in viewport coords
let currentCellRect = null;   // { left, top, right, bottom } in viewport coords
let rafPending = false;

export function init(context) {
  ctx = context;
  buildToolbarButton();
  buildPopover();
  buildLineChips();
  buildCellOverlay();
  wireHover();
  wireCellModeKeyNav();
  ctx.registerSlashItem({
    key: 'cells', label: 'Cell grid', hint: 'Rows × cols, aligned to the ruling',
    run: () => openSizePicker(anchorRectForCaret(), (rows, cols) => insertCellGrid(rows, cols))
  });
  ctx.registerShortcut('mod+shift+c', () => copyAtCaret());
}

/**
 * Called by ui/write-view.js right after it opens or switches a document —
 * reapplies the doc's saved page config and resets anything hover-related
 * that pointed at the previous document's content.
 */
export function applyPage(doc) {
  if (!ctx) return;
  const page = { ...DEFAULT_PAGE, ...((doc && doc.page) || {}) };
  ctx.pageEl.dataset.pageStyle = page.style;
  ctx.pageEl.dataset.tint = page.tint;
  ctx.pageEl.dataset.width = page.width;
  hideLineChips();
  hideCellOverlay();
  closePopover();
  syncMini(page);
  if (popEl) syncPopover(page);
}

/* ---------------------------------------------------------------
   Toolbar button + popover
   --------------------------------------------------------------- */
function pageIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M6 4h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>'
    + '<path d="M9 10h6M9 13.5h6M9 17h4"/></svg>';
}
function copyIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
}

function buildToolbarButton() {
  pageBtn = ctx.registerToolbarButton('page', {
    title: 'Page style, tint & width',
    icon: pageIcon(),
    run: () => togglePopover(),
    isActive: () => !!(popEl && !popEl.hidden)
  });
  miniSwatch = el('span', 'wp-mini');
  miniSwatch.setAttribute('aria-hidden', 'true');
  pageBtn.appendChild(miniSwatch);
}
function syncMini(page) {
  if (miniSwatch) miniSwatch.className = pageClasses(page);
}

function buildPopover() {
  popEl = el('div', 'wp-pop');
  popEl.hidden = true;
  popEl.setAttribute('role', 'dialog');
  popEl.setAttribute('aria-label', 'Page style');
  popEl.addEventListener('mousedown', e => e.preventDefault());

  popEl.appendChild(section('Page style', buildThumbs()));
  popEl.appendChild(section('Tint', buildTints()));
  popEl.appendChild(section('Width', buildWidths()));
  cellSection = section('Cell mode', buildCellModeRow());
  cellSection.hidden = true;
  popEl.appendChild(cellSection);

  document.body.appendChild(popEl);
  document.addEventListener('mousedown', (e) => {
    if (!popEl.hidden && !popEl.contains(e.target) && e.target !== pageBtn && !pageBtn.contains(e.target)) closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !popEl.hidden) { closePopover(); }
  });
  addEventListener('resize', closePopover);
  document.addEventListener('scroll', closePopover, true);
}
function section(title, body) {
  const s = el('div', 'wp-section');
  s.appendChild(el('div', 'wp-heading', title));
  s.appendChild(body);
  return s;
}

function buildThumbs() {
  const wrap = el('div', 'wp-thumbs');
  PAGE_STYLES.forEach(({ key, label }) => {
    const b = el('button', 'wp-thumb');
    b.type = 'button';
    b.dataset.style = key;
    b.title = label;
    const preview = el('span');
    preview.className = pageClasses({ style: key, tint: 'white', width: 'normal' });
    b.appendChild(preview);
    b.appendChild(el('span', 'wp-thumb-label', label));
    b.addEventListener('click', () => setPage({ style: key }));
    wrap.appendChild(b);
  });
  return wrap;
}
function buildTints() {
  const wrap = el('div', 'wp-swrow');
  PAGE_TINTS.forEach(({ key, label }) => {
    const b = el('button', 'wp-tintswatch');
    b.type = 'button';
    b.dataset.tint = key;
    b.title = label;
    b.addEventListener('click', () => setPage({ tint: key }));
    wrap.appendChild(b);
  });
  return wrap;
}
function buildWidths() {
  const wrap = el('div', 'wp-widthrow');
  PAGE_WIDTHS.forEach(({ key, label }) => {
    const b = el('button', 'wp-widthbtn', label);
    b.type = 'button';
    b.dataset.width = key;
    b.addEventListener('click', () => setPage({ width: key }));
    wrap.appendChild(b);
  });
  return wrap;
}
function buildCellModeRow() {
  const wrap = el('div');
  const b = el('button', 'btn tiny ghost', 'Insert cell grid…');
  b.type = 'button';
  b.addEventListener('click', () => openSizePicker(b.getBoundingClientRect(), (rows, cols) => insertCellGrid(rows, cols)));
  wrap.appendChild(b);
  return wrap;
}

function togglePopover() {
  if (!ctx.getDoc()) return;
  if (popEl.hidden) openPopover(); else closePopover();
}
function openPopover() {
  const doc = ctx.getDoc();
  if (!doc) return;
  syncPopover({ ...DEFAULT_PAGE, ...doc.page });
  popEl.hidden = false;
  const rect = pageBtn.getBoundingClientRect();
  const w = popEl.offsetWidth || 280;
  const left = Math.max(8, Math.min(innerWidth - w - 8, rect.left));
  let top = rect.bottom + 6;
  if (top + (popEl.offsetHeight || 320) > innerHeight - 8) top = Math.max(8, rect.top - (popEl.offsetHeight || 320) - 6);
  popEl.style.left = Math.round(left) + 'px';
  popEl.style.top = Math.round(top) + 'px';
}
function closePopover() { if (popEl) popEl.hidden = true; }
function syncPopover(page) {
  popEl.querySelectorAll('.wp-thumb').forEach(b => b.classList.toggle('active', b.dataset.style === page.style));
  popEl.querySelectorAll('.wp-tintswatch').forEach(b => b.classList.toggle('active', b.dataset.tint === page.tint));
  popEl.querySelectorAll('.wp-widthbtn').forEach(b => b.classList.toggle('active', b.dataset.width === page.width));
  cellSection.hidden = !CELL_MODE_STYLES.includes(page.style);
}

async function setPage(patch) {
  const doc = ctx.getDoc();
  if (!doc) return;
  const page = { ...DEFAULT_PAGE, ...doc.page, ...patch };
  ctx.pageEl.dataset.pageStyle = page.style;
  ctx.pageEl.dataset.tint = page.tint;
  ctx.pageEl.dataset.width = page.width;
  syncMini(page);
  syncPopover(page);
  await updateWriteDoc(doc.id, { page });
  ctx.saveNow();
}

/* ---------------------------------------------------------------
   Lined / legal — hover a line, copy it (or its paragraph)
   --------------------------------------------------------------- */
function buildLineChips() {
  lineChip = el('button', 'wp-chip wp-chip-line');
  lineChip.type = 'button';
  lineChip.title = 'Copy this line';
  lineChip.innerHTML = copyIcon();
  lineChip.hidden = true;
  lineChip.addEventListener('mousedown', e => e.preventDefault());
  lineChip.addEventListener('click', (e) => {
    if (!currentLineBand) return;
    if (e.shiftKey) copyText(currentLineBand.block ? currentLineBand.block.textContent : '', 'Paragraph copied.');
    else copyText(collectLineText(currentLineBand), 'Line copied.');
  });

  paraChip = el('button', 'wp-chip wp-chip-para', '¶');
  paraChip.type = 'button';
  paraChip.title = 'Copy the whole paragraph';
  paraChip.hidden = true;
  paraChip.addEventListener('mousedown', e => e.preventDefault());
  paraChip.addEventListener('click', () => {
    if (!currentLineBand || !currentLineBand.block) return;
    copyText(currentLineBand.block.textContent, 'Paragraph copied.');
  });
  document.body.append(lineChip, paraChip);
}
function hideLineChips() {
  currentLineBand = null;
  if (lineChip) lineChip.hidden = true;
  if (paraChip) paraChip.hidden = true;
}
function positionLineChips(band) {
  const sheet = ctx.sheet;
  const sheetRect = sheet.getBoundingClientRect();
  const lineH = readLineH();
  const relTop = snapToLine(band.top - sheetRect.top, lineH);
  const centerY = sheetRect.top + relTop + lineH / 2;
  const h = lineChip.offsetHeight || 22;
  let left = sheetRect.left - (lineChip.offsetWidth || 22) - 6;
  if (left < 4) left = sheetRect.left + 4;
  lineChip.style.top = Math.round(centerY - h / 2) + 'px';
  lineChip.style.left = Math.round(left) + 'px';
  lineChip.hidden = false;
  paraChip.style.top = Math.round(centerY - h / 2) + 'px';
  paraChip.style.left = Math.round(left + (lineChip.offsetWidth || 22) + 4) + 'px';
  paraChip.hidden = false;
}

function collectLineText(band) {
  const sheetRect = ctx.sheet.getBoundingClientRect();
  const rect = { left: sheetRect.left - 4, right: sheetRect.right + 4, top: band.top, bottom: band.bottom };
  return collectTextInRect(band.block || ctx.sheet, rect);
}

/* ---------------------------------------------------------------
   Grid / graph — hover a cell, copy it
   --------------------------------------------------------------- */
function buildCellOverlay() {
  cellOverlay = el('div', 'wp-cell-overlay');
  cellOverlay.hidden = true;
  cellOverlay.setAttribute('aria-hidden', 'true');
  cellChip = el('button', 'wp-chip wp-chip-cell');
  cellChip.type = 'button';
  cellChip.title = 'Copy this cell';
  cellChip.innerHTML = copyIcon();
  cellChip.hidden = true;
  cellChip.addEventListener('mousedown', e => e.preventDefault());
  cellChip.addEventListener('click', () => {
    if (!currentCellRect) return;
    copyText(collectTextInRect(ctx.sheet, currentCellRect), 'Cell copied.');
  });
  document.body.append(cellOverlay, cellChip);
}
function hideCellOverlay() {
  currentCellRect = null;
  if (cellOverlay) cellOverlay.hidden = true;
  if (cellChip) cellChip.hidden = true;
}
function cellSizePx(style, lineH) {
  return style === 'grid' ? lineH : lineH / 4;
}
function cellRectAtPoint(x, y) {
  const rect = ctx.sheet.getBoundingClientRect();
  const lineH = readLineH();
  const cellPx = cellSizePx(ctx.pageEl.dataset.pageStyle, lineH);
  const localX = x - rect.left, localY = y - rect.top;
  if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) return null;
  const col = Math.floor(localX / cellPx), row = Math.floor(localY / cellPx);
  const left = rect.left + col * cellPx, top = rect.top + row * cellPx;
  return { left, top, right: left + cellPx, bottom: top + cellPx };
}
function positionCellOverlay(rect) {
  cellOverlay.style.left = Math.round(rect.left) + 'px';
  cellOverlay.style.top = Math.round(rect.top) + 'px';
  cellOverlay.style.width = Math.round(rect.right - rect.left) + 'px';
  cellOverlay.style.height = Math.round(rect.bottom - rect.top) + 'px';
  cellOverlay.hidden = false;
  cellChip.hidden = false;
  const cw = cellChip.offsetWidth || 20;
  cellChip.style.left = Math.round(Math.max(rect.left, rect.right - cw)) + 'px';
  cellChip.style.top = Math.round(rect.top - (cellChip.offsetHeight || 20) - 2) + 'px';
}

/* ---------------------------------------------------------------
   Hover wiring shared by both features
   --------------------------------------------------------------- */
function wireHover() {
  ctx.sheet.addEventListener('mousemove', (e) => {
    if (rafPending) return;
    rafPending = true;
    const x = e.clientX, y = e.clientY;
    requestAnimationFrame(() => { rafPending = false; handleHover(x, y); });
  });
  ctx.sheet.addEventListener('mouseleave', () => { hideLineChips(); hideCellOverlay(); });
  document.addEventListener('scroll', () => { hideLineChips(); hideCellOverlay(); }, true);
}
function handleHover(x, y) {
  if (!ctx.getDoc()) { hideLineChips(); hideCellOverlay(); return; }
  const style = ctx.pageEl.dataset.pageStyle;
  if (style === 'lined' || style === 'legal') {
    const band = lineBandAtPoint(x, y);
    if (band) { currentLineBand = band; positionLineChips(band); }
    else hideLineChips();
  } else hideLineChips();

  if (style === 'grid' || style === 'graph') {
    const rect = cellRectAtPoint(x, y);
    if (rect) { currentCellRect = rect; positionCellOverlay(rect); }
    else hideCellOverlay();
  } else hideCellOverlay();
}

/** Keyboard-accessible fallback for the two hover-copy features: copies
    whatever line or cell the caret currently sits in. */
function copyAtCaret() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { ctx.toast('Place the caret in the text first.'); return; }
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const rects = r.getClientRects();
  const rc = rects[0] || r.getBoundingClientRect();
  if (!rc || (!rc.width && !rc.height)) { ctx.toast('Place the caret in the text first.'); return; }
  const cx = rc.left + 1, cy = (rc.top + rc.bottom) / 2;
  const style = ctx.pageEl.dataset.pageStyle;
  if (style === 'lined' || style === 'legal') {
    const band = lineBandAtPoint(cx, cy);
    if (band) copyText(collectLineText(band), 'Line copied.');
  } else if (style === 'grid' || style === 'graph') {
    const rect = cellRectAtPoint(cx, cy);
    if (rect) copyText(collectTextInRect(ctx.sheet, rect), 'Cell copied.');
  } else {
    ctx.toast('Line and cell copy only apply to ruled or grid pages.');
  }
}

/* ---------------------------------------------------------------
   Geometry: mapping a point to a visual line, and text to a rectangle
   --------------------------------------------------------------- */
function readLineH() {
  const raw = getComputedStyle(ctx.pageEl).getPropertyValue('--line-h');
  return parseFloat(raw) || 28;
}
function caretFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }
  return null;
}
function blockAncestor(node) {
  let node2 = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (node2 && node2 !== ctx.sheet && !/^(P|LI|H1|H2|H3|BLOCKQUOTE|PRE|TD|TH|DIV)$/.test(node2.tagName || '')) {
    node2 = node2.parentElement;
  }
  return node2 && node2 !== ctx.sheet ? node2 : null;
}

/** The vertical band (top/bottom, in viewport coordinates) of the visual
    line under (x, y), plus the block element it belongs to. Built from a
    single character's rect near the caret, since a collapsed range's own
    client rect is unreliable across browsers. */
function lineBandAtPoint(x, y) {
  if (!ctx.sheet.contains(document.elementFromPoint(x, y))) return null;
  const range = caretFromPoint(x, y);
  if (!range || !ctx.sheet.contains(range.startContainer)) return null;
  const node = range.startContainer;
  const block = blockAncestor(node);
  if (!block) return null;
  let rect = null;
  if (node.nodeType === Node.TEXT_NODE && node.data.length) {
    const idx = Math.min(range.startOffset, node.data.length - 1);
    const r = document.createRange();
    r.setStart(node, idx);
    r.setEnd(node, idx + 1);
    const rc = r.getBoundingClientRect();
    if (rc.width || rc.height) rect = rc;
  }
  if (!rect) {
    const target = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    rect = (target || block).getBoundingClientRect();
  }
  return { top: rect.top, bottom: rect.bottom, block };
}

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
/** Every character inside `root` whose own rectangle intersects `rect`,
    concatenated in document order. Powers both the line-copy and the
    cell-copy chips: the only difference between the two features is the
    rectangle they pass in. Deliberately per-character (not per-node) so a
    styled span that wraps mid-line, or a cell boundary that cuts through a
    run of text, still comes out right. Only ever run on a click, not on
    every hover frame. */
function collectTextInRect(root, rect) {
  if (!root) return '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeValue && n.nodeValue.length) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  let out = '';
  let node;
  const r = document.createRange();
  while ((node = walker.nextNode())) {
    r.selectNodeContents(node);
    const nodeRects = r.getClientRects();
    let overlaps = false;
    for (const nr of nodeRects) { if (rectsIntersect(nr, rect)) { overlaps = true; break; } }
    if (!overlaps) continue;
    const len = node.data.length;
    for (let i = 0; i < len; i++) {
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      const cr = r.getBoundingClientRect();
      if (!cr.width && !cr.height) continue;
      if (rectsIntersect(cr, rect)) out += node.data[i];
    }
  }
  return out.trim();
}

function copyText(text, message) {
  const t = String(text || '').replace(/​/g, '').trim();
  if (!t) { ctx.toast('Nothing to copy there.'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(() => ctx.toast(message)).catch(() => fallbackCopy(t, message));
  } else fallbackCopy(t, message);
}
function fallbackCopy(t, message) {
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    ctx.toast(message);
  } catch (err) { ctx.toast('Could not copy that.'); }
}

/* ---------------------------------------------------------------
   Cell mode: a real editable grid (table.write-cells)
   --------------------------------------------------------------- */

/** Cells are exactly one --line-h square (N = 1): a whole multiple of the
    Grid ruling and a submultiple of the fine Graph ruling, so the table's
    borders always land on a ruling line in either style. */
function insertCellGrid(rows, cols) {
  const table = document.createElement('table');
  table.className = 'write-cells';
  table.setAttribute('role', 'grid');
  for (let r = 0; r < Math.max(1, rows); r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < Math.max(1, cols); c++) {
      const td = document.createElement('td');
      td.innerHTML = '<br>';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  insertNodeAtCaret(table);
  ctx.sheet.dispatchEvent(new Event('input', { bubbles: true }));
}
function insertNodeAtCaret(node) {
  const sheet = ctx.sheet;
  sheet.focus();
  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount && sheet.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(sheet);
  }
  range.collapse(false);
  range.insertNode(node);
  const after = document.createRange();
  after.setStartAfter(node);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
}
function anchorRectForCaret() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const rects = r.getClientRects();
    if (rects.length) return rects[rects.length - 1];
  }
  return ctx.sheet.getBoundingClientRect();
}

/** A small "how many rows and columns" grid, the same idea as the classic
    table-insert widget: hover to preview, click to confirm. */
function openSizePicker(anchorRect, onPick) {
  const ROWS = 8, COLS = 8;
  const pop = el('div', 'wp-pop wp-sizepop');
  const grid = el('div', 'wp-sizegrid');
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = el('button', 'wp-sizecell');
      cell.type = 'button';
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.tabIndex = -1;
      grid.appendChild(cell);
      cells.push(cell);
    }
  }
  const label = el('div', 'wp-sizelabel', '1 × 1');
  const mark = (r, c) => {
    cells.forEach(cell => cell.classList.toggle('on', +cell.dataset.r <= r && +cell.dataset.c <= c));
    label.textContent = (r + 1) + ' × ' + (c + 1);
  };
  mark(0, 0);
  grid.addEventListener('pointermove', (e) => {
    const t = e.target.closest('.wp-sizecell');
    if (t) mark(+t.dataset.r, +t.dataset.c);
  });
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('.wp-sizecell');
    if (!t) return;
    onPick(+t.dataset.r + 1, +t.dataset.c + 1);
    close();
  });
  pop.append(grid, label);
  document.body.appendChild(pop);

  const w = pop.offsetWidth || 160, h = pop.offsetHeight || 120;
  const left = Math.max(8, Math.min(innerWidth - w - 8, anchorRect.left));
  let top = anchorRect.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, anchorRect.top - h - 6);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';

  function close() {
    pop.remove();
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onKey);
  }
  function onDocDown(e) { if (!pop.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
  document.addEventListener('keydown', onKey);
}

/** Tab / Shift+Tab / arrow keys move between cells of a table.write-cells
    grid — the one bit of keyboard navigation a plain contenteditable table
    does not give you for free. */
function wireCellModeKeyNav() {
  ctx.sheet.addEventListener('keydown', (e) => {
    if (!['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const td = cellAtCaret();
    if (!td) return;
    const table = td.closest('table.write-cells');
    const row = td.parentElement;
    const cellIndex = [...row.children].indexOf(td);
    const rowIndex = [...table.rows].indexOf(row);
    let target = null;
    if (e.key === 'Tab') {
      target = e.shiftKey ? prevCell(table, rowIndex, cellIndex) : nextCell(table, rowIndex, cellIndex);
    } else if (e.key === 'ArrowRight' && atCellEnd(td)) {
      target = row.children[cellIndex + 1] || (table.rows[rowIndex + 1] || {}).children?.[0];
    } else if (e.key === 'ArrowLeft' && atCellStart(td)) {
      target = row.children[cellIndex - 1] || (table.rows[rowIndex - 1] ? table.rows[rowIndex - 1].children[table.rows[rowIndex - 1].children.length - 1] : null);
    } else if (e.key === 'ArrowDown') {
      target = table.rows[rowIndex + 1] ? table.rows[rowIndex + 1].children[cellIndex] : null;
    } else if (e.key === 'ArrowUp') {
      target = table.rows[rowIndex - 1] ? table.rows[rowIndex - 1].children[cellIndex] : null;
    }
    if (target) { e.preventDefault(); placeCaretAtStart(target); }
  });
}
function cellAtCaret() {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return null;
  const node = sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode;
  return node ? node.closest('table.write-cells td') : null;
}
function nextCell(table, rowIndex, cellIndex) {
  const row = table.rows[rowIndex];
  if (row.children[cellIndex + 1]) return row.children[cellIndex + 1];
  const nextRow = table.rows[rowIndex + 1];
  return nextRow ? nextRow.children[0] : null;
}
function prevCell(table, rowIndex, cellIndex) {
  const row = table.rows[rowIndex];
  if (row.children[cellIndex - 1]) return row.children[cellIndex - 1];
  const prevRow = table.rows[rowIndex - 1];
  return prevRow ? prevRow.children[prevRow.children.length - 1] : null;
}
function atCellStart(td) {
  const sel = window.getSelection();
  if (!sel.isCollapsed || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  return r.startOffset === 0 && (r.startContainer === td || r.startContainer === td.firstChild);
}
function atCellEnd(td) {
  const sel = window.getSelection();
  if (!sel.isCollapsed || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
  let last = null, n;
  while ((n = walker.nextNode())) last = n;
  if (!last) return true;
  return r.startContainer === last && r.startOffset === last.data.length;
}
function placeCaretAtStart(td) {
  const range = document.createRange();
  range.selectNodeContents(td);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
