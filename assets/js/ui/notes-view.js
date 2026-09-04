/**
 * The Notes view: every saved note, clamped until expanded.
 *
 * Notes you wrote yourself come first, in their own group — they belong to no
 * document, so they have nowhere else to sit and are the ones most likely to
 * be wanted again. The rest are grouped by the document they came from.
 *
 * A written note's body is Markdown and goes through the same renderer as a
 * document, with its image references resolved on the way in.
 */
import { on, EVENTS } from '../core/bus.js';
import { NOTE_CLAMP_CHARS, NOTE_CLAMP_LINES } from '../core/config.js';
import { $, cssEscape, el, prefers } from '../core/dom.js';
import { formatBytes, formatWhen, plural } from '../core/format.js';
import { fileById, filedNotes, notes, ownNotes } from '../core/state.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { deleteNote, isOwnNote, jumpToNote } from '../features/notes.js';
import { refsIn, resolve, weightOf } from '../features/note-images.js';
import { noteMarkdown, allNotesMarkdown, saveOneFile } from '../features/exporter.js';
import { openDoc } from '../features/panes.js';
import { renderMarkdown } from '../md/renderer.js';
import { openNoteEditor } from './note-editor.js';

let expandAllOn = false;

function needsExpand(note) {
  if (isOwnNote(note)) {
    const body = note.body || '';
    return body.length > NOTE_CLAMP_CHARS || body.split('\n').length > NOTE_CLAMP_LINES ||
      refsIn(body).length > 0;
  }
  const quote = note.quote || '';
  return quote.length > NOTE_CLAMP_CHARS || quote.split('\n').length > NOTE_CLAMP_LINES;
}

export function renderNotes() {
  const body = $('#notesBody');
  body.innerHTML = '';
  $('#notesEmpty').hidden = notes.length > 0;
  $('#expandAll').hidden = notes.length === 0;
  $('#saveAllNotes').hidden = notes.length === 0;

  const groups = new Map();
  filedNotes().forEach(n => {
    if (!groups.has(n.fileId)) groups.set(n.fileId, []);
    groups.get(n.fileId).push(n);
  });

  const own = ownNotes();
  $('#notesTotal').textContent = notes.length
    ? plural(notes.length, 'note', 'notes') +
      (groups.size ? ' across ' + plural(groups.size, 'document', 'documents') : '') +
      (own.length && groups.size ? ' · ' + own.length + ' of your own' : '')
    : '';

  if (own.length) body.appendChild(ownGroup(own));

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

/** Notes of your own: one group, newest first, with nothing to jump back to. */
function ownGroup(list) {
  const section = el('section', 'ngroup own');
  const head = el('h2', 'ngroup-head');
  head.append(
    el('span', 'fname plain', 'Notes of your own'),
    el('span', 'fmeta', plural(list.length, 'note', 'notes'))
  );
  const add = el('button', 'link', 'Write another');
  add.type = 'button';
  add.addEventListener('click', () => openNoteEditor());
  head.appendChild(add);
  section.appendChild(head);

  const ul = el('ul', 'rows');
  list.slice()
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .forEach(note => ul.appendChild(noteCard(note, false)));
  section.appendChild(ul);
  return section;
}

function noteCard(note, docExists) {
  const own = isOwnNote(note);
  const li = el('li', 'note' + (own ? ' mine' : ''));
  li.dataset.id = note.id;
  if (expandAllOn) li.classList.add('expanded');

  if (own) {
    li.appendChild(el('h3', 'note-title', note.title || 'Untitled note'));
    const article = el('div', 'note-body md');
    /* Same pipeline as a document — marked, then DOMPurify — with the image
       references swapped for the pictures they stand for. */
    renderMarkdown(article, resolve(note.body || ''));
    li.appendChild(article);
  } else {
    li.appendChild(el('div', 'note-quote', note.quote));
  }

  const meta = el('div', 'note-meta');
  if (own) {
    const pictures = refsIn(note.body).length;
    const said = [formatWhen(note.updatedAt || note.createdAt)];
    if (pictures) said.push(plural(pictures, 'image', 'images') + ' · ' + formatBytes(weightOf(note.body)));
    meta.append(el('span', 'where plain', 'Written here'), el('span', 'dot', '·'),
      el('span', null, said.join(' · ')));
  } else {
    const jump = el('button', 'link where', note.headingText ? 'Open at “' + note.headingText + '”' : 'Open in the document');
    jump.type = 'button';
    jump.disabled = !docExists;
    jump.addEventListener('click', () => jumpToNote(note.id));
    meta.append(jump, el('span', 'dot', '·'), el('span', null, formatWhen(note.createdAt)));
  }

  const acts = el('div', 'note-acts');
  if (own) {
    const edit = el('button', 'btn tiny ghost', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => openNoteEditor(note.id));
    acts.appendChild(edit);
  }
  if (needsExpand(note)) {
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
  save.addEventListener('click', () => saveOneFile(
    own ? 'note — ' + (note.title || 'untitled') : 'note — ' + (note.headingText || note.fileName),
    noteMarkdown(note)));
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
$('#newNote').addEventListener('click', () => openNoteEditor());
$('#emptyNewNote').addEventListener('click', () => openNoteEditor());

/* On the Notes page, "n" writes one — as long as nothing else is listening. */
document.addEventListener('keydown', e => {
  if (document.body.dataset.view !== 'notes') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey || $('dialog[open]')) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openNoteEditor(); }
});
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
