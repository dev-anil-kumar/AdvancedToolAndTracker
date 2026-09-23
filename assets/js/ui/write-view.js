/**
 * The Write view: a calm, paper-like rich-text editor.
 *
 * Layout: a left rail (the document library — filter, new, rename, duplicate,
 * remove), a main column (sticky grouped toolbar, the paper sheet, a slim
 * status bar), and a collapsible outline panel. A floating selection bubble
 * and a slash menu live over the sheet; a shortcut cheat-sheet is a dialog
 * like the canvas's.
 *
 * Like ui/json-view.js: this module owns the DOM, reads state, and asks
 * features/writedocs.js to change it. The actual formatting logic lives in
 * features/write/commands.js; the keymap and Markdown autoformat live in
 * features/write/shortcuts.js. Everything either of those needs from a real
 * selection is read off `window.getSelection()` directly — there is no
 * editor object in between.
 *
 * ---------------------------------------------------------------------
 * Extension hook contract (for the Phase-2 agents building paste, images,
 * search, page styles and file I/O — see features/write/*.js, each a stub
 * exporting `init(ctx)`):
 *
 *   ctx.sheet                     the #writeSheet contenteditable element
 *   ctx.pageEl                    the .write-page wrapper (data-page-style /
 *                                 data-tint / data-width live here)
 *   ctx.toolbarEl                 the #writeToolbar element
 *   ctx.getDoc()                  the open record from state, or null
 *   ctx.saveNow()                 flush the debounced autosave immediately
 *   ctx.toast(message)            the app's transient status line
 *   ctx.openDoc(id)               switch the sheet to another library document
 *                                 (features/write/io.js uses this after
 *                                 opening a file, or a drop, creates one)
 *   ctx.registerToolbarButton(group, { title, icon, text, run, isActive })
 *                                 appends a button into a toolbar group —
 *                                 group is one of 'block','text','list',
 *                                 'align','insert','page','file','search',
 *                                 'view', or a new name of your own
 *   ctx.registerShortcut(combo, fn)
 *                                 combo is what features/write/shortcuts.js's
 *                                 keyCombo() produces (e.g. 'mod+f'). A combo
 *                                 already in WRITE_KEYMAP replaces that
 *                                 action's handler (which otherwise toasts
 *                                 "not ready yet"); any other combo is a new
 *                                 binding
 *   ctx.registerSlashItem({ key, label, hint, run(cmds) })
 *                                 upserts one entry in the "/" menu by key —
 *                                 replaces the built-in placeholder (e.g.
 *                                 'image') if that key already exists
 * ---------------------------------------------------------------------
 */
import { on, EVENTS } from '../core/bus.js';
import { WRITE_FONTS, WRITE_HIGHLIGHTS, WRITE_SAVE_MS, WRITE_SLASH_ITEMS, WRITE_TEXT_COLORS } from '../core/config.js';
import { $, $$, el, uid } from '../core/dom.js';
import { formatWhen, plural } from '../core/format.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { writeDocById, writedocs, writeDocsByRecency } from '../core/state.js';
import { addWriteDoc, duplicateWriteDoc, removeWriteDoc, renameWriteDoc, updateWriteDoc } from '../features/writedocs.js';
import * as cmds from '../features/write/commands.js';
import { attachAutoformat, createWriteShortcuts } from '../features/write/shortcuts.js';
import { isZen, setZen } from '../features/focus.js';
import * as writePaste from '../features/write/paste.js';
import * as writeImages from '../features/write/images.js';
import * as writeSearch from '../features/write/search.js';
import * as writePages from '../features/write/pages.js';
import * as writeIo from '../features/write/io.js';

/* ---------- State ---------- */
let docId = null;
let saveTimer = null;
let saved = true;
let filterText = '';

let sheetEl = null, pageEl = null, toolbarEl = null;
const groupEls = {};
const stateButtons = {};       // action name -> button, for aria-pressed
const trackedActive = [];      // { btn, isActive() } from registerToolbarButton
const slashItems = WRITE_SLASH_ITEMS.map(item => ({ ...item, run: null }));

const GROUP_ORDER = ['block', 'text', 'list', 'align', 'insert', 'page', 'file', 'search', 'view'];

/* ---------- Icons: small stroke-path glyphs, matching the rest of the app ---------- */
const ICON_PATHS = {
  bold: 'M7 5h6.5a3.5 3.5 0 0 1 0 7H7zM7 12h7.5a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M10 5h7M7 19h7M14 5 10 19',
  underline: 'M6 4v6a6 6 0 0 0 12 0V4M4 20h16',
  strike: 'M5 12h14M9 6.2c0-1.3 1.7-2.3 3.8-2.3s3.8 1 3.8 2.1c0 1-.6 1.6-1.7 2M9 17.8c0 1.3 1.7 2.3 3.8 2.3s3.8-1 3.8-2.2c0-1-.8-1.7-2-2.1',
  code: 'M9 6 4 12l5 6M15 6l5 6-5 6',
  link: 'M9 15l6-6M8.5 13.5 6.3 15.7a3.4 3.4 0 0 0 4.8 4.8l2.6-2.6M15.5 10.5l2.2-2.2a3.4 3.4 0 0 0-4.8-4.8l-2.6 2.6',
  quote: 'M7.5 8.2c-2 0-3.3 1.4-3.3 3.4 0 1.8 1.2 3 3 3M7.5 8.2v3.4M16.5 8.2c-2 0-3.3 1.4-3.3 3.4 0 1.8 1.2 3 3 3M16.5 8.2v3.4',
  bullet: 'M5 6h.01M5 12h.01M5 18h.01M9 6h10M9 12h10M9 18h10',
  number: 'M4.5 6.5h1v3M4 9.5h2M4.2 15.3h2c1 0 1.6.9 1 1.7L4.2 19.5h3M9 6h11M9 12h11M9 18h11',
  checklist: 'M4 6.5 5.3 7.8 8 5M4 12.5l1.3 1.3L8 11M4 18.5l1.3 1.3L8 17M11 6h9M11 12h9M11 18h9',
  indent: 'M4 5h16M4 19h16M4 12h8M13 8.5l4 3.5-4 3.5',
  outdent: 'M4 5h16M4 19h16M4 12h8M17 8.5l-4 3.5 4 3.5',
  alignLeft: 'M4 6h16M4 12h10M4 18h13',
  alignCenter: 'M4 6h16M7 12h10M5.5 18h13',
  alignRight: 'M4 6h16M10 12h10M6.5 18h13',
  alignJustify: 'M4 6h16M4 12h16M4 18h16',
  hr: 'M4 12h16',
  table: 'M4 5.5h16M4 9.83h16M4 14.17h16M4 18.5h16M4 5.5v13M9.33 5.5v13M14.67 5.5v13M20 5.5v13',
  undo: 'M7 7 3 11l4 4M3 11h10.5a6 6 0 1 1 0 12H10',
  redo: 'M17 7l4 4-4 4M21 11H10.5a6 6 0 1 0 0 12H14',
  outline: 'M4 6h3M4 12h3M4 18h3M10 6h10M10 12h8M10 18h6',
  focus: 'M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15',
  help: 'M9.3 9a2.6 2.6 0 1 1 3.6 2.4c-1 .4-1.6 1.2-1.6 2.2v.3M12 17h.01',
  plus: 'M12 5v14M5 12h14'
};
function icon(name) {
  const d = ICON_PATHS[name] || '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
}

/* ---------- Opening & closing ---------- */

export function openWriteDoc(id) {
  const rec = writeDocById(id);
  if (!rec) { toast('That document is no longer here.'); return; }
  build();
  if (docId !== null && docId !== id) flushWrite();
  docId = rec.id;
  sheetEl.innerHTML = rec.html || '';
  pageEl.dataset.pageStyle = rec.page.style;
  pageEl.dataset.tint = rec.page.tint;
  pageEl.dataset.width = rec.page.width;
  writePages.applyPage(rec); // Phase-2 hook: re-sync the page popover + hover state for the new doc
  applyDocFont(rec.font);
  saved = true;
  closeSlash();
  hideBubble();
  writeImages.deselectImage(); // the old sheet's <img> (and its floating toolbar) is gone
  writeSearch.resetForDocSwitch(); // stale matches pointed at nodes that no longer exist
  $('#writeRail').classList.remove('open');
  renderWriteDocs();
  syncStatus();
  syncToolbar();
  route('write');
  setTimeout(() => sheetEl.focus(), 30);
}

function closeWriteDoc() {
  docId = null;
  sheetEl.innerHTML = '';
  closeSlash();
  hideBubble();
  writeImages.deselectImage();
  writeSearch.resetForDocSwitch();
  renderWriteDocs();
  syncStatus();
  syncToolbar();
}

function currentDoc() { return docId === null ? null : writeDocById(docId); }

function applyDocFont(key) {
  const font = WRITE_FONTS.find(f => f.key === key) || WRITE_FONTS[0];
  sheetEl.style.fontFamily = font.stack;
  const sel = $('#writeFontFamily');
  if (sel) sel.value = font.key;
}

async function setDocFont(key) {
  if (docId === null) return;
  applyDocFont(key);
  await updateWriteDoc(docId, { font: key });
}

async function createNewDoc() {
  const rec = await addWriteDoc({ name: 'Untitled document' });
  openWriteDoc(rec.id);
}

/* ---------- Autosave ---------- */

/**
 * `sheetEl.innerHTML`, minus the one bit of Phase-2 transient UI that lives
 * inside the sheet itself rather than floating over it: the "selected"
 * outline images.js paints directly onto the `<img>` while its toolbar is
 * open. Everything else (toolbars, hover chips, overlays, the find bar, the
 * slash menu) is appended to `document.body` and was never part of this
 * string to begin with. Cloned rather than stripped in place, so an image
 * mid-resize does not lose its selection just because autosave ticked.
 */
function getSaveHtml() {
  if (!sheetEl.querySelector('.write-img-selected')) return sheetEl.innerHTML;
  const clone = sheetEl.cloneNode(true);
  clone.querySelectorAll('.write-img-selected').forEach(img => img.classList.remove('write-img-selected'));
  return clone.innerHTML;
}

function queueSave() {
  saved = false;
  syncStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (docId === null) return;
    await updateWriteDoc(docId, { html: getSaveHtml() });
    saved = true;
    syncStatus();
  }, WRITE_SAVE_MS);
}

export async function flushWrite() {
  if (saved || docId === null) return;
  clearTimeout(saveTimer);
  await updateWriteDoc(docId, { html: getSaveHtml() });
  saved = true;
  syncStatus();
}

function afterEdit() {
  queueSave();
  syncToolbar();
  syncStatus();
}
const wrap = (fn) => () => { fn(); afterEdit(); };

/* ---------- Building the chrome, once ---------- */

let ready = false;
function build() {
  if (ready) return;
  ready = true;
  sheetEl = $('#writeSheet');
  pageEl = $('#writePage');
  toolbarEl = $('#writeToolbar');
  cmds.bindSheet(sheetEl);

  const railToggle = el('button', 'wt-btn wt-rail-toggle');
  railToggle.type = 'button'; railToggle.title = 'Documents';
  railToggle.innerHTML = icon('bullet');
  railToggle.addEventListener('click', () => $('#writeRail').classList.toggle('open'));
  toolbarEl.appendChild(railToggle);

  GROUP_ORDER.forEach(name => {
    const g = el('div', 'wt-group');
    g.dataset.group = name;
    toolbarEl.appendChild(g);
    groupEls[name] = g;
  });

  buildBlockGroup();
  buildTextGroup();
  buildListGroup();
  buildAlignGroup();
  buildInsertGroup();
  buildViewGroup();

  attachAutoformat(sheetEl, cmds);
  wireSheet();
  wireRail();
  wireBubble();
  wireSlash();
  wireOutline();
  wireShortcutsDialog();

  const ctx = {
    sheet: sheetEl,
    pageEl,
    toolbarEl,
    getDoc: currentDoc,
    saveNow: flushWrite,
    toast,
    /* Opens a document already in the library — for features/write/io.js,
       whose "Open a file" and drop handling create a document nothing in
       this module's own state machine knew about beforehand. */
    openDoc: openWriteDoc,
    registerToolbarButton,
    registerShortcut,
    registerSlashItem
  };
  writePaste.init(ctx);
  writeImages.init(ctx);
  writeSearch.init(ctx);
  writePages.init(ctx);
  writeIo.init(ctx);
}

function groupEl(name) {
  if (groupEls[name]) return groupEls[name];
  const g = el('div', 'wt-group');
  g.dataset.group = name;
  toolbarEl.appendChild(g);
  groupEls[name] = g;
  return g;
}

/**
 * The one thing Phase-2 modules use to add their own buttons. `def.icon`, if
 * given, is raw inline SVG markup — a Phase-2 module has no access to this
 * module's private icon set, so it draws its own; `def.text` is a plain
 * label for anything simpler than an icon.
 */
function registerToolbarButton(group, def) {
  const b = el('button', 'wt-btn');
  b.type = 'button';
  b.title = def.title || '';
  if (def.icon) b.innerHTML = def.icon;
  else if (def.text) b.textContent = def.text;
  b.addEventListener('click', () => { def.run(); afterEdit(); });
  if (def.isActive) trackedActive.push({ btn: b, isActive: def.isActive });
  groupEl(group).appendChild(b);
  return b;
}

function registerSlashItem(def) {
  const at = slashItems.findIndex(it => it.key === def.key);
  if (at >= 0) slashItems[at] = { ...slashItems[at], ...def };
  else slashItems.push(def);
}

const extraActions = {};
/**
 * `opts.preventDefault` defaults to true. `paste.js` needs `false` for
 * mod+shift+v: it wants the native `paste` event that follows the key
 * combo (not a `navigator.clipboard.readText()` call, which prompts for
 * permission) — so the browser's default paste has to be allowed through.
 */
function registerShortcut(combo, fn, opts) {
  extraActions[combo] = { fn, preventDefault: !opts || opts.preventDefault !== false };
}

function addBtn(group, name, title, iconName) {
  const b = el('button', 'wt-btn');
  b.type = 'button';
  b.title = title;
  b.innerHTML = icon(iconName);
  b.addEventListener('click', wrap(cmds[name] || (() => {})));
  groupEl(group).appendChild(b);
  stateButtons[name] = b;
  return b;
}

function buildBlockGroup() {
  const p = el('button', 'wt-btn', 'P');
  p.type = 'button'; p.title = 'Paragraph (⌥0)';
  p.addEventListener('click', wrap(cmds.paragraph));
  groupEl('block').appendChild(p);
  stateButtons.paragraph = p;
  [1, 2, 3].forEach(level => {
    const b = el('button', 'wt-btn', 'H' + level);
    b.type = 'button'; b.title = 'Heading ' + level + ' (⌥' + level + ')';
    b.addEventListener('click', wrap(() => cmds.heading(level)));
    groupEl('block').appendChild(b);
    stateButtons['h' + level] = b;
  });
  addBtn('block', 'quote', 'Quote (⇧⌘.)', 'quote');
  addBtn('block', 'codeBlock', 'Code block (⌥C)', 'code');
}

function buildTextGroup() {
  addBtn('text', 'bold', 'Bold (⌘B)', 'bold');
  addBtn('text', 'italic', 'Italic (⌘I)', 'italic');
  addBtn('text', 'underline', 'Underline (⌘U)', 'underline');
  addBtn('text', 'strike', 'Strikethrough (⇧⌘X)', 'strike');
  addBtn('text', 'inlineCode', 'Inline code (⌘E)', 'code');

  buildSwatchButton('text', {
    title: 'Highlight (⇧⌘H)', text: 'H', items: WRITE_HIGHLIGHTS,
    onPick: (hex) => cmds.highlight(hex)
  });
  buildSwatchButton('text', {
    title: 'Text colour', text: 'A', items: WRITE_TEXT_COLORS,
    onPick: (hex) => cmds.textColor(hex)
  });

  const fontSel = el('select', 'wt-select');
  fontSel.id = 'writeFontFamily';
  fontSel.title = 'Document font';
  WRITE_FONTS.forEach(f => {
    const o = el('option', null, f.label);
    o.value = f.key;
    fontSel.appendChild(o);
  });
  fontSel.addEventListener('change', () => setDocFont(fontSel.value));
  groupEl('text').appendChild(fontSel);

  const sizeSel = el('select', 'wt-select');
  sizeSel.title = 'Text size (applies to the selection)';
  const first = el('option', null, 'Size');
  first.value = ''; first.disabled = true; first.selected = true;
  sizeSel.appendChild(first);
  [12, 14, 16, 18, 20, 24, 28, 32].forEach(px => {
    const o = el('option', null, String(px) + ' px');
    o.value = String(px);
    sizeSel.appendChild(o);
  });
  sizeSel.addEventListener('change', () => {
    if (sizeSel.value) cmds.fontSize(Number(sizeSel.value));
    sizeSel.value = '';
    afterEdit();
  });
  groupEl('text').appendChild(sizeSel);
}

function buildListGroup() {
  addBtn('list', 'bulletList', 'Bulleted list (⇧⌘8)', 'bullet');
  addBtn('list', 'numberList', 'Numbered list (⇧⌘7)', 'number');
  addBtn('list', 'checklist', 'Checklist (⇧⌘9)', 'checklist');
  addBtn('list', 'indent', 'Indent (⌘])', 'indent');
  addBtn('list', 'outdent', 'Outdent (⌘[)', 'outdent');
}

function buildAlignGroup() {
  addBtn('align', 'alignLeft', 'Align left (⇧⌘L)', 'alignLeft');
  addBtn('align', 'alignCenter', 'Align center (⇧⌘E)', 'alignCenter');
  addBtn('align', 'alignRight', 'Align right (⇧⌘R)', 'alignRight');
  addBtn('align', 'alignJustify', 'Justify (⇧⌘J)', 'alignJustify');
}

function buildInsertGroup() {
  const link = el('button', 'wt-btn');
  link.type = 'button'; link.title = 'Link (⌘K)'; link.innerHTML = icon('link');
  link.addEventListener('click', () => openLinkBox());
  groupEl('insert').appendChild(link);
  stateButtons.link = link;

  addBtn('insert', 'hr', 'Divider', 'hr');

  const table = el('button', 'wt-btn');
  table.type = 'button'; table.title = 'Insert a 3 × 3 table'; table.innerHTML = icon('table');
  table.addEventListener('click', wrap(() => cmds.insertTable(3, 3)));
  groupEl('insert').appendChild(table);

  buildMenuButton('insert', {
    title: 'Table rows and columns', iconName: 'table',
    items: [
      { label: 'Add row', run: cmds.addRow }, { label: 'Remove row', run: cmds.removeRow },
      { label: 'Add column', run: cmds.addCol }, { label: 'Remove column', run: cmds.removeCol }
    ]
  });
}

function buildViewGroup() {
  addBtn('view', 'undo', 'Undo (⌘Z)', 'undo');
  addBtn('view', 'redo', 'Redo (⇧⌘Z)', 'redo');
  const outline = el('button', 'wt-btn');
  outline.type = 'button'; outline.title = 'Outline'; outline.innerHTML = icon('outline');
  outline.addEventListener('click', toggleOutline);
  groupEl('view').appendChild(outline);
  const focus = el('button', 'wt-btn');
  focus.type = 'button'; focus.title = 'Focus mode (⇧⌘F)'; focus.innerHTML = icon('focus');
  focus.addEventListener('click', () => setZen(!isZen()));
  groupEl('view').appendChild(focus);
  const help = el('button', 'wt-btn');
  help.type = 'button'; help.title = 'Keyboard shortcuts (⌘/)'; help.innerHTML = icon('help');
  help.addEventListener('click', openShortcutsDialog);
  groupEl('view').appendChild(help);
}

/** A button with a caret that opens a small swatch popover beside it. */
function buildSwatchButton(group, { title, iconName, text, items, onPick }) {
  const wrapEl = el('div', 'wt-swatchwrap');
  const main = el('button', 'wt-btn');
  main.type = 'button'; main.title = title;
  if (text) main.textContent = text; else main.innerHTML = icon(iconName);
  const caret = el('button', 'wt-caret', '▾');
  caret.type = 'button'; caret.title = title + ' options';
  const pop = el('div', 'wt-pop');
  pop.hidden = true;
  let lastHex = items[0] ? items[0].hex : '';
  items.forEach(item => {
    const s = el('button', 'wt-swatch');
    s.type = 'button'; s.title = item.label;
    if (item.hex) s.style.background = item.hex; else s.textContent = 'A';
    s.addEventListener('click', () => { lastHex = item.hex; onPick(item.hex); pop.hidden = true; afterEdit(); });
    pop.appendChild(s);
  });
  main.addEventListener('click', wrap(() => onPick(lastHex)));
  caret.addEventListener('click', (e) => { e.stopPropagation(); closeAllPops(pop); pop.hidden = !pop.hidden; });
  wrapEl.append(main, caret, pop);
  groupEl(group).appendChild(wrapEl);
  trackPop(pop);
  return wrapEl;
}

/** A button with a caret that opens a small text menu — used for table ops. */
function buildMenuButton(group, { title, iconName, items }) {
  const wrapEl = el('div', 'wt-swatchwrap');
  const caret = el('button', 'wt-btn wt-caret-solo');
  caret.type = 'button'; caret.title = title; caret.innerHTML = icon(iconName);
  const pop = el('div', 'wt-pop wt-pop-menu');
  pop.hidden = true;
  items.forEach(item => {
    const b = el('button', 'wt-menuitem', item.label);
    b.type = 'button';
    b.addEventListener('click', () => { item.run(); pop.hidden = true; afterEdit(); });
    pop.appendChild(b);
  });
  caret.addEventListener('click', (e) => { e.stopPropagation(); closeAllPops(pop); pop.hidden = !pop.hidden; });
  wrapEl.append(caret, pop);
  groupEl(group).appendChild(wrapEl);
  trackPop(pop);
  return wrapEl;
}

const openPops = [];
function closeAllPops(except) {
  openPops.forEach(p => { if (p !== except) p.hidden = true; });
}
document.addEventListener('click', () => closeAllPops(null));
function trackPop(pop) { openPops.push(pop); }

/* ---------- Link popover ---------- */

let linkBox = null;
function buildLinkBox() {
  linkBox = el('div', 'write-linkbox');
  linkBox.hidden = true;
  const input = el('input', 'input');
  input.type = 'url'; input.placeholder = 'https://…'; input.spellcheck = false;
  const apply = el('button', 'btn tiny primary', 'Apply');
  apply.type = 'button';
  const remove = el('button', 'btn tiny ghost', 'Remove');
  remove.type = 'button';
  apply.addEventListener('click', () => { cmds.insertLink(input.value.trim()); linkBox.hidden = true; afterEdit(); });
  remove.addEventListener('click', () => { cmds.removeLink(); linkBox.hidden = true; afterEdit(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); apply.click(); }
    if (e.key === 'Escape') { e.preventDefault(); linkBox.hidden = true; sheetEl.focus(); }
  });
  linkBox.addEventListener('mousedown', e => { if (e.target === linkBox) e.preventDefault(); });
  linkBox.append(input, apply, remove);
  document.body.appendChild(linkBox);
  return linkBox;
}
function openLinkBox() {
  const box = linkBox || buildLinkBox();
  const rect = anchorRect();
  box.hidden = false;
  const input = box.querySelector('input');
  const state = cmds.queryState();
  input.value = state.link || '';
  box.querySelector('.btn.ghost').hidden = !state.link;
  const top = Math.min(rect.bottom + 8, innerHeight - 60);
  const left = Math.max(8, Math.min(rect.left, innerWidth - 320));
  box.style.top = Math.round(top) + 'px';
  box.style.left = Math.round(left) + 'px';
  setTimeout(() => input.focus(), 10);
}
function anchorRect() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const rects = r.getClientRects();
    if (rects.length) return rects[rects.length - 1];
  }
  return sheetEl.getBoundingClientRect();
}

/* ---------- Toolbar state ---------- */

function syncToolbar() {
  const open = docId !== null;
  toolbarEl.querySelectorAll('button, select').forEach(b => { b.disabled = !open; });
  if (!open) return;
  const st = cmds.queryState();
  setPressed('bold', st.bold);
  setPressed('italic', st.italic);
  setPressed('underline', st.underline);
  setPressed('strike', st.strike);
  setPressed('bulletList', st.bullet);
  setPressed('numberList', st.number);
  setPressed('checklist', st.checklist);
  setPressed('alignLeft', st.align === 'left');
  setPressed('alignCenter', st.align === 'center');
  setPressed('alignRight', st.align === 'right');
  setPressed('alignJustify', st.align === 'justify');
  setPressed('h1', st.block === 'h1');
  setPressed('h2', st.block === 'h2');
  setPressed('h3', st.block === 'h3');
  setPressed('paragraph', st.block === 'p');
  setPressed('quote', st.block === 'quote');
  setPressed('codeBlock', st.block === 'code');
  setPressed('link', !!st.link);
  trackedActive.forEach(({ btn, isActive }) => btn.setAttribute('aria-pressed', String(!!isActive())));
}
function setPressed(name, val) {
  const b = stateButtons[name];
  if (b) b.setAttribute('aria-pressed', String(!!val));
}

/* ---------- Status bar ---------- */

function syncStatus() {
  const open = docId !== null;
  $('#writeToolbar').hidden = !open;
  $('#writeStatus').hidden = !open;
  if (!open) {
    ['writeWords', 'writeChars', 'writeReadTime', 'writeSaved'].forEach(id => { $('#' + id).textContent = ''; });
    return;
  }
  const text = (sheetEl.textContent || '').trim();
  const words = text ? text.split(/\s+/).length : 0;
  const mins = Math.max(1, Math.round(words / 200));
  $('#writeWords').textContent = plural(words, 'word', 'words');
  $('#writeChars').textContent = plural(text.length, 'character', 'characters');
  $('#writeReadTime').textContent = plural(mins, 'minute', 'minutes') + ' to read';
  $('#writeSaved').textContent = saved ? 'Saved' : 'Editing…';
  syncOutline();
}

/* ---------- Sheet wiring: autosave, slash trigger ---------- */

function wireSheet() {
  const actions = {
    bold: wrap(cmds.bold), italic: wrap(cmds.italic), underline: wrap(cmds.underline),
    strike: wrap(cmds.strike), inlineCode: wrap(cmds.inlineCode),
    highlight: wrap(() => cmds.highlight(WRITE_HIGHLIGHTS[0].hex)),
    link: () => openLinkBox(),
    h1: wrap(() => cmds.heading(1)), h2: wrap(() => cmds.heading(2)), h3: wrap(() => cmds.heading(3)),
    paragraph: wrap(cmds.paragraph),
    numberList: wrap(cmds.numberList), bulletList: wrap(cmds.bulletList), checklist: wrap(cmds.checklist),
    quote: wrap(cmds.quote), codeBlock: wrap(cmds.codeBlock),
    indent: wrap(cmds.indent), outdent: wrap(cmds.outdent),
    alignLeft: wrap(cmds.alignLeft), alignCenter: wrap(cmds.alignCenter),
    alignRight: wrap(cmds.alignRight), alignJustify: wrap(cmds.alignJustify),
    clearFormat: wrap(cmds.clearFormat),
    save: () => { flushWrite().then(() => toast('Saved.')); },
    undo: wrap(cmds.undo), redo: wrap(cmds.redo),
    shortcutSheet: openShortcutsDialog,
    focusMode: () => setZen(!isZen())
  };
  const dispatch = createWriteShortcuts(actions);

  sheetEl.addEventListener('keydown', (e) => {
    if (slashOpen && handleSlashKeydown(e)) return;
    const combo = comboOf(e);
    const extra = extraActions[combo];
    if (extra) {
      if (extra.preventDefault) e.preventDefault();
      extra.fn(e);
      return;
    }
    dispatch(e);
  });

  sheetEl.addEventListener('input', () => {
    afterEdit();
    checkSlashTrigger();
  });
  sheetEl.addEventListener('blur', () => setTimeout(closeSlash, 120));
}

/* A small local copy of shortcuts.js's keyCombo, so registerShortcut's map
   can be checked before the full keymap dispatch runs. */
function comboOf(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === ' ') key = 'space';
  parts.push(key);
  return parts.join('+');
}

/* ---------- Rail ---------- */

function wireRail() {
  $('#writeNew').addEventListener('click', createNewDoc);
  $('#writeEmptyNew').addEventListener('click', createNewDoc);
  $('#writeFilter').addEventListener('input', () => { filterText = $('#writeFilter').value; renderWriteDocs(); });
}

export function renderWriteDocs() {
  const empty = writedocs.length === 0;
  $('#writeEmpty').hidden = !empty;
  const q = filterText.trim().toLowerCase();
  const rows = $('#writeRows');
  rows.innerHTML = '';
  writeDocsByRecency()
    .filter(r => !q || r.name.toLowerCase().includes(q))
    .forEach(rec => rows.appendChild(writeRow(rec)));
}

function writeRow(rec) {
  const li = el('li', 'write-row' + (rec.id === docId ? ' active' : ''));
  const main = el('button', 'write-row-main');
  main.type = 'button';
  main.appendChild(el('span', 'write-row-name', rec.name));
  main.appendChild(el('span', 'write-row-meta', formatWhen(rec.updatedAt)));
  main.addEventListener('click', () => openWriteDoc(rec.id));
  li.appendChild(main);

  const acts = el('div', 'write-row-acts');
  const ren = el('button', 'btn tiny ghost', 'Rename');
  ren.type = 'button';
  ren.addEventListener('click', e => { e.stopPropagation(); startRename(li, rec); });
  const dup = el('button', 'btn tiny ghost', 'Duplicate');
  dup.type = 'button';
  dup.addEventListener('click', async e => {
    e.stopPropagation();
    const copy = await duplicateWriteDoc(rec.id);
    if (copy) openWriteDoc(copy.id);
  });
  const del = el('button', 'btn tiny ghost danger', 'Remove');
  del.type = 'button';
  del.addEventListener('click', async e => {
    e.stopPropagation();
    const was = rec.id === docId;
    if (await removeWriteDoc(rec.id) && was) {
      closeWriteDoc();
      const next = writeDocsByRecency()[0];
      if (next) openWriteDoc(next.id);
    }
  });
  acts.append(ren, dup, del);
  li.appendChild(acts);
  return li;
}

function startRename(li, rec) {
  const nameSpan = li.querySelector('.write-row-name');
  const input = el('input', 'write-row-rename');
  input.type = 'text';
  input.value = rec.name;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.value = rec.name; input.blur(); }
  });
  input.addEventListener('blur', () => renameWriteDoc(rec.id, input.value), { once: true });
}

/* ---------- Selection bubble ---------- */

let bubbleEl = null;
function wireBubble() {
  bubbleEl = $('#writeBubble');
  bubbleEl.addEventListener('mousedown', e => e.preventDefault());
  bubbleEl.addEventListener('pointerdown', e => e.preventDefault());

  const add = (title, iconName, run, text) => {
    const b = el('button', 'wt-btn');
    b.type = 'button'; b.title = title;
    if (text) b.textContent = text; else b.innerHTML = icon(iconName);
    b.addEventListener('click', () => { run(); afterEdit(); positionBubble(); });
    bubbleEl.appendChild(b);
  };
  add('Bold (⌘B)', 'bold', cmds.bold);
  add('Italic (⌘I)', 'italic', cmds.italic);
  add('Underline (⌘U)', 'underline', cmds.underline);
  add('Link (⌘K)', 'link', () => openLinkBox());
  add('Highlight (⇧⌘H)', null, () => cmds.highlight(WRITE_HIGHLIGHTS[0].hex), 'H');
  const clear = el('button', 'btn tiny ghost', 'Clear');
  clear.type = 'button';
  clear.addEventListener('click', () => { cmds.clearFormat(); afterEdit(); hideBubble(); });
  bubbleEl.appendChild(clear);

  let selTimer;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (document.body.dataset.view !== 'write' || docId === null) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideBubble(); return; }
      const range = sel.getRangeAt(0);
      if (!sheetEl.contains(range.commonAncestorContainer)) { hideBubble(); return; }
      if (!(sel.toString() || '').trim()) { hideBubble(); return; }
      positionBubble();
    }, 90);
  });
  addEventListener('resize', hideBubble);
  document.addEventListener('scroll', hideBubble, true);
}
function positionBubble() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideBubble(); return; }
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) { hideBubble(); return; }
  bubbleEl.hidden = false;
  const w = bubbleEl.offsetWidth || 220, h = bubbleEl.offsetHeight || 36;
  let top = rect.top - h - 8;
  if (top < 8) top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(innerWidth - w - 8, left));
  bubbleEl.style.top = Math.round(top) + 'px';
  bubbleEl.style.left = Math.round(left) + 'px';
}
function hideBubble() { if (bubbleEl) bubbleEl.hidden = true; }

/* ---------- Slash menu ---------- */

let slashOpen = false, slashActive = 0, slashNode = null;
function wireSlash() {
  const menu = $('#writeSlash');
  menu.addEventListener('mousedown', e => e.preventDefault());
}
function checkSlashTrigger() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) { closeSlash(); return; }
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) { closeSlash(); return; }
  let block = node.parentElement;
  while (block && block !== sheetEl && !/^(P|DIV|LI|H1|H2|H3)$/.test(block.tagName)) block = block.parentElement;
  if (!block || node !== block.firstChild) { closeSlash(); return; }
  const before = node.data.slice(0, range.startOffset);
  const m = /^\/(\w*)$/.exec(before);
  if (!m) { closeSlash(); return; }
  slashNode = node;
  openSlash(m[1], range);
}
function openSlash(query, range) {
  slashOpen = true;
  slashActive = 0;
  renderSlashList(query);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  const menu = $('#writeSlash');
  menu.hidden = false;
  menu.style.top = Math.round(rect.bottom + 6) + 'px';
  menu.style.left = Math.round(rect.left) + 'px';
}
function closeSlash() {
  slashOpen = false;
  $('#writeSlash').hidden = true;
}
function renderSlashList(query) {
  const menu = $('#writeSlash');
  menu.innerHTML = '';
  const q = (query || '').toLowerCase();
  const matches = slashItems.filter(it => !q || it.label.toLowerCase().includes(q) || it.key.includes(q));
  if (!matches.length) { closeSlash(); return; }
  if (slashActive >= matches.length) slashActive = matches.length - 1;
  matches.forEach((item, i) => {
    const row = el('div', 'write-slash-row' + (i === slashActive ? ' active' : ''));
    row.setAttribute('role', 'option');
    row.appendChild(el('span', 'write-slash-label', item.label));
    if (item.hint) row.appendChild(el('span', 'write-slash-hint', item.hint));
    row.addEventListener('click', () => chooseSlash(item));
    menu.appendChild(row);
  });
  menu.dataset.count = String(matches.length);
  menu._matches = matches;
}
function handleSlashKeydown(e) {
  const menu = $('#writeSlash');
  const matches = menu._matches || [];
  if (e.key === 'ArrowDown') { e.preventDefault(); slashActive = (slashActive + 1) % Math.max(1, matches.length); renderSlashList(currentSlashQuery()); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); slashActive = (slashActive - 1 + matches.length) % Math.max(1, matches.length); renderSlashList(currentSlashQuery()); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (matches[slashActive]) chooseSlash(matches[slashActive]); return true; }
  if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return true; }
  return false;
}
function currentSlashQuery() {
  if (!slashNode) return '';
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  const m = /^\/(\w*)$/.exec(slashNode.data.slice(0, range.startOffset));
  return m ? m[1] : '';
}
function chooseSlash(item) {
  if (slashNode) {
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    slashNode.data = slashNode.data.slice(range.startOffset);
    const r = document.createRange();
    r.setStart(slashNode, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  closeSlash();
  runSlashItem(item);
  afterEdit();
}
function runSlashItem(item) {
  if (item.run) { item.run(cmds); return; }
  const byKey = {
    h1: () => cmds.heading(1), h2: () => cmds.heading(2), h3: () => cmds.heading(3),
    paragraph: cmds.paragraph, bullet: cmds.bulletList, number: cmds.numberList,
    checklist: cmds.checklist, quote: cmds.quote, code: cmds.codeBlock,
    table: () => cmds.insertTable(3, 3), hr: cmds.hr,
    image: () => toast('Images aren’t ready yet.')
  };
  (byKey[item.key] || (() => {}))();
}

/* ---------- Outline panel ---------- */

function wireOutline() {
  $('#writeOutlineClose').addEventListener('click', () => { $('#writeOutline').hidden = true; });
}
function toggleOutline() {
  const panel = $('#writeOutline');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) syncOutline();
}
function syncOutline() {
  const panel = $('#writeOutline');
  if (panel.hidden || !sheetEl) return;
  const rows = $('#writeOutlineRows');
  rows.innerHTML = '';
  const heads = $$('h1,h2,h3', sheetEl);
  if (!heads.length) { rows.appendChild(el('li', 'write-outline-empty', 'No headings yet.')); return; }
  heads.forEach((h, i) => {
    if (!h.id) h.id = 'write-h-' + i + '-' + uid().slice(0, 6);
    const li = el('li', 'write-outline-row lvl-' + h.tagName.toLowerCase());
    const b = el('button', null, h.textContent || '(untitled heading)');
    b.type = 'button';
    b.addEventListener('click', () => h.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    li.appendChild(b);
    rows.appendChild(li);
  });
}

/* ---------- Shortcut cheat-sheet ---------- */

const WRITE_SHORTCUT_GROUPS = [
  ['Format text', [
    ['⌘B', 'Bold'], ['⌘I', 'Italic'], ['⌘U', 'Underline'], ['⇧⌘X', 'Strikethrough'],
    ['⌘E', 'Inline code'], ['⇧⌘H', 'Highlight'], ['⌘K', 'Link'], ['⌘\\', 'Clear formatting']
  ]],
  ['Blocks', [
    ['⌥1 / ⌥2 / ⌥3', 'Heading 1 / 2 / 3'], ['⌥0', 'Paragraph'],
    ['⇧⌘7', 'Numbered list'], ['⇧⌘8', 'Bulleted list'], ['⇧⌘9', 'Checklist'],
    ['⇧⌘.', 'Quote'], ['⌥C', 'Code block'], ['/', 'Slash menu, on an empty line']
  ]],
  ['Layout', [
    ['⌘] / ⌘[', 'Indent, outdent'],
    ['⇧⌘L / E / R / J', 'Align left, center, right, justify']
  ]],
  ['Document', [
    ['⌘F', 'Find'], ['⌘H', 'Replace'], ['⌘S', 'Save now'], ['⌘O', 'Open a file'],
    ['⇧⌘S', 'Download'], ['⌘P', 'Print'], ['⌘Z / ⇧⌘Z', 'Undo, redo'],
    ['⌘/', 'This list'], ['⇧⌘F', 'Focus mode']
  ]]
];
function wireShortcutsDialog() {
  $$('#writeShortcutsDlg [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
}
function openShortcutsDialog() {
  const body = $('#writeShortcutsBody');
  if (!body.childElementCount) {
    WRITE_SHORTCUT_GROUPS.forEach(([title, rows]) => {
      const section = el('div', 'keys-group');
      section.appendChild(el('h3', null, title));
      const list = el('dl');
      rows.forEach(([key, what]) => {
        list.appendChild(el('dt')).appendChild(el('kbd', null, key));
        list.appendChild(el('dd', null, what));
      });
      section.appendChild(list);
      body.appendChild(section);
    });
  }
  const dlg = $('#writeShortcutsDlg');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

/* ---------- Bus ---------- */

/* The bus fires on every autosave tick, wherever it was triggered from — the
   toolbar only exists once build() has run, which is only once the Write
   view has been opened at least once. */
on(EVENTS.WRITEDOCS, () => { renderWriteDocs(); if (ready) syncToolbar(); });
on(EVENTS.VIEW, name => {
  if (name === 'write') {
    build();
    if (docId === null) {
      const rec = writeDocsByRecency()[0];
      if (rec) { openWriteDoc(rec.id); return; }
    }
    renderWriteDocs();
    syncStatus();
    syncToolbar();
  } else if (docId !== null) flushWrite();
});
