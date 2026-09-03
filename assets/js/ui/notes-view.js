/**
 * The Notes view: every saved note, grouped by document, clamped to four
 * lines until expanded. Clicking one reopens its document at that passage.
 */
import { on, EVENTS } from '../core/bus.js';
import { NOTE_CLAMP_CHARS, NOTE_CLAMP_LINES } from '../core/config.js';
import { $, cssEscape, el, prefers } from '../core/dom.js';
import { formatWhen, plural } from '../core/format.js';
import { fileById, notes } from '../core/state.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { deleteNote, jumpToNote } from '../features/notes.js';
import { noteMarkdown, allNotesMarkdown, saveOneFile } from '../features/exporter.js';
import { openDoc } from '../features/panes.js';

let expandAllOn = false;

function needsExpand(quote) {
  return quote.length > NOTE_CLAMP_CHARS || quote.split('\n').length > NOTE_CLAMP_LINES;
}

export function renderNotes() {
  const body = $('#notesBody');
  body.innerHTML = '';
  $('#notesEmpty').hidden = notes.length > 0;
  $('#expandAll').hidden = notes.length === 0;
  $('#saveAllNotes').hidden = notes.length === 0;

  const groups = new Map();
  notes.forEach(n => {
    if (!groups.has(n.fileId)) groups.set(n.fileId, []);
    groups.get(n.fileId).push(n);
  });

  $('#notesTotal').textContent = notes.length
    ? plural(notes.length, 'note', 'notes') + ' across ' + plural(groups.size, 'document', 'documents')
    : '';

  /* Groups newest-first; notes inside a group in document order. */
  const ordered = [...groups.entries()].sort((a, b) => {
    const newest = list => Math.max.apply(null, list.map(n => n.createdAt || 0));
    return newest(b[1]) - newest(a[1]);
  });

  ordered.forEach(([fileId, list]) => {
    list.sort((a, b) => {
      const ai = a.blockIndex == null ? 1e9 : a.blockIndex;
      const bi = b.blockIndex == null ? 1e9 : b.blockIndex;
      return ai - bi || (a.createdAt || 0) - (b.createdAt || 0);
    });

    const rec = fileById(fileId);
    const section = el('section', 'ngroup');
    section.dataset.fileId = fileId;

    const head = el('h2', 'ngroup-head');
    const fname = el('button', 'fname', (rec && rec.name) || list[0].fileName);
    fname.type = 'button';
    fname.title = rec ? 'Open this document' : 'This document is no longer in your library';
    fname.addEventListener('click', () => { if (rec) openDoc(fileId); else toast('That document was removed from your library.'); });
    head.append(fname, el('span', 'fmeta', plural(list.length, 'note', 'notes')));
    section.appendChild(head);

    const ul = el('ul', 'rows');
    list.forEach(note => ul.appendChild(noteCard(note, !!rec)));
    section.appendChild(ul);
    body.appendChild(section);
  });
}

function noteCard(note, docExists) {
  const li = el('li', 'note');
  li.dataset.id = note.id;
  if (expandAllOn) li.classList.add('expanded');

  li.appendChild(el('div', 'note-quote', note.quote));

  const meta = el('div', 'note-meta');
  const jump = el('button', 'link where', note.headingText ? 'Open at “' + note.headingText + '”' : 'Open in the document');
  jump.type = 'button';
  jump.disabled = !docExists;
  jump.addEventListener('click', () => jumpToNote(note.id));
  meta.append(jump, el('span', 'dot', '·'), el('span', null, formatWhen(note.createdAt)));

  const acts = el('div', 'note-acts');
  if (needsExpand(note.quote)) {
    const ex = el('button', 'btn tiny ghost', expandAllOn ? 'Collapse' : 'Expand');
    ex.type = 'button';
    ex.setAttribute('aria-expanded', String(expandAllOn));
    ex.addEventListener('click', () => {
      const open = li.classList.toggle('expanded');
      ex.textContent = open ? 'Collapse' : 'Expand';
      ex.setAttribute('aria-expanded', String(open));
    });
    acts.appendChild(ex);
  }
  const save = el('button', 'btn tiny ghost', 'Save');
  save.type = 'button';
  save.title = 'Save this note as a .md file';
  save.addEventListener('click', () => saveOneFile('note — ' + (note.headingText || note.fileName), noteMarkdown(note)));
  acts.appendChild(save);

  const del = el('button', 'btn tiny ghost danger', 'Delete');
  del.type = 'button';
  del.addEventListener('click', () => deleteNote(note.id));
  acts.appendChild(del);

  meta.appendChild(acts);
  li.appendChild(meta);
  return li;
}

function scrollToNoteGroup(fileId) {
  const section = $('.ngroup[data-file-id="' + cssEscape(fileId) + '"]');
  if (section) section.scrollIntoView({ block: 'start', behavior: prefers('(prefers-reduced-motion: reduce)') ? 'auto' : 'smooth' });
}

$('#saveAllNotes').addEventListener('click', () => saveOneFile('folio-notes.md', allNotesMarkdown()));
$('#expandAll').addEventListener('click', () => {
  expandAllOn = !expandAllOn;
  $('#expandAll').textContent = expandAllOn ? 'Collapse all' : 'Expand all';
  $('#expandAll').setAttribute('aria-pressed', String(expandAllOn));
  renderNotes();
});

on(EVENTS.NOTES, renderNotes);
on(EVENTS.VIEW, name => { if (name === 'notes') renderNotes(); });

/* A pane's "n notes" button asks for that document's group. */
on(EVENTS.REVEAL_FILE, fileId => { route('notes'); renderNotes(); scrollToNoteGroup(fileId); });
