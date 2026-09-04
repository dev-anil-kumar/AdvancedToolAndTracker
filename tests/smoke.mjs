/**
 * Integration smoke test.
 *
 * jsdom does not execute <script type="module">, so this harness builds the
 * DOM from index.html, binds the browser globals the modules expect, and then
 * imports main.js itself. That exercises the real module graph — a broken
 * import or a missing export fails here rather than in the browser.
 *
 *   npm install && npm test
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import * as fakeIndexedDB from 'fake-indexeddb';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(here, '../index.html');
const ENTRY = resolve(here, '../assets/js/main.js');

let checks = 0, failures = 0;
const ok = (label, cond, detail) => {
  checks++;
  if (cond) { console.log('  ok   ' + label + (detail ? '  — ' + detail : '')); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  — ' + detail : '')); }
};
const section = (name) => console.log('\n' + name);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- Build a browser-ish environment ---------- */
const consoleErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', e => {
  const msg = String(e.message || e);
  if (!/Not implemented|scrollTo/.test(msg)) consoleErrors.push('jsdomError: ' + msg);
});
virtualConsole.on('error', (...args) => consoleErrors.push('console.error: ' + args.join(' ')));

const dom = await JSDOM.fromFile(INDEX, {
  runScripts: 'outside-only',        // we import the modules ourselves
  pretendToBeVisual: true,
  url: 'https://example.github.io/folio/',
  virtualConsole
});
const { window } = dom;
const d = window.document;

/* jsdom does not fetch <link> stylesheets here, and several assertions read
   computed styles, so inline the split CSS in the order index.html lists it. */
const CSS_ORDER = ['tokens', 'base', 'markdown', 'workspace', 'views', 'canvas', 'json', 'responsive'];
const style = d.createElement('style');
style.textContent = (await Promise.all(
  CSS_ORDER.map(name => readFile(resolve(here, '../assets/css/' + name + '.css'), 'utf8'))
)).join('\n');
d.head.appendChild(style);

/* Libraries that index.html loads from a CDN in the browser. */
window.marked = marked;
window.DOMPurify = createDOMPurify(window);
window.hljs = hljs;

/* Storage + a few APIs jsdom lacks. */
window.indexedDB = new fakeIndexedDB.IDBFactory();
window.IDBKeyRange = fakeIndexedDB.IDBKeyRange;
window.HTMLElement.prototype.scrollTo = function (opts) { if (opts && typeof opts.top === 'number') this.scrollTop = opts.top; };
window.Element.prototype.scrollIntoView = function () {};
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.HTMLAnchorElement.prototype.click = function () { if (this.download) saved.downloads.push(this.download); };
window.URL.createObjectURL = () => 'blob:test';
window.URL.revokeObjectURL = () => {};
window.confirm = () => true;
Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });

/* The canvas measures its host and serialises SVG; jsdom does neither. */
const HOST_BOX = { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 700, width: 1200, height: 700 };
const realRect = window.Element.prototype.getBoundingClientRect;
window.Element.prototype.getBoundingClientRect = function () {
  if (this.id === 'canvasHost') return { ...HOST_BOX, toJSON: () => HOST_BOX };
  return realRect.call(this);
};
/* jsdom performs no layout, so the inline editor has no measurable height.
   Give it plausible numbers: the box is what we sized it to, the content is
   one line per newline. Enough for the centring arithmetic to be exercised. */
const LINE_PX = 20;
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientHeight', {
  configurable: true,
  get() { return parseFloat((this.parentElement && this.parentElement.style.height) || '0') || 0; }
});
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
  configurable: true,
  get() { return String(this.value || '').split('\n').length * LINE_PX; }
});

window.Element.prototype.setPointerCapture = function () {};
window.Element.prototype.releasePointerCapture = function () {};

/* File System Access API, recorded rather than performed. */
const saved = { files: [], dirs: [], downloads: [] };
window.showSaveFilePicker = async (options) => {
  const name = options.suggestedName;
  return { name, createWritable: async () => ({
    write: async (data) => { saved.files.push({ name, text: String(data) }); },
    close: async () => {}
  })};
};
window.showDirectoryPicker = async () => {
  const at = (path) => ({
    name: 'Chosen Folder',
    getDirectoryHandle: async (n) => at(path + n + '/'),
    getFileHandle: async (n) => ({ createWritable: async () => ({
      write: async (data) => { saved.dirs.push({ path: path + n, text: String(data) }); },
      close: async () => {}
    })})
  });
  return at('');
};

/* Expose the window's globals to the modules, which expect to run in a page. */
for (const key of [
  'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'matchMedia', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame',
  'getComputedStyle', 'indexedDB', 'IDBKeyRange', 'confirm', 'alert',
  'Node', 'NodeFilter', 'Element', 'HTMLElement', 'Event', 'CustomEvent',
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'Range', 'Blob', 'FileReader',
  'marked', 'DOMPurify', 'hljs', 'showSaveFilePicker', 'showDirectoryPicker',
  'XMLSerializer', 'SVGElement',
  'innerWidth', 'innerHeight', 'CSS'
]) {
  if (key in window) Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.self = window;
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
globalThis.URL.createObjectURL = window.URL.createObjectURL;

/* ---------- Load the app ---------- */
await import(ENTRY);
await wait(120);

const q = (sel) => d.querySelector(sel);
const qa = (sel) => [...d.querySelectorAll(sel)];
const click = (elm) => elm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const submit = (form) => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const shownViews = () => qa('.view').filter(v => !v.hidden).map(v => v.id).join(',');
const paste = async (title, text) => {
  click(q('#rPaste'));
  q('#pasteTitle').value = title || '';
  q('#pasteText').value = text;
  submit(q('#pasteForm'));
  await wait(60);
};

section('boot');
ok('home view is showing', shownViews() === 'view-home', shownViews());
ok('one reading tab exists', qa('.ws-tab').length === 1 && qa('.workspace').length === 1);
ok('theme applied', ['light', 'dark'].includes(d.documentElement.dataset.theme), d.documentElement.dataset.theme);
ok('highlight colour applied', d.documentElement.style.getPropertyValue('--hl').length > 0);
ok('getting-started visible on an empty library', !q('#secStart').hidden);

section('open the sample document');
click(q('#qSample'));
await wait(150);
ok('switched to the reading view', shownViews() === 'view-read', shownViews());
ok('one pane', qa('.pane').length === 1);
ok('markdown rendered', qa('.pane .md h1,.pane .md h2').length > 3, qa('.pane .md h2').length + ' h2');
ok('code highlighted', /hljs/.test(q('.pane .md pre code').className));
ok('blocks indexed for notes', qa('.pane .md > [data-b]').length > 10);
ok('empty state hidden', q('#readEmpty').hidden);
ok('recent list populated', qa('#recentRows .row-item').length === 1);

section('paste a document');
await paste('', '# Meeting notes\n\nAlpha beta gamma.\n\n## Decisions\n\nWe ship on Friday.\n');
ok('two panes, one gutter', qa('.pane').length === 2 && qa('.gutter').length === 1);
ok('title derived from the first heading', qa('.pane-name')[1].textContent === 'Meeting notes', qa('.pane-name')[1].textContent);

section('notes from a selection');
const block = qa('.pane')[1].querySelector('.md > [data-b="3"]') || qa('.pane')[1].querySelector('.md > p');
const range = d.createRange();
range.setStart(block.firstChild, 0);
range.setEnd(block.firstChild, Math.min(20, block.firstChild.nodeValue.length));
window.getSelection().removeAllRanges();
window.getSelection().addRange(range);
Object.defineProperty(window.Range.prototype, 'getClientRects', {
  configurable: true, value() { return [{ top: 200, bottom: 220, left: 300, right: 460, width: 160, height: 20 }]; }
});
d.dispatchEvent(new window.Event('selectionchange'));
await wait(140);
ok('selection popover appears', !q('#selpop').hidden);
click(q('#selNote'));
await wait(140);
ok('note counted in the header', q('#tabNotesN').textContent === '1', q('#tabNotesN').textContent);
ok('pane badge shows the note', qa('.pane')[1].querySelector('.pane-notes').textContent === '1 note');
ok('home shows a note preview', qa('#notePreview .row-item').length === 1);

section('notes view');
click(q('#tab-notes'));
await wait(120);
ok('notes view is the only one showing', shownViews() === 'view-notes', shownViews());
ok('reading view is display:none', window.getComputedStyle(q('#view-read')).display === 'none');
ok('one group, one card', qa('.ngroup').length === 1 && qa('.note').length === 1);
ok('cards start collapsed', !q('.note').classList.contains('expanded'));
click(q('#expandAll'));
await wait(60);
ok('expand all works', qa('.note.expanded').length === 1 && q('#expandAll').textContent === 'Collapse all');
click(q('#expandAll'));
await wait(60);

section('jump back to the passage');
click(q('.note .where'));
await wait(180);
ok('back in the reading view', shownViews() === 'view-read', shownViews());
ok('passage highlighted', !!q('.pane .md mark.note-hit'));

section('reading tabs');
click(q('#wsAdd'));
await wait(100);
ok('second tab added and selected', qa('.ws-tab').length === 2 && qa('.ws-tab [role=tab]')[1].getAttribute('aria-selected') === 'true');
ok('new tab is empty', !q('#readEmpty').hidden && qa('.workspace:not([hidden]) .pane').length === 0);
click(q('#tab-home'));
await wait(60);
click(q('#recentRows .row-main'));
await wait(140);
ok('same document opens again in the new tab', qa('.pane').length === 3, qa('.pane').length + ' panes');
ok('pane keys are unique', new Set(qa('.pane').map(p => p.dataset.key)).size === 3);
click(qa('.ws-tab [role=tab]')[0]);
await wait(100);
ok('switching tabs swaps the grid', qa('.workspace:not([hidden]) .pane').length === 2);
click(q('#rCloseAll'));
await wait(100);
ok('close all is scoped to the active tab', qa('.pane').length === 1);
click(qa('.ws-close')[1]);
await wait(100);
ok('closing a tab disposes its panes', qa('.ws-tab').length === 1 && qa('.pane').length === 0);

section('layout: documents per row');
for (const n of ['A', 'B', 'C', 'D', 'E']) await paste('Doc ' + n, '# Doc ' + n + '\n\nBody.\n');
ok('five panes', qa('.pane').length === 5);
ok('3 per row by default', qa('.pane-row').map(r => r.querySelectorAll('.pane').length).join('+') === '3+2',
  qa('.pane-row').map(r => r.querySelectorAll('.pane').length).join('+'));
ok('a row divider exists', qa('.rgutter').length === 1);
click(q('#tab-home'));
await wait(60);
click(qa('#perRowSeg button')[1]);
await wait(100);
ok('switching to 2 per row rewraps', qa('.pane-row').map(r => r.querySelectorAll('.pane').length).join('+') === '2+2+1',
  qa('.pane-row').map(r => r.querySelectorAll('.pane').length).join('+'));
click(qa('#perRowSeg button')[2]);
await wait(100);

section('float and dock');
click(q('#tab-read'));
await wait(60);
const first = qa('.pane')[0];
click(first.querySelector('.pane-float'));
await wait(100);
ok('pane floats out of the grid', first.classList.contains('floating') && first.parentElement === d.body);
ok('geometry set', /px$/.test(first.style.width) && /px$/.test(first.style.top));
ok('resizable in both directions', window.getComputedStyle(first).resize === 'both');
ok('button label flips to Dock', first.querySelector('.pane-float').textContent === 'Dock');
click(first.querySelector('.pane-float'));
await wait(100);
ok('docks back into the grid', !first.classList.contains('floating') && first.style.width === '');

section('focus mode');
click(q('#zenBtn'));
await wait(60);
ok('chrome hidden', ['header.app', '.rtoolbar', '.wsbar', '.pane-head']
  .every(sel => window.getComputedStyle(q(sel)).display === 'none'));
ok('content still visible', window.getComputedStyle(q('.pane')).display !== 'none');
ok('exit affordance shown', !q('#zenExit').hidden);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(60);
ok('Escape leaves focus mode', d.body.className === '', JSON.stringify(d.body.className));

section('highlight colour');
click(q('#tab-home'));
await wait(60);
ok('six swatches', qa('#hlSwatches .swatch').length === 6);
click(qa('#hlSwatches .swatch')[1]);
await wait(60);
ok('--hl follows the choice', d.documentElement.style.getPropertyValue('--hl') === '#c98a1b',
  d.documentElement.style.getPropertyValue('--hl'));

section('open from a URL');
const requested = [];
window.fetch = async (url) => {
  requested.push(String(url));
  if (/notfound/.test(url)) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
  if (/webpage/.test(url)) return { ok: true, status: 200, text: async () => '<!doctype html><html></html>' };
  if (/offline/.test(url)) throw new TypeError('Failed to fetch');
  return { ok: true, status: 200, text: async () => '# Remote\n\nFetched.\n' };
};
globalThis.fetch = window.fetch;
click(q('#qUrl'));
q('#urlField').value = 'https://github.com/user/repo/blob/main/README.md';
submit(q('#urlForm'));
await wait(150);
ok('github blob link converted to raw', requested[0] === 'https://raw.githubusercontent.com/user/repo/main/README.md', requested[0]);
ok('document opened', qa('.pane-name').some(n => n.textContent === 'README.md'));
for (const [label, url, expect] of [
  ['404 reported', 'https://x.dev/notfound.md', /answered 404/],
  ['html page rejected', 'https://x.dev/webpage.md', /not a Markdown file/],
  ['network failure explained', 'https://x.dev/offline.md', /cross-origin/]
]) {
  click(q('#qUrl'));
  q('#urlField').value = url;
  submit(q('#urlForm'));
  await wait(120);
  ok(label, expect.test(q('#urlErr').textContent), q('#urlErr').textContent.slice(0, 46));
}
q('#urlDlg').close();

section('export');
click(q('#tab-home'));
await wait(80);
ok('export section visible', !q('#secExport').hidden);
click(q('#recentRows .row-item .row-act .btn'));
await wait(120);
ok('single document saved', saved.files.length === 1 && saved.files[0].name.endsWith('.md'), saved.files[0] && saved.files[0].name);
await paste('bad/name:with*chars?', '# Nasty\n\nText.\n');
click(q('#tab-home'));
await wait(80);
const nasty = qa('#recentRows .row-item').find(li => /bad/.test(li.textContent));
click(nasty.querySelector('.row-act .btn'));
await wait(120);
ok('filename sanitised', saved.files.at(-1).name === 'bad-name-with-chars-.md', saved.files.at(-1).name);
saved.dirs.length = 0;
click(q('#expAll'));
await wait(250);
ok('everything written to the chosen folder',
  saved.dirs.some(f => f.path.startsWith('documents/')) &&
  saved.dirs.some(f => f.path.startsWith('pasted/')) &&
  saved.dirs.some(f => f.path === 'folio-notes.md'),
  saved.dirs.map(f => f.path).join(', ').slice(0, 90));
ok('notes file has content', /# Notes — Folio/.test(saved.dirs.find(f => f.path === 'folio-notes.md').text));
click(q('#expNotes'));
await wait(120);
ok('notes exported on their own', saved.files.at(-1).name === 'folio-notes.md');

section('persistence');
const filesBefore = qa('#recentRows .row-item').length;
const notesBefore = q('#tabNotesN').textContent;
ok('nothing written to localStorage', window.localStorage.length === 0 && window.sessionStorage.length === 0);
ok('documents in the library', filesBefore > 5, filesBefore + ' documents, ' + notesBefore + ' note(s)');


/* ============================ canvas ============================ */
const pointer = (type, x, y, target) => {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  ev.pointerId = 1;
  (target || q('#canvasHost')).dispatchEvent(ev);
};
const drawShape = async (toolKey, x0, y0, x1, y1) => {
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: toolKey, bubbles: true }));
  pointer('pointerdown', x0, y0);
  pointer('pointermove', (x0 + x1) / 2, (y0 + y1) / 2, window);
  pointer('pointermove', x1, y1, window);
  pointer('pointerup', x1, y1, window);
  await wait(30);
};
const shapes = () => canvasScene().shapes;
const hideEditor = () => { q('#textEdit').hidden = true; };
const viewOf = () => canvasScene().view;
const toClientPt = (x, y) => [(x - viewOf().x) * viewOf().zoom, (y - viewOf().y) * viewOf().zoom];
const boxOf = (sh) => sh.kind === 'arrow'
  ? { x: Math.min(sh.points[0], sh.points[2]), y: Math.min(sh.points[1], sh.points[3]),
      w: Math.abs(sh.points[2] - sh.points[0]), h: Math.abs(sh.points[3] - sh.points[1]) }
  : { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
const centreOf = (sh) => { const b = boxOf(sh); return toClientPt(b.x + b.w / 2, b.y + b.h / 2); };
const clickShape = async (sh) => {
  const [x, y] = centreOf(sh);
  pointer('pointerdown', x, y);
  pointer('pointerup', x, y, window);
  await wait(40);
};
const dragShapeBy = async (sh, dx, dy) => {
  const [x, y] = centreOf(sh);
  pointer('pointerdown', x, y);
  pointer('pointermove', x + dx, y + dy, window);
  pointer('pointerup', x + dx, y + dy, window);
  await wait(50);
};
const setText = async (value) => {
  await wait(280);
  q('#textEditArea').value = value;
  q('#textEditArea').dispatchEvent(new window.Event('blur'));
  await wait(60);
};
let canvasScene = () => ({ shapes: [] });

const { DB_NAME, DB_VER } = await import('../assets/js/core/config.js');
const appState = await import('../assets/js/core/state.js');
const jsonDocsNow = () => appState.jsonDocsByRecency();
const editor0 = await import('../assets/js/features/canvas/editor.js');
const editor = editor0;

section('canvas: creating a drawing');
click(q('#canvasNew'));
await wait(200);
ok('canvas view is showing', shownViews() === 'view-canvas', shownViews());
ok('tool strip built', qa('#cTools .ctool').length === 7, qa('#cTools .ctool').map(b => b.dataset.tool).join(','));
ok('rectangle is the default tool', editor0.activeTool() === 'rect', editor0.activeTool());
ok('background swatches built', qa('#cFills .swatch').length === 6);
ok('font choices built', qa('#cFonts button').length === 3, qa('#cFonts button').map(b => b.dataset.font).join(','));
ok('ink swatches built', qa('#cInks .swatch').length === 5);
ok('empty state visible', !q('#canvasEmpty').hidden);
ok('drawing appears on Home', (click(q('#tab-home')), await wait(80), qa('#drawingRows .row-item').length) === 1);
ok('canvas tab badge', q('#tabCanvasN').textContent === '1', q('#tabCanvasN').textContent);
click(q('#tab-canvas'));
await wait(80);

canvasScene = () => editor.activeScene();

section('canvas: r, c and a draw shapes');
await drawShape('r', 200, 200, 340, 300);
ok('R drew a rectangle', shapes().length === 1 && shapes()[0].kind === 'rect', shapes()[0] && shapes()[0].kind);
ok('snapped and sized', shapes()[0].w === 140 && shapes()[0].h === 100, shapes()[0].w + '×' + shapes()[0].h);
ok('tool returns to select', editor.activeTool() === 'select');
await drawShape('c', 600, 200, 740, 300);
ok('C drew a circle', shapes()[1].kind === 'ellipse');
await drawShape('a', 330, 250, 610, 250);
ok('A drew an arrow', shapes()[2].kind === 'arrow');
ok('arrow bound to both shapes', shapes()[2].from === shapes()[0].id && shapes()[2].to === shapes()[1].id,
  JSON.stringify([shapes()[2].from, shapes()[2].to]));
ok('empty state hidden', q('#canvasEmpty').hidden);
ok('svg has shape nodes', qa('#scene .shape').length === 3, qa('#scene .shape').length + ' nodes');

section('canvas: text inside a shape');
pointer('dblclick', 270, 250);
await wait(60);
ok('double-click opens the inline editor', !q('#textEdit').hidden);
ok('editor is positioned over the shape', q('#textEdit').style.left !== '' && q('#textEdit').style.width !== '',
  q('#textEdit').style.left + ' / ' + q('#textEdit').style.width);

/* A pointerdown inside the editor must not reach the canvas: that was the bug —
   the host captured the pointer, focus was stolen, and blur closed the editor. */
const shapeXBefore = shapes()[0].x;
pointer('pointerdown', 270, 250, q('#textEditArea'));
pointer('pointermove', 320, 300, window);
pointer('pointerup', 320, 300, window);
await wait(40);
ok('clicking into the editor leaves the canvas alone',
  !q('#textEdit').hidden && shapes()[0].x === shapeXBefore, 'x=' + shapes()[0].x);

/* An immediate blur means focus was stolen, so the editor holds on. */
q('#textEditArea').dispatchEvent(new window.Event('blur'));
await wait(30);
ok('an instant blur does not close the editor', !q('#textEdit').hidden);

await wait(280);
q('#textEditArea').value = 'Ingest';
q('#textEditArea').dispatchEvent(new window.Event('blur'));
await wait(60);
ok('text stored on the shape', shapes()[0].text === 'Ingest', JSON.stringify(shapes()[0].text));
ok('text rendered as a label', [...d.querySelectorAll('#scene text')].some(t => t.textContent.includes('Ingest')));

section('canvas: Add text on the selected shape');
pointer('pointerdown', 660, 250);            // select the circle
pointer('pointerup', 660, 250, window);
await wait(40);
ok('one shape selected', editor.selectionCount() === 1, editor.selectionCount() + ' selected');
ok('Add text is enabled', !q('#cLabel').disabled);
click(q('#cLabel'));
await wait(40);
ok('button opens the editor', !q('#textEdit').hidden);
await wait(280);
q('#textEditArea').value = 'Store';
q('#textEditArea').dispatchEvent(new window.Event('blur'));
await wait(60);
ok('text stored via the button', shapes()[1].text === 'Store', JSON.stringify(shapes()[1].text));
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await wait(40);
ok('Enter opens it too', !q('#textEdit').hidden);
q('#textEditArea').dispatchEvent(new window.Event('keydown', { key: 'Escape' }));
hideEditor();
await wait(20);

section('canvas: connecting with arrows');
pointer('pointerdown', 270, 250);            // select the rectangle
pointer('pointerup', 270, 250, window);
await wait(40);
ok('ports appear on the selection', qa('#scene .port').length === 4, qa('#scene .port').length + ' ports');
const rightPort = qa('#scene .port').find(p => p.dataset.port === 'right');
ok('ports know their shape', rightPort.dataset.shape === shapes()[0].id);
const arrowsBefore = shapes().filter(s => s.kind === 'arrow').length;
pointer('pointerdown', 400, 260, rightPort);
pointer('pointermove', 500, 240, window);
pointer('pointermove', 660, 250, window);     // over the circle
await wait(20);
ok('the target highlights while connecting', qa('#scene .shape.hover-target').length === 1);
pointer('pointerup', 660, 250, window);
await wait(60);
const connectors = shapes().filter(s => s.kind === 'arrow');
ok('dragging a port made an arrow', connectors.length === arrowsBefore + 1);
const connector = connectors.at(-1);
ok('it is attached at both ends', connector.from === shapes()[0].id && connector.to === shapes()[1].id,
  JSON.stringify([connector.from, connector.to]));
ok('the attachment is drawn', qa('#scene .bound').length >= 1);

/* Move the rectangle: the arrow must follow it. */
const beforeEnds = JSON.stringify(editor.activeScene() && connector.points);
pointer('pointerdown', 270, 250);
pointer('pointermove', 270, 190, window);
pointer('pointerup', 270, 190, window);
await wait(60);
const line = [...d.querySelectorAll('#scene .shape[data-kind="arrow"] line')].at(1);
ok('a bound arrow re-routes when its shape moves', !!line && line.getAttribute('y1') !== null,
  'y1=' + (line && line.getAttribute('y1')));
ok('binding survives the move', connector.from === shapes()[0].id,
  String(connector.from).slice(0, 6) + ' -> ' + String(connector.to).slice(0, 6));
ok('the arrow ends on the borders, not the centres',
  connector.points[0] === shapes()[0].x + shapes()[0].w && beforeEnds !== null,
  connector.points.join(','));

section('canvas: detaching an arrow');
/* Click the arrow's own midpoint, converted from scene to client space. */
const view = () => canvasScene().view;
const mid = toClientPt((connector.points[0] + connector.points[2]) / 2,
                     (connector.points[1] + connector.points[3]) / 2);
pointer('pointerdown', mid[0], mid[1]);
pointer('pointerup', mid[0], mid[1], window);
await wait(40);
ok('clicking the line selects the arrow',
  editor.selection() && editor.selection().kind === 'arrow',
  editor.selection() ? editor.selection().kind : 'nothing');
ok('Detach is offered for a bound arrow', !q('#cDetach').disabled);
click(q('#cDetach'));
await wait(60);
ok('arrow detached', !connector.from && !connector.to);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(60);
ok('undo re-attaches it', !!shapes().find(s => s.kind === 'arrow' && s.from));

section('canvas: marquee selects several');
pointer('pointerdown', 120, 120);
pointer('pointermove', 400, 400, window);
await wait(20);
ok('marquee is drawn', qa('#scene .marquee').length === 1);
pointer('pointerup', 800, 400, window);
await wait(40);
ok('several shapes selected', editor.selectionCount() > 1, editor.selectionCount() + ' selected');
ok('count shown in the toolbar', /selected$/.test(q('#cCount').textContent), q('#cCount').textContent);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(30);
ok('Escape clears the selection', editor.selectionCount() === 0);

section('canvas: text on an arrow');
editor.clearSelection();
const arrowUnder = shapes().filter(sh => sh.kind === 'arrow').at(-1);
const amid = centreOf(arrowUnder);
pointer('dblclick', amid[0], amid[1]);
await wait(60);
ok('an arrow opens the text editor', !q('#textEdit').hidden, q('#textEdit').dataset.kind);
ok('the editor sits on the arrow, not at a corner', q('#textEdit').style.width === '160px',
  q('#textEdit').style.width);
await setText('feeds');
ok('text stored on the arrow', arrowUnder.text === 'feeds', JSON.stringify(arrowUnder.text));
ok('arrow label is drawn', [...d.querySelectorAll('#scene text')].some(t => t.textContent === 'feeds'));

section('canvas: backgrounds and fonts');
/* undo/redo rebuilds the scene from JSON, so never hold a shape reference
   across one — read it back out of the scene each time. */
const box = () => shapes()[0];
ok('a new rectangle gets a background', box().fill === 'harbor', String(box().fill));
ok('a new circle gets its own', shapes()[1].fill === 'amber', String(shapes()[1].fill));
ok('the background is painted', !!d.querySelector('#scene .shape[data-kind="rect"] rect').getAttribute('fill').startsWith,
  d.querySelector('#scene .shape[data-kind="rect"] rect').getAttribute('fill'));
await clickShape(box());
ok('the rectangle is selected', editor.selection() === box(), editor.selection() ? editor.selection().kind : 'none');
click(qa('#cFills .swatch').find(b => b.dataset.fill === 'moss'));
await wait(60);
ok('background changed on the selection', box().fill === 'moss', String(box().fill));
click(qa('#cFills .swatch').find(b => b.dataset.fill === 'none'));
await wait(60);
ok('background can be cleared', box().fill === 'none' &&
  d.querySelector('#scene .shape[data-kind="rect"] rect').getAttribute('fill') === 'none');
ok('font defaults to sans', box().font === 'sans');
click(qa('#cFonts button').find(b => b.dataset.font === 'hand'));
await wait(60);
ok('font changed on the selection', box().font === 'hand', String(box().font));
const label = [...d.querySelectorAll('#scene text')].find(t => t.textContent === 'Ingest');
ok('the font reaches the SVG', /Caveat/.test(label.getAttribute('font-family')), label.getAttribute('font-family'));
/* Centring is arithmetic, not dominant-baseline: the baseline of a single
   line must sit half a cap height below the shape's middle. */
const centreY = box().y + box().h / 2;
const fontSize = Number(label.getAttribute('font-size'));
const baseline = Number(label.getAttribute('y'));
ok('text is horizontally centred', label.getAttribute('text-anchor') === 'middle' &&
  Number(label.getAttribute('x')) === box().x + box().w / 2,
  label.getAttribute('x') + ' vs ' + (box().x + box().w / 2));
ok('text is vertically centred on the shape',
  Math.abs(baseline - (centreY + fontSize * 0.35)) < 0.02,
  'baseline ' + baseline + ' for centre ' + centreY + ' at ' + fontSize + 'px');
ok('centring does not depend on dominant-baseline', !label.hasAttribute('dominant-baseline'));

/* A CSS font-family on .label would outrank the per-shape attribute. */
const canvasCss = await readFile(resolve(here, '../assets/css/canvas.css'), 'utf8');
const labelRule = (canvasCss.match(/#scene \.label \{[^}]*\}/) || [''])[0];
ok('CSS does not override the per-shape font', !/font-family/.test(labelRule), labelRule.slice(0, 60));

/* Two lines must straddle the middle, not start at it. */
const twoLineShape = box();
await clickShape(twoLineShape);
click(q('#cLabel'));
await setText('Ingest\nqueue');
const multi = [...d.querySelectorAll('#scene text')].find(t => t.textContent.startsWith('Ingest'));
const spans = [...multi.querySelectorAll('tspan')];
ok('a wrapped label keeps its block centred', spans.length === 2 &&
  Number(multi.getAttribute('y')) < centreY,
  spans.length + ' lines, first baseline ' + multi.getAttribute('y'));
click(qa('#cFonts button').find(b => b.dataset.font === 'sans'));
await wait(40);

section('canvas: the editor opens centred');
await clickShape(box());
click(q('#cLabel'));
await wait(40);
const editorBox = q('#textEdit');
const area = q('#textEditArea');
ok('the editor covers the shape', Math.round(parseFloat(editorBox.style.width)) === box().w,
  editorBox.style.width + ' for a ' + box().w + 'px shape');
ok('its text is centred horizontally', area.style.textAlign === 'center', area.style.textAlign);
ok('it uses the shape\'s own font', /Caveat|Inter|Source Serif/.test(area.style.fontFamily),
  area.style.fontFamily.slice(0, 24));
ok('its content is padded to the middle', area.style.paddingTop !== '' && area.style.paddingTop !== '0px',
  'padding-top ' + area.style.paddingTop);
const padBefore = parseFloat(area.style.paddingTop) || 0;
area.value = 'one\ntwo\nthree\nfour';
area.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(20);
ok('it re-centres as the text grows', (parseFloat(area.style.paddingTop) || 0) <= padBefore,
  padBefore + 'px -> ' + area.style.paddingTop);
area.value = 'Ingest';
hideEditor();
await wait(20);

section('canvas: copy and paste');
const countBeforePaste = shapes().length;
await clickShape(box());
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }));
await wait(40);
ok('copy fills the clipboard', editor.clipboardSize() === 1, editor.clipboardSize() + ' item');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true }));
await wait(80);
ok('paste adds a shape', shapes().length === countBeforePaste + 1, shapes().length + ' shapes');
const pasted = shapes().at(-1);
ok('the copy is the same object', pasted.kind === box().kind && pasted.text === box().text &&
  pasted.fill === box().fill && pasted.w === box().w, JSON.stringify([pasted.kind, pasted.text, pasted.w]));
ok('the copy is offset, not stacked', pasted.x === box().x + 24 && pasted.y === box().y + 24);
ok('the copy has its own id', pasted.id !== box().id);
ok('the paste is selected', editor.selectionCount() === 1 && editor.selection().id === pasted.id);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(60);
ok('paste is undoable', shapes().length === countBeforePaste);

section('canvas: resize from every corner');
await clickShape(box());
ok('four corner handles', qa('#scene .handle').length === 4,
  qa('#scene .handle').map(h => h.dataset.handle).join(','));
const before = { x: box().x, y: box().y, w: box().w, h: box().h };
const nw = qa('#scene .handle').find(h => h.dataset.handle === 'nw');
const nwAt = toClientPt(before.x, before.y);
pointer('pointerdown', nwAt[0], nwAt[1], nw);
pointer('pointermove', nwAt[0] - 40, nwAt[1] - 20, window);
pointer('pointerup', nwAt[0] - 40, nwAt[1] - 20, window);
await wait(60);
ok('the north-west corner moves the origin',
  box().x === before.x - 40 && box().y === before.y - 20 && box().w === before.w + 40 && box().h === before.h + 20,
  [box().x, box().y, box().w, box().h].join(','));
const ne = qa('#scene .handle').find(h => h.dataset.handle === 'ne');
const neAt = toClientPt(box().x + box().w, box().y);
pointer('pointerdown', neAt[0], neAt[1], ne);
pointer('pointermove', neAt[0] + 20, neAt[1] + 10, window);
pointer('pointerup', neAt[0] + 20, neAt[1] + 10, window);
await wait(60);
ok('the north-east corner keeps the left edge', box().x === before.x - 40 && box().w === before.w + 60,
  [box().x, box().w].join(','));

section('canvas: the text box has no visible edge');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(30);
await drawShape('n', 300, 500, 520, 580);
const note = shapes().at(-1);
ok('N draws a text box', note.kind === 'note', note.kind);
ok('it starts with no background', note.fill === 'none');
ok('it opens its editor straight away', !q('#textEdit').hidden);
await setText('A quiet aside');
editor.clearSelection();
await wait(40);
const noteRect = d.querySelector('#scene .shape[data-kind="note"] rect');
ok('no border once it has text and is deselected', noteRect.getAttribute('stroke') === 'none',
  noteRect.getAttribute('stroke'));
const noteLabel = [...d.querySelectorAll('#scene text')].find(t => t.textContent === 'A quiet aside');
ok('its text is centred', noteLabel && noteLabel.getAttribute('text-anchor') === 'middle');
await clickShape(note);
ok('it is still selectable', editor.selection() && editor.selection().kind === 'note');
ok('and shows its edge while selected',
  d.querySelector('#scene .shape[data-kind="note"] rect').getAttribute('stroke') !== 'none');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
await wait(60);

section('canvas: double-click with a draw tool active');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
await wait(20);
ok('rectangle tool is up', editor.activeTool() === 'rect');
const countBeforeClick = shapes().length;
await clickShape(box());
ok('a click on a shape selects it instead of stamping a new one',
  shapes().length === countBeforeClick && editor.selection() === box(),
  shapes().length + ' shapes');
ok('and the tool is still the rectangle', editor.activeTool() === 'rect');
const dcAt = centreOf(box());
pointer('dblclick', dcAt[0], dcAt[1]);
await wait(60);
ok('double-click still reaches the text editor', !q('#textEdit').hidden);
hideEditor();
await wait(20);

section('canvas: double-click on empty canvas writes there');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'v', bubbles: true }));
const emptySpot = toClientPt(-260, 620);
const beforeEmpty = shapes().length;
pointer('dblclick', emptySpot[0], emptySpot[1]);
await wait(60);
ok('a text box appears where you clicked', shapes().length === beforeEmpty + 1 &&
  shapes().at(-1).kind === 'note', shapes().at(-1).kind);
ok('with its editor already open', !q('#textEdit').hidden);
await setText('Aside');
ok('and it keeps what you typed', shapes().at(-1).text === 'Aside');
editor.clearSelection();
await clickShape(shapes().at(-1));
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
await wait(40);

section('canvas: shapes line up with their neighbours');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await drawShape('r', 700, 620, 820, 690);
const mover = shapes().at(-1);
const anchorBox = box();
/* Drop it a few pixels away from sharing the anchor's left edge. */
const wantX = anchorBox.x + 4;
const from = centreOf(mover);
const target = toClientPt(wantX + mover.w / 2, mover.y + mover.h / 2);
pointer('pointerdown', from[0], from[1]);
pointer('pointermove', target[0], target[1], window);
await wait(20);
ok('a guide appears while it lines up', qa('#scene .guides line').length >= 1,
  qa('#scene .guides line').length + ' guides');
pointer('pointerup', target[0], target[1], window);
await wait(50);
ok('it snapped onto the neighbour\'s edge', mover.x === anchorBox.x,
  mover.x + ' vs ' + anchorBox.x);
ok('the guides clear on release', qa('#scene .guides line').length === 0);

section('canvas: alt-drag, axis lock and stacking');
const beforeAlt = shapes().length;
const altFrom = centreOf(mover);
const altDown = new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: altFrom[0], clientY: altFrom[1], button: 0, altKey: true });
altDown.pointerId = 1;
q('#canvasHost').dispatchEvent(altDown);
pointer('pointermove', altFrom[0] + 120, altFrom[1], window);
pointer('pointerup', altFrom[0] + 120, altFrom[1], window);
await wait(60);
ok('alt-drag leaves a copy behind', shapes().length === beforeAlt + 1, shapes().length + ' shapes');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(50);

const lastId = shapes().at(-1).id;
await clickShape(shapes()[0]);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: ']', metaKey: true, bubbles: true }));
await wait(50);
ok('bring to front moves it last in the scene', shapes().at(-1).id !== lastId &&
  shapes().at(-1).kind === 'rect');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true }));
await wait(50);
ok('send to back moves it first', shapes()[0].kind === 'rect');

section('canvas: the tool can be locked');
ok('lock starts off', q('#cLock').getAttribute('aria-pressed') === 'false');
click(q('#cLock'));
await wait(20);
ok('lock turns on', editor.isToolLocked() && q('#cLock').getAttribute('aria-pressed') === 'true');
await drawShape('r', 980, 620, 1080, 680);
ok('the tool survives a drawing', editor.activeTool() === 'rect', editor.activeTool());
click(q('#cLock'));
await drawShape('r', 980, 700, 1080, 760);
ok('unlocked, it goes back to select', editor.activeTool() === 'select');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(30);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(30);

section('canvas: a shape grows to fit its text');
/* Draw a deliberately small box so the outcome does not depend on what the
   earlier sections left lying around. */
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await drawShape('r', 1000, 260, 1100, 310);
const smallId = shapes().at(-1).id;
const heightBefore = shapes().at(-1).h;
click(q('#cLabel'));
await setText('A label long enough that it has to wrap onto several lines inside this shape');
const grown = shapes().find(sh => sh.id === smallId);
ok('the shape grew to hold the text', grown.h > heightBefore, heightBefore + ' -> ' + grown.h);
ok('and it kept its width', grown.w === 100, String(grown.w));
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(40);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(40);

section('canvas: the shortcuts panel');
click(q('#cHelp'));
await wait(40);
ok('it opens', q('#shortcutsDlg').open);
ok('and lists the tool keys', /Rectangle/.test(q('#shortcutsBody').textContent) &&
  q('#shortcutsBody').querySelectorAll('kbd').length > 15,
  q('#shortcutsBody').querySelectorAll('kbd').length + ' keys');
q('#shortcutsDlg').close();
await wait(20);

section('canvas: containers carry their contents');
await drawShape('f', 160, 160, 800, 380);
const container = shapes().find(s => s.kind === 'container');
ok('F drew a container', !!container);
await wait(40);
ok('everything inside was adopted — arrows included',
  shapes().filter(s => s.parent === container.id).length === 4,
  shapes().filter(s => s.parent === container.id).length + ' children');
const beforeMove = { x: shapes()[0].x, y: shapes()[0].y };
const containerOrigin = { x: container.x, y: container.y };
/* Grab the container just inside its own corner, clear of every child. */
const grab = toClientPt(container.x + 8, container.y + container.h - 8);
pointer('pointerdown', grab[0], grab[1]);
pointer('pointermove', grab[0] + 100, grab[1] + 100, window);
pointer('pointerup', grab[0] + 100, grab[1] + 100, window);
await wait(60);
ok('container moved', container.x === containerOrigin.x + 100 && container.y === containerOrigin.y + 100,
  container.x + ',' + container.y);
ok('children moved with it',
  shapes()[0].x === beforeMove.x + 100 && shapes()[0].y === beforeMove.y + 100,
  shapes()[0].x + ',' + shapes()[0].y);

section('canvas: undo, redo and delete');
const countBefore = shapes().length;
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(60);
ok('undo restores the previous position', shapes()[0].x === beforeMove.x, shapes()[0].x + '');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }));
await wait(60);
ok('redo re-applies it', shapes()[0].x === beforeMove.x + 100);
const doomed = new Set([container.id, ...shapes().filter(sh => sh.parent === container.id).map(sh => sh.id)]);
click(q('#cDelete'));
await wait(60);
ok('deleting a container takes its contents',
  shapes().every(sh => !doomed.has(sh.id)) && shapes().length === countBefore - doomed.size,
  doomed.size + ' removed, ' + shapes().length + ' of ' + countBefore + ' left');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(60);
ok('undo brings them back', shapes().length === countBefore);

section('canvas: zoom and fit');
const zoomBefore = canvasScene().view.zoom;
click(q('#cZoomIn'));
await wait(40);
ok('zoom in', canvasScene().view.zoom > zoomBefore, q('#cZoom').textContent);
click(q('#cFit'));
await wait(40);
ok('fit frames the drawing', canvasScene().view.zoom > 0 && q('#cZoom').textContent.endsWith('%'), q('#cZoom').textContent);

section('canvas: shift constrains');
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
pointer('pointerdown', 900, 420);
const shifted = new window.MouseEvent('pointermove', { bubbles: true, clientX: 1060, clientY: 480, shiftKey: true });
shifted.pointerId = 1;
window.dispatchEvent(shifted);
const shiftedUp = new window.MouseEvent('pointerup', { bubbles: true, clientX: 1060, clientY: 480, shiftKey: true });
shiftedUp.pointerId = 1;
window.dispatchEvent(shiftedUp);
await wait(40);
const square = shapes().at(-1);
ok('shift draws a square', square.w === square.h, square.w + '×' + square.h);
d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
await wait(40);

section('canvas: export and import');
saved.files.length = 0;
click(q('#cExportJson'));
await wait(120);
const exported = saved.files.at(-1);
ok('exported as .json', exported && exported.name.endsWith('.json'), exported && exported.name);
const parsed = JSON.parse(exported.text);
ok('format is self-describing', parsed.type === 'folio-drawing' && parsed.version === 1);
ok('all shapes round-tripped', parsed.shapes.length === shapes().length, parsed.shapes.length + ' shapes');
click(q('#cExportSvg'));
await wait(120);
ok('exported as .svg', saved.files.at(-1).name.endsWith('.svg'));
ok('svg is standalone', /<svg[^>]+xmlns/.test(saved.files.at(-1).text) && /<ellipse|<rect/.test(saved.files.at(-1).text));
const pngBlob = await editor.toPNG(1);
ok('PNG degrades gracefully without canvas support', pngBlob === null, String(pngBlob));
click(q('#cExportPng'));
await wait(80);
ok('PNG tells the user rather than failing silently', /rasterise/.test(q('#toast').textContent),
  q('#toast').textContent.slice(0, 40));

const { importDrawing } = await import('../assets/js/features/drawings.js');
const roundTripped = await importDrawing(exported.text, 'Round trip');
await wait(80);
ok('import restores every shape', roundTripped.shapes.length === parsed.shapes.length);
ok('import keeps container links',
  roundTripped.shapes.filter(s => s.parent).length === parsed.shapes.filter(s => s.parent).length);
const boundInFile = parsed.shapes.filter(s => s.kind === 'arrow' && s.from && s.to).length;
const boundAfter = roundTripped.shapes.filter(s => s.kind === 'arrow' && s.from && s.to).length;
ok('import keeps every arrow binding', boundInFile > 0 && boundAfter === boundInFile,
  boundAfter + ' of ' + boundInFile + ' bound arrows');
let rejected = '';
try { await importDrawing('{"type":"something-else","shapes":[]}', 'x'); }
catch (err) { rejected = err.message; }
ok('a foreign file is rejected', /Folio drawing/.test(rejected), rejected);
try { await importDrawing('not json at all', 'x'); }
catch (err) { rejected = err.message; }
ok('invalid JSON is rejected', /valid JSON/.test(rejected), rejected);

section('canvas: persistence');
click(q('#tab-home'));
await wait(150);
ok('both drawings listed on Home', qa('#drawingRows .row-item').length === 2,
  qa('#drawingRows .row-item').length + ' rows');
const stored = await new Promise((res, rej) => {
  const req = window.indexedDB.open(DB_NAME, DB_VER);
  req.onsuccess = () => {
    const tx = req.result.transaction('drawings').objectStore('drawings').getAll();
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => rej(tx.error);
  };
  req.onerror = () => rej(req.error);
});
ok('drawings are in IndexedDB', stored.length === 2 && stored.every(r => Array.isArray(r.shapes)),
  stored.length + ' records');

/* ============================= JSON ============================= */
const jsonMode = (key) => click(qa('#jModes button').find(b => b.dataset.mode === key));
const jrows = () => qa('#jTreeHost .jrow');
/* Match on the key itself: a parent's summary line quotes its children's
   names, so searching the whole row's text finds the wrong row. */
const jrow = (key) => jrows().find(r => {
  const k = r.querySelector('.jkey');
  return k && k.textContent === String(key);
});
const jrowText = (needle) => jrows().find(r => r.querySelector('.jval').textContent.includes(needle));
const twistOf = (row) => row.querySelector('.jtwist');
const openRow = async (key) => { click(twistOf(jrow(key))); await wait(60); };
/* Some branches arrive open, so "open this one" has to check first. */
const ensureOpen = async (key) => {
  const row = jrow(key);
  if (row && row.parentElement.classList.contains('closed')) await openRow(key);
};
const jtype = (sel) => (q(sel) ? q(sel).dataset.type : null);
const pasteJson = async (title, text) => {
  click(q('#jPaste'));
  q('#jsonTitle').value = title || '';
  q('#jsonText').value = text;
  submit(q('#jsonForm'));
  await wait(120);
};

section('json: opening the sample');
click(q('#tab-json'));
await wait(80);
ok('empty state until something is open', !q('#jsonEmpty').hidden);
click(q('#jsonEmptySample'));
await wait(200);
ok('json view is showing', shownViews() === 'view-json', shownViews());
ok('empty state gone', q('#jsonEmpty').hidden);
ok('five ways to look at it', qa('#jModes button').length === 5,
  qa('#jModes button').map(b => b.dataset.mode).join(','));
ok('tree is the default', q('#jModes button[data-mode="tree"]').getAttribute('aria-pressed') === 'true');
ok('tab badge counts the document', q('#tabJsonN').textContent === '1', q('#tabJsonN').textContent);
ok('title shown in the toolbar', /sample\.json$/.test(q('#jName').value), q('#jName').value);
ok('no error banner for valid json', q('#jError').hidden);

section('json: the tree');
ok('rows rendered', jrows().length > 8, jrows().length + ' rows');
ok('the document opens partly expanded', !!jrow('device') && !!jrow('osVersion'),
  jrows().length + ' rows');
ok('but not all the way down', !jrow('temperatureC'));
ok('types are coloured apart', new Set([
  window.getComputedStyle(q('#jTreeHost .jlit.string')).color,
  window.getComputedStyle(q('#jTreeHost .jlit.number')).color,
  window.getComputedStyle(q('#jTreeHost .jlit.boolean')).color,
  window.getComputedStyle(q('#jTreeHost .jlit.null')).color
]).size === 4);
ok('numbers are numbers', !!jrow('total_call_rec_synced').querySelector('.jlit.number'));
ok('booleans are booleans', !!jrow('is_auto_dialer_enabled').querySelector('.jlit.boolean'));
ok('null is null', !!jrow('last_sync_error').querySelector('.jlit.null'));
ok('a branch shows a summary rather than its contents',
  /keys/.test(jrow('device').querySelector('.jsum').textContent),
  jrow('device').querySelector('.jsum').textContent);
ok('nesting is indented', Number(jrow('osVersion').style.getPropertyValue('--d')) >
  Number(jrow('device').style.getPropertyValue('--d')),
  jrow('osVersion').style.getPropertyValue('--d') + ' vs ' + jrow('device').style.getPropertyValue('--d'));
await openRow('device');
ok('a branch closes on its twisty', !jrow('osVersion'));
await openRow('device');
ok('and opens again', !!jrow('osVersion'));
await openRow('battery');
ok('one more level down', !!jrow('temperatureC'));
await openRow('permissions');
ok('array indices read as indices',
  !!jrow(0) && jrow(0).querySelector('.jkey').classList.contains('idx'));
ok('a leaf has no twisty to press', twistOf(jrow('osVersion')).disabled);
ok('the tree is a real tree to a screen reader',
  q('#jTreeHost').getAttribute('role') === 'tree' &&
  qa('#jTreeHost [role="treeitem"]').length === jrows().length &&
  qa('#jTreeHost [role="group"]').length > 0,
  qa('#jTreeHost [role="treeitem"]').length + ' treeitems, ' +
  qa('#jTreeHost [role="group"]').length + ' groups');
ok('levels are announced', jrow('osVersion').parentElement.getAttribute('aria-level') === '3',
  jrow('osVersion').parentElement.getAttribute('aria-level'));
ok('a branch says whether it is open',
  jrow('device').parentElement.getAttribute('aria-expanded') === 'true' &&
  !jrow('osVersion').parentElement.hasAttribute('aria-expanded'));
ok('a row has a spoken name of its own',
  /^appVersion: /.test(jrow('appVersion').parentElement.getAttribute('aria-label')),
  jrow('appVersion').parentElement.getAttribute('aria-label'));
/* Keyboard: the treeitems are what move, not the rows. */
jrow('device').parentElement.focus();
q('#jTreeHost').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
await wait(40);
ok('arrow keys walk the tree', d.activeElement.getAttribute('role') === 'treeitem' &&
  d.activeElement !== jrow('device').parentElement,
  d.activeElement.getAttribute('aria-label'));
q('#jTreeHost').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
await wait(40);
click(jrow('appVersion').querySelector('.jval'));
await wait(60);
ok('clicking a row names it in the breadcrumb', q('#jCrumbPath').textContent === 'device.appVersion',
  q('#jCrumbPath').textContent);
ok('and gives its type', q('#jCrumbType').textContent === 'string', q('#jCrumbType').textContent);

section('json: JSON hidden inside a string');
/* Back to just the top level, so an index means the one we mean. */
click(q('#jCollapse'));
await wait(80);
await openRow('$');
const queueRow = jrow('synced_call_details_queue');
ok('recognised as a document, not a string',
  !!queueRow.querySelector('.jchip') && /JSON in a string/.test(queueRow.querySelector('.jchip').textContent),
  queueRow.querySelector('.jchip') ? queueRow.querySelector('.jchip').textContent : 'no chip');
ok('summarised as the array it is', /4 items/.test(queueRow.querySelector('.jsum').textContent),
  queueRow.querySelector('.jsum').textContent);
ok('an ordinary string is not mistaken for one',
  !/JSON in a string/.test(jrow('notes').textContent));
await ensureOpen('synced_call_details_queue');
ok('it expands like any other branch', !!jrow(0) && !!jrow(3), jrows().length + ' rows');
await openRow(0);
ok('records inside are real structure', !!jrow('callUUID') && !!jrow('sanitizedCustomerNumber'));
ok('their values keep their types', !!jrow('creationTimeMillis').querySelector('.jlit.number'));
click(jrow('callUUID').querySelector('.jval'));
await wait(40);
ok('the path shows the string boundary it crossed',
  q('#jCrumbPath').textContent === 'synced_call_details_queue » [0].callUUID',
  q('#jCrumbPath').textContent);
await ensureOpen('retry_envelope');
await ensureOpen('payload');
ok('a document nested twice over opens too', !!jrow('backoff') && !!jrow('lastError'),
  jrows().length + ' rows');
ok('the truncated field is called out, not silently shown as a string',
  /truncated JSON/.test(jrow('truncated_payload').textContent),
  jrow('truncated_payload').textContent.slice(0, 70));
ok('a multi-line string is flagged', /multi-line/.test(jrow('notes').textContent));
click(jrow('notes').querySelector('.jval'));
await wait(40);
ok('and reads as itself once selected',
  q('#jTreeHost .jstring-full').textContent.split('\n').length === 2,
  JSON.stringify(q('#jTreeHost .jstring-full').textContent.slice(0, 30)));

section('json: find');
const rowsBeforeSearch = jrows().length;
q('#jSearch').value = 'ANSWERED';
q('#jSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(260);
ok('matches counted', /match/.test(q('#jHits').textContent), q('#jHits').textContent);
ok('the tree filters down to the matches', jrows().length < 40 && !!jrowText('ANSWERED'),
  jrows().length + ' rows');
ok('the match is reached through the embedded document', !!jrow('synced_call_details_queue'));
ok('and unrelated branches are gone', !jrow('device'));
q('#jSearch').value = '';
q('#jSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(240);
ok('clearing the search puts back exactly what was open before it',
  jrows().length === rowsBeforeSearch, jrows().length + ' vs ' + rowsBeforeSearch + ' rows');

section('json: expand and collapse');
click(q('#jExpand'));
await wait(150);
const wideOpen = jrows().length;
ok('expand opens everything', wideOpen > 60, wideOpen + ' rows');
click(q('#jCollapse'));
await wait(80);
ok('collapse closes everything', jrows().length === 1, jrows().length + ' rows');
await openRow('$');
ok('the root opens again', jrows().length > 8, jrows().length + ' rows');

section('json: table');
jsonMode('table');
await wait(150);
ok('table view is showing', !q('#jTableHost').hidden && q('#jTreeHost').hidden);
ok('the biggest array was chosen', qa('#jTableHost tbody tr').length === 4,
  qa('#jTableHost tbody tr').length + ' rows');
ok('columns are the union of the record keys', qa('#jTableHost thead th').length > 9,
  qa('#jTableHost thead th').length + ' columns');
const heads = qa('#jTableHost .jt-sort').map(b => b.textContent);
ok('the array it tabulated was the one inside a string',
  heads.includes('callUUID') && heads.includes('sanitizedCustomerNumber'), heads.join(','));
ok('a picker is only offered when there is a choice', q('#jTables').hidden);
ok('rows are numbered', q('#jTableHost .jt-n').textContent === '#');
ok('missing fields read as missing', qa('#jTableHost .jt-empty').length > 0);
const durationCol = qa('#jTableHost .jt-sort').findIndex(b => b.textContent === 'duration');
click(qa('#jTableHost .jt-sort')[durationCol]);
await wait(80);
const durations = qa('#jTableHost tbody tr').map(tr => Number(tr.children[durationCol + 1].textContent) || 0);
ok('a column sorts', durations.join(',') === durations.slice().sort((a, b) => a - b).join(','), durations.join(','));
q('#jSearch').value = 'missed';
q('#jSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(240);
ok('the table filters', qa('#jTableHost tbody tr').length === 1,
  qa('#jTableHost tbody tr').length + ' rows');
q('#jSearch').value = '';
q('#jSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(240);
click(q('#jTableHost .link-chip'));
await wait(150);
ok('a nested cell hands you back to the tree', !q('#jTreeHost').hidden && !!q('#jTreeHost .jrow.sel'));
ok('and it is the cell you clicked', /recording/.test(q('#jCrumbPath').textContent),
  q('#jCrumbPath').textContent);

section('json: code');
jsonMode('code');
await wait(150);
ok('code view is showing', !q('#jCodeHost').hidden);
ok('line numbers in the gutter', /^1\n2\n3/.test(q('.jc-gutter').textContent));
ok('a key is coloured apart from a string value',
  window.getComputedStyle(q('.jc-key')).color !== window.getComputedStyle(q('.jc-string')).color,
  window.getComputedStyle(q('.jc-key')).color + ' vs ' + window.getComputedStyle(q('.jc-string')).color);
ok('every token kind is coloured',
  ['key', 'string', 'number', 'boolean', 'null'].every(k => !!q('.jc-' + k)));
ok('punctuation takes the block colour rather than a span of its own',
  !q('.jc-punct') && window.getComputedStyle(q('.jc-code')).color === 'var(--j-punct)',
  window.getComputedStyle(q('.jc-code')).color);
ok('nested json is still escaped by default',
  /\\"sanitizedCustomerNumber\\"/.test(q('.jc-code').textContent));
click(q('#jUnwrap'));
await wait(150);
ok('unwrap opens the nested documents out',
  !/\\"sanitizedCustomerNumber\\"/.test(q('.jc-code').textContent) &&
  /^\s+"sanitizedCustomerNumber": "\+91/m.test(q('.jc-code').textContent));
ok('a nested document two strings deep is opened out as well',
  /^\s+"lastError": "socket hang up"/m.test(q('.jc-code').textContent));
ok('but one that cannot be parsed is left exactly as it is',
  /"truncated_payload": "\[\{\\"callStartTime/.test(q('.jc-code').textContent));
ok('unwrap is a toggle', q('#jUnwrap').getAttribute('aria-pressed') === 'true');
ok('the status line counts the nested documents', /nested document/.test(q('#jStats').textContent),
  q('#jStats').textContent);
q('#jSearch').value = 'ANSWERED';
q('#jSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(260);
ok('search marks the code', qa('.jc-hit').length > 0, qa('.jc-hit').length + ' marks');
q('#jSearch').value = '';
q('#jSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(240);
click(q('#jUnwrap'));
await wait(120);

section('json: raw');
jsonMode('raw');
await wait(100);
const sampleText = q('#sample-json').textContent.trim();
ok('raw is exactly what was opened', q('#jRaw').textContent === sampleText,
  q('#jRaw').textContent.length + ' vs ' + sampleText.length + ' chars');
ok('find is put away where it means nothing', q('#jSearch').hidden);

section('json: editing a value in the tree');
jsonMode('tree');
await wait(120);
ok('reading has no edit affordances', qa('#jTreeHost .jval.editable').length === 0);
click(q('#jEditable'));
await wait(120);
ok('edit values is a toggle', q('#jEditable').getAttribute('aria-pressed') === 'true');
ok('values become clickable', qa('#jTreeHost .jval.editable').length > 0);
click(jrow('total_call_rec_synced').querySelector('.jval'));
await wait(60);
ok('clicking a value opens an input', !!q('#jTreeHost .jedit'));
q('#jTreeHost .jedit').value = '9001';
q('#jTreeHost .jedit').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await wait(120);
ok('the new value is typed, not stringified',
  /9001/.test(jrow('total_call_rec_synced').textContent) &&
  !!jrow('total_call_rec_synced').querySelector('.jlit.number'),
  jrow('total_call_rec_synced').textContent.slice(0, 40));
await wait(700);
ok('the edit reached the document', /"total_call_rec_synced": 9001/.test(jsonDocsNow()[0].text),
  (jsonDocsNow()[0].text.match(/"total_call_rec_synced":[^,]*/) || [''])[0]);
ok('the status line says it is saved', q('#jSaved').textContent === 'Saved', q('#jSaved').textContent);

section('json: editing inside an embedded document');
await ensureOpen('synced_call_details_queue');
await ensureOpen(0);
click(jrow('leadIdentifier').querySelector('.jval'));
await wait(60);
q('#jTreeHost .jedit').value = 'ipt::000001';
q('#jTreeHost .jedit').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await wait(800);
const reread = JSON.parse(jsonDocsNow()[0].text);
ok('an edit inside a string-borne document is written back through the string',
  JSON.parse(reread.synced_call_details_queue)[0].leadIdentifier === 'ipt::000001',
  JSON.parse(reread.synced_call_details_queue)[0].leadIdentifier);
ok('the surrounding document is still valid JSON', typeof reread.synced_call_details_queue === 'string');
click(q('#jEditable'));
await wait(80);

section('json: the source pane');
jsonMode('edit');
await wait(120);
ok('the source pane holds the text', q('#jEditArea').value.length > 100);
q('#jEditArea').value = '{ "a": 1, "b": [1, 2, }';
q('#jEditArea').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(320);
ok('a broken document is reported', !q('#jError').hidden && /Invalid JSON/.test(q('#jError').textContent),
  q('#jError').textContent.slice(0, 80));
ok('with a line and column', /line \d+, column \d+/.test(q('#jError').textContent),
  q('#jError').textContent.slice(0, 90));
ok('format refuses to run on it',
  (click(q('#jFormat')), await wait(60), /Fix the syntax/.test(q('#toast').textContent)),
  q('#toast').textContent.slice(0, 40));
q('#jEditArea').value = '{"b":[3,1,2],"a":{"z":1,"y":2}}';
q('#jEditArea').dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(320);
ok('fixing it clears the banner', q('#jError').hidden);
click(q('#jFormat'));
await wait(120);
ok('format re-indents', /^\{\n  "b": \[/.test(q('#jEditArea').value), JSON.stringify(q('#jEditArea').value.slice(0, 18)));
click(q('#jSortKeys'));
await wait(120);
ok('sort keys sorts every object', /"a":[\s\S]*"y"[\s\S]*"z"[\s\S]*"b"/.test(q('#jEditArea').value),
  q('#jEditArea').value.replace(/\s+/g, ''));
ok('arrays keep their order', /\[\s*3,\s*1,\s*2\s*\]/.test(q('#jEditArea').value));
click(q('#jMinify'));
await wait(120);
ok('minify strips the whitespace', q('#jEditArea').value === '{"a":{"y":2,"z":1},"b":[3,1,2]}',
  q('#jEditArea').value);
await wait(700);
ok('the source edit was saved', jsonDocsNow()[0].text === '{"a":{"y":2,"z":1},"b":[3,1,2]}',
  jsonDocsNow()[0].text.slice(0, 40));

section('json: keyboard');
jsonMode('tree');
await wait(100);
const pressJson = (key, opts) => d.dispatchEvent(new window.KeyboardEvent('keydown',
  Object.assign({ key, bubbles: true }, opts || {})));
pressJson('3');
await wait(100);
ok('a number picks a view', q('#jModes button[data-mode="code"]').getAttribute('aria-pressed') === 'true');
pressJson(']');
await wait(100);
ok('brackets step through them', q('#jModes button[data-mode="raw"]').getAttribute('aria-pressed') === 'true');
pressJson('[');
await wait(100);
ok('in both directions', q('#jModes button[data-mode="code"]').getAttribute('aria-pressed') === 'true');
pressJson('/');
await wait(60);
ok('slash reaches the find box', d.activeElement === q('#jSearch'), d.activeElement.id);
q('#jSearch').blur();
pressJson('f', { metaKey: true });
await wait(60);
ok('so does the usual find shortcut', d.activeElement === q('#jSearch'), d.activeElement.id);
q('#jSearch').blur();
jsonMode('tree');
await wait(100);

section('json: a second document');
await pasteJson('Deploys', '[{"env":"prod","ok":true},{"env":"staging","ok":false}]');
ok('two documents in the library', jsonDocsNow().length === 2, jsonDocsNow().length + ' documents');
ok('the pasted one is on screen', q('#jName').value === 'Deploys', q('#jName').value);
ok('an array root tabulates straight away',
  (jsonMode('table'), await wait(150), qa('#jTableHost tbody tr').length) === 2,
  qa('#jTableHost tbody tr').length + ' rows');

await pasteJson('Broken', '{"nope"');
ok('an invalid paste is still kept', jsonDocsNow().length === 3);
ok('and opens in the source pane', q('#jModes button[data-mode="edit"]').getAttribute('aria-pressed') === 'true');
ok('with the reason', /Invalid JSON/.test(q('#jError').textContent), q('#jError').textContent.slice(0, 60));
jsonMode('tree');
await wait(100);
ok('the tree says why it is empty rather than showing nothing',
  /until the syntax parses/.test(q('#jTreeHost').textContent), q('#jTreeHost').textContent.slice(0, 40));
jsonMode('code');
await wait(100);
ok('the code view still shows the broken text', /nope/.test(q('.jc-code').textContent));

section('json: opening from a URL');
const jsonRequested = [];
const previousFetch = window.fetch;
window.fetch = async (url) => {
  jsonRequested.push(String(url));
  if (/notjson/.test(url)) return { ok: true, status: 200, text: async () => '<!doctype html><html></html>' };
  if (/missing/.test(url)) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '' };
  return { ok: true, status: 200, text: async () => '{"from":"the network","rows":[1,2,3]}' };
};
globalThis.fetch = window.fetch;
click(q('#jUrl'));
q('#jsonUrlField').value = 'https://x.dev/data/config.json';
submit(q('#jsonUrlForm'));
await wait(200);
ok('the file was requested', jsonRequested[0] === 'https://x.dev/data/config.json', jsonRequested[0]);
ok('named after the file', q('#jName').value === 'config.json', q('#jName').value);
jsonMode('tree');
await wait(150);
ok('and opened in the tree', !!jrow('from'), jrows().length + ' rows');
/* The source pane commits on blur, and a blur can land after another document
   has been opened. It must never write the old text into the new record. */
q('#jEditArea').dispatchEvent(new window.Event('blur'));
await wait(700);
ok('a late blur from the source pane cannot corrupt the new document',
  JSON.parse(jsonDocsNow()[0].text).from === 'the network',
  jsonDocsNow()[0].text.slice(0, 60));
for (const [label, url, expect] of [
  ['a web page is refused', 'https://x.dev/notjson.json', /not JSON/],
  ['a 404 is reported', 'https://x.dev/missing.json', /answered 404/]
]) {
  click(q('#jUrl'));
  q('#jsonUrlField').value = url;
  submit(q('#jsonUrlForm'));
  await wait(150);
  ok(label, expect.test(q('#jsonUrlErr').textContent), q('#jsonUrlErr').textContent.slice(0, 46));
}
q('#jsonUrlDlg').close();
window.fetch = previousFetch;
globalThis.fetch = previousFetch;

section('json: home and persistence');
click(q('#tab-home'));
await wait(120);
ok('the JSON section lists them', qa('#jsonRows .row-item').length === 4,
  qa('#jsonRows .row-item').length + ' rows');
ok('an invalid document is labelled', /invalid/.test(q('#jsonRows').textContent));
ok('the tab badge follows', q('#tabJsonN').textContent === '4', q('#tabJsonN').textContent);
saved.files.length = 0;
click(qa('#jsonRows .row-item')[0].querySelector('.row-act .btn'));
await wait(120);
ok('a document saves as .json', saved.files.length === 1 && saved.files[0].name.endsWith('.json'),
  saved.files[0] && saved.files[0].name);
const storedJson = await new Promise((res, rej) => {
  const req = window.indexedDB.open(DB_NAME, DB_VER);
  req.onsuccess = () => {
    const tx = req.result.transaction('jsondocs').objectStore('jsondocs').getAll();
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => rej(tx.error);
  };
  req.onerror = () => rej(req.error);
});
ok('documents are in IndexedDB', storedJson.length === 4 && storedJson.every(r => typeof r.text === 'string'),
  storedJson.length + ' records');
click(qa('#jsonRows .row-item')[0].querySelector('.row-act .btn.danger'));
await wait(150);
ok('and can be removed', qa('#jsonRows .row-item').length === 3,
  qa('#jsonRows .row-item').length + ' rows');

console.log('\n' + (failures ? 'FAILED' : 'PASSED') + ': ' + (checks - failures) + '/' + checks + ' checks');
if (consoleErrors.length) {
  console.log('console errors:\n  ' + consoleErrors.join('\n  '));
  failures++;
}
process.exit(failures ? 1 : 0);
