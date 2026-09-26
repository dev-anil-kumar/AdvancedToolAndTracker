/**
 * The HTML library: adding, editing, removing.
 *
 * Mirrors features/jsondocs.js — everything that changes `htmldocs` happens
 * here, and every change is announced on the bus. A record stores the *text* of
 * the document: the markup the reader gave us, which is the only thing that
 * survives being rendered, edited or re-saved.
 */
import { emit, EVENTS } from '../core/bus.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { uid } from '../core/dom.js';
import { htmlDocById, htmldocs, setHtmlDocs } from '../core/state.js';
import { toast } from '../core/toast.js';
import { isMhtml, mhtmlToHtml } from './html/mhtml.js';

/** Add a document, or refresh the one that is already here under that name. */
export async function addHtmlDoc(input) {
  const text = String(input.text == null ? '' : input.text).replace(/^﻿/, '');
  const name = (input.name || 'document.html').trim().slice(0, 120) || 'document.html';
  const kind = input.kind || 'file';
  const now = Date.now();

  let rec = htmldocs.find(h => h.kind === kind && h.name === name && h.text === text);
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
    setHtmlDocs(htmldocs.concat([rec]));
  }
  await persist(dbPut('htmldocs', rec));
  emit(EVENTS.HTMLDOCS);
  return rec;
}

/** Save edited text. Quiet: this runs on a debounce while someone is typing. */
export async function updateHtmlDoc(id, text) {
  const rec = htmlDocById(id);
  if (!rec) return null;
  rec.text = String(text == null ? '' : text);
  rec.size = rec.text.length;
  rec.updatedAt = Date.now();
  await persist(dbPut('htmldocs', rec));
  emit(EVENTS.HTMLDOCS);
  return rec;
}

export async function renameHtmlDoc(id, name) {
  const rec = htmlDocById(id);
  if (!rec) return;
  rec.name = String(name || '').trim().slice(0, 120) || 'Untitled HTML';
  rec.updatedAt = Date.now();
  await persist(dbPut('htmldocs', rec));
  emit(EVENTS.HTMLDOCS);
}

export async function removeHtmlDoc(id) {
  const rec = htmlDocById(id);
  if (!rec) return false;
  if (!confirm('Remove “' + rec.name + '” from your library?')) return false;
  setHtmlDocs(htmldocs.filter(h => h.id !== id));
  await persist(dbDel('htmldocs', id));
  emit(EVENTS.HTMLDOCS);
  toast('Removed “' + rec.name + '”.');
  return true;
}

/** A name for pasted or downloaded markup: its <title>, else its first <h1>. */
export function deriveHtmlName(text) {
  const src = String(text == null ? '' : text);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(src);
  if (title && title[1].trim()) return title[1].trim().slice(0, 80) + '.html';
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(src);
  if (h1) {
    const heading = h1[1].replace(/<[^>]+>/g, '').trim();
    if (heading) return heading.slice(0, 80) + '.html';
  }
  return 'Pasted HTML';
}

/** Fetch a document over HTTP. Same rules as a Markdown URL: CORS applies. */
export async function loadHtmlFromUrl(rawInput) {
  const url = String(rawInput).trim();
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new Error('Couldn’t download that file. The server may not allow cross-origin reads.');
  }
  if (!res.ok) throw new Error('The server answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') + '.');
  let text = await res.text();
  if (!text.trim()) throw new Error('That file is empty.');

  // Prefer the filename the URL ends in; otherwise read a name out of the markup.
  let name = '';
  try {
    const seg = new URL(url, location.href).pathname.split('/').filter(Boolean).pop();
    if (seg) name = decodeURIComponent(seg);
  } catch (e) { /* fall through to a derived name */ }

  // A saved-page archive comes back as MHTML: flatten it before we store it.
  let kind = 'url';
  if (isMhtml(text)) {
    try {
      text = mhtmlToHtml(text);
      kind = 'mhtml';
    } catch (err) { /* keep the raw text and treat it as an ordinary page */ }
  }

  if (!/\.(html|htm|xhtml|mhtml|mht)$/i.test(name)) name = deriveHtmlName(text);
  return addHtmlDoc({ name, kind, source: url, text });
}
