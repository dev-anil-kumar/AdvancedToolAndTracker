/**
 * The Home view: recent documents, a preview of recent notes, the layout and
 * highlight settings, and the export controls.
 *
 * A view: it reads state and re-renders when the bus says something changed.
 * It never mutates state itself — that is what the feature modules are for.
 */
import { on, EVENTS } from '../core/bus.js';
import { PER_ROW_MAX, PER_ROW_MIN, RECENT_VISIBLE, HIGHLIGHTS } from '../core/config.js';
import { $, el } from '../core/dom.js';
import { formatBytes, formatWhen, kindLabel, plural } from '../core/format.js';
import {
  byRecency, documents, files, notes, pastedDocs, prefs,
  anyPaneFor, noteCountFor, savePrefs
} from '../core/state.js';
import { removeDoc } from '../features/library.js';
import { openDoc, layoutAll } from '../features/panes.js';
import { jumpToNote } from '../features/notes.js';
import { applyHighlight } from '../features/highlight.js';
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

  renderPerRow();
  renderSwatches();
  renderExport();
}

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
  name.appendChild(el('span', 'kind' + (open ? ' open' : ''), open ? 'Open' : kindLabel(rec)));
  const n = noteCountFor(rec.id);
  const sub = [];
  sub.push(formatWhen(rec.openedAt || rec.addedAt));
  if (rec.size) sub.push(formatBytes(rec.size));
  if (n) sub.push(plural(n, 'note', 'notes'));
  if (rec.kind === 'url') sub.push(rec.source);
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

/* Re-render whenever anything Home displays has changed. */
[EVENTS.LIBRARY, EVENTS.NOTES, EVENTS.PANES, EVENTS.PREFS].forEach(evt => on(evt, renderHome));
