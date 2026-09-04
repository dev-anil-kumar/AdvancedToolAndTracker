/**
 * The single source of truth.
 *
 * Collections are exported as live bindings: other modules read them directly
 * and mutate their contents, but only ever *replace* them through the setters
 * here, so there is one place to look when asking "who changed this array?".
 */
import { emit, EVENTS } from './bus.js';
import { clamp } from './dom.js';
import { dbAll, dbPut, persist } from './db.js';
import { HIGHLIGHTS, PER_ROW_DEFAULT, PER_ROW_MIN, PER_ROW_MAX } from './config.js';

export const prefs = { perRow: PER_ROW_DEFAULT, highlight: HIGHLIGHTS[0].key };
export let workspaces = [];     // reading tabs: { id, name }
export let activeWs = null;
export let files = [];          // { id, name, kind, source, content, size, addedAt, openedAt }
export let notes = [];          // { id, fileId, fileName, quote, blockIndex, headingId, headingText, createdAt }
export let panes = [];          // { key, fileId, wsId, el, floating, geom }
export let drawings = [];       // { id, name, shapes, view, createdAt, updatedAt }
export let jsondocs = [];       // { id, name, text, source, createdAt, updatedAt }

export async function loadPrefs() {
  try {
    const rows = await dbAll('prefs');
    const row = (rows || []).find(r => r.id === 'layout');
    if (row) {
      if (row.perRow) prefs.perRow = clamp(Number(row.perRow) || PER_ROW_DEFAULT, PER_ROW_MIN, PER_ROW_MAX);
      if (row.highlight && HIGHLIGHTS.some(h => h.key === row.highlight)) prefs.highlight = row.highlight;
    }
  } catch (err) { /* defaults are fine */ }
}
/** Persist the preferences and tell the app they changed. */
export function savePrefs() {
  persist(dbPut('prefs', { id: 'layout', perRow: prefs.perRow, highlight: prefs.highlight }));
  emit(EVENTS.PREFS);
}

/* ---------- Replacing a collection ---------- */
export function setFiles(next) { files = next; }
export function setNotes(next) { notes = next; }
export function setPanes(next) { panes = next; }
export function setWorkspaces(next) { workspaces = next; }
export function setActiveWs(next) { activeWs = next; }
export function setDrawings(next) { drawings = next; }
export function setJsonDocs(next) { jsondocs = next; }

/* ---------- Selectors: the only way other modules ask questions ---------- */
export function fileById(id) { return files.find(f => f.id === id) || null; }
export function noteById(id) { return notes.find(n => n.id === id) || null; }
export function noteCountFor(fileId) { return notes.reduce((n, x) => n + (x.fileId === fileId ? 1 : 0), 0); }
export function notesFor(fileId) { return notes.filter(n => n.fileId === fileId); }

export function wsById(id) { return workspaces.find(w => w.id === id) || null; }
export function panesIn(wsId) { return panes.filter(p => p.wsId === wsId); }
export function paneByKey(key) { return panes.find(p => p.key === key) || null; }
export function findPane(fileId, wsId) { return panes.find(p => p.fileId === fileId && p.wsId === wsId) || null; }
export function anyPaneFor(fileId) { return panes.find(p => p.fileId === fileId) || null; }

export function drawingById(id) { return drawings.find(dr => dr.id === id) || null; }
export function drawingsByRecency() {
  return drawings.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function jsonDocById(id) { return jsondocs.find(j => j.id === id) || null; }
export function jsonDocsByRecency() {
  return jsondocs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function documents() { return files.filter(f => f.kind !== 'paste'); }
export function pastedDocs() { return files.filter(f => f.kind === 'paste'); }
export function byRecency() {
  return files.slice().sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0));
}
