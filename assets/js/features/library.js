/**
 * The document library: adding, removing, and the ways a document gets in —
 * a local file, a public URL, pasted text, or the built-in sample.
 *
 * A file does not have to be Markdown. A PDF or a spreadsheet is converted to
 * Markdown on the way in (features/convert), so by the time it reaches the
 * library it is a document like any other — which is what lets panes, notes,
 * export and focus mode work on it without knowing it was ever anything else.
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
import { convert, sniff } from './convert/index.js';
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
  /* Page and sheet counts, and the size of the file it was made from: what a
     converted document knows about itself that its Markdown does not say. */
  if (input.meta) Object.assign(rec, input.meta);
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
    const kind = sniff(file);
    if (kind === 'unknown') {
      toast('Folio can’t read “' + file.name + '” — Markdown, text, PDF and spreadsheets only.');
      continue;
    }
    try {
      const rec = kind === 'markdown' ? await addMarkdownFile(file) : await addConvertedFile(file, kind);
      openDoc(rec.id);
    } catch (err) {
      toast(err && err.message ? err.message : 'Couldn’t read “' + file.name + '”.');
    }
  }
}

async function addMarkdownFile(file) {
  return addDoc({ name: file.name, kind: 'file', source: file.name, content: await file.text() });
}

/** A PDF or a spreadsheet: read it, convert it, then it is just a document. */
async function addConvertedFile(file, kind) {
  toast('Reading “' + file.name + '”…');
  const made = await convert(await file.arrayBuffer(), file.name, kind);
  const rec = await addDoc({
    name: file.name,
    kind: made.kind,
    source: file.name,
    content: made.content,
    meta: Object.assign({ sourceSize: file.size }, made.meta)
  });
  toast('Read “' + file.name + '” — ' + describe(rec) + '.');
  return rec;
}

/** What a converted document turned out to hold, for the toast and the rows. */
export function describe(rec) {
  if (rec.kind === 'pdf') {
    return plural(rec.read || rec.pages || 0, 'page', 'pages') +
      (rec.read && rec.pages && rec.read < rec.pages ? ' of ' + rec.pages : '');
  }
  if (rec.kind === 'sheet') {
    return plural(rec.sheets || 0, 'sheet', 'sheets') + ', ' + plural(rec.rows || 0, 'row', 'rows');
  }
  return plural(rec.content ? rec.content.length : 0, 'character', 'characters');
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

  /* A link can point at a PDF or a workbook just as easily as at Markdown. */
  const remote = remoteKind(url, res);
  if (remote === 'pdf' || remote === 'sheet') {
    if (typeof res.arrayBuffer !== 'function') throw new Error('That file could not be downloaded.');
    const name = fileNameFromUrl(url) || (remote === 'pdf' ? 'document.pdf' : 'workbook.xlsx');
    const made = await convert(await res.arrayBuffer(), name, remote);
    const rec = await addDoc({
      name, kind: made.kind, source: url, content: made.content, meta: made.meta
    });
    openDoc(rec.id);
    return;
  }

  const text = await res.text();
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(text)) {
    throw new Error('That URL returned a web page, not a Markdown file. Use the direct (raw) link to the .md file.');
  }
  if (!text.trim()) throw new Error('That file is empty.');

  let name = fileNameFromUrl(url) || 'document.md';
  if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(name)) name = deriveName(text);

  const rec = await addDoc({ name, kind: 'url', source: url, content: text });
  openDoc(rec.id);
}

/** The last path segment of a URL, decoded. */
function fileNameFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : '';
  } catch (e) { return ''; }
}

/* The URL's own extension is the best evidence; the served type is the backup. */
function remoteKind(url, res) {
  const byName = sniff(fileNameFromUrl(url));
  if (byName !== 'unknown') return byName;
  const type = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '';
  return sniff({ name: '', type: (type || '').split(';')[0].trim() });
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
