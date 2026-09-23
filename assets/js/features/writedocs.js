/**
 * The Write library: adding, editing, renaming, duplicating, removing.
 *
 * Mirrors features/jsondocs.js and features/drawings.js — everything that
 * changes `writedocs` happens here, and every change is announced on the bus.
 * A record stores rendered HTML (what `contenteditable` produces), plus the
 * page style and font it was written in, so reopening it looks exactly like
 * it was left:
 *
 *   { id, name, html, page: { style, tint, width }, font,
 *     source, originalName, originalType, originalBlobOrText,
 *     createdAt, updatedAt }
 *
 * `source`/`originalName`/`originalType`/`originalBlobOrText` are set by
 * features/write/io.js when a document was opened from a file, so "Download
 * original" has something to hand back — this module only carries them
 * through untouched.
 */
import { emit, EVENTS } from '../core/bus.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { uid } from '../core/dom.js';
import { writeDocById, writedocs, setWriteDocs } from '../core/state.js';

const DEFAULT_PAGE = { style: 'blank', tint: 'white', width: 'normal' };

/** A fresh, empty page. */
export async function addWriteDoc(input) {
  const opts = input || {};
  const now = Date.now();
  const rec = {
    id: uid(),
    name: (opts.name || 'Untitled document').trim().slice(0, 120) || 'Untitled document',
    html: opts.html || '',
    page: { ...DEFAULT_PAGE, ...(opts.page || {}) },
    font: opts.font || 'sans',
    source: opts.source || '',
    originalName: opts.originalName || '',
    originalType: opts.originalType || '',
    originalBlobOrText: opts.originalBlobOrText || null,
    createdAt: now,
    updatedAt: now
  };
  setWriteDocs(writedocs.concat([rec]));
  await persist(dbPut('writedocs', rec));
  emit(EVENTS.WRITEDOCS);
  return rec;
}

/**
 * Save edited content. Quiet: this runs on a debounce while someone is
 * typing, so it never toasts and never re-renders the rail on its own — the
 * caller decides when that is worth doing.
 */
export async function updateWriteDoc(id, patch) {
  const rec = writeDocById(id);
  if (!rec) return null;
  if (patch.html !== undefined) rec.html = String(patch.html == null ? '' : patch.html);
  if (patch.page) rec.page = { ...rec.page, ...patch.page };
  if (patch.font) rec.font = patch.font;
  rec.updatedAt = Date.now();
  await persist(dbPut('writedocs', rec));
  emit(EVENTS.WRITEDOCS);
  return rec;
}

export async function renameWriteDoc(id, name) {
  const rec = writeDocById(id);
  if (!rec) return null;
  rec.name = String(name || '').trim().slice(0, 120) || 'Untitled document';
  rec.updatedAt = Date.now();
  await persist(dbPut('writedocs', rec));
  emit(EVENTS.WRITEDOCS);
  return rec;
}

/** A copy of the document, right after the original in the rail. */
export async function duplicateWriteDoc(id) {
  const rec = writeDocById(id);
  if (!rec) return null;
  const now = Date.now();
  const copy = {
    ...rec,
    id: uid(),
    name: rec.name.replace(/ copy( \d+)?$/, '') + ' copy',
    createdAt: now,
    updatedAt: now
  };
  setWriteDocs(writedocs.concat([copy]));
  await persist(dbPut('writedocs', copy));
  emit(EVENTS.WRITEDOCS);
  return copy;
}

export async function removeWriteDoc(id) {
  const rec = writeDocById(id);
  if (!rec) return false;
  if (!confirm('Remove “' + rec.name + '” from your library?')) return false;
  setWriteDocs(writedocs.filter(w => w.id !== id));
  await persist(dbDel('writedocs', id));
  emit(EVENTS.WRITEDOCS);
  return true;
}
