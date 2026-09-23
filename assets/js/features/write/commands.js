/**
 * The formatting command layer for the Write sheet.
 *
 * A thin wrapper over `document.execCommand` for the handful of things
 * browsers still do reliably with it (bold, lists, alignment, undo/redo,
 * block type…), and small Range-based helpers for the rest (inline code,
 * highlight, text colour, font family/size) — execCommand's own versions of
 * those are inconsistent enough across browsers that wrapping the selection
 * ourselves is the more dependable route. Nothing here depends on a UI: this
 * module only ever touches the sheet it was bound to and the window
 * selection, so ui/write-view.js can call it and re-render its toolbar from
 * `queryState()` without either side knowing much about the other.
 */
import { uid } from '../../core/dom.js';

let sheet = null;

/** Called once by ui/write-view.js when the sheet element is built. */
export function bindSheet(el) { sheet = el; }

function focusSheet() {
  if (sheet && document.activeElement !== sheet) sheet.focus();
}

function exec(name, value) {
  focusSheet();
  try { document.execCommand(name, false, value); } catch (err) { /* unsupported in this browser */ }
}

/** The selection, but only when it actually lives inside the sheet. */
function sheetRange() {
  const sel = window.getSelection();
  if (!sheet || !sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!sheet.contains(range.commonAncestorContainer)) return null;
  return range;
}

/**
 * Wrap the current selection in an element `makeWrapper()` builds. Used for
 * everything execCommand does not have a dependable command for. A
 * collapsed selection has nothing to wrap, so it is left alone rather than
 * wrapping an empty element no one could then type into sensibly.
 */
function wrapSelection(makeWrapper) {
  const range = sheetRange();
  if (!range || range.collapsed) return false;
  const wrapper = makeWrapper();
  try {
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  } catch (err) {
    return false;
  }
  const sel = window.getSelection();
  const again = document.createRange();
  again.selectNodeContents(wrapper);
  sel.removeAllRanges();
  sel.addRange(again);
  return true;
}

/** The block element the caret sits in, stopping at the sheet's own edge. */
function currentBlock() {
  const range = sheetRange();
  if (!range) return null;
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== sheet && !/^(P|H1|H2|H3|H4|BLOCKQUOTE|PRE|LI|DIV)$/.test(node.tagName || '')) {
    node = node.parentElement;
  }
  return node === sheet ? null : node;
}

/* ---------- Inline ---------- */
export const bold = () => exec('bold');
export const italic = () => exec('italic');
export const underline = () => exec('underline');
export const strike = () => exec('strikeThrough');
export const clearFormat = () => exec('removeFormat');
export const undo = () => exec('undo');
export const redo = () => exec('redo');

export const inlineCode = () => wrapSelection(() => document.createElement('code'));

export function highlight(hex) {
  return wrapSelection(() => {
    const mark = document.createElement('mark');
    mark.className = 'w-hl';
    mark.style.background = hex || '#f5d24a';
    return mark;
  });
}

export function textColor(hex) {
  if (!hex) return wrapSelection(() => document.createElement('span'));
  return wrapSelection(() => {
    const span = document.createElement('span');
    span.style.color = hex;
    return span;
  });
}

export function fontFamily(stack) {
  return wrapSelection(() => {
    const span = document.createElement('span');
    span.style.fontFamily = stack;
    return span;
  });
}

export function fontSize(px) {
  return wrapSelection(() => {
    const span = document.createElement('span');
    span.style.fontSize = px + 'px';
    return span;
  });
}

/* ---------- Blocks ---------- */
export const heading = (level) => exec('formatBlock', 'H' + level);
export const paragraph = () => exec('formatBlock', 'P');
export const quote = () => exec('formatBlock', 'BLOCKQUOTE');
export const codeBlock = () => {
  exec('formatBlock', 'PRE');
  const block = currentBlock();
  if (block && block.tagName === 'PRE' && !block.querySelector('code')) {
    const code = document.createElement('code');
    code.append(...block.childNodes);
    block.appendChild(code);
  }
};

export const bulletList = () => exec('insertUnorderedList');
export const numberList = () => exec('insertOrderedList');

/** A bulleted list whose items carry a real, clickable checkbox. */
export function checklist() {
  exec('insertUnorderedList');
  const block = currentBlock();
  const list = block && (block.tagName === 'LI' ? block.closest('ul') : block.querySelector('ul'));
  const ul = list || (sheet && sheet.querySelector('ul:not(.write-checklist)'));
  if (!ul) return;
  ul.classList.add('write-checklist');
  ul.querySelectorAll(':scope > li').forEach(li => {
    if (li.querySelector(':scope > input[type=checkbox]')) return;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.contentEditable = 'false';
    li.insertBefore(box, li.firstChild);
  });
}

export const indent = () => exec('indent');
export const outdent = () => exec('outdent');
export const alignLeft = () => exec('justifyLeft');
export const alignCenter = () => exec('justifyCenter');
export const alignRight = () => exec('justifyRight');
export const alignJustify = () => exec('justifyFull');
export const hr = () => exec('insertHorizontalRule');

/* ---------- Links ---------- */
export function insertLink(url) {
  if (!url) return;
  const href = /^[a-z][\w+.-]*:/i.test(url) ? url : 'https://' + url;
  const range = sheetRange();
  if (range && range.collapsed) {
    focusSheet();
    const a = document.createElement('a');
    a.href = href;
    a.textContent = url;
    range.insertNode(a);
    range.setStartAfter(a);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  exec('createLink', href);
}
export const removeLink = () => exec('unlink');

/* ---------- Tables ---------- */
export function insertTable(rows = 3, cols = 3) {
  focusSheet();
  const table = document.createElement('table');
  table.className = 'write-table';
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) tr.appendChild(document.createElement('td')).innerHTML = '<br>';
    table.appendChild(tr);
  }
  const range = sheetRange();
  if (!range) { sheet.appendChild(table); return table; }
  range.collapse(false);
  range.insertNode(table);
  return table;
}

function tableOf(node) {
  let el = node || currentBlock();
  if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
  return el ? el.closest('table.write-table, table') : null;
}
function cellOf() {
  const range = sheetRange();
  if (!range) return null;
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return node ? node.closest('td,th') : null;
}

export function addRow() {
  const cell = cellOf(), table = tableOf(cell);
  if (!table) return;
  const row = cell ? cell.closest('tr') : table.rows[table.rows.length - 1];
  const cols = row ? row.children.length : 1;
  const tr = document.createElement('tr');
  for (let c = 0; c < cols; c++) tr.appendChild(document.createElement('td')).innerHTML = '<br>';
  row ? row.after(tr) : table.appendChild(tr);
}
export function removeRow() {
  const cell = cellOf(), table = tableOf(cell);
  if (!table || table.rows.length <= 1) return;
  const row = cell ? cell.closest('tr') : table.rows[table.rows.length - 1];
  if (row) row.remove();
}
export function addCol() {
  const cell = cellOf(), table = tableOf(cell);
  if (!table) return;
  const at = cell ? [...cell.parentElement.children].indexOf(cell) : -1;
  [...table.rows].forEach(row => {
    const td = document.createElement('td');
    td.innerHTML = '<br>';
    at >= 0 && row.children[at] ? row.children[at].after(td) : row.appendChild(td);
  });
}
export function removeCol() {
  const cell = cellOf(), table = tableOf(cell);
  if (!table || table.rows[0].children.length <= 1) return;
  const at = cell ? [...cell.parentElement.children].indexOf(cell) : table.rows[0].children.length - 1;
  [...table.rows].forEach(row => { if (row.children[at]) row.children[at].remove(); });
}

/* ---------- Reading the state back out, for the toolbar ---------- */

export function queryState() {
  const state = {
    bold: false, italic: false, underline: false, strike: false,
    bullet: false, number: false, checklist: false,
    align: 'left', block: 'p', link: null, table: false
  };
  try {
    state.bold = document.queryCommandState('bold');
    state.italic = document.queryCommandState('italic');
    state.underline = document.queryCommandState('underline');
    state.strike = document.queryCommandState('strikeThrough');
    state.bullet = document.queryCommandState('insertUnorderedList');
    state.number = document.queryCommandState('insertOrderedList');
    if (document.queryCommandState('justifyCenter')) state.align = 'center';
    else if (document.queryCommandState('justifyRight')) state.align = 'right';
    else if (document.queryCommandState('justifyFull')) state.align = 'justify';
  } catch (err) { /* queryCommandState can throw on an unfocused document */ }
  const block = currentBlock();
  if (block) {
    const tag = block.tagName;
    if (/^H[1-3]$/.test(tag)) state.block = tag.toLowerCase();
    else if (tag === 'BLOCKQUOTE') state.block = 'quote';
    else if (tag === 'PRE') state.block = 'code';
    else state.block = 'p';
    const ul = tag === 'LI' ? block.closest('ul') : null;
    if (ul && ul.classList.contains('write-checklist')) state.checklist = true;
    state.table = !!tableOf(block);
  }
  const range = sheetRange();
  if (range) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const a = node ? node.closest('a[href]') : null;
    if (a && sheet && sheet.contains(a)) state.link = a.href;
  }
  return state;
}

/** A unique id for whatever needs one while building sheet content. */
export const newId = uid;
