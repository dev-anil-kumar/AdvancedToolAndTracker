/**
 * The comparison library: adding, editing, removing, and the four ways the two
 * sides get their text — a local file, a public URL, pasted text, or something
 * already in the library.
 *
 * Mirrors features/library.js and features/jsondocs.js: everything that changes
 * `compares` happens here, and every change is announced on the bus.
 *
 * A record keeps both sides' text, because a comparison you cannot reopen is
 * not worth listing. Two very large sides are the exception — writing tens of
 * megabytes into IndexedDB on every keystroke of a rename is not a trade worth
 * making — so above a limit the comparison lives for the session and says so
 * rather than pretending to be saved.
 */
import { emit, EVENTS } from '../core/bus.js';
import { DIFF_FETCH_MAX, DIFF_STORE_MAX } from '../core/config.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { uid } from '../core/dom.js';
import { compareById, compares, setCompares } from '../core/state.js';
import { toast } from '../core/toast.js';
import { toRawUrl } from './library.js';

/** One side of a comparison, in the shape a record stores. */
export const side = (input) => ({
  name: String((input && input.name) || '').slice(0, 200),
  kind: (input && input.kind) || 'file',
  source: String((input && input.source) || '').slice(0, 2000),
  text: String((input && input.text) != null ? input.text : '')
});

const tooBig = (rec) => rec.a.text.length > DIFF_STORE_MAX || rec.b.text.length > DIFF_STORE_MAX;

export async function addCompare(input) {
  const now = Date.now();
  const rec = {
    id: uid(),
    name: (input.name || deriveCompareName(input.a, input.b)).slice(0, 160),
    a: side(input.a),
    b: side(input.b),
    opts: Object.assign({}, input.opts),
    createdAt: now,
    updatedAt: now,
    stored: true
  };
  rec.stored = !tooBig(rec);
  setCompares(compares.concat([rec]));
  if (rec.stored) await persist(dbPut('compares', rec));
  else toast('These two are large enough that this comparison is kept for this session only.');
  emit(EVENTS.COMPARES);
  return rec;
}

/** Change one or both sides, or the options. Quiet: this runs while reading. */
export async function updateCompare(id, patch) {
  const rec = compareById(id);
  if (!rec) return null;
  if (patch.a) rec.a = side(patch.a);
  if (patch.b) rec.b = side(patch.b);
  if (patch.opts) rec.opts = Object.assign({}, patch.opts);
  if (patch.name !== undefined) rec.name = String(patch.name || '').slice(0, 160) || 'Untitled comparison';
  rec.updatedAt = Date.now();
  rec.stored = !tooBig(rec);
  if (rec.stored) await persist(dbPut('compares', rec));
  emit(EVENTS.COMPARES);
  return rec;
}

export async function renameCompare(id, name) {
  return updateCompare(id, { name: String(name || '').trim() });
}

export async function removeCompare(id) {
  const rec = compareById(id);
  if (!rec) return false;
  if (!confirm('Remove “' + rec.name + '” from your library?')) return false;
  setCompares(compares.filter(c => c.id !== id));
  await persist(dbDel('compares', id));
  emit(EVENTS.COMPARES);
  toast('Removed “' + rec.name + '”.');
  return true;
}

/** A name for a comparison: what the two sides are called, when they differ. */
export function deriveCompareName(a, b) {
  const left = shortName((a && a.name) || '');
  const right = shortName((b && b.name) || '');
  if (left && right) return left === right ? left : left + ' → ' + right;
  return left || right || 'Comparison';
}

const shortName = (name) => String(name).split(/[\\/]/).pop().slice(0, 70);

/* ---------- Getting the text ---------- */

/** Read a dropped or picked file. Anything textual will do. */
export async function readSideFile(file) {
  if (file.size > DIFF_FETCH_MAX) {
    throw new Error('“' + file.name + '” is larger than ' + Math.round(DIFF_FETCH_MAX / 1048576) + ' MB.');
  }
  return side({ name: file.name, kind: 'file', source: file.name, text: await file.text() });
}

/**
 * Download one side. The same rules as anywhere else in Folio: the server has
 * to allow cross-origin reads, and a GitHub page link is turned into the raw
 * file it stands for.
 */
export async function loadSideFromUrl(rawInput) {
  const url = toRawUrl(String(rawInput).trim());
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error('Couldn’t download that file. The server may not allow cross-origin reads — a raw.githubusercontent.com or Gist link will work.');
  }
  if (!res.ok) throw new Error('The server answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') + '.');
  const length = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : 0;
  if (length && length > DIFF_FETCH_MAX) {
    throw new Error('That file is larger than ' + Math.round(DIFF_FETCH_MAX / 1048576) + ' MB.');
  }
  const text = await res.text();
  if (!text) throw new Error('That file is empty.');

  let name = '';
  try {
    const seg = new URL(url, location.href).pathname.split('/').filter(Boolean).pop();
    if (seg) name = decodeURIComponent(seg);
  } catch (e) { /* a name is a convenience, not a requirement */ }
  return side({ name: name || url, kind: 'url', source: url, text });
}
