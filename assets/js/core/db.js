/**
 * Persistence. IndexedDB when it is available, an in-memory map when it is
 * not, so the app degrades to session-only instead of breaking.
 *
 * Callers wrap writes in persist() and never see a rejected promise.
 */
import { DB_NAME, DB_VER, STORES } from './config.js';
import { toast } from './toast.js';

/* One bucket per store, so the fallback covers everything STORES lists. */
const mem = Object.fromEntries(STORES.map(name => [name, new Map()]));
let dbPromise = null, storageWarned = false;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export async function dbAll(store) {
  const db = await openDB();
  if (!db) return [...mem[store].values()];
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
export async function dbPut(store, value) {
  const db = await openDB();
  if (!db) { mem[store].set(value.id, value); return value; }
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    t.oncomplete = () => res(value);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
export async function dbDel(store, id) {
  const db = await openDB();
  if (!db) { mem[store].delete(id); return; }
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(id);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
/* Persistence is a convenience, never a blocker: a failed write warns once. */
export async function persist(promise) {
  try { return await promise; }
  catch (err) {
    console.warn('Folio: could not save', err);
    if (!storageWarned) {
      storageWarned = true;
      toast('Saving is unavailable in this browser — documents will be lost on reload.');
    }
    return null;
  }
}
