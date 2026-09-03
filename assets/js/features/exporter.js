/**
 * Saving Markdown back out.
 *
 * Uses the File System Access API so the user picks the destination, and falls
 * back to an ordinary download (single file) or one combined document (bulk)
 * in browsers that lack it — Safari and Firefox today.
 */
import { el } from '../core/dom.js';
import { plural } from '../core/format.js';
import { documents, fileById, notes, pastedDocs } from '../core/state.js';
import { toast } from '../core/toast.js';

/* The three things this app can write out. */
const FILE_TYPES = {
  md:   { ext: '.md',   mime: 'text/markdown', label: 'Markdown', accept: ['.md', '.markdown'] },
  json: { ext: '.json', mime: 'application/json', label: 'Folio drawing', accept: ['.json'] },
  svg:  { ext: '.svg',  mime: 'image/svg+xml', label: 'SVG image', accept: ['.svg'] },
  png:  { ext: '.png',  mime: 'image/png', label: 'PNG image', accept: ['.png'] }
};

export const canPickDir = typeof window.showDirectoryPicker === 'function';
export const canPickFile = typeof window.showSaveFilePicker === 'function';

export function safeName(name, ext) {
  const suffix = ext || '.md';
  const n = String(name || 'document')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || 'document';
  if (n.toLowerCase().endsWith(suffix.toLowerCase())) return n;
  return n.replace(/\.(md|markdown|txt|json|svg)$/i, '') + suffix;
}

function uniqueName(used, prefix, name) {
  let candidate = name, i = 2;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  while (used.has(prefix + candidate)) candidate = stem + ' (' + i++ + ')' + ext;
  used.add(prefix + candidate);
  return candidate;
}

export function downloadBlob(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/markdown') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* One file: a real Save-As dialog where the browser has one. */
export async function saveOneFile(name, text, kind) {
  const type = FILE_TYPES[kind || 'md'];
  const file = safeName(name, type.ext);
  if (canPickFile) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: file,
        types: [{ description: type.label, accept: { [type.mime]: type.accept } }]
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      toast('Saved “' + (handle.name || file) + '”.');
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      console.warn('Folio: save picker failed', err);
    }
  }
  downloadBlob(file, text, type.mime);
  toast('Downloaded “' + file + '”.');
  return true;
}

/** Save a Blob — the PNG path, where there is nothing to stringify. */
export async function saveBinaryFile(name, blob, kind) {
  const type = FILE_TYPES[kind || 'png'];
  const file = safeName(name, type.ext);
  if (canPickFile) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: file,
        types: [{ description: type.label, accept: { [type.mime]: type.accept } }]
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast('Saved “' + (handle.name || file) + '”.');
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      console.warn('Folio: save picker failed', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Downloaded “' + file + '”.');
  return true;
}

/* Many files: into a folder the user picks, else one combined download. */
export async function saveManyFiles(items, bundleName) {
  if (!items.length) { toast('Nothing to export yet.'); return; }
  if (canPickDir) {
    try {
      const dir = await showDirectoryPicker({ mode: 'readwrite', id: 'folio-export' });
      const used = new Set();
      let count = 0;
      for (const item of items) {
        const target = item.folder ? await dir.getDirectoryHandle(item.folder, { create: true }) : dir;
        const name = uniqueName(used, (item.folder || '') + '/', safeName(item.name));
        const fh = await target.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(item.text);
        await w.close();
        count++;
      }
      toast('Saved ' + plural(count, 'file', 'files') + ' to “' + dir.name + '”.');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('Folio: folder export failed', err);
      toast('Could not write to that folder — saving one combined file instead.');
    }
  }
  downloadBlob(safeName(bundleName || 'folio-export'), combineItems(items));
}

function combineItems(items) {
  const head = '# Folio export\n\n_' + items.length + ' ' + (items.length === 1 ? 'file' : 'files') +
    ' · ' + new Date().toLocaleString() + '_\n';
  return head + items.map(it =>
    '\n\n---\n\n<!-- ' + ((it.folder ? it.folder + '/' : '') + it.name) + ' -->\n\n' + it.text.trim() + '\n'
  ).join('');
}

export function noteMarkdown(note) {
  const rec = fileById(note.fileId);
  const quote = note.quote.split('\n').map(l => '> ' + l).join('\n');
  return '# Note from ' + ((rec && rec.name) || note.fileName) + '\n\n' + quote + '\n\n' +
    '*' + (note.headingText ? 'Section: ' + note.headingText + ' · ' : '') +
    'saved ' + new Date(note.createdAt).toLocaleString() + '*\n';
}

export function allNotesMarkdown() {
  const groups = new Map();
  notes.forEach(n => { if (!groups.has(n.fileId)) groups.set(n.fileId, []); groups.get(n.fileId).push(n); });
  let out = '# Notes — Folio\n\n_' + plural(notes.length, 'note', 'notes') + ' across ' +
    plural(groups.size, 'document', 'documents') + ' · exported ' + new Date().toLocaleString() + '_\n';
  groups.forEach((list, fileId) => {
    const rec = fileById(fileId);
    out += '\n\n## ' + ((rec && rec.name) || list[0].fileName) + '\n';
    list.slice().sort((a, b) => (a.blockIndex || 0) - (b.blockIndex || 0)).forEach(n => {
      out += '\n' + n.quote.split('\n').map(l => '> ' + l).join('\n') + '\n\n' +
        '*' + (n.headingText ? n.headingText + ' · ' : '') + new Date(n.createdAt).toLocaleString() + '*\n';
    });
  });
  return out + '\n';
}

export const docItems = () => documents().map(f => ({ name: f.name, text: f.content, folder: 'documents' }));
export const pasteItems = () => pastedDocs().map(f => ({ name: f.name, text: f.content, folder: 'pasted' }));

/** Everything, in one call: documents, pasted text, and the notes file. */
export function everythingItems() {
  const items = docItems().concat(pasteItems());
  if (notes.length) items.push({ name: 'folio-notes.md', text: allNotesMarkdown() });
  return items;
}
