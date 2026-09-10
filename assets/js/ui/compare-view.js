/**
 * The Compare view.
 *
 * Two files, side by side, aligned row for row. Everything hard about that is
 * in features/diff — this file is about the reading of it, and three things in
 * particular:
 *
 * Only the visible rows exist. A comparison of two hundred-thousand-line files
 * is two hundred thousand rows, and a browser asked to hold that many elements
 * stops being a browser. Every row is exactly one line tall, so the row under
 * any scroll position is arithmetic rather than measurement: the pane is given
 * a spacer of the full height, and the forty-odd rows on screen are drawn into
 * a box translated to the right offset. Scrolling redraws those forty. That is
 * the whole trick, and it is why a ten-megabyte comparison scrolls like a short
 * one.
 *
 * The two panes agree. Both are drawn from the same row list, so a row's two
 * halves are always at the same height, and linking the panes is then a matter
 * of copying one scroll position to the other. Unlinking them is a matter of
 * not doing that — which is the whole of the Free scroll mode, and why it costs
 * nothing to offer.
 *
 * The unchanged parts get out of the way. Two files that differ in four places
 * are mostly the same file; a long unchanged run keeps a little context at each
 * end and offers the rest behind one row, which can be opened where it matters.
 *
 * A view: it reads state, renders, and asks features/compares.js to change it.
 */
import { on, EVENTS } from '../core/bus.js';
import {
  DIFF_ALGOS, DIFF_CONTEXT, DIFF_LAYOUTS, DIFF_OPTIONS, DIFF_OVERSCAN, DIFF_ROW_H,
  DIFF_SAVE_MS, DIFF_SCROLLS, DIFF_STRATEGIES, MIN_PANE, RESIZE_STEP, RESIZE_STEP_BIG
} from '../core/config.js';
import { $, $$, clamp, el, prefers } from '../core/dom.js';
import { formatBytes, formatWhen, plural } from '../core/format.js';
import { route } from '../core/router.js';
import { compares, comparesByRecency, compareById, files, jsondocs } from '../core/state.js';
import { toast } from '../core/toast.js';
import {
  addCompare, deriveCompareName, loadSideFromUrl, readSideFile, removeCompare, side, updateCompare
} from '../features/compares.js';
import {
  autoStrategy, blocksOf, compare, createSyntax, detectPair, foldRows, optionsFor, unifiedPatch
} from '../features/diff/index.js';
import { saveOneFile } from '../features/exporter.js';

/* ---------- State ---------- */

let recId = null;            // the library record, once this comparison is kept
let name = '';
let sideA = null;            // { name, kind, source, text }
let sideB = null;
let opts = { strategy: 'auto', algo: 'histogram' };
let touched = false;         // has the reader changed the options themselves?
let type = null;             // what the pair was taken to be
let result = null;
let rows = [];               // every row of the comparison
let view = [];               // the rows on screen, folds and all
let flat = [];               // the same, flattened for the unified layout
let opened = new Set();      // folds the reader has opened
let showAll = false;
let layout = 'split';
let scrollMode = 'linked';
let blocks = [];
let cursor = -1;             // which change we are on
let colour = null;           // the syntax colourers, when the type has one
let running = 0;             // comparison generation; a stale reply is dropped
let busy = false;
let saveTimer = null;
let picking = 'a';
let pickWay = 'file';
let ready = false;
let widths = { a: 0, b: 0 };

/* ---------- Building, once ---------- */

function build() {
  if (ready) return;
  ready = true;

  segmented($('#cLayouts'), DIFF_LAYOUTS, () => layout, next => { layout = next; render(); });
  segmented($('#cScrolls'), DIFF_SCROLLS, () => scrollMode, next => {
    scrollMode = next;
    syncChrome();
    if (next === 'linked') mirror(paneA, paneB);
  });
  dropdown($('#cStrategy'), DIFF_STRATEGIES, 'How the two files are matched up');
  dropdown($('#cAlgo'), DIFF_ALGOS, 'Line matching algorithm');
  buildOptions();
  segmented($('#cmpWays'), WAYS, () => pickWay, next => { pickWay = next; showWay(); });
}

function segmented(box, items, current, pick) {
  box.innerHTML = '';
  items.forEach(item => {
    const b = el('button', null, item.label);
    b.type = 'button';
    b.dataset.key = item.key;
    b.title = item.hint;
    b.setAttribute('aria-pressed', String(item.key === current()));
    b.addEventListener('click', () => {
      pick(item.key);
      $$('button', box).forEach(x => x.setAttribute('aria-pressed', String(x.dataset.key === item.key)));
    });
    box.appendChild(b);
  });
}

function dropdown(select, items, label) {
  select.innerHTML = '';
  select.title = label;
  items.forEach(item => {
    const o = el('option', null, item.label);
    o.value = item.key;
    o.title = item.hint;
    select.appendChild(o);
  });
}

function buildOptions() {
  const box = $('#cOptsPanel');
  box.innerHTML = '';
  DIFF_OPTIONS.forEach(item => {
    const label = el('label', 'copt');
    const box2 = document.createElement('input');
    box2.type = 'checkbox';
    box2.dataset.key = item.key;
    box2.addEventListener('change', () => {
      opts[item.key] = box2.checked;
      /* Ignoring all whitespace already ignores the trailing sort. */
      if (item.key === 'allSpace' && box2.checked) opts.trimEnd = true;
      touched = true;
      /* Colour is a property of the drawing, not of the comparison — there is
         no reason to match ten megabytes again to change it. */
      if (item.key === 'syntax') {
        if (result) colour = colourers(result);
        virtA.paint(true);
        virtB.paint(true);
        syncChrome();
        return;
      }
      syncChrome();
      run();
    });
    label.appendChild(box2);
    label.appendChild(el('span', 't', item.label));
    label.title = item.hint;
    box.appendChild(label);
  });
}

/* ---------- Opening ---------- */

/** Open a kept comparison. */
export function openCompare(id) {
  const rec = compareById(id);
  if (!rec) { toast('That comparison is no longer here.'); return; }
  build();
  recId = rec.id;
  name = rec.name;
  sideA = side(rec.a);
  sideB = side(rec.b);
  opts = Object.assign({ strategy: 'auto', algo: 'histogram' }, rec.opts);
  touched = true;
  opened = new Set();
  showAll = false;
  cursor = -1;
  route('compare');
  run();
}

/** Start a fresh comparison from two sides, either of which may be missing. */
export function startCompare(a, b, title) {
  build();
  recId = null;
  name = title || '';
  if (a) sideA = side(a);
  if (b) sideB = side(b);
  touched = false;
  opened = new Set();
  showAll = false;
  cursor = -1;
  route('compare');
  run();
}

/** Two files dropped on the window while this view is on screen. */
export function acceptCompareDrop(dropped) {
  if (!dropped || !dropped.length) return false;
  build();
  (async () => {
    try {
      if (dropped.length >= 2) {
        const [a, b] = await Promise.all([readSideFile(dropped[0]), readSideFile(dropped[1])]);
        recId = null; name = ''; touched = false;
        sideA = a; sideB = b;
      } else {
        const one = await readSideFile(dropped[0]);
        if (!sideA) sideA = one;
        else if (!sideB) sideB = one;
        else { sideA = sideB; sideB = one; }
        if (!recId) touched = false;
      }
      opened = new Set();
      cursor = -1;
      run();
    } catch (err) {
      toast((err && err.message) || 'Couldn’t read that file.');
    }
  })();
  return true;
}

/* ---------- Running the comparison ---------- */

async function run() {
  if (!ready) build();
  if (!sideA || !sideB) {
    result = null; rows = []; view = []; flat = []; blocks = [];
    render();
    return;
  }
  const found = detectPair(sideA, sideB);
  type = found.type;
  /* Until the reader says otherwise, the options are the ones this kind of file
     wants: trailing space matters in a fixture and not in source. */
  if (!touched) opts = Object.assign(optionsFor(type), { strategy: opts.strategy, algo: opts.algo });

  /* Two files that turn out to be different kinds have no shared structure to
     match, so unless the reader has asked for one they are compared as lines. */
  const asked = Object.assign({}, opts, { type });
  if (!found.agree && (!opts.strategy || opts.strategy === 'auto')) asked.strategy = 'lines';

  const gen = ++running;
  busy = true;
  syncChrome();
  const answer = await compare(sideA, sideB, asked);
  if (gen !== running) return;                 // a later comparison overtook this one
  busy = false;

  result = answer;
  rows = answer.rows;
  rows.forEach((r, i) => { r.at = i; });
  if (!found.agree) {
    result.notes = result.notes.concat([
      'These two look like different kinds of file — ' + found.a.label + ' and ' + found.b.label +
      ' — so they are compared line by line.'
    ]);
  }
  colour = colourers(answer);
  measureWidths();
  opened = new Set();
  cursor = -1;
  render();
  if (recId) queueSave();
}

/** The syntax colourers for this comparison, when its type has one. */
function colourers(answer) {
  if (!opts.syntax) return null;
  if (answer.strategy === 'lines' && answer.aLines && answer.bLines) {
    return {
      a: createSyntax(answer.aLines, type.id),
      b: createSyntax(answer.bLines, type.id),
      byLine: true
    };
  }
  if (answer.strategy === 'structure') {
    /* The rows are JSON, one value per line, and JSON has nothing that spans a
       line — so each row can be coloured entirely on its own. */
    return {
      a: createSyntax(answer.rows.map(r => r.a || ''), 'json'),
      b: createSyntax(answer.rows.map(r => r.b || ''), 'json'),
      byLine: false
    };
  }
  return null;
}

/* ---------- Rendering ---------- */

const paneA = () => $('#cPaneA');
const paneB = () => $('#cPaneB');

function render() {
  const open = !!(sideA && sideB && result);
  $('#compareEmpty').hidden = !!(sideA && sideB && result);
  $('#cColB').hidden = layout === 'unified';
  $('#cGutter').hidden = layout === 'unified';
  $('#cRibbon').hidden = !open;

  const folded = open ? foldRows(rows, showAll ? Infinity : DIFF_CONTEXT, opened) : { view: [] };
  view = folded.view;
  flat = layout === 'unified' ? unify(view) : view;
  blocks = blocksOf(flat);
  measure();
  syncChrome();
  drawRibbon();
  virtA.reset();
  virtB.reset();
  virtA.paint(true);
  virtB.paint(true);
}

/** Redraw without moving anything: after a fold opens, or an option changes. */
function repaint() {
  const folded = foldRows(rows, showAll ? Infinity : DIFF_CONTEXT, opened);
  view = folded.view;
  flat = layout === 'unified' ? unify(view) : view;
  blocks = blocksOf(flat);
  measure();
  drawRibbon();
  virtA.paint(true);
  virtB.paint(true);
  syncChrome();
}

/**
 * One column instead of two: a rewritten row becomes its two halves, one above
 * the other, which is the unified diff everybody already knows how to read.
 */
function unify(list) {
  const out = [];
  list.forEach(r => {
    if (r.k === 'fold') { out.push(r); return; }
    if (r.k === 'chg') {
      out.push({ k: 'del', u: r.a, ai: r.ai, bi: null, segs: r.aSegs, move: r.move, soft: r.soft, at: r.at });
      out.push({ k: 'ins', u: r.b, ai: null, bi: r.bi, segs: r.bSegs, move: r.move, soft: r.soft, at: r.at });
      return;
    }
    const text = r.a === null ? r.b : r.a;
    out.push({ k: r.k, u: text, ai: r.ai, bi: r.bi, segs: r.k === 'del' ? r.aSegs : r.bSegs, move: r.move, soft: r.soft, at: r.at });
  });
  return out;
}

/**
 * How wide the widest line is, in characters.
 *
 * The panes are monospace, so a width in `ch` is exact, and fixing it up front
 * is what stops the row box from changing width as different rows scroll
 * through it — a pane whose content width jumps about while you scroll it is
 * unusable. Measured once when a comparison arrives, never again: walking every
 * line of a ten-megabyte file to open one fold would be a strange way to spend
 * a frame. A tab is counted as the four columns it is set to render as.
 */
function measureWidths() {
  const wide = (field) => {
    let most = 0;
    for (let i = 0; i < rows.length; i++) {
      const text = rows[i][field];
      if (!text) continue;
      let cols = text.length;
      if (text.indexOf('\t') >= 0) {
        for (let n = 0; n < text.length; n++) if (text[n] === '\t') cols += 3;
      }
      if (cols > most) most = cols;
    }
    return most;
  };
  widths = { a: wide('a'), b: wide('b') };
}

/* The gutters are pixels and the text is characters, so the pane needs both. */
const sizeFor = (cols) => 'calc(var(--cgutters) + ' + (cols + 3) + 'ch)';

function measure() {
  const single = layout === 'unified';
  $('#cSizerA').style.minWidth = sizeFor(single ? Math.max(widths.a, widths.b) : widths.a);
  $('#cSizerB').style.minWidth = sizeFor(widths.b);
}

/* ---------- The virtualiser ---------- */

/**
 * Draw the rows a pane can actually see, and nothing else.
 *
 * `side` is 'a', 'b', or 'u' for the single column of the unified layout. The
 * three differ only in which half of a row they read, so one implementation
 * covers all of them.
 */
function virtualiser(paneId, sizerId, rowsId, sideOf) {
  let first = -1, last = -1;
  const pane = () => $('#' + paneId);
  const sizer = () => $('#' + sizerId);
  const box = () => $('#' + rowsId);

  function paint(force) {
    const el2 = pane();
    const whichSide = sideOf();
    const list = whichSide === 'b' ? view : flat;
    const total = list.length;
    sizer().style.height = (total * DIFF_ROW_H) + 'px';
    const height = el2.clientHeight || 480;
    const start = Math.max(0, Math.floor(el2.scrollTop / DIFF_ROW_H) - DIFF_OVERSCAN);
    const end = Math.min(total, Math.ceil((el2.scrollTop + height) / DIFF_ROW_H) + DIFF_OVERSCAN);
    if (!force && start === first && end === last) return;
    first = start; last = end;
    const holder = box();
    holder.style.transform = 'translateY(' + (start * DIFF_ROW_H) + 'px)';
    holder.innerHTML = '';
    for (let i = start; i < end; i++) holder.appendChild(rowElement(list[i], whichSide));
  }

  return {
    paint,
    reset() { first = -1; last = -1; pane().scrollTop = 0; pane().scrollLeft = 0; }
  };
}

const virtA = virtualiser('cPaneA', 'cSizerA', 'cRowsA', () => (layout === 'unified' ? 'u' : 'a'));
const virtB = virtualiser('cPaneB', 'cSizerB', 'cRowsB', () => 'b');

const MARKS = { del: '−', ins: '+', chg: '~', eq: ' ', none: ' ' };

function rowElement(row, whichSide) {
  if (!row) return el('div', 'crow');
  if (row.k === 'fold') return foldElement(row);

  const single = whichSide === 'u';
  const text = single ? row.u : whichSide === 'a' ? row.a : row.b;
  const num = single ? (row.bi === null ? row.ai : row.bi) : whichSide === 'a' ? row.ai : row.bi;
  const segs = single ? row.segs : whichSide === 'a' ? row.aSegs : row.bSegs;
  /* Nothing on this side of a removal or an addition: a filler row, so the two
     panes stay in step and the reader can see that something is missing. */
  const kind = text === null ? 'none' : row.k;

  const node = el('div', 'crow ' + kind + (row.move ? ' moved' : '') + (row.soft ? ' soft' : ''));
  node.style.height = DIFF_ROW_H + 'px';
  const gutterNum = el('span', 'cnum', num === null ? '' : String(num));
  node.appendChild(gutterNum);
  node.appendChild(el('span', 'cmark', MARKS[kind] || ' '));

  const body = el('span', 'ctext');
  if (text !== null) fill(body, text, segs, row, whichSide);
  node.appendChild(body);
  if (row.move) {
    node.title = 'This block only changed place';
  }
  return node;
}

/**
 * A row's text.
 *
 * A rewritten line shows which words changed; an unchanged one shows its syntax
 * colours. Never both — a line marked twice over is harder to read than a line
 * marked once, and the two questions ("what changed here" and "what is this
 * code") are never being asked at the same moment.
 */
function fill(body, text, segs, row, whichSide) {
  if (segs && segs.length) {
    segs.forEach(seg => {
      if (!seg.text) return;
      body.appendChild(el('span', seg.eq ? 'cs' : 'cs mark', seg.text));
    });
    return;
  }
  const spans = colourSpans(row, whichSide, text);
  if (!spans) { body.textContent = text; return; }
  spans.forEach(span => body.appendChild(el('span', 'k-' + span.k, span.text)));
}

function colourSpans(row, whichSide, text) {
  if (!colour || !text) return null;
  const single = whichSide === 'u';
  const from = single ? (row.ai !== null ? 'a' : 'b') : whichSide;
  const painter = colour[from];
  if (!painter || !painter.active) return null;
  if (colour.byLine) {
    const line = from === 'a' ? row.ai : row.bi;
    return line === null ? null : painter.spans(line - 1);
  }
  return row.at === undefined ? null : painter.spans(row.at);
}

function foldElement(row) {
  const node = el('div', 'crow fold');
  node.style.height = DIFF_ROW_H + 'px';
  const b = el('button', 'cfold', plural(row.count, 'unchanged line', 'unchanged lines') + ' — show');
  b.type = 'button';
  b.addEventListener('click', () => {
    opened.add(row.at);
    repaint();
  });
  node.appendChild(b);
  return node;
}

/* ---------- The ribbon ---------- */

/**
 * A map of the whole comparison down the edge of the panes: one tick per change
 * block, placed where it falls in the file. On a long file this is the only
 * thing that answers "how much of this changed, and where" at a glance.
 */
const RIBBON_TICKS = 500;      // more marks than this on an 11px strip is a smear

function drawRibbon() {
  const strip = $('#cRibbon');
  strip.innerHTML = '';
  if (!result || !result.blocks.length || !rows.length) return;
  const total = rows.length;
  const all = result.blocks;
  /* Past a few hundred changes the strip cannot show them separately anyway, so
     neighbours are gathered into one mark rather than drawing thousands of
     elements nobody can aim at. */
  const stride = Math.max(1, Math.ceil(all.length / RIBBON_TICKS));
  for (let i = 0; i < all.length; i += stride) {
    const group = all.slice(i, i + stride);
    const first = group[0], last = group[group.length - 1];
    const kind = group.every(x => x.moved) ? 'moved'
      : group.every(x => x.kind === first.kind) ? first.kind : 'chg';
    const tick = el('button', 'ctick ' + kind);
    tick.type = 'button';
    tick.tabIndex = -1;
    tick.setAttribute('aria-hidden', 'true');
    tick.style.top = ((first.start / total) * 100) + '%';
    tick.style.height = Math.max(0.35, ((last.end - first.start + 1) / total) * 100) + '%';
    const at = i;
    tick.addEventListener('click', () => goTo(at));
    strip.appendChild(tick);
  }
}

/* ---------- Moving between changes ---------- */

function goTo(index) {
  if (!blocks.length) return;
  cursor = clamp(index, 0, blocks.length - 1);
  const row = blocks[cursor].start;
  const target = Math.max(0, (row - 3) * DIFF_ROW_H);
  paneA().scrollTop = target;
  if (scrollMode === 'linked') paneB().scrollTop = target;
  virtA.paint();
  virtB.paint();
  syncWhere();
}

const step = (by) => {
  if (!blocks.length) { toast('These two are identical.'); return; }
  if (cursor < 0) goTo(by > 0 ? nearestBelow() : blocks.length - 1);
  else goTo((cursor + by + blocks.length) % blocks.length);
};

function nearestBelow() {
  const top = Math.floor(paneA().scrollTop / DIFF_ROW_H);
  for (let i = 0; i < blocks.length; i++) if (blocks[i].start >= top) return i;
  return 0;
}

function syncWhere() {
  const where = $('#cWhere');
  if (!blocks.length) { where.textContent = result && result.stats.identical ? 'identical' : ''; return; }
  let showing = cursor;
  if (showing < 0) {
    /* A file can have thousands of change blocks and this runs on every scroll
       event, so find the one at the top of the pane rather than walking to it. */
    const top = Math.floor(paneA().scrollTop / DIFF_ROW_H);
    let lo = 0, hi = blocks.length - 1;
    showing = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].start <= top) { showing = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
  }
  where.textContent = (showing + 1) + '/' + blocks.length;
}

/* ---------- Chrome ---------- */

function syncChrome() {
  const both = !!(sideA && sideB);
  const open = both && !!result;

  $('#cFileA').textContent = sideA ? shortName(sideA.name) || 'Pasted text' : 'Nothing chosen';
  $('#cFileB').textContent = sideB ? shortName(sideB.name) || 'Pasted text' : 'Nothing chosen';
  $('#cMetaA').textContent = sideA ? sideMeta(sideA, result && result.a) : '';
  $('#cMetaB').textContent = sideB ? sideMeta(sideB, result && result.b) : '';
  $('#cName').value = name;
  $('#cName').disabled = !both;
  $('#cName').placeholder = both ? deriveCompareName(sideA, sideB) : 'Untitled comparison';

  $('#cStrategy').value = opts.strategy || 'auto';
  $('#cAlgo').value = opts.algo || 'histogram';
  $('#cAlgo').disabled = effective() !== 'lines';
  $$('#cOptsPanel input').forEach(box => { box.checked = !!opts[box.dataset.key]; });
  $('#cOptions').setAttribute('aria-expanded', String(!$('#cOptsPanel').hidden));
  $('#cExpandAll').setAttribute('aria-pressed', String(showAll));
  $('#cExpandAll').textContent = showAll ? 'Fold unchanged' : 'Show all lines';
  $$('#cScrolls button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === scrollMode)));
  $$('#cLayouts button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.key === layout)));

  const showIf = (id, cond) => { $('#' + id).hidden = !cond; };
  ['cStrategy', 'cAlgo', 'cOptions', 'cScrolls', 'cPrev', 'cNext', 'cWhere', 'cExpandAll',
    'cSwap', 'cPatch', 'cSavePatch'].forEach(id => showIf(id, open));
  showIf('cLayouts', open);
  showIf('cKeep', open && !recId);
  showIf('cRemove', !!recId);
  showIf('cScrolls', open && layout === 'split');

  $('#cType').textContent = type ? typeLabel() : '';
  $('#cType').hidden = !open;
  $('#cStats').textContent = busy ? 'Comparing…' : open ? statusLine() : '';

  const banner = $('#cNotes');
  const notes = open && result.notes.length ? result.notes : [];
  banner.hidden = !notes.length;
  if (notes.length) banner.textContent = notes.join(' ');
  syncWhere();
}

const shortName = (n) => String(n || '').split(/[\\/]/).pop();

function sideMeta(one, counted) {
  const bits = [formatBytes(one.text.length)];
  if (counted) bits.push(plural(counted.lines, 'line', 'lines'));
  if (one.kind === 'url') bits.push('downloaded');
  if (one.kind === 'paste') bits.push('pasted');
  if (one.kind === 'library') bits.push('from your library');
  return bits.join(' · ');
}

function typeLabel() {
  const how = effective();
  const label = how === 'structure' ? 'structural' : how === 'table' ? 'tabular' : opts.algo || 'histogram';
  const guessed = type.from === 'content' ? ' (detected)' : '';
  return type.label + guessed + ' · ' + label;
}

const effective = () => (opts.strategy && opts.strategy !== 'auto' ? opts.strategy
  : result ? result.strategy : type ? autoStrategy(type) : 'lines');

function statusLine() {
  const s = result.stats;
  if (s.identical) return 'These two are identical' + (s.ignored ? ', give or take ' + plural(s.ignored, 'ignored line', 'ignored lines') : '');
  const bits = [];
  if (s.added) bits.push(s.added + ' added');
  if (s.removed) bits.push(s.removed + ' removed');
  if (s.changed) bits.push(s.changed + ' rewritten');
  if (s.moved) bits.push(plural(s.moved, 'block moved', 'blocks moved'));
  if (s.ignored) bits.push(s.ignored + ' ignored');
  bits.push(Math.round(s.similarity * 100) + '% alike');
  return bits.join(' · ');
}

/* ---------- Scrolling ---------- */

function mirror(from, to) {
  const a = from(), b = to();
  if (!a || !b) return;
  if (Math.abs(b.scrollTop - a.scrollTop) > 0.5) b.scrollTop = a.scrollTop;
  if (Math.abs(b.scrollLeft - a.scrollLeft) > 0.5) b.scrollLeft = a.scrollLeft;
}

/* ---------- The divider ---------- */

function evenPanes() {
  $('#cColA').style.flexGrow = '1';
  $('#cColB').style.flexGrow = '1';
}

function resizeBy(px) {
  const a = $('#cColA'), b = $('#cColB');
  const wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width;
  const total = wa + wb;
  if (total < 2 * MIN_PANE) return;
  const grown = (parseFloat(a.style.flexGrow) || 1) + (parseFloat(b.style.flexGrow) || 1);
  const na = clamp(wa + px, MIN_PANE, total - MIN_PANE);
  a.style.flexGrow = (na / total * grown).toFixed(4);
  b.style.flexGrow = ((total - na) / total * grown).toFixed(4);
}

function startDrag(e) {
  if (prefers('(max-width: 820px)')) return;
  const a = $('#cColA'), b = $('#cColB');
  e.preventDefault();
  const g = e.currentTarget;
  const startX = e.clientX;
  const wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width;
  const total = wa + wb;
  const grown = (parseFloat(a.style.flexGrow) || 1) + (parseFloat(b.style.flexGrow) || 1);

  g.classList.add('dragging');
  document.body.classList.add('resizing');
  try { g.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }

  const move = (ev) => {
    if (total < 2 * MIN_PANE) return;
    const na = clamp(wa + (ev.clientX - startX), MIN_PANE, total - MIN_PANE);
    a.style.flexGrow = (na / total * grown).toFixed(4);
    b.style.flexGrow = ((total - na) / total * grown).toFixed(4);
  };
  const done = () => {
    g.classList.remove('dragging');
    document.body.classList.remove('resizing');
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', done);
    g.removeEventListener('pointercancel', done);
    virtA.paint(true);
    virtB.paint(true);
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', done);
  g.addEventListener('pointercancel', done);
}

/* ---------- Keeping it ---------- */

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!recId) return;
    updateCompare(recId, { a: sideA, b: sideB, opts, name: name || deriveCompareName(sideA, sideB) });
  }, DIFF_SAVE_MS);
}

async function keep() {
  if (!sideA || !sideB) return;
  const rec = await addCompare({ name: name || deriveCompareName(sideA, sideB), a: sideA, b: sideB, opts });
  recId = rec.id;
  name = rec.name;
  syncChrome();
  toast('Kept “' + rec.name + '”. It is on your Home page.');
}

function closeCurrent() {
  recId = null;
  name = '';
  sideA = null; sideB = null;
  result = null; rows = []; view = []; flat = []; blocks = [];
  colour = null;
  cursor = -1;
  render();
}

/* ---------- Choosing a side ---------- */

const WAYS = [
  { key: 'file', label: 'Upload', hint: 'A file from this computer' },
  { key: 'paste', label: 'Paste', hint: 'Text pasted straight in' },
  { key: 'url', label: 'URL', hint: 'Downloaded from a public link' },
  { key: 'library', label: 'Library', hint: 'Something already open in Folio' }
];

function promptSide(which) {
  build();
  picking = which;
  $('#cmpErr').textContent = '';
  $('#cmpPicked').textContent = '';
  $('#cmpDlgTitle').textContent = which === 'a' ? 'Choose the left file' : 'Choose the right file';
  $('#cmpDlgLede').textContent = which === 'a'
    ? 'The version you are comparing from — the older one, usually.'
    : 'The version you are comparing to.';
  fillLibrary();
  showWay();
  const dlg = $('#cmpDlg');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  setTimeout(() => {
    const focus = pickWay === 'paste' ? $('#cmpText') : pickWay === 'url' ? $('#cmpUrl') : pickWay === 'library' ? $('#cmpLib') : $('#cmpPick');
    if (focus) focus.focus();
  }, 30);
}

function showWay() {
  $('#cmpWayFile').hidden = pickWay !== 'file';
  $('#cmpWayPaste').hidden = pickWay !== 'paste';
  $('#cmpWayUrl').hidden = pickWay !== 'url';
  $('#cmpWayLib').hidden = pickWay !== 'library';
  $('#cmpUse').hidden = pickWay === 'file';
  $('#cmpUse').disabled = pickWay === 'library' && !$('#cmpLib').options.length;
}

function fillLibrary() {
  const sel = $('#cmpLib');
  sel.innerHTML = '';
  const add = (group, list, read) => {
    if (!list.length) return;
    const box = el('optgroup');
    box.label = group;
    list.forEach(rec => {
      const o = el('option', null, rec.name + '  ·  ' + formatBytes(read(rec).length));
      o.value = group + ':' + rec.id;
      box.appendChild(o);
    });
    sel.appendChild(box);
  };
  add('Documents', files, f => f.content || '');
  add('JSON', jsondocs, j => j.text || '');
  $('#cmpLibNote').textContent = files.length + jsondocs.length
    ? 'Documents and JSON you have already opened.'
    : 'Nothing in your library yet — open a document or some JSON first.';
}

function assign(which, one) {
  if (which === 'a') sideA = one; else sideB = one;
  if (!recId) touched = false;
  opened = new Set();
  cursor = -1;
  run();
}

/* ---------- The Home section ---------- */

export function renderCompares() {
  const list = $('#compareRows');
  $('#secCompares').hidden = compares.length === 0;
  $('#comparesCount').textContent = compares.length ? plural(compares.length, 'comparison', 'comparisons') : '';
  list.innerHTML = '';
  comparesByRecency().forEach(rec => list.appendChild(compareRow(rec)));
}

function compareRow(rec) {
  const li = el('li', 'row-item');
  const main = el('button', 'row-main');
  main.type = 'button';
  const title = el('div', 'row-name');
  title.appendChild(el('span', 't', rec.name));
  title.appendChild(el('span', 'kind' + (rec.id === recId ? ' open' : ''), rec.id === recId ? 'Open' : 'Compare'));
  const sub = [formatWhen(rec.updatedAt), formatBytes((rec.a.text || '').length + (rec.b.text || '').length)];
  if (!rec.stored) sub.push('this session only');
  main.append(title, el('div', 'row-sub', sub.join(' · ')));
  main.addEventListener('click', () => openCompare(rec.id));

  const acts = el('div', 'row-act');
  const del = el('button', 'btn tiny ghost danger', 'Remove');
  del.type = 'button';
  del.addEventListener('click', async e => {
    e.stopPropagation();
    if (await removeCompare(rec.id) && rec.id === recId) closeCurrent();
  });
  acts.append(del);
  li.append(main, acts);
  return li;
}

/* ---------- Wiring ---------- */

$('#cPickA').addEventListener('click', () => promptSide('a'));
$('#cPickB').addEventListener('click', () => promptSide('b'));
$('#cEmptyA').addEventListener('click', () => promptSide('a'));
$('#cEmptyB').addEventListener('click', () => promptSide('b'));
$('#qCompare').addEventListener('click', () => { build(); route('compare'); if (!sideA) promptSide('a'); });
$('#newCompareLink').addEventListener('click', () => { build(); closeCurrent(); route('compare'); promptSide('a'); });

$('#cEmptySample').addEventListener('click', () => {
  const a = $('#sample-cmp-a'), b = $('#sample-cmp-b');
  startCompare(
    { name: 'Queue.kt', kind: 'sample', source: 'built-in', text: a ? a.textContent.replace(/^\n/, '') : '' },
    { name: 'Queue.kt (after)', kind: 'sample', source: 'built-in', text: b ? b.textContent.replace(/^\n/, '') : '' },
    'Queue.kt — before and after'
  );
});

$('#cName').addEventListener('change', () => {
  name = $('#cName').value.trim();
  if (recId) updateCompare(recId, { name: name || deriveCompareName(sideA, sideB) });
});

$('#cStrategy').addEventListener('change', () => {
  opts.strategy = $('#cStrategy').value;
  run();
});
$('#cAlgo').addEventListener('change', () => {
  opts.algo = $('#cAlgo').value;
  run();
});
$('#cOptions').addEventListener('click', () => {
  const panel = $('#cOptsPanel');
  panel.hidden = !panel.hidden;
  $('#cOptions').setAttribute('aria-expanded', String(!panel.hidden));
});
$('#cExpandAll').addEventListener('click', () => { showAll = !showAll; repaint(); });
$('#cPrev').addEventListener('click', () => step(-1));
$('#cNext').addEventListener('click', () => step(1));

$('#cSwap').addEventListener('click', () => {
  if (!sideA || !sideB) return;
  const held = sideA;
  sideA = sideB;
  sideB = held;
  run();
});

$('#cPatch').addEventListener('click', () => {
  const patch = unifiedPatch(rows, sideA ? sideA.name : 'a', sideB ? sideB.name : 'b', DIFF_CONTEXT);
  if (!patch) { toast('Nothing to copy — these two are identical.'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(patch).then(() => toast('Copied as a unified diff.'), () => {});
  }
});
$('#cSavePatch').addEventListener('click', () => {
  const patch = unifiedPatch(rows, sideA ? sideA.name : 'a', sideB ? sideB.name : 'b', DIFF_CONTEXT);
  if (!patch) { toast('Nothing to save — these two are identical.'); return; }
  saveOneFile(name || deriveCompareName(sideA, sideB), patch, 'diff');
});
$('#cKeep').addEventListener('click', keep);
$('#cRemove').addEventListener('click', async () => {
  if (recId && await removeCompare(recId)) closeCurrent();
});

/* The divider */
$('#cGutter').addEventListener('pointerdown', startDrag);
$('#cGutter').addEventListener('keydown', e => {
  const by = e.shiftKey ? RESIZE_STEP_BIG : RESIZE_STEP;
  if (e.key === 'ArrowLeft') { e.preventDefault(); resizeBy(-by); virtA.paint(true); virtB.paint(true); }
  if (e.key === 'ArrowRight') { e.preventDefault(); resizeBy(by); virtA.paint(true); virtB.paint(true); }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); evenPanes(); virtA.paint(true); virtB.paint(true); }
});
$('#cGutter').addEventListener('dblclick', () => { evenPanes(); virtA.paint(true); virtB.paint(true); });

/* Scrolling */
$('#cPaneA').addEventListener('scroll', () => {
  virtA.paint();
  /* Draw the other pane in the same turn as the scroll that moved it, or a
     fast flick shows a band of blank rows on one side. */
  if (scrollMode === 'linked' && layout === 'split') { mirror(paneA, paneB); virtB.paint(); }
  cursor = -1;
  syncWhere();
});
$('#cPaneB').addEventListener('scroll', () => {
  virtB.paint();
  if (scrollMode === 'linked' && layout === 'split') { mirror(paneB, paneA); virtA.paint(); }
  cursor = -1;
  syncWhere();
});
addEventListener('resize', () => {
  if (document.body.dataset.view !== 'compare') return;
  virtA.paint(true);
  virtB.paint(true);
});

/* The dialog */
$$('#cmpDlg [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$('#cmpPick').addEventListener('click', () => $('#compareInput').click());
$('#compareInput').addEventListener('change', async e => {
  const chosen = [...e.target.files];
  e.target.value = '';
  if (!chosen.length) return;
  try {
    if (chosen.length >= 2) {
      const [a, b] = await Promise.all([readSideFile(chosen[0]), readSideFile(chosen[1])]);
      $('#cmpDlg').close();
      recId = null; name = ''; touched = false;
      sideA = a; sideB = b;
      opened = new Set();
      run();
      return;
    }
    const one = await readSideFile(chosen[0]);
    $('#cmpDlg').close();
    assign(picking, one);
  } catch (err) {
    $('#cmpErr').textContent = (err && err.message) || 'Couldn’t read that file.';
  }
});

$('#cmpForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('#cmpErr');
  err.textContent = '';
  try {
    if (pickWay === 'paste') {
      const text = $('#cmpText').value;
      if (!text) { err.textContent = 'Nothing pasted yet.'; return; }
      const title = $('#cmpTitle').value.trim();
      assign(picking, side({ name: title, kind: 'paste', source: 'pasted', text }));
      $('#cmpText').value = ''; $('#cmpTitle').value = '';
    } else if (pickWay === 'url') {
      const url = $('#cmpUrl').value.trim();
      if (!url) { err.textContent = 'A link is needed.'; return; }
      const btn = $('#cmpUse');
      btn.disabled = true; btn.textContent = 'Downloading…';
      try {
        assign(picking, await loadSideFromUrl(url));
        $('#cmpUrl').value = '';
      } finally {
        btn.disabled = false; btn.textContent = 'Use this file';
      }
    } else if (pickWay === 'library') {
      const value = $('#cmpLib').value;
      if (!value) { err.textContent = 'Nothing chosen.'; return; }
      const at = value.indexOf(':');
      const group = value.slice(0, at), id = value.slice(at + 1);
      const rec = group === 'JSON' ? jsondocs.find(j => j.id === id) : files.find(f => f.id === id);
      if (!rec) { err.textContent = 'That is no longer in your library.'; return; }
      assign(picking, side({
        name: rec.name,
        kind: 'library',
        source: rec.source || 'library',
        text: group === 'JSON' ? rec.text : rec.content
      }));
    } else {
      $('#compareInput').click();
      return;
    }
    $('#cmpDlg').close();
  } catch (thrown) {
    err.textContent = (thrown && thrown.message) || String(thrown);
  }
});

/* ---------- Shortcuts, live only while this view is on screen ---------- */

document.addEventListener('keydown', e => {
  if (document.body.dataset.view !== 'compare') return;
  const target = e.target;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' || target.isContentEditable);
  if (typing) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); return; }
  if (e.key === 'p' || e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); return; }
  if (e.key === 'u') { e.preventDefault(); layout = layout === 'split' ? 'unified' : 'split'; render(); return; }
  if (e.key === 's') {
    e.preventDefault();
    scrollMode = scrollMode === 'linked' ? 'free' : 'linked';
    if (scrollMode === 'linked') mirror(paneA, paneB);
    syncChrome();
    return;
  }
  if (e.key === 'x') { e.preventDefault(); showAll = !showAll; repaint(); return; }
  if (e.key === 'w') { e.preventDefault(); $('#cSwap').click(); }
});

on(EVENTS.COMPARES, () => { renderCompares(); syncChrome(); });
on(EVENTS.VIEW, viewName => {
  if (viewName !== 'compare') return;
  build();
  /* The panes had no height while the view was hidden, so nothing was drawn. */
  virtA.paint(true);
  virtB.paint(true);
  syncChrome();
});
