/**
 * The document library: adding, removing, and the four ways a document gets
 * in — a local file, a public URL, pasted text, or the built-in sample.
 *
 * Everything that changes `files` happens here.
 */
import { emit, EVENTS } from '../core/bus.js';
import { MAX_OPEN_AT_ONCE } from '../core/config.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { $, uid } from '../core/dom.js';
import { files, notes, setFiles, setNotes, fileById, noteCountFor } from '../core/state.js';
import { plural } from '../core/format.js';
import { toast } from '../core/toast.js';
import { closePane, openDoc } from './panes.js';

export async function addDoc(input) {
  const content = String(input.content || '').replace(/^﻿/, '');
  const name = (input.name || 'document.md').trim();
  const kind = input.kind || 'file';
  const source = input.source || '';
  const now = Date.now();

  let rec = null;
  if (kind === 'url') rec = files.find(f => f.kind === 'url' && f.source === source);
  else if (kind === 'sample') rec = files.find(f => f.kind === 'sample');
  else rec = files.find(f => f.kind === kind && f.name === name && f.content === content);

  if (rec) {
    rec.content = content;
    rec.size = content.length;
    rec.openedAt = now;
  } else {
    rec = { id: uid(), name, kind, source, content, size: content.length, addedAt: now, openedAt: now };
    files.push(rec);
  }
  await persist(dbPut('files', rec));
  emit(EVENTS.LIBRARY);
  return rec;
}

export async function removeDoc(id) {
  const rec = fileById(id);
  if (!rec) return;
  const n = noteCountFor(id);
  const msg = 'Remove “' + rec.name + '” from your library?' +
    (n ? '\n\nIts ' + plural(n, 'note', 'notes') + ' will be deleted too.' : '');
  if (!confirm(msg)) return;

  closePane(id);
  setFiles(files.filter(f => f.id !== id));
  const doomed = notes.filter(x => x.fileId === id);
  setNotes(notes.filter(x => x.fileId !== id));
  await persist(dbDel('files', id));
  for (const note of doomed) await persist(dbDel('notes', note.id));
  emit(EVENTS.LIBRARY);
  emit(EVENTS.NOTES);
  toast('Removed “' + rec.name + '”.');
}

export function deriveName(md) {
  const heading = md.match(/^[ \t]*#{1,6}[ \t]+(.+)$/m);
  if (heading) return heading[1].replace(/\s*#+\s*$/, '').trim().slice(0, 90);
  const firstLine = (md.split('\n').find(l => l.trim()) || '').trim();
  return firstLine.slice(0, 70) || 'Pasted document';
}

/* ---------- Sources ---------- */

export async function handleFiles(list) {
  const chosen = [...list].slice(0, MAX_OPEN_AT_ONCE);
  for (const file of chosen) {
    try {
      const text = await file.text();
      const rec = await addDoc({ name: file.name, kind: 'file', source: file.name, content: text });
      openDoc(rec.id);
    } catch (err) {
      toast('Couldn’t read “' + file.name + '”.');
    }
  }
}

/* GitHub blob links point at a web page; their raw form is what we want. */
export function toRawUrl(input) {
  let u;
  try { u = new URL(input); } catch (e) { return input; }
  if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
    return 'https://raw.githubusercontent.com' + u.pathname.replace('/blob/', '/') + (u.search || '');
  }
  if (u.hostname === 'github.com' && u.pathname.includes('/raw/')) return u.href;
  return u.href;
}

export async function loadFromUrl(rawInput) {
  const url = toRawUrl(String(rawInput).trim());
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error('Couldn’t download that file. The server may not allow cross-origin reads — a raw.githubusercontent.com or Gist link will work.');
  }
  if (!res.ok) throw new Error('The server answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') + '.');
  const text = await res.text();
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(text)) {
    throw new Error('That URL returned a web page, not a Markdown file. Use the direct (raw) link to the .md file.');
  }
  if (!text.trim()) throw new Error('That file is empty.');

  let name = 'document.md';
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (seg) name = decodeURIComponent(seg);
  } catch (e) { /* keep default */ }
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(name)) name = deriveName(text);

  const rec = await addDoc({ name, kind: 'url', source: url, content: text });
  openDoc(rec.id);
}

export async function openSample() {
  const rec = await addDoc({
    name: 'Folio — sample document',
    kind: 'sample',
    source: 'built-in',
    content: $('#sample-md').textContent.trim()
  });
  openDoc(rec.id);
}
