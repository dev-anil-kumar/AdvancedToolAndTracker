/**
 * The HTML view.
 *
 * One document, three ways to look at it. Reading is the whole point: a page
 * opens rendered, exactly as a browser would draw it, and the two other
 * surfaces stay out of the way until you ask for them.
 *
 *   preview  the reading view — the page itself, in a sandboxed frame
 *   code     the source, coloured and read-only
 *   edit     a plain source pane that writes back as you type
 *
 * The preview is a real render: its own CSS applies, and its own scripts run
 * when the Scripts toggle is on — which it is by default, because a page that
 * cannot run is only half a page. The frame is sandboxed either way, so what
 * runs there cannot reach the rest of the app.
 *
 * A view: it reads state, renders, and asks features/htmldocs.js to change it.
 */
import { on, EVENTS } from '../core/bus.js';
import { HTML_MODES, HTML_SAVE_MS } from '../core/config.js';
import { $, $$, el } from '../core/dom.js';
import { formatBytes, formatWhen, plural } from '../core/format.js';
import { htmldocs, htmlDocById, htmlDocsByRecency } from '../core/state.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { saveOneFile } from '../features/exporter.js';
import {
  addHtmlDoc, deriveHtmlName, loadHtmlFromUrl, removeHtmlDoc, renameHtmlDoc, updateHtmlDoc
} from '../features/htmldocs.js';
import { isMhtml, mhtmlToHtml } from '../features/html/mhtml.js';

/* Above this many characters the code view shows plain text: colouring a
   document this large costs more than it is worth, and the browser stutters. */
const CODE_MAX = 500000;

/* The two sandbox recipes. With scripts, the frame renders like Chrome; the
   sandbox still walls it off from the app around it. Without, nothing runs. */
const SANDBOX_RUN = 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals allow-presentation';
const SANDBOX_SAFE = 'allow-same-origin';

/* ---------- State ---------- */

let docId = null;          // the record being read
let text = '';             // its source, as edited
let mode = 'preview';
let scripts = true;        // whether the preview runs the page's own scripts
let saveTimer = null;
let saved = true;
let painted = {};          // which surfaces are up to date

const invalidate = () => { painted = {}; };

/* ---------- Opening ---------- */

export function openHtmlDoc(id) {
  const rec = htmlDocById(id);
  if (!rec) { toast('That page is no longer here.'); return; }
  build();
  docId = rec.id;
  load(rec.text);
  route('html');
}

/** Read a document in from text, wherever it came from. */
function load(source) {
  text = String(source == null ? '' : source);
  saved = true;
  invalidate();
  /* The source pane always holds the open document, whether or not it is the
     surface on screen. It commits on input, and an input can arrive long after
     a different document was opened — keeping it in step is the only way this
     one's text never lands on top of that one's. */
  $('#hvEditArea').value = text;
  painted.edit = true;
  hideBanner();
  render();
}

/* ---------- Building, once ---------- */

let ready = false;
function build() {
  if (ready) return;
  ready = true;

  renderModes();

  /* Spell out what "Export PDF" does: there is no PDF library here — it is the
     browser's own print dialog, where "Save as PDF" is a destination. */
  $('#hvPrint').title = 'Open the print dialog — choose “Save as PDF” to export this page';

  /* Every fresh render scrolls the page back to the top: a reload the reader
     asked for should start where reading starts, not where they left off. */
  $('#hvFrame').addEventListener('load', () => {
    try { $('#hvFrame').contentWindow.scrollTo(0, 0); } catch (e) { /* cross-origin, never mind */ }
  });
}

function renderModes() {
  const box = $('#hvModes');
  box.innerHTML = '';
  HTML_MODES.forEach(m => {
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

function setMode(next) {
  if (!HTML_MODES.some(m => m.key === next)) return;
  /* Leaving Edit commits the pane and lets the preview pick the change up. */
  if (mode === 'edit' && next !== 'edit') { commitSource(); painted.preview = false; }
  mode = next;
  render();
}

function render() {
  const open = docId !== null;
  $('#hvEmpty').hidden = open;
  ['hvFrame', 'hvCodeHost', 'hvEditHost'].forEach(id => { $('#' + id).hidden = true; });
  syncToolbar();
  if (!open) { hideBanner(); return; }

  if (mode === 'preview') paintPreview();
  if (mode === 'code') paintCode();
  if (mode === 'edit') paintEdit();
}

/**
 * Draw the page into the frame. Changing the sandbox needs the srcdoc set
 * again — the attribute only takes effect on the next load — so both happen
 * together, and this is the one place either is touched.
 */
function renderPreview() {
  const frame = $('#hvFrame');
  frame.setAttribute('sandbox', scripts ? SANDBOX_RUN : SANDBOX_SAFE);
  frame.srcdoc = text || '';
}

function paintPreview() {
  $('#hvFrame').hidden = false;
  if (!painted.preview) { renderPreview(); painted.preview = true; }
}

function paintCode() {
  const host = $('#hvCodeHost');
  host.hidden = false;
  if (painted.code) return;
  host.innerHTML = '';
  const pre = el('pre', 'hvcode');
  const code = el('code');
  const big = text.length > CODE_MAX;
  if (!big && self.hljs) {
    /* highlight.js is loaded globally; XML is its grammar for HTML. It returns
       a safe HTML string of spans, so innerHTML is right here. */
    pre.classList.add('hljs');
    try { code.innerHTML = self.hljs.highlight(text, { language: 'xml' }).value; }
    catch (e) { code.textContent = text; }
  } else {
    code.textContent = text;
  }
  pre.appendChild(code);
  host.appendChild(pre);
  painted.code = true;
  painted.codeBig = big;
  syncToolbar();
}

function paintEdit() {
  $('#hvEditHost').hidden = false;
  const area = $('#hvEditArea');
  if (!painted.edit) { area.value = text; painted.edit = true; }
  setTimeout(() => area.focus(), 20);
}

/* ---------- The source pane ---------- */

/** Re-read the textarea. Called as you type (debounced) and on leaving Edit. */
function commitSource() {
  if (docId === null) return;
  const area = $('#hvEditArea');
  if (area.value === text) return;
  text = area.value;
  const keepEdit = painted.edit;
  invalidate();
  painted.edit = keepEdit;
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
    await updateHtmlDoc(docId, text);
    saved = true;
    syncToolbar();
  }, HTML_SAVE_MS);
}

/** Write pending edits out now — on leaving the view, or before exporting. */
export async function flushHtml() {
  if (saved || docId === null) return;
  clearTimeout(saveTimer);
  await updateHtmlDoc(docId, text);
  saved = true;
  syncToolbar();
}

/* ---------- The error banner ---------- */

function showBanner(message) {
  const banner = $('#hvBanner');
  banner.hidden = false;
  banner.textContent = '';
  banner.appendChild(el('strong', null, 'Could not open'));
  banner.appendChild(document.createTextNode(' — ' + message));
}
function hideBanner() { $('#hvBanner').hidden = true; }

/* ---------- Chrome ---------- */

/** Which controls make sense right now, and what the status line says. */
function syncToolbar() {
  const open = docId !== null;
  const rec = open ? htmlDocById(docId) : null;
  $$('#hvModes button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#hvName').value = rec ? rec.name : '';
  $('#hvName').disabled = !open;

  const showIf = (id, cond) => { $('#' + id).hidden = !cond; };
  const preview = mode === 'preview';
  /* The reload, scripts and print controls only mean anything against a live
     render, so they belong to the preview alone. */
  showIf('hvReload', open && preview);
  showIf('hvScripts', open && preview);
  showIf('hvPrint', open && preview);
  showIf('hvCopy', open);
  showIf('hvExport', open);
  showIf('hvRemove', open);

  $('#hvScripts').setAttribute('aria-pressed', String(scripts));

  $('#hvStats').textContent = open ? statusLine() : '';
  /* The saved note only speaks while you are editing — nowhere else is there
     anything to have saved. */
  $('#hvSaved').textContent = open && mode === 'edit' ? (saved ? 'Saved' : 'Editing…') : '';
}

function statusLine() {
  const rec = htmlDocById(docId);
  const bits = [formatBytes(text.length)];
  /* A page rebuilt from an MHTML archive is not the file you saved — its images
     and styles were pulled inline — so it says as much. */
  if (rec && rec.kind === 'mhtml') bits.push('from MHTML archive');
  if (mode === 'preview' && !scripts) bits.push('scripts off');
  if (mode === 'code' && painted.codeBig) bits.push('too big to colour');
  return bits.join(' · ');
}

/* ---------- Sources ---------- */

export function pickHtmlFile() { $('#htmlInput').click(); }

/** True for the archive extensions, so a failed unpack can explain itself. */
const isMhtmlName = (name) => /\.(mhtml|mht)$/i.test(String(name || ''));

export async function openHtmlFiles(list) {
  const chosen = [...list].slice(0, 6);
  let last = null;
  let archiveError = '';
  for (const file of chosen) {
    try {
      const raw = await file.text();
      /* A .mhtml or .mht archive is one file holding a whole page and its
         resources; unpack it into a single self-contained document first. A
         malformed archive throws something worth reading, so it earns the
         banner rather than a toast that slips away. */
      if (isMhtml(raw)) {
        last = await addHtmlDoc({ name: file.name, kind: 'mhtml', source: file.name, text: mhtmlToHtml(raw) });
      } else {
        last = await addHtmlDoc({ name: file.name, kind: 'file', source: file.name, text: raw });
      }
    } catch (err) {
      if (isMhtmlName(file.name)) archiveError = (err && err.message) || 'That archive could not be unpacked.';
      else toast('Couldn’t read “' + file.name + '”.');
    }
  }
  if (last) openHtmlDoc(last.id);
  else if (archiveError) { route('html'); showBanner(archiveError); }
  return last;
}

export async function openSampleHtml() {
  const node = $('#sample-html');
  const rec = await addHtmlDoc({
    name: 'Welcome — sample.html',
    kind: 'sample',
    source: 'built-in',
    text: node ? node.textContent.trim() : '<!doctype html><title>Sample</title>'
  });
  openHtmlDoc(rec.id);
}

/* ---------- The library section on Home ---------- */

export function renderHtmlDocs() {
  const list = $('#htmlRows');
  $('#secHtml').hidden = htmldocs.length === 0;
  $('#htmlCount').textContent = htmldocs.length ? plural(htmldocs.length, 'page', 'pages') : '';
  list.innerHTML = '';
  htmlDocsByRecency().forEach(rec => list.appendChild(htmlRow(rec)));
}

function htmlRow(rec) {
  const li = el('li', 'row-item');
  const main = el('button', 'row-main');
  main.type = 'button';
  const name = el('div', 'row-name');
  name.appendChild(el('span', 't', rec.name));
  name.appendChild(el('span', 'kind' + (rec.id === docId ? ' open' : ''), rec.id === docId ? 'Open' : 'HTML'));
  const sub = [formatWhen(rec.updatedAt), formatBytes(rec.size || rec.text.length)];
  if (rec.kind === 'mhtml') sub.push('MHTML');
  main.append(name, el('div', 'row-sub', sub.join(' · ')));
  main.addEventListener('click', () => openHtmlDoc(rec.id));

  const acts = el('div', 'row-act');
  const save = el('button', 'btn tiny ghost', 'Save');
  save.type = 'button';
  save.title = 'Save this page as an .html file';
  save.addEventListener('click', e => { e.stopPropagation(); saveOneFile(rec.name, rec.text, 'html'); });
  const del = el('button', 'btn tiny ghost danger', 'Remove');
  del.type = 'button';
  del.addEventListener('click', async e => {
    e.stopPropagation();
    if (await removeHtmlDoc(rec.id) && rec.id === docId) closeCurrent();
  });
  acts.append(save, del);
  li.append(main, acts);
  return li;
}

function closeCurrent() {
  docId = null;
  text = '';
  $('#hvEditArea').value = '';
  $('#hvFrame').srcdoc = '';
  invalidate();
  hideBanner();
  render();
}

/* ---------- Wiring ---------- */

$('#hvModes').addEventListener('keydown', e => {
  const buttons = $$('#hvModes button');
  const at = buttons.indexOf(document.activeElement);
  if (at < 0) return;
  const go = (i) => { e.preventDefault(); buttons[(i + buttons.length) % buttons.length].focus(); };
  if (e.key === 'ArrowRight') go(at + 1);
  if (e.key === 'ArrowLeft') go(at - 1);
});

$('#hvName').addEventListener('change', () => {
  if (docId === null) return;
  renameHtmlDoc(docId, $('#hvName').value);
});

$('#hvReload').addEventListener('click', () => {
  if (docId === null || mode !== 'preview') return;
  renderPreview();
});

$('#hvScripts').addEventListener('click', () => {
  scripts = $('#hvScripts').getAttribute('aria-pressed') !== 'true';
  $('#hvScripts').setAttribute('aria-pressed', String(scripts));
  painted.preview = false;
  if (mode === 'preview') paintPreview();
  toast(scripts ? 'The page’s own scripts will run.' : 'Scripts held back — showing the page without them.');
});

/* The dependency-free way to a PDF: the browser's own print dialog, where
   "Save as PDF" is one of the destinations. It only makes sense against a
   rendered page, so it lives with the preview. */
$('#hvPrint').addEventListener('click', () => {
  if (docId === null || mode !== 'preview') return;
  try { $('#hvFrame').contentWindow.print(); }
  catch (err) { toast('This page would not open the print dialog.'); }
});

$('#hvCopy').addEventListener('click', () => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('Copied the source.'), () => {});
  }
});

$('#hvExport').addEventListener('click', async () => {
  await flushHtml();
  const rec = htmlDocById(docId);
  if (rec) saveOneFile(rec.name, text, 'html');
});

$('#hvRemove').addEventListener('click', async () => {
  if (docId !== null && await removeHtmlDoc(docId)) closeCurrent();
});

let typeTimer = null;
$('#hvEditArea').addEventListener('input', () => {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(commitSource, 220);
});
$('#hvEditArea').addEventListener('blur', commitSource);
$('#hvEditArea').addEventListener('keydown', e => {
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
    flushHtml().then(() => toast('Saved.'));
  }
});

$('#htmlInput').addEventListener('change', e => { openHtmlFiles(e.target.files); e.target.value = ''; });
$('#hvOpen').addEventListener('click', pickHtmlFile);
$('#hvEmptyOpen').addEventListener('click', pickHtmlFile);
$('#hvEmptyPaste').addEventListener('click', () => promptHtml());
$('#hvEmptySample').addEventListener('click', openSampleHtml);

/* ---------- Dialogs ---------- */

function openDialog(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

const htmlDlg = $('#htmlDlg');
export function promptHtml() {
  $('#htmlErr').textContent = '';
  openDialog(htmlDlg);
  setTimeout(() => $('#htmlText').focus(), 30);
}
$('#htmlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const source = $('#htmlText').value;
  if (!source.trim()) { $('#htmlErr').textContent = 'Nothing to open yet.'; return; }
  const rec = await addHtmlDoc({
    name: $('#htmlTitle').value.trim() || deriveHtmlName(source),
    kind: 'paste',
    source: 'pasted',
    text: source
  });
  htmlDlg.close();
  $('#htmlText').value = ''; $('#htmlTitle').value = '';
  openHtmlDoc(rec.id);
});

const htmlUrlDlg = $('#htmlUrlDlg');
export function promptHtmlUrl() {
  $('#htmlUrlErr').textContent = '';
  openDialog(htmlUrlDlg);
  setTimeout(() => $('#htmlUrlField').focus(), 30);
}
$('#htmlUrlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#htmlUrlSubmit'), url = $('#htmlUrlField').value.trim();
  if (!url) return;
  $('#htmlUrlErr').textContent = '';
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const rec = await loadHtmlFromUrl(url);
    htmlUrlDlg.close();
    $('#htmlUrlField').value = '';
    openHtmlDoc(rec.id);
  } catch (err) {
    $('#htmlUrlErr').textContent = err.message || String(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Download & open';
  }
});

$('#hvPaste').addEventListener('click', () => promptHtml());
$('#pasteHtmlLink').addEventListener('click', () => promptHtml());
$('#hvUrl').addEventListener('click', () => promptHtmlUrl());
$$('#htmlDlg [data-close],#htmlUrlDlg [data-close]').forEach(b =>
  b.addEventListener('click', () => b.closest('dialog').close()));

/* ---------- Shortcuts, live only while this view is on screen ---------- */

document.addEventListener('keydown', e => {
  if (document.body.dataset.view !== 'html' || docId === null) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const mod = e.metaKey || e.ctrlKey;
  /* Print stays reachable even from the source panes — it is the export. */
  if (mod && (e.key === 'p' || e.key === 'P') && mode === 'preview') {
    e.preventDefault();
    try { $('#hvFrame').contentWindow.print(); } catch (err) { toast('This page would not open the print dialog.'); }
    return;
  }
  if (typing) return;
  const at = HTML_MODES.findIndex(m => m.key === mode);
  if (e.key >= '1' && e.key <= String(HTML_MODES.length)) { e.preventDefault(); setMode(HTML_MODES[Number(e.key) - 1].key); return; }
  if (e.key === '[') { e.preventDefault(); setMode(HTML_MODES[(at + HTML_MODES.length - 1) % HTML_MODES.length].key); return; }
  if (e.key === ']') { e.preventDefault(); setMode(HTML_MODES[(at + 1) % HTML_MODES.length].key); return; }
});

on(EVENTS.HTMLDOCS, () => { renderHtmlDocs(); syncToolbar(); });
on(EVENTS.VIEW, name => {
  if (name === 'html') { build(); render(); }
  else if (docId !== null) flushHtml();
});
