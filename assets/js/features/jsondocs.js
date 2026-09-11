/**
 * The JSON library: adding, editing, removing.
 *
 * Mirrors features/library.js and features/drawings.js — everything that
 * changes `jsondocs` happens here, and every change is announced on the bus.
 * A record stores the *text*, never the parsed value: the text is what the
 * reader gave us, and it is the only thing that survives being invalid.
 */
import { emit, EVENTS } from '../core/bus.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { uid } from '../core/dom.js';
import { jsonDocById, jsondocs, setJsonDocs } from '../core/state.js';
import { toast } from '../core/toast.js';
import { parse } from './json/model.js';

/** Add a document, or refresh the one that is already here under that name. */
export async function addJsonDoc(input) {
  const text = String(input.text == null ? '' : input.text).replace(/^﻿/, '');
  const name = (input.name || 'document.json').trim().slice(0, 120) || 'document.json';
  const kind = input.kind || 'file';
  const now = Date.now();

  let rec = jsondocs.find(j => j.kind === kind && j.name === name && j.text === text);
  if (rec) {
    rec.updatedAt = now;
  } else {
    rec = {
      id: uid(), name, kind,
      source: input.source || '',
      text,
      size: text.length,
      createdAt: now,
      updatedAt: now
    };
    setJsonDocs(jsondocs.concat([rec]));
  }
  await persist(dbPut('jsondocs', rec));
  emit(EVENTS.JSONDOCS);
  return rec;
}

/** Save edited text. Quiet: this runs on a debounce while someone is typing. */
export async function updateJsonDoc(id, text) {
  const rec = jsonDocById(id);
  if (!rec) return null;
  rec.text = String(text == null ? '' : text);
  rec.size = rec.text.length;
  rec.updatedAt = Date.now();
  await persist(dbPut('jsondocs', rec));
  emit(EVENTS.JSONDOCS);
  return rec;
}

export async function renameJsonDoc(id, name) {
  const rec = jsonDocById(id);
  if (!rec) return;
  rec.name = String(name || '').trim().slice(0, 120) || 'Untitled JSON';
  rec.updatedAt = Date.now();
  await persist(dbPut('jsondocs', rec));
  emit(EVENTS.JSONDOCS);
}

export async function removeJsonDoc(id) {
  const rec = jsonDocById(id);
  if (!rec) return false;
  if (!confirm('Remove “' + rec.name + '” from your library?')) return false;
  setJsonDocs(jsondocs.filter(j => j.id !== id));
  await persist(dbDel('jsondocs', id));
  emit(EVENTS.JSONDOCS);
  toast('Removed “' + rec.name + '”.');
  return true;
}

/** A name for pasted or downloaded text: the first string-ish thing in it. */
export function deriveJsonName(text) {
  const res = parse(text);
  if (res.ok && res.value && typeof res.value === 'object' && !Array.isArray(res.value)) {
    for (const key of ['name', 'title', 'id', 'label']) {
      const v = res.value[key];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80) + '.json';
    }
    const keys = Object.keys(res.value);
    if (keys.length) return keys[0].slice(0, 60) + '.json';
  }
  if (res.ok && Array.isArray(res.value)) return res.value.length + ' records.json';
  return 'Pasted JSON';
}

/** Fetch a document over HTTP. Same rules as a Markdown URL: CORS applies. */
export async function loadJsonFromUrl(rawInput) {
  const url = String(rawInput).trim();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error('Couldn’t download that file. The server may not allow cross-origin reads.');
  }
  if (!res.ok) throw new Error('The server answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') + '.');
  const text = await res.text();
  if (!text.trim()) throw new Error('That file is empty.');
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(text)) {
    throw new Error('That URL returned a web page, not JSON.');
  }
  let name = '';
  try {
    const seg = new URL(url, location.href).pathname.split('/').filter(Boolean).pop();
    if (seg) name = decodeURIComponent(seg);
  } catch (e) { /* fall through to a derived name */ }
  if (!/\.(json|jsonc|geojson|ndjson|jsonl|txt)$/i.test(name)) name = deriveJsonName(text);
  return addJsonDoc({ name, kind: 'url', source: url, text });
}
