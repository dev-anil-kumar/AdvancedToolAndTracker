/**
 * The Home view: recent documents, a preview of recent notes, the layout and
 * highlight settings, and the export controls.
 *
 * A view: it reads state and re-renders when the bus says something changed.
 * It never mutates state itself — that is what the feature modules are for.
 */
import { on, EVENTS } from '../core/bus.js';
import { PER_ROW_MAX, PER_ROW_MIN, RECENT_VISIBLE, HIGHLIGHTS, STORES } from '../core/config.js';
import { dbAll, dbClear, dbDel } from '../core/db.js';
import { refsIn } from '../features/note-images.js';
import { $, el } from '../core/dom.js';
import { formatBytes, formatWhen, kindLabel, plural } from '../core/format.js';
import {
  byRecency, documents, files, notes, pastedDocs, prefs, writedocs, writeDocsByRecency,
  anyPaneFor, noteCountFor, savePrefs
} from '../core/state.js';
import { describe, removeDoc } from '../features/library.js';
import { openDoc, layoutAll } from '../features/panes.js';
import { jumpToNote } from '../features/notes.js';
import { applyHighlight } from '../features/highlight.js';
import { addWriteDoc, removeWriteDoc } from '../features/writedocs.js';
import { openWriteDoc } from './write-view.js';
import {
  canPickDir, docItems, pasteItems, everythingItems,
  allNotesMarkdown, saveManyFiles, saveOneFile
} from '../features/exporter.js';

let showAllFiles = false;

/** Show more or fewer recent documents. Wired up by main.js. */
export function toggleShowAll() { showAllFiles = !showAllFiles; renderHome(); }

export function renderHome() {
  const ordered = byRecency();

  $('#secRecent').hidden = ordered.length === 0;
  $('#secStart').hidden = ordered.length > 0;
  $('#recentCount').textContent = ordered.length ? plural(ordered.length, 'document', 'documents') : '';

  const more = $('#showAllFiles');
  more.hidden = ordered.length <= RECENT_VISIBLE;
  more.textContent = showAllFiles ? 'Show fewer' : 'Show all ' + ordered.length;

  const rows = $('#recentRows');
  rows.innerHTML = '';
  (showAllFiles ? ordered : ordered.slice(0, RECENT_VISIBLE)).forEach(rec => rows.appendChild(fileRow(rec)));

  const preview = $('#notePreview');
  preview.innerHTML = '';
  $('#secNotes').hidden = notes.length === 0;
  $('#notesCount').textContent = notes.length ? plural(notes.length, 'note', 'notes') : '';
  notes.slice(0, 3).forEach(note => preview.appendChild(noteRow(note)));

  renderWritingSection();
  renderPerRow();
  renderSwatches();
  renderExport();
}

/* ---------- Writing (Write documents) ---------- */

function renderWritingSection() {
  $('#secWriting').hidden = writedocs.length === 0;
  $('#writingCount').textContent = writedocs.length ? plural(writedocs.length, 'document', 'documents') : '';
  const rows = $('#writeHomeRows');
  rows.innerHTML = '';
  writeDocsByRecency().slice(0, RECENT_VISIBLE).forEach(rec => rows.appendChild(writingRow(rec)));
}

function writingRow(rec) {
  const li = el('li', 'row-item');
  const main = el('button', 'row-main');
  main.type = 'button';
  const name = el('div', 'row-name');
  name.appendChild(el('span', 't', rec.name));
  name.appendChild(el('span', 'kind', 'Document'));
  main.append(name, el('div', 'row-sub', formatWhen(rec.updatedAt)));
  main.addEventListener('click', () => openWriteDoc(rec.id));

  const acts = el('div', 'row-act');
  const del = el('button', 'btn tiny ghost danger', 'Remove');
  del.type = 'button';
  del.title = 'Remove from library';
  del.addEventListener('click', e => { e.stopPropagation(); removeWriteDoc(rec.id); });
  acts.appendChild(del);

  li.append(main, acts);
  return li;
}

async function newWriteDoc() {
  const rec = await addWriteDoc({});
  openWriteDoc(rec.id);
}
$('#qWrite').addEventListener('click', newWriteDoc);
$('#newWriteLink').addEventListener('click', newWriteDoc);

function renderPerRow() {
  const seg = $('#perRowSeg');
  seg.innerHTML = '';
  for (let i = PER_ROW_MIN; i <= PER_ROW_MAX; i++) {
    const b = el('button', null, String(i));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(prefs.perRow === i));
    b.setAttribute('aria-label', i === 1 ? 'One document per row' : i + ' documents per row');
    b.addEventListener('click', () => {
      prefs.perRow = i;
      savePrefs();
      renderPerRow();
      layoutAll();
    });
    seg.appendChild(b);
  }
}

function fileRow(rec) {
  const li = el('li', 'row-item');
  const open = anyPaneFor(rec.id);

  const main = el('button', 'row-main');
  main.type = 'button';
  const name = el('div', 'row-name');
  name.appendChild(el('span', 't', rec.name));
  /* What it is, and separately whether it is open: a PDF is still a PDF while
     you are reading it, and that is the more useful of the two facts. */
  name.appendChild(el('span', 'kind', kindLabel(rec)));
  if (open) name.appendChild(el('span', 'kind open', 'Open'));
  const n = noteCountFor(rec.id);
  const sub = [];
  sub.push(formatWhen(rec.openedAt || rec.addedAt));
  /* A converted document is better described by what it came from than by the
     length of the Markdown it turned into. */
  if (rec.kind === 'pdf' || rec.kind === 'sheet') {
    sub.push(describe(rec));
    if (rec.sourceSize) sub.push(formatBytes(rec.sourceSize));
  } else if (rec.size) {
    sub.push(formatBytes(rec.size));
  }
  if (n) sub.push(plural(n, 'note', 'notes'));
  if (/^https?:/i.test(rec.source || '')) sub.push(rec.source);
  main.append(name, el('div', 'row-sub', sub.join(' · ')));
  main.addEventListener('click', () => openDoc(rec.id));

  const acts = el('div', 'row-act');
  const save = el('button', 'btn tiny ghost', 'Save');
  save.type = 'button';
  save.title = 'Save this document as a .md file';
  save.addEventListener('click', e => { e.stopPropagation(); saveOneFile(rec.name, rec.content); });
  acts.appendChild(save);

  const del = el('button', 'btn tiny ghost danger', 'Remove');
  del.type = 'button';
  del.title = 'Remove from library';
  del.addEventListener('click', e => { e.stopPropagation(); removeDoc(rec.id); });
  acts.appendChild(del);

  li.append(main, acts);
  return li;
}

function noteRow(note) {
  const li = el('li', 'row-item');
  const main = el('button', 'row-main');
  main.type = 'button';
  main.appendChild(el('div', 'row-quote', note.quote));
  const where = note.fileName + (note.headingText ? ' · ' + note.headingText : '');
  main.appendChild(el('div', 'row-sub', where + ' · ' + formatWhen(note.createdAt)));
  main.addEventListener('click', () => jumpToNote(note.id));
  li.appendChild(main);
  return li;
}

/* ---------- Highlight colour ---------- */

function renderSwatches() {
  const box = $('#hlSwatches');
  box.innerHTML = '';
  HIGHLIGHTS.forEach(h => {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(prefs.highlight === h.key));
    b.setAttribute('aria-label', h.label);
    b.title = h.label;
    b.style.background = h.hex;
    b.appendChild(el('span'));
    b.addEventListener('click', () => {
      prefs.highlight = h.key;
      applyHighlight();
      savePrefs();
      renderSwatches();
    });
    box.appendChild(b);
  });
}

/* ---------- Export controls ---------- */

function renderExport() {
  const docs = documents().length;
  const pasted = pastedDocs().length;
  $('#secExport').hidden = files.length === 0 && notes.length === 0;
  $('#exportCount').textContent = [
    files.length ? plural(files.length, 'document', 'documents') : '',
    notes.length ? plural(notes.length, 'note', 'notes') : ''
  ].filter(Boolean).join(' · ');
  $('#expDocs').textContent = 'Documents' + (docs ? ' (' + docs + ')' : '');
  $('#expPasted').textContent = 'Pasted' + (pasted ? ' (' + pasted + ')' : '');
  $('#expNotes').textContent = 'Notes' + (notes.length ? ' (' + notes.length + ')' : '');
  $('#expDocs').disabled = !docs;
  $('#expPasted').disabled = !pasted;
  $('#expNotes').disabled = !notes.length;
  $('#expAll').disabled = !files.length && !notes.length;
  $('#exportDesc').textContent = canPickDir
    ? 'Choose a folder and Folio writes each one into it as a .md file — documents and pasted text in their own subfolders. Individual documents and notes have a Save button of their own.'
    : 'This browser can’t choose a folder, so files land in your Downloads folder; a bulk export arrives as one combined Markdown file. Individual documents and notes have a Save button of their own.';
}

$('#expDocs').addEventListener('click', () => saveManyFiles(docItems(), 'folio-documents'));
$('#expPasted').addEventListener('click', () => saveManyFiles(pasteItems(), 'folio-pasted'));
$('#expNotes').addEventListener('click', () => saveOneFile('folio-notes.md', allNotesMarkdown()));
$('#expAll').addEventListener('click', () => saveManyFiles(everythingItems(), 'folio-everything'));

/* ---------- Clearing saved data ---------- */

/* Reload afterwards: every feature keeps its own in-memory copy, and a fresh
   start is the one reset that reaches all of them. */
$('#clearBtns').addEventListener('click', async e => {
  const b = e.target.closest('[data-clear]');
  if (!b) return;
  const all = b.dataset.clear === 'all';
  const what = all ? 'ALL saved data (documents, notes, drawings, settings…)' : 'all saved ' + b.textContent;
  if (!confirm('Delete ' + what + ' from this browser? This cannot be undone.')) return;
  for (const store of all ? STORES : b.dataset.clear.split(',')) await dbClear(store);
  await sweepOrphans();
  location.reload();
});

/** Drop what pointed at cleared data: a document's highlights, and images no note uses. */
async function sweepOrphans() {
  const fileIds = new Set((await dbAll('files')).map(f => f.id));
  const notes = await dbAll('notes');
  const kept = notes.filter(n => !n.fileId || fileIds.has(n.fileId));
  for (const n of notes) if (!kept.includes(n)) await dbDel('notes', n.id);
  const used = new Set(kept.flatMap(n => refsIn(n.body)));
  for (const im of await dbAll('images')) if (!used.has(im.id)) await dbDel('images', im.id);
}

/* Re-render whenever anything Home displays has changed. */
[EVENTS.LIBRARY, EVENTS.NOTES, EVENTS.PANES, EVENTS.PREFS, EVENTS.WRITEDOCS].forEach(evt => on(evt, renderHome));
