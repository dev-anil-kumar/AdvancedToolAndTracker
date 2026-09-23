/**
 * Extension hook — paste & drop (Phase 2, Agent B).
 *
 * Owns: sanitising `text/html` paste through a DOMPurify allowlist that
 * keeps a whitelisted subset of inline style; turning Markdown-looking
 * plain text into rich content with `marked`; `Ctrl/⌘+Shift+V` paste as
 * plain text; images pasted onto the sheet, handed off to
 * features/write/images.js (drag-drop is that module's own listener).
 *
 * `sanitizeHtml` and `looksLikeMarkdown` are exported as pure functions —
 * neither touches the sheet — so tests/smoke.mjs can exercise the allowlist
 * and the Markdown heuristic directly. Everything else here is the glue
 * that reads a real `paste` event and inserts the result at the caret.
 *
 * DOMPurify and marked are loaded globally by index.html (see the pinned
 * library scripts near the bottom), the same way assets/js/md/renderer.js
 * uses them — no import needed, just the bare identifiers.
 */
import { insertImageFile } from './images.js';

/* ---------- The paste allowlist ---------- */

const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'br', 'hr', 'img', 'span', 'mark', 'sub', 'sup'
];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'target', 'rel', 'colspan', 'rowspan', 'style'];
const ALLOWED_STYLE_PROPS = [
  'color', 'background-color', 'font-weight', 'font-style',
  'text-decoration', 'text-align', 'font-size', 'font-family'
];

/** Keep only the inline-style declarations this editor understands. */
function filterStyle(value) {
  const kept = [];
  String(value || '').split(';').forEach(decl => {
    const at = decl.indexOf(':');
    if (at < 0) return;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const val = decl.slice(at + 1).trim();
    if (!prop || !val) return;
    if (!ALLOWED_STYLE_PROPS.includes(prop)) return;          // drops mso-*, margin, etc.
    if (/expression|javascript:|url\(/i.test(val)) return;    // no funny business in a value
    kept.push(prop + ':' + val);
  });
  return kept.join(';');
}

function styleFilterHook(node, data) {
  if (data.attrName !== 'style') return;
  data.attrValue = filterStyle(data.attrValue);
  if (!data.attrValue) data.keepAttr = false;
}

/**
 * A handful of Word/Google Docs quirks the tag/attribute allowlist alone
 * cannot express, applied on a detached scratch element before DOMPurify
 * ever sees the markup:
 *   - Word's namespaced `<o:p>` paragraph marker — dropped (its content,
 *     usually just a stray &nbsp;, is harmless left in place).
 *   - Google Docs wraps an entire paste in `<b style="font-weight:normal">`
 *     to "reset" styling; left alone that would bold the whole document, so
 *     it is swapped for a plain `<span>` before the allowlist runs.
 */
function neutralizeQuirks(root) {
  [...root.querySelectorAll('*')].forEach(node => {
    if (/^o:p$/i.test(node.tagName)) { node.remove(); return; }
    if (!/^(B|STRONG)$/.test(node.tagName)) return;
    const fw = (node.style && node.style.fontWeight) || '';
    if (/^(normal|400)$/i.test(fw.trim())) {
      const span = document.createElement('span');
      if (node.getAttribute('style')) span.setAttribute('style', node.getAttribute('style'));
      while (node.firstChild) span.appendChild(node.firstChild);
      node.replaceWith(span);
    }
  });
}

/**
 * Sanitize pasted `text/html` (or Markdown rendered to HTML) down to the
 * semantic subset this editor knows how to keep looking right. Pure: takes
 * a string, returns a string, touches nothing outside a detached element.
 */
export function sanitizeHtml(html) {
  const raw = String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '');   // mso conditional comments, etc.
  const scratch = document.createElement('div');
  scratch.innerHTML = raw;
  neutralizeQuirks(scratch);

  DOMPurify.addHook('uponSanitizeAttribute', styleFilterHook);
  try {
    return DOMPurify.sanitize(scratch.innerHTML, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false
    });
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute');
  }
}

/**
 * Does this plain text look enough like Markdown to be worth rendering as
 * rich content? A handful of block-level signals (heading, fence, table
 * row, quote, list) are strong enough alone; inline signals (a link, bold,
 * inline code) only count once there are two of them, since a single `*`
 * or `(` shows up in ordinary prose too.
 */
export function looksLikeMarkdown(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  const strong = [
    /^#{1,6}\s+\S/m,        // heading
    /```/,                  // fenced code block
    /^\s*\|.*\|\s*$/m,      // table row
    /^\s*>\s?\S/m,          // blockquote
    /^\s*[-*+]\s+\S/m,      // bullet list
    /^\s*\d+\.\s+\S/m       // numbered list
  ];
  if (strong.some(re => re.test(t))) return true;
  const weak = [
    /\[[^\]]+\]\(\S+?\)/,               // [text](url)
    /(\*\*[^*\n]+\*\*|__[^_\n]+__)/,    // **bold** or __bold__
    /`[^`\n]+`/                          // `code`
  ];
  return weak.filter(re => re.test(t)).length >= 2;
}

/* ---------- Plain text → HTML ---------- */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Bare URLs, turned into links — skipped entirely for a forced plain paste. */
function linkify(s) {
  return s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;!?)]/g, (url) => '<a href="' + url + '">' + url + '</a>');
}

function plainTextToHtml(text, { linkify: doLinkify = true } = {}) {
  const paragraphs = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return paragraphs.map(p => {
    const lines = p.split('\n').map(line => {
      const escaped = escapeHtml(line);
      return doLinkify ? linkify(escaped) : escaped;
    });
    return '<p>' + (lines.join('<br>') || '<br>') + '</p>';
  }).join('');
}

/* ---------- Inserting at the caret ---------- */

/** Splice `html` in by hand, for the (rare) browser that refuses execCommand. */
function manualInsert(html, ctx) {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !ctx.sheet.contains(range.commonAncestorContainer)) {
    ctx.sheet.insertAdjacentHTML('beforeend', html);
    return;
  }
  range.deleteContents();
  const frag = document.createElement('div');
  frag.innerHTML = html;
  let last = null;
  [...frag.childNodes].forEach(node => { range.insertNode(node); range.setStartAfter(node); last = node; });
  if (last) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

/**
 * Insert already-sanitized HTML at the caret. `execCommand('insertHTML')`
 * is tried first since it is the one path that folds cleanly into the
 * browser's own undo stack; a manual Range splice is the fallback, and
 * either way a synthetic `input` event tells ui/write-view.js to autosave
 * and resync the toolbar, exactly as a native keystroke would.
 */
function insertHtmlAtCaret(html, ctx) {
  ctx.sheet.focus();
  let ok = false;
  try { ok = document.execCommand('insertHTML', false, html); } catch (err) { ok = false; }
  if (!ok) manualInsert(html, ctx);
  ctx.sheet.dispatchEvent(new Event('input', { bubbles: true }));
}

function insertPlainText(text, ctx, opts) {
  const html = !opts || opts.linkify !== false ? plainTextToHtml(text) : plainTextToHtml(text, { linkify: false });
  insertHtmlAtCaret(html, ctx);
}

function insertSmartText(text, ctx) {
  const html = looksLikeMarkdown(text) && typeof marked !== 'undefined'
    ? sanitizeHtml(marked.parse(text))
    : plainTextToHtml(text);
  insertHtmlAtCaret(html, ctx);
}

/* ---------- Paste event ---------- */

async function onPaste(e, ctx) {
  const dt = e.clipboardData;
  if (!dt) return;   // no way to see the clipboard — let the browser do its default thing

  if (plainNext) {
    plainNext = false;
    e.preventDefault();
    const text = dt.getData('text/plain');
    if (text) insertPlainText(text, ctx, { linkify: false });
    return;
  }

  const imageFiles = [...(dt.items || [])]
    .filter(it => it.kind === 'file' && /^image\//.test(it.type))
    .map(it => it.getAsFile())
    .filter(Boolean);
  if (imageFiles.length) {
    e.preventDefault();
    for (const file of imageFiles) await insertImageFile(file, ctx);
    return;
  }

  const html = dt.getData('text/html');
  if (html && html.trim()) {
    e.preventDefault();
    insertHtmlAtCaret(sanitizeHtml(html), ctx);
    return;
  }

  const text = dt.getData('text/plain');
  if (text) {
    e.preventDefault();
    insertSmartText(text, ctx);
  }
}

/**
 * `Ctrl/⌘+Shift+V` — bypass every smart conversion and paste literal text.
 * The shortcut itself doesn't have clipboard data (only a real `paste`
 * event does), so it can't insert anything directly. Reading the clipboard
 * via `navigator.clipboard.readText()` would work but triggers a permission
 * prompt; instead this leaves the key combo's default behaviour alone (see
 * `registerShortcut`'s `preventDefault: false` below) so the browser's own
 * paste follows right behind it, and arms a one-shot flag that tells the
 * very next `paste` event — which is that native paste — to treat the
 * clipboard as plain text instead of running it through the usual
 * HTML/Markdown handling. The flag has a short expiry so a shortcut that
 * for some reason isn't followed by a paste doesn't leak into a later one.
 */
let plainNext = false;
let plainNextTimer = null;
function pasteAsPlainText() {
  plainNext = true;
  clearTimeout(plainNextTimer);
  plainNextTimer = setTimeout(() => { plainNext = false; }, 1000);
}

export function init(ctx) {
  ctx.sheet.addEventListener('paste', (e) => { onPaste(e, ctx); });
  ctx.registerShortcut('mod+shift+v', pasteAsPlainText, { preventDefault: false });
}
