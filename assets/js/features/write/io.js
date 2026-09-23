/**
 * Open any file → a Write document; download the current one back out.
 *
 * Three things are kept pure and exported for tests because everything else
 * here depends on the DOM, IndexedDB or a picked File:
 *
 *   fileKind(name, type)     which of a dozen small readers a file goes to
 *   textToHtml(text, kind)   that reader's text turned into sheet-ready HTML
 *   htmlToMarkdown(html)     the sheet's HTML turned back into Markdown
 *
 * Everything else is the plumbing around them: reading a File (text, or
 * pdf.js / SheetJS / a hand-rolled ZIP-and-inflate for .docx), a NUL-byte
 * binary sniff with a safe preview, a toolbar "file" group with an Open
 * button and a Download popover, the rail's "Open file" button, and the
 * three shortcuts (mod+o, mod+shift+s, mod+p) the plan reserves for them.
 */
import { WRITE_FONTS } from '../../core/config.js';
import { toast } from '../../core/toast.js';
import { downloadBlob } from '../exporter.js';
import { addWriteDoc } from '../writedocs.js';
import { convert } from '../convert/index.js';

/* ---------- fileKind: which reader a file goes to ---------- */

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdwn']);
const SHEET_EXTS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods']);
const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'css', 'scss', 'less',
  'xml', 'svg', 'swift', 'lua', 'pl', 'r', 'scala', 'dart', 'vue', 'svelte',
  'graphql', 'gql', 'proto', 'vb', 'json', 'jsonc', 'geojson', 'ndjson', 'jsonl',
  'log', 'ipynb', 'env', 'gradle', 'makefile', 'dockerfile'
]);

/**
 * Which of a dozen small readers a file goes to: 'html', 'markdown', 'pdf',
 * 'sheet', 'csv', 'rtf', 'docx', 'code', 'text', or 'unknown' when neither
 * the name nor the type say anything useful (the caller then sniffs the
 * bytes themselves — a binary file and a plain one both end up here).
 */
export function fileKind(name, type) {
  const n = String(name || '');
  const t = String(type || '').toLowerCase();
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 ? n.slice(dot + 1).toLowerCase() : '';

  if (ext === 'html' || ext === 'htm' || t === 'text/html') return 'html';
  if (MD_EXTS.has(ext) || t === 'text/markdown') return 'markdown';
  if (ext === 'pdf' || t === 'application/pdf') return 'pdf';
  if (SHEET_EXTS.has(ext) || /spreadsheet|excel/.test(t)) return 'sheet';
  if (ext === 'csv' || ext === 'tsv' || t === 'text/csv') return 'csv';
  if (ext === 'rtf' || t === 'text/rtf' || t === 'application/rtf') return 'rtf';
  if (ext === 'docx' || t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'txt' || ext === 'text' || t === 'text/plain') return 'text';
  if (CODE_EXTS.has(ext)) return 'code';
  if (t.startsWith('text/')) return 'text';
  if (!ext && !t) return 'text';
  return 'unknown';
}

/* ---------- Small pure helpers the HTML builders share ---------- */

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

function csvToHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(l => l.length);
  if (!lines.length) return '<p></p>';
  const rows = lines.slice(0, 2000).map(parseCsvLine);
  const [head, ...body] = rows;
  const row = (cells, tag) => '<tr>' + cells.map(c => '<' + tag + '>' + escapeHtml(c) + '</' + tag + '>').join('') + '</tr>';
  let html = '<table><thead>' + row(head, 'th') + '</thead><tbody>' + body.map(r => row(r, 'td')).join('') + '</tbody></table>';
  if (lines.length > 2000) html += '<p><em>Showing the first 2000 of ' + lines.length + ' rows.</em></p>';
  return html;
}

/** Barely-there RTF → plain text: strip control words/groups, keep \par as a line break. */
function rtfToText(src) {
  let s = String(src || '');
  s = s.replace(/\{\\\*[^{}]*\}/g, '');
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  s = s.replace(/\\par[d]?\b\s?/g, '\n');
  s = s.replace(/\\tab\b\s?/g, '\t');
  s = s.replace(/\\line\b\s?/g, '\n');
  s = s.replace(/\\[a-zA-Z]+-?\d*[ ]?/g, '');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\\\\/g, '\\');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function paragraphsHtml(text) {
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!src.trim()) return '<p></p>';
  return src.split(/\n{2,}/).map(block => '<p>' + escapeHtml(block).replace(/\n/g, '<br>') + '</p>').join('');
}

function codeHtml(text) {
  return '<pre><code>' + escapeHtml(text) + '</code></pre>';
}

/* ---------- Sanitizing rich HTML (opened .html files, and marked's output) ----------
   Keeps semantic tags and a whitelisted subset of inline style — the same
   allowlist the plan asks Smart Paste (features/write/paste.js) to use, so
   a document opened from disk and one pasted in look the same afterwards. */
const RICH_TAGS = [
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'mark', 'sub', 'sup',
  'p', 'div', 'span', 'br', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'img', 'hr'
];
const RICH_ATTR = ['href', 'src', 'alt', 'title', 'style', 'colspan', 'rowspan'];
const STYLE_PROP = /^(color|background-color|font-weight|font-style|text-decoration(-line)?|text-align|font-size|font-family)$/i;

function sanitizeStyle(styleText) {
  return String(styleText || '').split(';').map(s => s.trim()).filter(Boolean).map(decl => {
    const at = decl.indexOf(':');
    if (at < 0) return null;
    const prop = decl.slice(0, at).trim();
    const val = decl.slice(at + 1).trim();
    if (!prop || !val || !STYLE_PROP.test(prop) || /expression|javascript:|url\(/i.test(val)) return null;
    return prop + ': ' + val;
  }).filter(Boolean).join('; ');
}

function sanitizeRichHtml(html) {
  const clean = DOMPurify.sanitize(String(html || ''), {
    ALLOWED_TAGS: RICH_TAGS, ALLOWED_ATTR: RICH_ATTR, ALLOW_DATA_ATTR: false
  });
  const wrap = document.createElement('div');
  wrap.innerHTML = clean;
  wrap.querySelectorAll('[style]').forEach(node => {
    const kept = sanitizeStyle(node.getAttribute('style'));
    if (kept) node.setAttribute('style', kept); else node.removeAttribute('style');
  });
  wrap.querySelectorAll('a[href]').forEach(a => {
    if (/^https?:/i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  return wrap.innerHTML;
}

/**
 * A reader's text, turned into HTML the sheet can hold. Pure other than
 * leaning on the DOMPurify/marked/document globals every other Folio module
 * that touches HTML leans on too (see md/renderer.js).
 */
export function textToHtml(text, kind) {
  const src = String(text == null ? '' : text);
  switch (kind) {
    case 'html': return sanitizeRichHtml(src);
    case 'markdown': return sanitizeRichHtml(marked.parse(src));
    case 'csv': return csvToHtml(src);
    case 'rtf': return paragraphsHtml(rtfToText(src));
    case 'code': return codeHtml(src);
    case 'text':
    default: return paragraphsHtml(src);
  }
}

/* ---------- htmlToMarkdown: the sheet's HTML, back out as Markdown ---------- */

const mdEscape = (t) => String(t || '').replace(/[\\`*_]/g, '\\$&');

function inlineMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return mdEscape(node.data);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const inner = () => [...node.childNodes].map(inlineMd).join('');
  switch (node.tagName) {
    case 'BR': return '  \n';
    case 'B': case 'STRONG': { const t = inner(); return t.trim() ? '**' + t + '**' : ''; }
    case 'I': case 'EM': { const t = inner(); return t.trim() ? '*' + t + '*' : ''; }
    case 'S': case 'STRIKE': case 'DEL': { const t = inner(); return t.trim() ? '~~' + t + '~~' : ''; }
    case 'CODE': return node.textContent ? '`' + node.textContent + '`' : '';
    case 'A': {
      const href = node.getAttribute('href') || '';
      const t = inner() || href;
      return href ? '[' + t + '](' + href + ')' : t;
    }
    case 'IMG': return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
    default: return inner();
  }
}
const inlineText = (node) => [...node.childNodes].map(inlineMd).join('').trim();

function listItemText(li) {
  let text = '';
  li.childNodes.forEach(ch => {
    if (ch.nodeType === Node.ELEMENT_NODE && (ch.tagName === 'UL' || ch.tagName === 'OL' || ch.tagName === 'INPUT')) return;
    text += inlineMd(ch);
  });
  return text.trim();
}

function listMd(node, depth) {
  const ordered = node.tagName === 'OL';
  const checklist = node.classList && node.classList.contains('write-checklist');
  const indent = '  '.repeat(depth);
  return [...node.children].filter(c => c.tagName === 'LI').map((li, i) => {
    const checkbox = checklist ? li.querySelector(':scope > input[type="checkbox"]') : null;
    const marker = checklist ? (checkbox && checkbox.checked ? '- [x] ' : '- [ ] ') : (ordered ? (i + 1) + '. ' : '- ');
    let line = indent + marker + listItemText(li);
    [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL').forEach(nested => {
      line += '\n' + listMd(nested, depth + 1);
    });
    return line;
  }).join('\n');
}

function tableMd(node) {
  const rows = [...node.rows].map(row => [...row.cells].map(cell =>
    inlineText(cell).replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
  if (!rows.length) return '';
  const width = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => { const out = r.slice(0, width); while (out.length < width) out.push(''); return out; });
  const line = (cells) => '| ' + cells.join(' | ') + ' |';
  return [line(norm[0]), line(norm[0].map(() => '---'))].concat(norm.slice(1).map(line)).join('\n');
}

function blockMd(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.data.trim();
    return t ? [mdEscape(t)] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  switch (node.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return ['#'.repeat(Number(node.tagName[1])) + ' ' + inlineText(node)];
    case 'P': {
      const t = inlineText(node);
      return t ? [t] : [];
    }
    case 'BLOCKQUOTE': {
      const inner = [];
      node.childNodes.forEach(child => inner.push(...blockMd(child)));
      return inner.length ? [inner.join('\n\n').split('\n').map(l => '> ' + l).join('\n')] : [];
    }
    case 'PRE': {
      const code = node.querySelector('code') || node;
      return ['```\n' + code.textContent.replace(/\n+$/, '') + '\n```'];
    }
    case 'UL': case 'OL':
      return [listMd(node, 0)];
    case 'HR': return ['---'];
    case 'TABLE': return [tableMd(node)];
    case 'DIV': case 'LI': {
      const inner = [];
      node.childNodes.forEach(child => inner.push(...blockMd(child)));
      return inner;
    }
    default: return [];
  }
}

/** The sheet's HTML → Markdown. Covers headings, bold/italic/strike/code,
    links, images, lists (incl. checklists), quotes, code blocks, tables, hr —
    the plan's list for the Download menu's .md file. */
export function htmlToMarkdown(html) {
  const container = document.createElement('div');
  container.innerHTML = String(html == null ? '' : html);
  const blocks = [];
  container.childNodes.forEach(node => blocks.push(...blockMd(node)));
  return blocks.filter(b => b !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** "innerText"-like plain text: block elements each get their own line. */
function htmlToPlainText(html) {
  const container = document.createElement('div');
  container.innerHTML = String(html == null ? '' : html);
  const BLOCK = /^(P|DIV|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE|PRE|TR|TABLE|UL|OL|HR)$/;
  let out = '';
  (function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) { out += node.data; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') { out += '\n'; return; }
    if (node.tagName === 'HR') { out += '\n---\n'; return; }
    node.childNodes.forEach(walk);
    if (BLOCK.test(node.tagName)) out += '\n\n';
  })(container);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------- .docx: a minimal ZIP reader, only used when one is already available ----------
   `DecompressionStream('deflate-raw')` is a native, dependency-free inflater —
   the "zip reader already available" the plan allows for. Where it's missing
   (an older browser) the caller just reads the file as text instead. */

function findEOCD(view) {
  const max = Math.min(view.byteLength, 65557);
  for (let i = view.byteLength - 22; i >= view.byteLength - max && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntry(buffer, targetName) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEOCD(view);
  if (eocd < 0) return null;
  let ptr = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    if (name === targetName) {
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = bytes.subarray(start, start + compSize);
      return method === 0 ? data : await inflateRaw(data);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** word/document.xml, very roughly, into paragraphs — table/list structure
    is not attempted, just the words, which is what "basic extraction" buys. */
function docxXmlToHtml(xml) {
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); }
  catch (err) { return null; }
  if (!doc || doc.querySelector('parsererror')) return null;
  const paragraphs = [...doc.getElementsByTagName('w:p')];
  if (!paragraphs.length) return null;
  return paragraphs.map(p => {
    const runs = [...p.getElementsByTagName('w:t')].map(t => t.textContent).join('');
    return '<p>' + escapeHtml(runs) + '</p>';
  }).join('') || null;
}

async function tryDocxText(buffer) {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const bytes = await readZipEntry(buffer, 'word/document.xml');
    if (!bytes) return null;
    return docxXmlToHtml(new TextDecoder('utf-8').decode(bytes));
  } catch (err) {
    return null;
  }
}

/* ---------- Binary sniff ---------- */

function looksBinary(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return true;
  return false;
}

function safePreview(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
      .replace(/[^\t\n\r\x20-\x7E -￿]/g, '·').slice(0, 2000);
  } catch (err) {
    return '(binary data)';
  }
}

/* ---------- Reading one File into a new Write document ---------- */

const LARGE_FILE_BYTES = 5 * 1024 * 1024;

function cleanFileName(name, ext) {
  let n = String(name || 'document').replace(/[\\/:*?"<>|]/g, '-').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'document';
  n = n.replace(/\.(md|markdown|mdown|mkd|txt|text|html?|docx?|json|csv|tsv|xlsx?|xlsm|xlsb|ods|pdf|rtf)$/i, '');
  return n + ext;
}

async function openOneFile(file) {
  const name = file.name || 'Untitled document';
  if (file.size > LARGE_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    if (!confirm('“' + name + '” is ' + mb + ' MB — that’s large for a document. Open it anyway?')) return null;
  }
  const kind = fileKind(name, file.type);
  const common = { name, originalName: name, originalType: file.type || '', originalBlobOrText: file };

  if (kind === 'pdf' || kind === 'sheet') {
    const buffer = await file.arrayBuffer();
    const made = await convert(buffer, name, kind);
    const rec = await addWriteDoc({ ...common, html: textToHtml(made.content, 'markdown'), source: kind });
    return rec.id;
  }

  if (kind === 'docx') {
    const buffer = await file.arrayBuffer();
    const extracted = await tryDocxText(buffer);
    const html = extracted != null ? extracted : textToHtml(await file.text(), 'text');
    const rec = await addWriteDoc({ ...common, html, source: 'docx' });
    return rec.id;
  }

  if (kind !== 'html' && kind !== 'markdown' && kind !== 'csv' && kind !== 'rtf' && kind !== 'code' && kind !== 'text') {
    /* 'unknown' — sniff the first 8KB for the NUL bytes a binary file has. */
    const head = await file.slice(0, 8192).arrayBuffer();
    if (looksBinary(head)) {
      const notice = '<p><strong>This looks like a binary file</strong> (' + escapeHtml(name) +
        (file.size ? ', ' + formatSize(file.size) : '') + '). Folio can’t show it as text, ' +
        'but here’s a safe preview of what’s in it — the original is kept for “Download original”.</p>';
      const rec = await addWriteDoc({ ...common, html: notice + textToHtml(safePreview(head), 'code'), source: 'binary' });
      return rec.id;
    }
  }

  const text = await file.text();
  const rec = await addWriteDoc({ ...common, html: textToHtml(text, kind === 'unknown' ? 'text' : kind), source: 'file' });
  return rec.id;
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** Open one or more files as new Write documents; the last one opened
    becomes the visible one. Used by the toolbar/rail/shortcut picker here,
    and by main.js for a drop outside the sheet while Write is active. */
export async function openFilesAsWriteDocs(files) {
  const list = [...(files || [])].slice(0, 8);
  let lastId = null;
  for (const file of list) {
    try {
      const id = await openOneFile(file);
      if (id) lastId = id;
    } catch (err) {
      console.warn('Folio: could not open file for Write', err);
      toast('Couldn’t open “' + (file && file.name || 'that file') + '”.');
    }
  }
  if (lastId && CTX && CTX.openDoc) CTX.openDoc(lastId);
  return lastId;
}

/* ---------- Download: standalone HTML, Markdown, text, Word, print ---------- */

function fontStack(key) {
  const f = WRITE_FONTS.find(x => x.key === key);
  return (f || WRITE_FONTS[0]).stack;
}

function standaloneHtml(doc) {
  const tint = (doc.page && doc.page.tint) || 'white';
  const width = { narrow: '560px', wide: '920px', full: 'none' }[(doc.page && doc.page.width) || 'normal'] || '720px';
  const bg = tint === 'dark' ? '#20242a' : tint === 'cream' ? '#fbf6ea' : '#ffffff';
  const ink = tint === 'dark' ? '#dee3e8' : '#171a1d';
  const inkSoft = tint === 'dark' ? '#a4adb6' : '#4b545c';
  const line = tint === 'dark' ? '#333c45' : '#dfe3e7';
  const css = 'body{margin:0;background:' + (tint === 'dark' ? '#0f1216' : '#eceef0') + ';display:flex;justify-content:center;padding:40px 20px}' +
    '.page{max-width:' + width + ';width:100%;background:' + bg + ';color:' + ink + ';border-radius:4px;' +
    'box-shadow:0 1px 2px rgba(16,22,28,.08),0 8px 24px -16px rgba(16,22,28,.3);padding:56px 64px;' +
    'font-family:' + fontStack(doc.font) + ';font-size:16px;line-height:28px;box-sizing:border-box}' +
    '.page h1,.page h2,.page h3{font-weight:700;letter-spacing:-.018em;margin:0 0 28px}' +
    '.page h1{font-size:1.9em}.page h2{font-size:1.5em}.page h3{font-size:1.2em}' +
    '.page p{margin:0 0 28px}' +
    '.page blockquote{margin:0 0 28px;padding:0 0 0 18px;border-left:2px solid ' + inkSoft + ';color:' + inkSoft + '}' +
    '.page pre{margin:0 0 28px;padding:20px;background:#0d1117;color:#e6edf3;border-radius:8px;overflow-x:auto;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}' +
    '.page code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;' +
    'background:rgba(31,95,125,.12);padding:.15em .35em;border-radius:5px}' +
    '.page pre code{background:none;padding:0}' +
    '.page ul,.page ol{margin:0 0 28px;padding-left:1.4em}' +
    '.page hr{border:0;border-top:1px solid ' + line + ';margin:27px 0}' +
    '.page table{border-collapse:collapse;margin:0 0 28px;width:100%}' +
    '.page td,.page th{border:1px solid ' + line + ';padding:7px 8px;vertical-align:top}' +
    '.page img{max-width:100%;height:auto;display:block;margin:0 0 28px;border-radius:8px}' +
    '.page mark{border-radius:3px;padding:0 .1em;color:#171a1d}';
  return '<!doctype html>\n<html><head><meta charset="utf-8"><title>' + escapeHtml(doc.name || 'Document') +
    '</title><style>' + css + '</style></head><body><article class="page">' + (doc.html || '') + '</article></body></html>\n';
}

function wordHtml(doc) {
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" ' +
    'xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>' + escapeHtml(doc.name || 'Document') +
    '</title><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom>' +
    '<w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->' +
    '<style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt;color:#000}' +
    'table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px}' +
    'blockquote{border-left:2px solid #999;margin:0;padding-left:12px;color:#444}</style>' +
    '</head><body>' + (doc.html || '') + '</body></html>';
}

function download(name, text, mime) {
  downloadBlob(name, text, mime);
  toast('Downloaded “' + name + '”.');
}

function downloadOriginal(doc) {
  const original = doc.originalBlobOrText;
  if (!original) { toast('There’s no original file for this document.'); return; }
  const name = doc.originalName || (doc.name + '.txt');
  if (typeof Blob !== 'undefined' && original instanceof Blob) {
    const url = URL.createObjectURL(original);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Downloaded “' + name + '”.');
  } else {
    download(name, String(original), doc.originalType || 'text/plain');
  }
}

async function copyHtml(doc) {
  try { await navigator.clipboard.writeText(doc.html || ''); toast('Copied as HTML.'); }
  catch (err) { toast('Your browser blocked the copy.'); }
}
async function copyMarkdown(doc) {
  try { await navigator.clipboard.writeText(htmlToMarkdown(doc.html || '')); toast('Copied as Markdown.'); }
  catch (err) { toast('Your browser blocked the copy.'); }
}

function printDoc() {
  if (CTX && CTX.saveNow) CTX.saveNow();
  window.print();
}

/* ---------- The toolbar/rail/menu chrome ---------- */

let CTX = null;

const IO_ICONS = {
  open: 'M12 4v9m0 0-3.3-3.3M12 13l3.3-3.3M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
  download: 'M12 4v10m0 0-3.3-3.3M12 14l3.3-3.3M5 17v2A1.5 1.5 0 0 0 6.5 20.5h11A1.5 1.5 0 0 0 19 19v-2',
  html: 'M4 4.5h16v15H4z M8.5 10 6.7 12l1.8 2 M15.5 10l1.8 2-1.8 2 M11.3 9 9.7 15',
  markdown: 'M4.5 5.5h15v13h-15z M7.5 15V9l2.5 2.7L12.5 9v6 M16.5 9v6 M14.7 12.2 16.5 14l1.8-1.8',
  text: 'M5 6h14M5 12h14M5 18h9',
  doc: 'M6.5 3.5h7l4 4V20.5h-11z M13.5 3.5V8h4 M9 12.5h6M9 16h6',
  print: 'M7 8.5V4h10v4.5 M5 8.5h14a2 2 0 0 1 2 2V16h-4v4H7v-4H3v-5.5a2 2 0 0 1 2-2z M7 16h10v4H7z',
  original: 'M12 4v10m0 0-3.3-3.3M12 14l3.3-3.3M5 4h5 M5 4v13.5A1.5 1.5 0 0 0 6.5 19H10',
  copy: 'M8.5 8.5h10v10h-10z M5.5 15.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1'
};
const svgIcon = (name) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (IO_ICONS[name] || '') + '"/></svg>';

let fileInputEl = null;
function pickFiles() {
  if (!fileInputEl) {
    fileInputEl = document.createElement('input');
    fileInputEl.type = 'file';
    fileInputEl.multiple = true;
    fileInputEl.hidden = true;
    fileInputEl.addEventListener('change', () => {
      const files = [...(fileInputEl.files || [])];
      fileInputEl.value = '';
      if (files.length) openFilesAsWriteDocs(files);
    });
    document.body.appendChild(fileInputEl);
  }
  fileInputEl.click();
}

let menuEl = null, menuAnchor = null;
function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'wio-menu';
  menuEl.hidden = true;
  menuEl.setAttribute('role', 'menu');
  document.body.appendChild(menuEl);
  document.addEventListener('mousedown', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== menuAnchor) closeMenu();
  });
  return menuEl;
}
function closeMenu() { if (menuEl) menuEl.hidden = true; }
function menuItems(doc) {
  const items = [
    { label: 'Download as HTML', hint: '.html', icon: 'html', run: () => doc && download(cleanFileName(doc.name, '.html'), standaloneHtml(doc), 'text/html') },
    { label: 'Download as Markdown', hint: '.md', icon: 'markdown', run: () => doc && download(cleanFileName(doc.name, '.md'), htmlToMarkdown(doc.html || ''), 'text/markdown') },
    { label: 'Download as text', hint: '.txt', icon: 'text', run: () => doc && download(cleanFileName(doc.name, '.txt'), htmlToPlainText(doc.html || ''), 'text/plain') },
    { label: 'Download as Word', hint: '.doc', icon: 'doc', run: () => doc && download(cleanFileName(doc.name, '.doc'), wordHtml(doc), 'application/msword') },
    { label: 'Print / Save as PDF', hint: '⌘P', icon: 'print', run: printDoc },
    { label: 'Copy as HTML', hint: '', icon: 'copy', run: () => doc && copyHtml(doc) },
    { label: 'Copy as Markdown', hint: '', icon: 'copy', run: () => doc && copyMarkdown(doc) }
  ];
  if (doc && doc.originalBlobOrText) {
    items.push({ label: 'Download original', hint: doc.originalName || '', icon: 'original', run: () => downloadOriginal(doc) });
  }
  return items;
}
function openMenu(anchorBtn) {
  const menu = ensureMenu();
  const doc = CTX && CTX.getDoc();
  menu.innerHTML = '';
  menuItems(doc).forEach(item => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wio-item';
    b.setAttribute('role', 'menuitem');
    b.innerHTML = svgIcon(item.icon) + '<span class="wio-item-label">' + escapeHtml(item.label) + '</span>' +
      (item.hint ? '<span class="wio-item-hint">' + escapeHtml(item.hint) + '</span>' : '');
    b.addEventListener('click', () => { closeMenu(); item.run(); });
    menu.appendChild(b);
  });
  menu.hidden = false;
  menuAnchor = anchorBtn;
  const rect = anchorBtn.getBoundingClientRect();
  const top = Math.min(rect.bottom + 6, innerHeight - 80);
  const left = Math.max(8, Math.min(rect.left, innerWidth - 260));
  menu.style.top = Math.round(top) + 'px';
  menu.style.left = Math.round(left) + 'px';
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll('.wio-item')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[at + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[at - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchorBtn.focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  const first = menu.querySelector('.wio-item');
  if (first) first.focus();
}
function toggleMenu(anchorBtn) {
  if (menuEl && !menuEl.hidden && menuAnchor === anchorBtn) closeMenu();
  else openMenu(anchorBtn);
}

/**
 * `init(ctx)` is called once, when ui/write-view.js builds its DOM — see the
 * ctx contract documented at the top of that file.
 */
export function init(ctx) {
  CTX = ctx;

  ctx.registerToolbarButton('file', { title: 'Open a file (⌘O)', icon: svgIcon('open'), run: pickFiles });
  const dlBtn = ctx.registerToolbarButton('file', {
    title: 'Download or print (⇧⌘S)', icon: svgIcon('download'), run: () => toggleMenu(dlBtn)
  });

  ctx.registerShortcut('mod+o', pickFiles);
  ctx.registerShortcut('mod+shift+s', () => toggleMenu(dlBtn));
  ctx.registerShortcut('mod+p', printDoc);

  const railBtn = document.getElementById('writeOpenFile');
  if (railBtn) railBtn.addEventListener('click', pickFiles);

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuEl && !menuEl.hidden) closeMenu();
  });
}
