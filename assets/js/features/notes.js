/**
 * Notes. There are two kinds, and they are kept in one list.
 *
 * A *passage* note comes from a selection: it records the quote, the document,
 * the index of the top-level block it started in, and the nearest heading.
 * Jumping back prefers the block index, falls back to the heading, and
 * highlights the quote itself when it can be found inside a single text node.
 *
 * A note *of your own* is written here rather than taken from anything, so it
 * has a title and a Markdown body — with images, which live in their own store
 * (see note-images.js). It belongs to no document and has nowhere to jump to.
 *
 * `kind` tells them apart. Notes saved before there were two kinds have no
 * `kind` at all, which reads as a passage note — so nothing has to be migrated.
 */
import { emit, EVENTS } from '../core/bus.js';
import { NOTE_BODY_MAX, NOTE_QUOTE_MAX } from '../core/config.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { $, cssEscape, el, uid } from '../core/dom.js';
import { route } from '../core/router.js';
import { anyPaneFor, fileById, noteById, notes, setNotes } from '../core/state.js';
import { toast } from '../core/toast.js';
import { pruneImages, refsIn } from './note-images.js';
import { openDoc, scrollPaneTo, syncPaneHead } from './panes.js';

export const isOwnNote = (note) => !!note && note.kind === 'manual';

export function selectionInfo() {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const text = sel.toString().replace(/\s+$/, '');
  if (!text.trim()) return null;

  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  if (!startEl || !startEl.closest) return null;
  const article = startEl.closest('.pane-body .md');
  if (!article) return null;
  const paneEl = article.closest('.pane');
  if (!paneEl) return null;

  let block = startEl;
  while (block && block.parentElement !== article) block = block.parentElement;

  let heading = null;
  for (let n = block; n; n = n.previousElementSibling) {
    if (/^H[1-6]$/.test(n.tagName)) { heading = n; break; }
  }

  return {
    text, range, article, paneEl, block, heading,
    fileId: paneEl.dataset.fileId,
    paneKey: paneEl.dataset.key
  };
}

function headingLabel(heading) {
  if (!heading) return '';
  return (heading.textContent || '').replace(/^#/, '').trim().slice(0, 90);
}

const selpop = $('#selpop');
/* mousedown anywhere normally collapses the selection — keep ours alive. */
selpop.addEventListener('mousedown', e => e.preventDefault());
selpop.addEventListener('pointerdown', e => e.preventDefault());
function positionSelPop(range) {
  const rects = range.getClientRects();
  const rect = (rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect());
  if (!rect || (!rect.width && !rect.height)) { hideSelPop(); return; }
  selpop.hidden = false;
  const w = selpop.offsetWidth || 168, h = selpop.offsetHeight || 34;
  let top = rect.top - h - 8;
  if (top < 8) top = Math.min(rect.bottom + 8, innerHeight - h - 8);
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(8, Math.min(innerWidth - w - 8, left));
  selpop.style.top = Math.round(top) + 'px';
  selpop.style.left = Math.round(left) + 'px';
}
export function hideSelPop() { selpop.hidden = true; }

let selTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const info = selectionInfo();
    if (!info) { hideSelPop(); return; }
    positionSelPop(info.range);
  }, 90);
});
addEventListener('resize', hideSelPop);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideSelPop();
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing || $('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); saveSelectionAsNote(); }
});
/* Capture-phase: catches every pane body, in any reading tab, floating or docked. */
document.addEventListener('scroll', hideSelPop, true);

$('#selCopy').addEventListener('click', async () => {
  const info = selectionInfo();
  if (!info) return;
  try { await navigator.clipboard.writeText(info.text); toast('Copied.'); }
  catch (e) { toast('Your browser blocked the clipboard.'); }
  hideSelPop();
});
$('#selNote').addEventListener('click', saveSelectionAsNote);

export async function saveSelectionAsNote() {
  const info = selectionInfo();
  if (!info) { toast('Select some text in a document first.'); return; }
  const rec = fileById(info.fileId);
  if (!rec) { toast('That document is no longer in your library.'); return; }

  const note = {
    id: uid(),
    fileId: rec.id,
    fileName: rec.name,
    quote: info.text.slice(0, NOTE_QUOTE_MAX),
    blockIndex: info.block ? Number(info.block.getAttribute('data-b')) : null,
    headingId: info.heading ? info.heading.id : '',
    headingText: headingLabel(info.heading),
    createdAt: Date.now()
  };
  setNotes([note].concat(notes));
  await persist(dbPut('notes', note));

  hideSelPop();
  const sel = getSelection();
  if (sel) sel.removeAllRanges();
  syncPaneHead(rec.id);
  emit(EVENTS.NOTES);
  toast('Note saved.', { label: 'View notes', run: () => route('notes') });
}

/* ---------- Notes you write yourself ---------- */

/** The first line of the body, for a note saved without a title. */
export function deriveNoteTitle(body) {
  const line = String(body || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  return line.replace(/^#{1,6}\s*/, '').replace(/[*_`>[\]]/g, '').trim().slice(0, 90) || 'Untitled note';
}

/**
 * Save a note of your own. With an `id` it replaces that note, so the editor
 * uses one call for both writing and rewriting.
 */
export async function saveOwnNote(input) {
  const body = String(input.body == null ? '' : input.body).slice(0, NOTE_BODY_MAX);
  const title = String(input.title || '').trim().slice(0, 120) || deriveNoteTitle(body);
  const existing = input.id ? noteById(input.id) : null;
  const now = Date.now();

  const note = {
    id: existing ? existing.id : uid(),
    kind: 'manual',
    title,
    body,
    fileId: null,
    fileName: '',
    quote: '',
    blockIndex: null,
    headingId: '',
    headingText: '',
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };

  if (existing) setNotes(notes.map(n => (n.id === note.id ? note : n)));
  else setNotes([note].concat(notes));
  await persist(dbPut('notes', note));
  /* Pictures the editor added and then took out again have no owner now. */
  await pruneImages(refsIn(body));
  emit(EVENTS.NOTES);
  toast(existing ? 'Note updated.' : 'Note saved.', { label: 'View notes', run: () => route('notes') });
  return note;
}

export async function deleteNote(id) {
  const note = notes.find(n => n.id === id);
  if (!note) return;
  if (isOwnNote(note) && !confirm('Delete “' + note.title + '”? This cannot be undone.')) return;
  setNotes(notes.filter(n => n.id !== id));
  await persist(dbDel('notes', id));
  if (note.fileId) syncPaneHead(note.fileId);
  if (isOwnNote(note)) await pruneImages();
  emit(EVENTS.NOTES);
  toast('Note deleted.');
}

/* ---------- Jump from a note back to its place in the document ---------- */
export function jumpToNote(id) {
  const note = notes.find(n => n.id === id);
  if (!note || isOwnNote(note)) return;
  const existing = anyPaneFor(note.fileId);
  const pane = openDoc(note.fileId, existing ? existing.wsId : null);
  if (!pane) return;
  requestAnimationFrame(() => revealNote(pane, note));
}

function revealNote(pane, note) {
  const article = $('.md', pane.el), body = $('.pane-body', pane.el);
  if (!article || !body) return;

  article.querySelectorAll('mark.note-hit').forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });

  let target = null;
  if (note.blockIndex != null && !isNaN(note.blockIndex)) target = article.querySelector('[data-b="' + note.blockIndex + '"]');
  if (!target && note.headingId) target = article.querySelector('#' + cssEscape(note.headingId));
  if (!target) {
    toast('Couldn’t find that passage — the document has changed since the note was made.');
    return;
  }

  const mark = highlightQuote(target, note.quote);
  scrollPaneTo(body, mark || target, 24);
  if (!mark) {
    target.classList.remove('note-flash');
    void target.offsetWidth;
    target.classList.add('note-flash');
    setTimeout(() => target.classList.remove('note-flash'), 2200);
  }
}

/* Highlight the quoted words when they sit inside a single text node; otherwise
   the caller flashes the whole block, which always works. */
function highlightQuote(block, quote) {
  const needle = String(quote || '').trim().split('\n')[0].slice(0, 140);
  if (needle.length < 4) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const i = node.nodeValue.indexOf(needle);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + needle.length);
    const mark = el('mark', 'note-hit');
    try { range.surroundContents(mark); return mark; } catch (err) { return null; }
  }
  return null;
}
