/**
 * Extension hook — find & replace (Phase 2, Agent B).
 *
 * `findMatches` is the pure part: given a flat string, a query and the two
 * toggles, it returns `{start, end}` offsets — no DOM, so tests/smoke.mjs
 * can exercise the matching rules directly. Everything else here maps
 * those offsets onto the live sheet: walking its text nodes once to build
 * an index, turning an offset pair into a Range, and painting all of them.
 *
 * Highlighting never touches the sheet's own content. Modern browsers get
 * the CSS Custom Highlight API (`CSS.highlights`), which paints ranges
 * without inserting anything into the DOM at all. Where that is not
 * available, the fallback still avoids mutating the sheet: it paints
 * fixed-position `<mark data-find>` rectangles over the live text's
 * `getClientRects()`, in an overlay layer outside the editable element —
 * so there is nothing to strip before a save, because nothing was ever
 * inside `ctx.sheet` to begin with, in either path. Only Replace / Replace
 * all touch the real content, and only the matched text itself.
 */

/* ---------- Pure matching ---------- */

/**
 * Every occurrence of `query` in `text`, as `{start, end}` character
 * offsets. Special regex characters in the query are escaped first, so a
 * literal search never becomes an accidental pattern.
 */
export function findMatches(text, query, opts = {}) {
  const { caseSensitive = false, wholeWord = false } = opts;
  const hay = String(text == null ? '' : text);
  const q = String(query == null ? '' : query);
  if (!q) return [];
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = wholeWord ? '\\b' + escaped + '\\b' : escaped;
  let re;
  try { re = new RegExp(pattern, caseSensitive ? 'g' : 'gi'); } catch (err) { return []; }
  const out = [];
  let m;
  while ((m = re.exec(hay))) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/* ---------- Icons ---------- */
const ICON_PATHS = {
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4.5-4.5',
  prev: 'M6 14l6-6 6 6',
  next: 'M6 10l6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18'
};
function icon(name) {
  const d = ICON_PATHS[name] || '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
}

/* ---------- Offsets ↔ Ranges on the live sheet ---------- */

function buildTextIndex(root) {
  const nodes = [];
  let pos = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const len = n.data.length;
    nodes.push({ node: n, start: pos, end: pos + len });
    pos += len;
  }
  return nodes;
}

/** `cursor` is a `{ i: 0 }` shared across calls in one pass, since offsets
    within a single render are always visited in increasing order. */
function pointAt(nodes, offset, cursor) {
  if (!nodes.length) return null;
  while (cursor.i < nodes.length - 1 && offset > nodes[cursor.i].end) cursor.i++;
  const rec = nodes[cursor.i];
  return { node: rec.node, offset: Math.max(0, Math.min(offset - rec.start, rec.node.data.length)) };
}

function rangeFor(nodes, start, end, cursor) {
  const a = pointAt(nodes, start, cursor);
  const b = pointAt(nodes, end, cursor);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/* ---------- Module state ---------- */

const usingHighlightApi = typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;

let barEl = null, replaceRow = null, queryInput = null, replaceInput = null, countEl = null;
let caseBtn = null, wholeBtn = null;
let overlayEl = null;
let lastRanges = [];
const state = { matches: [], active: -1 };

/* ---------- Building the bar (lazy, once) ---------- */

function iconBtn(name, title, run) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'wt-btn'; b.title = title; b.innerHTML = icon(name);
  b.addEventListener('click', run);
  return b;
}
function toggleBtn(label, title, ctx) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'wt-btn write-find-toggle'; b.textContent = label; b.title = title;
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); refresh(ctx); });
  return b;
}

function onBarKeydown(e, ctx) {
  if (e.key === 'Escape') { e.preventDefault(); closeFind(ctx); return; }
  if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) prevMatch(ctx); else nextMatch(ctx); }
}

function build(ctx) {
  if (barEl) return;
  barEl = document.createElement('div');
  barEl.className = 'write-find';
  barEl.hidden = true;

  const row = document.createElement('div');
  row.className = 'write-find-row';
  queryInput = document.createElement('input');
  queryInput.type = 'text'; queryInput.className = 'write-find-input write-find-query';
  queryInput.placeholder = 'Find'; queryInput.spellcheck = false;
  queryInput.addEventListener('input', () => refresh(ctx));
  queryInput.addEventListener('keydown', e => onBarKeydown(e, ctx));
  row.appendChild(queryInput);

  countEl = document.createElement('span');
  countEl.className = 'write-find-count';
  row.appendChild(countEl);

  row.appendChild(iconBtn('prev', 'Previous match (⇧Enter)', () => prevMatch(ctx)));
  row.appendChild(iconBtn('next', 'Next match (Enter)', () => nextMatch(ctx)));
  caseBtn = toggleBtn('Aa', 'Case-sensitive', ctx);
  wholeBtn = toggleBtn('""', 'Whole word', ctx);
  row.append(caseBtn, wholeBtn);
  row.appendChild(iconBtn('close', 'Close (Esc)', () => closeFind(ctx)));
  barEl.appendChild(row);

  replaceRow = document.createElement('div');
  replaceRow.className = 'write-find-row';
  replaceRow.hidden = true;
  replaceInput = document.createElement('input');
  replaceInput.type = 'text'; replaceInput.className = 'write-find-input';
  replaceInput.placeholder = 'Replace with…'; replaceInput.spellcheck = false;
  replaceInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeFind(ctx); }
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(ctx); }
  });
  replaceRow.appendChild(replaceInput);
  const repOne = document.createElement('button');
  repOne.type = 'button'; repOne.className = 'btn tiny ghost'; repOne.textContent = 'Replace';
  repOne.addEventListener('click', () => replaceOne(ctx));
  const repAll = document.createElement('button');
  repAll.type = 'button'; repAll.className = 'btn tiny primary'; repAll.textContent = 'Replace all';
  repAll.addEventListener('click', () => replaceAll(ctx));
  replaceRow.append(repOne, repAll);
  barEl.appendChild(replaceRow);

  document.body.appendChild(barEl);
  addEventListener('resize', () => { if (!barEl.hidden) position(ctx); });
}

function position(ctx) {
  const scrollEl = ctx.sheet.closest('.write-scroll') || ctx.pageEl;
  const rect = scrollEl.getBoundingClientRect();
  const w = barEl.offsetWidth || 420;
  barEl.style.top = Math.round(rect.top + 10) + 'px';
  barEl.style.left = Math.round(Math.max(8, rect.left + rect.width / 2 - w / 2)) + 'px';
}

/* ---------- Opening / closing ---------- */

function openFind(ctx, withReplace) {
  build(ctx);
  barEl.hidden = false;
  replaceRow.hidden = !withReplace;
  const sel = window.getSelection();
  const selected = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  if (selected && !queryInput.value) queryInput.value = selected;
  position(ctx);
  refresh(ctx);
  (withReplace ? replaceInput : queryInput).focus();
  queryInput.select();
}

function closeFind(ctx) {
  if (!barEl || barEl.hidden) return;
  barEl.hidden = true;
  clearHighlights();
  ctx.sheet.focus();
}

/* ---------- Matching + highlighting ---------- */

function refresh(ctx) {
  const text = ctx.sheet.textContent || '';
  const opts = {
    caseSensitive: caseBtn.getAttribute('aria-pressed') === 'true',
    wholeWord: wholeBtn.getAttribute('aria-pressed') === 'true'
  };
  state.matches = findMatches(text, queryInput.value, opts);
  if (!state.matches.length) state.active = -1;
  else if (state.active < 0 || state.active >= state.matches.length) state.active = 0;
  updateCount();
  renderHighlights(ctx);
  scrollToActive(ctx);
}

function updateCount() {
  countEl.textContent = !queryInput.value ? '' : (state.matches.length ? (state.active + 1) + ' / ' + state.matches.length : '0 / 0');
}

function clearHighlights() {
  if (usingHighlightApi) { CSS.highlights.delete('write-find'); CSS.highlights.delete('write-find-active'); }
  if (overlayEl) overlayEl.innerHTML = '';
  lastRanges = [];
}

function buildOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.className = 'write-find-overlay';
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function paintOverlay() {
  const layer = buildOverlay();
  layer.innerHTML = '';
  lastRanges.forEach((range, i) => {
    [...range.getClientRects()].forEach(rect => {
      const mark = document.createElement('mark');
      mark.className = 'write-find-mark' + (i === state.active ? ' active' : '');
      mark.setAttribute('data-find', '');
      mark.style.top = Math.round(rect.top) + 'px';
      mark.style.left = Math.round(rect.left) + 'px';
      mark.style.width = Math.round(rect.width) + 'px';
      mark.style.height = Math.round(rect.height) + 'px';
      layer.appendChild(mark);
    });
  });
}

function renderHighlights(ctx) {
  clearHighlights();
  if (!state.matches.length) return;
  const nodes = buildTextIndex(ctx.sheet);
  const cursor = { i: 0 };
  lastRanges = state.matches.map(m => rangeFor(nodes, m.start, m.end, cursor)).filter(Boolean);
  if (usingHighlightApi) {
    CSS.highlights.set('write-find', new Highlight(...lastRanges));
    if (state.active >= 0 && lastRanges[state.active]) {
      CSS.highlights.set('write-find-active', new Highlight(lastRanges[state.active]));
    }
  } else {
    paintOverlay();
  }
}

function scrollToActive(ctx) {
  if (state.active < 0 || !lastRanges[state.active]) return;
  const rect = lastRanges[state.active].getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return;
  const scrollEl = ctx.sheet.closest('.write-scroll') || ctx.sheet;
  const box = scrollEl.getBoundingClientRect();
  if (rect.top < box.top + 60) scrollEl.scrollBy({ top: rect.top - box.top - box.height * 0.35, behavior: 'smooth' });
  else if (rect.bottom > box.bottom - 60) scrollEl.scrollBy({ top: rect.bottom - box.bottom + box.height * 0.35, behavior: 'smooth' });
}

function nextMatch(ctx) {
  if (!state.matches.length) return;
  state.active = (state.active + 1) % state.matches.length;
  updateCount();
  renderHighlights(ctx);
  scrollToActive(ctx);
}
function prevMatch(ctx) {
  if (!state.matches.length) return;
  state.active = (state.active - 1 + state.matches.length) % state.matches.length;
  updateCount();
  renderHighlights(ctx);
  scrollToActive(ctx);
}

/* ---------- Replace ---------- */

function replaceOne(ctx) {
  if (state.active < 0 || !state.matches.length) return;
  const m = state.matches[state.active];
  const nodes = buildTextIndex(ctx.sheet);
  const range = rangeFor(nodes, m.start, m.end, { i: 0 });
  if (!range) return;
  range.deleteContents();
  range.insertNode(document.createTextNode(replaceInput.value));
  ctx.sheet.normalize();
  ctx.sheet.dispatchEvent(new Event('input', { bubbles: true }));
  refresh(ctx);
}

function replaceAll(ctx) {
  if (!state.matches.length) { ctx.toast('Nothing to replace.'); return; }
  const value = replaceInput.value;
  const nodes = buildTextIndex(ctx.sheet);
  const cursor = { i: 0 };
  const ranges = state.matches.map(m => rangeFor(nodes, m.start, m.end, cursor)).filter(Boolean);
  for (let i = ranges.length - 1; i >= 0; i--) {
    ranges[i].deleteContents();
    ranges[i].insertNode(document.createTextNode(value));
  }
  ctx.sheet.normalize();
  ctx.sheet.dispatchEvent(new Event('input', { bubbles: true }));
  ctx.toast('Replaced ' + ranges.length + (ranges.length === 1 ? ' match.' : ' matches.'));
  refresh(ctx);
}

/**
 * Hide the find bar and drop its highlights, without focusing the sheet —
 * for ui/write-view.js to call when switching (or closing) a document. Left
 * open, the bar's matches would still be pointing at text nodes from the
 * sheet that just got replaced.
 */
export function resetForDocSwitch() {
  if (barEl) barEl.hidden = true;
  clearHighlights();
}

/* ---------- init ---------- */

export function init(ctx) {
  ctx.registerToolbarButton('search', { title: 'Find (⌘F)', icon: icon('search'), run: () => openFind(ctx, false) });
  ctx.registerShortcut('mod+f', () => openFind(ctx, false));
  ctx.registerShortcut('mod+h', () => openFind(ctx, true));
  ctx.sheet.addEventListener('input', () => { if (barEl && !barEl.hidden) refresh(ctx); });
  addEventListener('scroll', () => { if (barEl && !barEl.hidden && !usingHighlightApi) paintOverlay(); }, true);
}
