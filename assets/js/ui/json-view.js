/**
 * The JSON view.
 *
 * One document, five ways to look at it, and the switch between them costs
 * nothing: the parsed value is shared, each surface renders from it on demand,
 * and only the one on screen exists in the DOM.
 *
 *   tree   the reading view — collapsible, coloured, lazy
 *   table  any array of objects as rows and columns
 *   code   formatted and coloured, with line numbers
 *   raw    the text exactly as it arrived
 *   edit   a plain source pane that says where the syntax broke
 *
 * Editing never gets in reading's way. The tree only grows controls when
 * *Edit values* is switched on, and the source pane is a mode of its own.
 *
 * A view: it reads state, renders, and asks features/jsondocs.js to change it.
 */
import { on, EVENTS } from '../core/bus.js';
import {
  GRAPH_OPEN_DEPTH, JSON_INDENT, JSON_MODES, JSON_OPEN_DEPTH, JSON_SAVE_MS
} from '../core/config.js';
import { $, $$, el } from '../core/dom.js';
import { formatBytes, formatWhen, plural } from '../core/format.js';
import { jsonDocById, jsondocs, jsonDocsByRecency } from '../core/state.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { saveOneFile } from '../features/exporter.js';
import {
  addJsonDoc, deriveJsonName, loadJsonFromUrl, removeJsonDoc, renameJsonDoc, updateJsonDoc
} from '../features/jsondocs.js';
import { renderCode } from '../features/json/code.js';
import {
  minify, parse, pretty, sortKeys, stats, tables, typeOf, unwrap
} from '../features/json/model.js';
import { createGraph } from '../features/json/graph.js';
import { createTable } from '../features/json/table.js';
import { createTree } from '../features/json/tree.js';

/* ---------- State ---------- */

let docId = null;          // the record being read
let text = '';             // its source, as edited
let value = null;          // the parsed value, or null while broken
let problem = null;        // { error, line, column } while broken
let stream = 0;            // how many documents were laid end to end, if several
let mode = 'tree';
let unwrapped = false;
let saveTimer = null;
let saved = true;
let at = -1;               // which match the reader has stepped to, -1 for none
let picks = [];            // the arrays the table view can show
let pickedTable = 0;
let info = null;           // node counts, worked out once per value
let painted = {};          // which surfaces are up to date

let tree = null;
let table = null;
let graph = null;

/* ---------- Opening ---------- */

export function openJsonDoc(id) {
  const rec = jsonDocById(id);
  if (!rec) { toast('That document is no longer here.'); return; }
  build();
  docId = rec.id;
  load(rec.text);
  route('json');
}

/**
 * Everything derived from a new value, in one place. Walking a large document
 * is not free, so it happens when the value changes and never again — the
 * toolbar reads the answers rather than asking for them on every keystroke.
 */
function derive() {
  picks = value === null ? [] : tables(value);
  if (pickedTable >= picks.length) pickedTable = biggestTable();
  info = value === null ? null : stats(value);
}

/** Read a document in from text, wherever it came from. */
function load(source) {
  text = String(source == null ? '' : source);
  const res = parse(text);
  value = res.ok ? res.value : null;
  problem = res.ok ? null : res;
  stream = res.stream || 0;
  at = -1;
  pickedTable = 0;
  derive();
  pickedTable = biggestTable();
  saved = true;
  invalidate();
  /* The source pane always holds the open document, whether or not it is the
     surface on screen. It commits on blur, and a blur can arrive long after a
     different document was opened — which would write this one's text over
     that one's. Keeping it in step is the only way that cannot happen. */
  $('#jEditArea').value = text;
  painted.edit = true;
  if (!res.ok && mode !== 'raw') mode = 'edit';
  render();
}

function biggestTable() {
  let at = 0;
  picks.forEach((t, i) => { if (t.rows > (picks[at] ? picks[at].rows : 0)) at = i; });
  return at;
}

const invalidate = () => { painted = {}; };

/* ---------- Building, once ---------- */

let ready = false;
function build() {
  if (ready) return;
  ready = true;

  renderModes();

  tree = createTree({
    host: $('#jTreeHost'),
    onChange: () => afterTreeEdit(),
    onSelect: (hit) => showCrumb(hit),
    onCopy: (copied) => toast('Copied ' + plural(copied.length, 'character', 'characters') + '.')
  });

  graph = createGraph({
    host: $('#jGraphHost'),
    onSelect: (hit) => { showCrumb(hit); syncToolbar(); },
    onReveal: (segments) => { setMode('tree'); tree.reveal(segments); }
  });

  table = createTable({
    host: $('#jTableHost'),
    onOpen: (row, label, segments) => {
      const chosen = picks[pickedTable];
      if (!chosen) return;
      /* The cell knows its own path inside the record; prefix the record. */
      setMode('tree');
      tree.reveal(chosen.segments.concat([{ key: row }], segments || []));
    }
  });
}

function renderModes() {
  const box = $('#jModes');
  box.innerHTML = '';
  JSON_MODES.forEach(m => {
    const b = el('button', null, m.label);
    b.type = 'button';
    b.dataset.mode = m.key;
    b.title = m.hint;
    b.setAttribute('aria-pressed', String(m.key === mode));
    b.addEventListener('click', () => setMode(m.key));
    box.appendChild(b);
  });
}

/* ---------- Modes ---------- */

export function setMode(next) {
  if (!JSON_MODES.some(m => m.key === next)) return;
  if (mode === 'edit' && next !== 'edit') commitSource();
  mode = next;
  at = -1;                       // the nth match of one surface is not the nth of another
  render();
}

function render() {
  const open = docId !== null;
  $('#jsonEmpty').hidden = open;
  ['jTreeHost', 'jTableHost', 'jGraphHost', 'jCodeHost', 'jRawHost', 'jEditHost']
    .forEach(id => { $('#' + id).hidden = true; });
  syncToolbar();
  if (!open) { $('#jCrumb').hidden = true; $('#jError').hidden = true; return; }

  showProblem();
  if (mode === 'tree') paintTree();
  if (mode === 'table') paintTable();
  if (mode === 'graph') paintGraph();
  if (mode === 'code') paintCode();
  if (mode === 'raw') paintRaw();
  if (mode === 'edit') paintEdit();
}

function paintTree() {
  const host = $('#jTreeHost');
  host.hidden = false;
  if (value === null) {
    /* There is no tree to draw, but leaving the stage blank would look broken. */
    host.innerHTML = '';
    host.appendChild(el('p', 'empty-line', 'Nothing to outline until the syntax parses — the edit pane says where it breaks.'));
    painted.tree = false;
    return;
  }
  if (!painted.tree) {
    tree.setRoot(value, JSON_OPEN_DEPTH);
    tree.setEditable($('#jEditable').getAttribute('aria-pressed') === 'true');
    if (query()) tree.search(query());
    painted.tree = true;
  }
}

function paintTable() {
  const host = $('#jTableHost');
  host.hidden = false;
  host.classList.toggle('empty', !picks.length);
  if (!picks.length) {
    host.innerHTML = '';
    host.appendChild(el('p', 'empty-line',
      value === null
        ? 'Fix the syntax in the edit pane and the table will fill itself in.'
        : 'No array of objects in this document — the tree and code views are the ones to use.'));
    return;
  }
  if (!painted.table) {
    const chosen = picks[pickedTable] || picks[0];
    table.setRows(chosen.value);
    table.setFilter(query());
    painted.table = true;
    syncToolbar();
  }
}

function paintGraph() {
  const host = $('#jGraphHost');
  host.hidden = false;
  if (value === null) {
    host.innerHTML = '';
    host.appendChild(el('p', 'empty-line', 'Nothing to map until the syntax parses — the edit pane says where it breaks.'));
    painted.graph = false;
    return;
  }
  if (!painted.graph) {
    graph.setRoot(value, GRAPH_OPEN_DEPTH);
    if (query()) graph.search(query());
    painted.graph = true;
    syncToolbar();
  }
}

function paintCode() {
  const host = $('#jCodeHost');
  host.hidden = false;
  if (!painted.code) {
    const shown = value === null ? text : pretty(unwrapped ? unwrap(value) : value, JSON_INDENT);
    const out = renderCode(host, shown, query());
    painted.code = true;
    painted.codeInfo = out;
    syncToolbar();
  }
}

function paintRaw() {
  $('#jRawHost').hidden = false;
  if (!painted.raw) { $('#jRaw').textContent = text; painted.raw = true; }
}

function paintEdit() {
  $('#jEditHost').hidden = false;
  const area = $('#jEditArea');
  if (!painted.edit) { area.value = text; painted.edit = true; }
  setTimeout(() => area.focus(), 20);
}

/* ---------- The source pane ---------- */

/** Re-read the textarea. Called as you type (debounced) and on leaving Edit. */
function commitSource() {
  if (docId === null) return;
  const area = $('#jEditArea');
  if (area.value === text) return;
  text = area.value;
  const res = parse(text);
  value = res.ok ? res.value : null;
  problem = res.ok ? null : res;
  stream = res.stream || 0;
  derive();
  const keepEdit = painted.edit;
  invalidate();
  painted.edit = keepEdit;
  queueSave();
  showProblem();
  syncToolbar();
}

/**
 * Replace the source outright — what Format, Minify and Sort keys all do.
 * Everything is derived again from the new text, so there is one code path and
 * no way for the text and the value to drift apart.
 */
function applySource(next, label) {
  text = String(next);
  const res = parse(text);
  value = res.ok ? res.value : null;
  problem = res.ok ? null : res;
  stream = res.stream || 0;
  derive();
  invalidate();
  $('#jEditArea').value = text;
  painted.edit = true;
  queueSave();
  render();
  if (label) toast(label + ' — ' + formatBytes(text.length) + '.');
}

/** The three rewrites all need a document that parses. */
function needValue() {
  if (value !== null) return true;
  toast('Fix the syntax first — ' + (problem ? problem.error : 'invalid JSON') + '.');
  return false;
}

/* ---------- Editing in the tree ---------- */

function afterTreeEdit() {
  value = tree.root();
  text = pretty(value, JSON_INDENT);
  /* Whatever it arrived as, it is one document now. */
  stream = 0;
  derive();
  const keepTree = painted.tree;
  invalidate();
  painted.tree = keepTree;
  $('#jEditArea').value = text;
  painted.edit = true;
  queueSave();
  syncToolbar();
}

/* ---------- Saving ---------- */

function queueSave() {
  saved = false;
  syncToolbar();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (docId === null) return;
    await updateJsonDoc(docId, text);
    saved = true;
    syncToolbar();
  }, JSON_SAVE_MS);
}

/** Write pending edits out now — on leaving the view, or before exporting. */
export async function flushJson() {
  if (saved || docId === null) return;
  clearTimeout(saveTimer);
  await updateJsonDoc(docId, text);
  saved = true;
  syncToolbar();
}

/* ---------- Chrome ---------- */

const query = () => $('#jSearch').value.trim();

/* ---------- Stepping through the matches ---------- */

/**
 * Find is one box, and every surface answers it — so stepping has to work on
 * all of them too. Each view knows how many matches it has and how to bring
 * the nth into view; this is only the arithmetic between them, which is the
 * same everywhere: wrap at both ends, so the last match leads back to the
 * first and Up from the first lands on the last.
 */
function findTotal() {
  if (docId === null || !query()) return 0;
  if (mode === 'tree') return value === null ? 0 : tree.matchCount();
  if (mode === 'graph') return value === null ? 0 : graph.matchCount();
  if (mode === 'table') return table.matchCount();
  if (mode === 'code') return painted.codeInfo ? painted.codeInfo.marks : 0;
  if (mode === 'edit') return sourceMatches().length;
  return 0;
}

/** Where the search term sits in the source text, in order. */
function sourceMatches() {
  const needle = query().toLowerCase();
  if (!needle) return [];
  const hay = $('#jEditArea').value.toLowerCase();
  const found = [];
  let from = 0, next;
  while ((next = hay.indexOf(needle, from)) !== -1) { found.push(next); from = next + needle.length; }
  return found;
}

function focusMatch() {
  if (at < 0) return;
  if (mode === 'tree') { tree.focusMatch(at); return; }
  if (mode === 'graph') { graph.focusMatch(at); return; }
  if (mode === 'table') { table.focusMatch(at); return; }
  if (mode === 'code') {
    const marks = $$('#jCodeHost mark.jc-hit');
    marks.forEach(m => m.classList.remove('hit-now'));
    const one = marks[at];
    if (!one) return;
    one.classList.add('hit-now');
    if (typeof one.scrollIntoView === 'function') one.scrollIntoView({ block: 'center' });
    return;
  }
  if (mode === 'edit') {
    const spots = sourceMatches();
    const area = $('#jEditArea');
    const start = spots[at];
    if (start === undefined) return;
    /* The caret is the only highlight a textarea has, so put it on the match
       and leave the focus in the find box — otherwise Enter would stop
       stepping the moment it worked. */
    area.setSelectionRange(start, start + query().length);
    const line = area.value.slice(0, start).split('\n').length - 1;
    const step = parseFloat(getComputedStyle(area).lineHeight) || 20;
    area.scrollTop = Math.max(0, (line - 4) * step);
  }
}

/** Step to the next match, or the previous one. Both ends wrap. */
function stepFind(delta) {
  const total = findTotal();
  if (!total) { at = -1; syncToolbar(); return; }
  at = at < 0 ? (delta > 0 ? 0 : total - 1) : (((at + delta) % total) + total) % total;
  focusMatch();
  syncToolbar();
}

function showProblem() {
  const banner = $('#jError');
  if (!problem) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = '';
  banner.appendChild(el('strong', null, 'Invalid JSON'));
  banner.appendChild(document.createTextNode(' — ' + problem.error +
    (problem.line ? ' at line ' + problem.line + ', column ' + problem.column : '') + '. '));
  if (mode !== 'edit') {
    const go = el('button', 'link', 'Open the edit pane');
    go.type = 'button';
    go.addEventListener('click', () => setMode('edit'));
    banner.appendChild(go);
  } else if (problem.line) {
    const go = el('button', 'link', 'Go to line ' + problem.line);
    go.type = 'button';
    go.addEventListener('click', () => selectProblemLine());
    banner.appendChild(go);
  }
}

/** Put the caret where the parser gave up. */
function selectProblemLine() {
  const area = $('#jEditArea');
  if (!problem || !problem.line) return;
  const lines = area.value.split('\n');
  let at = 0;
  for (let i = 0; i < problem.line - 1; i++) at += lines[i].length + 1;
  const end = at + (lines[problem.line - 1] || '').length;
  area.focus();
  area.setSelectionRange(at, end);
}

function showCrumb(hit) {
  $('#jCrumb').hidden = false;
  $('#jCrumbPath').textContent = hit.path;
  $('#jCrumbType').textContent = hit.type;
  $('#jCrumbType').dataset.type = hit.type;
}

/** Which controls make sense right now, and what the status line says. */
function syncToolbar() {
  const open = docId !== null;
  const rec = open ? jsonDocById(docId) : null;
  $$('#jModes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#jName').value = rec ? rec.name : '';
  $('#jName').disabled = !open;

  const showIf = (id, cond) => { $('#' + id).hidden = !cond; };
  const outline = mode === 'tree' || mode === 'graph';
  showIf('jExpand', open && outline);
  showIf('jCollapse', open && outline);
  showIf('jEditable', open && mode === 'tree');
  ['jZoomOut', 'jZoom', 'jZoomIn', 'jFit'].forEach(id => showIf(id, open && mode === 'graph'));
  showIf('jUnwrap', open && mode === 'code');
  showIf('jFormat', open && mode === 'edit');
  showIf('jMinify', open && mode === 'edit');
  showIf('jSortKeys', open && mode === 'edit');
  showIf('jTables', open && mode === 'table' && picks.length > 1);
  showIf('jSearch', open && mode !== 'raw');
  if (open && mode === 'graph') $('#jZoom').textContent = Math.round(graph.zoomLevel() * 100) + '%';
  showIf('jHits', open && mode !== 'raw');
  const steps = open && mode !== 'raw' && findTotal() > 0;
  showIf('jPrev', steps);
  showIf('jNext', steps);
  showIf('jCopy', open);
  showIf('jExport', open);
  showIf('jRemove', open);

  if (open && mode === 'table' && picks.length > 1) renderTablePicker();

  $('#jStats').textContent = open ? statusLine() : '';
  $('#jSaved').textContent = open ? (saved ? 'Saved' : 'Editing…') : '';
  $('#jHits').textContent = hitLine();
}

function statusLine() {
  const bits = [formatBytes(text.length)];
  if (value === null || !info) { bits.push('unparsed'); return bits.join(' · '); }
  bits.push(plural(info.nodes, 'node', 'nodes') + (info.partial ? '+' : ''));
  bits.push(info.depth + ' deep');
  /* Several whole documents pasted in together: say so, or the array they are
     being read as looks like something the reader did not write. */
  if (stream) bits.push(plural(stream, 'document', 'documents') + ' read as a list');
  if (mode === 'table') {
    const chosen = picks[pickedTable];
    if (chosen) bits.push(plural(chosen.rows, 'row', 'rows') + ' × ' + table.columnCount() + ' cols');
  }
  if (mode === 'code' && painted.codeInfo) {
    bits.push(plural(painted.codeInfo.lines, 'line', 'lines'));
    if (!painted.codeInfo.coloured) bits.push('too big to colour');
  }
  if (mode === 'graph' && painted.graph) {
    const drawn = graph.info();
    bits.push(plural(drawn.nodes, 'box', 'boxes') + (drawn.partial ? ' drawn' : ''));
  }
  if (info.embeds) bits.push(plural(info.embeds, 'nested document', 'nested documents'));
  return bits.join(' · ');
}

function hitLine() {
  const q = query();
  if (!q || docId === null) return '';
  const total = findTotal();
  /* "3 of 10" once you are stepping, the plain count until then — the position
     is noise before it means anything. */
  const where = (n, one, many) => (n ? (at >= 0 ? (at + 1) + ' of ' + n + ' ' + (n === 1 ? one : many) : plural(n, one, many)) : '');
  if (mode === 'table') return total ? where(total, 'row', 'rows') : 'no rows';
  if (mode === 'edit') return total ? where(total, 'match', 'matches') : 'no matches';
  if (mode === 'code') return painted.codeInfo ? (total ? where(total, 'match', 'matches') : 'no matches') : '';
  const outline = mode === 'tree' ? tree : mode === 'graph' ? graph : null;
  if (outline) return outline.searchHits() ? where(total, 'match', 'matches') : 'no matches';
  return '';
}

function renderTablePicker() {
  const sel = $('#jTables');
  if (sel.dataset.stamp === String(picks.length) + ':' + docId) { sel.value = String(pickedTable); return; }
  sel.dataset.stamp = String(picks.length) + ':' + docId;
  sel.innerHTML = '';
  picks.forEach((t, i) => {
    const o = el('option', null, t.path + '  ·  ' + plural(t.rows, 'row', 'rows'));
    o.value = String(i);
    sel.appendChild(o);
  });
  sel.value = String(pickedTable);
}

/* ---------- Sources ---------- */

export function pickJsonFile() { $('#jsonInput').click(); }

export async function openJsonFiles(list) {
  const chosen = [...list].slice(0, 6);
  let last = null;
  for (const file of chosen) {
    try {
      last = await addJsonDoc({ name: file.name, kind: 'file', source: file.name, text: await file.text() });
    } catch (err) {
      toast('Couldn’t read “' + file.name + '”.');
    }
  }
  if (last) openJsonDoc(last.id);
  return last;
}

export async function openSampleJson() {
  const node = $('#sample-json');
  const rec = await addJsonDoc({
    name: 'Call sync — sample.json',
    kind: 'sample',
    source: 'built-in',
    text: node ? node.textContent.trim() : '{}'
  });
  openJsonDoc(rec.id);
}

/* ---------- The library section on Home ---------- */

export function renderJsonDocs() {
  const list = $('#jsonRows');
  $('#secJson').hidden = jsondocs.length === 0;
  $('#jsonCount').textContent = jsondocs.length ? plural(jsondocs.length, 'document', 'documents') : '';
  list.innerHTML = '';
  jsonDocsByRecency().forEach(rec => list.appendChild(jsonRow(rec)));
}

function jsonRow(rec) {
  const li = el('li', 'row-item');
  const main = el('button', 'row-main');
  main.type = 'button';
  const name = el('div', 'row-name');
  name.appendChild(el('span', 't', rec.name));
  name.appendChild(el('span', 'kind' + (rec.id === docId ? ' open' : ''), rec.id === docId ? 'Open' : 'JSON'));
  const res = parse(rec.text);
  const sub = [formatWhen(rec.updatedAt), formatBytes(rec.size || rec.text.length)];
  if (!res.ok) sub.push('invalid');
  else sub.push(typeOf(res.value) === 'array' ? plural(res.value.length, 'item', 'items') : typeOf(res.value));
  main.append(name, el('div', 'row-sub', sub.join(' · ')));
  main.addEventListener('click', () => openJsonDoc(rec.id));

  const acts = el('div', 'row-act');
  const save = el('button', 'btn tiny ghost', 'Save');
  save.type = 'button';
  save.title = 'Save this document as a .json file';
  save.addEventListener('click', e => { e.stopPropagation(); saveOneFile(rec.name, rec.text, 'json'); });
  const del = el('button', 'btn tiny ghost danger', 'Remove');
  del.type = 'button';
  del.addEventListener('click', async e => {
    e.stopPropagation();
    if (await removeJsonDoc(rec.id) && rec.id === docId) closeCurrent();
  });
  acts.append(save, del);
  li.append(main, acts);
  return li;
}

function closeCurrent() {
  docId = null;
  text = '';
  $('#jEditArea').value = '';
  value = null;
  problem = null;
  stream = 0;
  at = -1;
  picks = [];
  info = null;
  invalidate();
  if (tree) tree.setRoot(null);
  if (graph) graph.setRoot(null);
  if (table) table.clear();
  render();
}

/* ---------- Wiring ---------- */

$('#jModes').addEventListener('keydown', e => {
  const buttons = $$('#jModes button');
  const at = buttons.indexOf(document.activeElement);
  if (at < 0) return;
  const go = (i) => { e.preventDefault(); buttons[(i + buttons.length) % buttons.length].focus(); };
  if (e.key === 'ArrowRight') go(at + 1);
  if (e.key === 'ArrowLeft') go(at - 1);
});

$('#jName').addEventListener('change', () => {
  if (docId === null) return;
  renameJsonDoc(docId, $('#jName').value);
});

let findTimer = null;
let findPending = false;
function runFind() {
  findPending = false;
  if (docId === null) return;
  at = -1;                       // a new term starts again from the top
  if (mode === 'tree' && value !== null) tree.search(query());
  if (mode === 'graph' && value !== null) graph.search(query());
  if (mode === 'table') table.setFilter(query());
  if (mode === 'code') { painted.code = false; paintCode(); }
  syncToolbar();
}
$('#jSearch').addEventListener('input', () => {
  clearTimeout(findTimer);
  findPending = true;
  findTimer = setTimeout(runFind, 160);
});
$('#jSearch').addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#jSearch').value = ''; $('#jSearch').dispatchEvent(new Event('input')); return; }
  /* Enter steps forward and ⇧Enter back, which is what every find box does;
     the arrows do the same, so a hand already on them need not move. */
  if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    /* Enter can arrive inside the typing debounce; the search the reader is
       stepping through has to be the one they finished typing. */
    if (findPending) { clearTimeout(findTimer); runFind(); }
    stepFind(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
  }
});
$('#jPrev').addEventListener('click', () => stepFind(-1));
$('#jNext').addEventListener('click', () => stepFind(1));

$('#jExpand').addEventListener('click', () => {
  if (value === null) return;
  const whole = mode === 'graph' ? graph.expandAll() : tree.expandAll();
  syncToolbar();
  if (!whole) {
    toast(mode === 'graph'
      ? 'Drawn as much as fits on one map — open a branch for the rest.'
      : 'Opened as much as is comfortable — use Find to reach the rest.');
  }
});
$('#jCollapse').addEventListener('click', () => {
  if (mode === 'graph') graph.collapseAll();
  else tree.collapseAll();
  syncToolbar();
});
$('#jZoomIn').addEventListener('click', () => { graph.zoomBy(1.25); syncToolbar(); });
$('#jZoomOut').addEventListener('click', () => { graph.zoomBy(1 / 1.25); syncToolbar(); });
$('#jFit').addEventListener('click', () => { graph.fit(); syncToolbar(); });

$('#jEditable').addEventListener('click', () => {
  const btn = $('#jEditable');
  const next = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(next));
  tree.setEditable(next);
  if (query()) tree.search(query());
  toast(next
    ? 'Click any value to change it. Double-click a key to rename it.'
    : 'Back to reading.');
});

$('#jUnwrap').addEventListener('click', () => {
  const btn = $('#jUnwrap');
  unwrapped = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(unwrapped));
  painted.code = false;
  if (mode === 'code') paintCode();
  syncToolbar();
});

$('#jFormat').addEventListener('click', () => { if (needValue()) applySource(pretty(value, JSON_INDENT), 'Formatted'); });
$('#jMinify').addEventListener('click', () => { if (needValue()) applySource(minify(value), 'Minified'); });
$('#jSortKeys').addEventListener('click', () => { if (needValue()) applySource(pretty(sortKeys(value), JSON_INDENT), 'Keys sorted'); });

$('#jTables').addEventListener('change', () => {
  pickedTable = Number($('#jTables').value) || 0;
  painted.table = false;
  paintTable();
});

$('#jCopy').addEventListener('click', () => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Copied the whole document.'), () => {});
  }
});
$('#jExport').addEventListener('click', async () => {
  await flushJson();
  const rec = jsonDocById(docId);
  if (rec) saveOneFile(rec.name, text, 'json');
});
$('#jRemove').addEventListener('click', async () => {
  if (docId !== null && await removeJsonDoc(docId)) closeCurrent();
});
$('#jCrumbCopy').addEventListener('click', () => {
  const path = $('#jCrumbPath').textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(path);
  toast('Copied ' + path);
});

let typeTimer = null;
$('#jEditArea').addEventListener('input', () => {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(commitSource, 220);
});
$('#jEditArea').addEventListener('blur', commitSource);
$('#jEditArea').addEventListener('keydown', e => {
  /* Tab indents rather than leaving the pane, which is what a source pane is for. */
  if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const a = e.target, at = a.selectionStart;
    a.value = a.value.slice(0, at) + '  ' + a.value.slice(a.selectionEnd);
    a.selectionStart = a.selectionEnd = at + 2;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    commitSource();
    flushJson().then(() => toast('Saved.'));
  }
});

$('#jsonInput').addEventListener('change', e => { openJsonFiles(e.target.files); e.target.value = ''; });
$('#jOpen').addEventListener('click', pickJsonFile);
$('#jsonEmptyOpen').addEventListener('click', pickJsonFile);
$('#jsonEmptySample').addEventListener('click', openSampleJson);
$('#qJson').addEventListener('click', pickJsonFile);

/* ---------- Dialogs ---------- */

function openDialog(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}
const jsonDlg = $('#jsonDlg');
export function promptJson() {
  $('#jsonErr').textContent = '';
  openDialog(jsonDlg);
  setTimeout(() => $('#jsonText').focus(), 30);
}
$('#jsonForm').addEventListener('submit', async e => {
  e.preventDefault();
  const source = $('#jsonText').value;
  if (!source.trim()) { $('#jsonErr').textContent = 'Nothing to open yet.'; return; }
  const rec = await addJsonDoc({
    name: $('#jsonTitle').value.trim() || deriveJsonName(source),
    kind: 'paste',
    source: 'pasted',
    text: source
  });
  jsonDlg.close();
  $('#jsonText').value = ''; $('#jsonTitle').value = '';
  openJsonDoc(rec.id);
});

const jsonUrlDlg = $('#jsonUrlDlg');
export function promptJsonUrl() {
  $('#jsonUrlErr').textContent = '';
  openDialog(jsonUrlDlg);
  setTimeout(() => $('#jsonUrlField').focus(), 30);
}
$('#jsonUrlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#jsonUrlSubmit'), url = $('#jsonUrlField').value.trim();
  if (!url) return;
  $('#jsonUrlErr').textContent = '';
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const rec = await loadJsonFromUrl(url);
    jsonUrlDlg.close();
    $('#jsonUrlField').value = '';
    openJsonDoc(rec.id);
  } catch (err) {
    $('#jsonUrlErr').textContent = err.message || String(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Download & open';
  }
});
$('#jPaste').addEventListener('click', promptJson);
$('#qJsonPaste').addEventListener('click', promptJson);
$('#jsonEmptyPaste').addEventListener('click', promptJson);
$('#pasteJsonLink').addEventListener('click', promptJson);
$('#jUrl').addEventListener('click', promptJsonUrl);
$$('#jsonDlg [data-close],#jsonUrlDlg [data-close]').forEach(b =>
  b.addEventListener('click', () => b.closest('dialog').close()));

/* ---------- Shortcuts, live only while this view is on screen ---------- */

document.addEventListener('keydown', e => {
  if (document.body.dataset.view !== 'json' || docId === null) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); $('#jSearch').focus(); $('#jSearch').select(); return; }
  if (typing) return;
  const at = JSON_MODES.findIndex(m => m.key === mode);
  if (e.key >= '1' && e.key <= String(JSON_MODES.length)) { e.preventDefault(); setMode(JSON_MODES[Number(e.key) - 1].key); return; }
  if (e.key === '[') { e.preventDefault(); setMode(JSON_MODES[(at + JSON_MODES.length - 1) % JSON_MODES.length].key); return; }
  if (e.key === ']') { e.preventDefault(); setMode(JSON_MODES[(at + 1) % JSON_MODES.length].key); return; }
  if (e.key === '/') { e.preventDefault(); $('#jSearch').focus(); }
});

on(EVENTS.JSONDOCS, () => { renderJsonDocs(); syncToolbar(); });
on(EVENTS.VIEW, name => {
  if (name === 'json') { build(); render(); }
  else if (docId !== null) flushJson();
});
