/**
 * The drawing library: create, save, remove, import.
 *
 * Mirrors features/library.js — everything that changes `drawings` happens
 * here, and every change is announced on the bus.
 */
import { emit, EVENTS } from '../core/bus.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { drawingById, drawings, setDrawings } from '../core/state.js';
import { toast } from '../core/toast.js';
import { newScene, parseScene, serialize } from './canvas/model.js';

/** A record is a scene plus timestamps. */
function record(scene) {
  const now = Date.now();
  const existing = drawingById(scene.id);
  return {
    id: scene.id,
    name: scene.name,
    shapes: scene.shapes,
    view: scene.view,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
}

export async function createDrawing(name) {
  const scene = newScene(name);
  await saveDrawing(scene);
  return scene;
}

/** Write a scene to storage. Called on autosave, so it stays quiet. */
export async function saveDrawing(scene) {
  const rec = record(scene);
  const rest = drawings.filter(d => d.id !== rec.id);
  setDrawings(rest.concat([rec]));
  await persist(dbPut('drawings', rec));
  emit(EVENTS.DRAWINGS);
  return rec;
}

export async function renameDrawing(id, name) {
  const rec = drawingById(id);
  if (!rec) return;
  rec.name = String(name || '').trim().slice(0, 90) || 'Untitled drawing';
  rec.updatedAt = Date.now();
  await persist(dbPut('drawings', rec));
  emit(EVENTS.DRAWINGS);
}

export async function removeDrawing(id) {
  const rec = drawingById(id);
  if (!rec) return;
  if (!confirm('Delete “' + rec.name + '”? This cannot be undone.')) return;
  setDrawings(drawings.filter(d => d.id !== id));
  await persist(dbDel('drawings', id));
  emit(EVENTS.DRAWINGS);
  toast('Deleted “' + rec.name + '”.');
}

/** A stored record, back to the shape the editor works with. */
export function toScene(rec) {
  return {
    id: rec.id,
    name: rec.name,
    shapes: JSON.parse(JSON.stringify(rec.shapes || [])),
    view: rec.view || { x: -80, y: -60, zoom: 1 }
  };
}

/** Import an exported .json drawing. Returns the new scene. */
export async function importDrawing(json, fallbackName) {
  const scene = parseScene(json, fallbackName);
  await saveDrawing(scene);
  toast('Imported “' + scene.name + '” — ' + scene.shapes.length + ' shapes.');
  return scene;
}

export { serialize };
