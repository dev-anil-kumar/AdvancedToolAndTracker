/**
 * Extension hook — images (Phase 2, Agent B).
 *
 * Owns: a toolbar button + slash item that open a file picker; paste
 * (handed to us by features/write/paste.js) and drag-drop straight onto the
 * sheet; downscaling a huge image on insert; and, once an image is
 * selected, a small floating toolbar (size, alignment, alt text, delete)
 * plus a drag handle for a free-form resize.
 *
 * Images are stored the simplest way that works for a document that is
 * itself just stored HTML (features/writedocs.js): as an inline `data:`
 * URL on the `<img>` itself, downscaled first so a phone photo does not
 * turn a document into megabytes of base64. That is a deliberate
 * difference from features/note-images.js, whose notes are Markdown and so
 * need a separate image store to keep the text short — a Write document
 * has no such constraint.
 */
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from '../../core/config.js';

const MAX_DIM = 1600;                              // px, the longest side an inserted image may keep
const SIZE_PRESETS = { s: 240, m: 420, l: 640 };    // px, target width per preset

const ICON_PATHS = {
  image: 'M4 5.5h16v13H4zM4 15l4.5-4.5L11 13l4-4 5 5.5M9 9.2a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2',
  alignLeft: 'M4 6h16M4 12h10M4 18h13',
  alignCenter: 'M4 6h16M7 12h10M5.5 18h13',
  alignRight: 'M4 6h16M10 12h10M6.5 18h13',
  trash: 'M5 7h14M9 7V5.2c0-.7.6-1.2 1.2-1.2h3.6c.6 0 1.2.5 1.2 1.2V7M7 7l1 12.4c0 .9.8 1.6 1.7 1.6h4.6c.9 0 1.7-.7 1.7-1.6L18 7'
};
function icon(name) {
  const d = ICON_PATHS[name] || '';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
}

/* ---------- Module state ---------- */
let fileInput = null;
let currentImg = null;      // the selected <img>, or null
let toolbarEl = null;
let handleEl = null;
let altInput = null;

/* ---------- Reading a file into something insertable ---------- */

function readAsDataUrl(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(String(reader.result || ''));
    reader.onerror = () => rej(new Error('That image could not be read.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('That image could not be decoded.'));
    img.src = src;
  });
}

/** Shrink to MAX_DIM on the longest side via canvas; leaves small images alone. */
async function downscale(file, type) {
  const dataUrl = await readAsDataUrl(file);
  const decoded = await loadImage(dataUrl);
  const w = decoded.naturalWidth, h = decoded.naturalHeight;
  if (!w || !h || (w <= MAX_DIM && h <= MAX_DIM)) return dataUrl;
  const scale = MAX_DIM / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const g = canvas.getContext('2d');
  g.drawImage(decoded, 0, 0, canvas.width, canvas.height);
  const mime = type === 'image/png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(mime, 0.86);
}

/**
 * Animated GIF and vector SVG lose the thing that makes them useful if
 * pushed through a canvas (the animation, the infinite resolution), so
 * they are kept as-is; everything else is downscaled if it is bigger than
 * the sheet could ever usefully show.
 */
function toInsertableDataUrl(file, type) {
  if (type === 'image/gif' || type === 'image/svg+xml') return readAsDataUrl(file);
  return downscale(file, type);
}

/**
 * Read a File, downscale it if needed, and insert it at the caret. Shared
 * with features/write/paste.js, which calls this for an image found on the
 * clipboard.
 */
export async function insertImageFile(file, ctx) {
  const type = String(file.type || '').toLowerCase();
  if (!IMAGE_TYPES.includes(type)) {
    ctx.toast('“' + (file.name || 'That file') + '” isn’t an image Folio can show.');
    return;
  }
  if (file.size > IMAGE_MAX_BYTES) {
    ctx.toast('That image is too large to insert here.');
    return;
  }
  let dataUrl;
  try {
    dataUrl = await toInsertableDataUrl(file, type);
  } catch (err) {
    ctx.toast('That image could not be read.');
    return;
  }
  insertImageHtml(dataUrl, file.name || '', ctx);
}

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

function insertImageHtml(dataUrl, name, ctx) {
  const alt = escapeAttr(String(name || 'image').replace(/\.[a-z0-9]+$/i, ''));
  const html = '<img class="write-img" data-size="m" data-align="none" src="' + dataUrl + '" alt="' + alt + '">';
  ctx.sheet.focus();
  let ok = false;
  try { ok = document.execCommand('insertHTML', false, html); } catch (err) { ok = false; }
  if (!ok) {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (range && ctx.sheet.contains(range.commonAncestorContainer)) {
      range.deleteContents();
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const node = wrap.firstChild;
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      ctx.sheet.insertAdjacentHTML('beforeend', html);
    }
  }
  ctx.sheet.dispatchEvent(new Event('input', { bubbles: true }));

  // The freshly-inserted <img> is the last one still at its default preset;
  // snapping its height needs naturalWidth/Height, so wait for it to decode
  // if it has not already.
  const inserted = [...ctx.sheet.querySelectorAll('img.write-img[data-size="m"]')].pop();
  if (inserted) {
    if (inserted.complete) applyPreset(inserted, 'm', ctx);
    else inserted.addEventListener('load', () => applyPreset(inserted, 'm', ctx), { once: true });
  }
}

/* ---------- Picker, paste target, drag-drop ---------- */

function pickFile(ctx) {
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = IMAGE_TYPES.join(',');
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      [...fileInput.files].forEach(f => insertImageFile(f, ctx));
      fileInput.value = '';
    });
    document.body.appendChild(fileInput);
  }
  fileInput.click();
}

function hasImageFiles(dt) {
  if (!dt) return false;
  const files = dt.files ? [...dt.files] : [];
  if (files.some(f => IMAGE_TYPES.includes(String(f.type || '').toLowerCase()))) return true;
  const items = dt.items ? [...dt.items] : [];
  return items.some(it => it.kind === 'file' && /^image\//.test(it.type));
}

/** Drag-drop onto the sheet. Only image files are ours to take; anything
    else is left alone so main.js's own window drop handler still opens it
    as a document, same as dropping it anywhere else in the app. */
function onDrop(e, ctx) {
  const dt = e.dataTransfer;
  if (!hasImageFiles(dt)) return;
  e.preventDefault();
  e.stopPropagation();
  const files = dt.files ? [...dt.files].filter(f => IMAGE_TYPES.includes(String(f.type || '').toLowerCase())) : [];
  files.forEach(f => insertImageFile(f, ctx));
}

/* ---------- Selection: floating toolbar + resize handle ---------- */

function buildImageUi(ctx) {
  if (toolbarEl) return;

  toolbarEl = document.createElement('div');
  toolbarEl.className = 'write-img-toolbar';
  toolbarEl.hidden = true;
  toolbarEl.addEventListener('mousedown', e => e.preventDefault());

  [['s', 'S'], ['m', 'M'], ['l', 'L'], ['full', 'Full']].forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'wt-btn'; b.textContent = label; b.title = 'Size: ' + label;
    b.addEventListener('click', () => {
      if (!currentImg) return;
      applyPreset(currentImg, key, ctx);
      afterChange(ctx);
    });
    toolbarEl.appendChild(b);
  });

  [['left', 'alignLeft'], ['center', 'alignCenter'], ['right', 'alignRight']].forEach(([key, iconName]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'wt-btn'; b.innerHTML = icon(iconName); b.title = 'Align ' + key;
    b.addEventListener('click', () => {
      if (!currentImg) return;
      currentImg.dataset.align = currentImg.dataset.align === key ? 'none' : key;
      afterChange(ctx);
    });
    toolbarEl.appendChild(b);
  });

  altInput = document.createElement('input');
  altInput.type = 'text'; altInput.className = 'write-img-alt';
  altInput.placeholder = 'Alt text'; altInput.spellcheck = false;
  altInput.addEventListener('change', () => { if (currentImg) { currentImg.alt = altInput.value; afterChange(ctx); } });
  altInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); altInput.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); deselectImage(); ctx.sheet.focus(); }
  });
  toolbarEl.appendChild(altInput);

  const del = document.createElement('button');
  del.type = 'button'; del.className = 'wt-btn'; del.title = 'Delete image'; del.innerHTML = icon('trash');
  del.addEventListener('click', () => {
    if (!currentImg) return;
    const img = currentImg;
    deselectImage();
    img.remove();
    afterChange(ctx);
  });
  toolbarEl.appendChild(del);
  document.body.appendChild(toolbarEl);

  handleEl = document.createElement('div');
  handleEl.className = 'write-img-handle';
  handleEl.hidden = true;
  handleEl.addEventListener('mousedown', (e) => startResize(e, ctx));
  document.body.appendChild(handleEl);
}

function afterChange(ctx) {
  ctx.sheet.dispatchEvent(new Event('input', { bubbles: true }));
  repositionImageUi();
}

function repositionImageUi() {
  if (!currentImg || !toolbarEl) return;
  const r = currentImg.getBoundingClientRect();
  toolbarEl.hidden = false;
  const w = toolbarEl.offsetWidth || 260;
  let top = r.top - toolbarEl.offsetHeight - 8;
  if (top < 8) top = Math.min(r.top + 8, innerHeight - 44);
  const left = Math.max(8, Math.min(innerWidth - w - 8, r.left));
  toolbarEl.style.top = Math.round(top) + 'px';
  toolbarEl.style.left = Math.round(left) + 'px';
  handleEl.hidden = false;
  handleEl.style.top = Math.round(r.bottom - 7) + 'px';
  handleEl.style.left = Math.round(r.right - 7) + 'px';
}

function selectImage(img, ctx) {
  currentImg = img;
  img.classList.add('write-img-selected');
  buildImageUi(ctx);
  altInput.value = img.alt || '';
  toolbarEl.hidden = false;
  repositionImageUi();
}

/**
 * Deselect whatever image is selected and hide its floating toolbar/handle.
 * Exported so ui/write-view.js can call it when switching documents or
 * closing the sheet — the old `<img>` (and the position the toolbar was
 * floating at) belongs to a sheet that is about to disappear.
 */
export function deselectImage() {
  if (currentImg) currentImg.classList.remove('write-img-selected');
  currentImg = null;
  if (toolbarEl) toolbarEl.hidden = true;
  if (handleEl) handleEl.hidden = true;
}

function isInsideImageUi(node) {
  return (toolbarEl && toolbarEl.contains(node)) ||
         (handleEl && handleEl.contains(node)) ||
         (currentImg && currentImg.contains(node));
}

/** Snap a preset width to a height in whole multiples of --line-h — simple
    on purpose: a fixed crop (object-fit: cover) rather than true reflow. */
function applyPreset(img, key, ctx) {
  img.dataset.size = key;
  if (key === 'full') {
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.objectFit = '';
    return;
  }
  const target = SIZE_PRESETS[key];
  const naturalW = img.naturalWidth || target;
  const naturalH = img.naturalHeight || Math.round(target * 0.6);
  const lineH = parseFloat(getComputedStyle(ctx.pageEl).getPropertyValue('--line-h')) || 28;
  const rawH = naturalH * (target / naturalW);
  const snapped = Math.max(lineH, Math.round(rawH / lineH) * lineH);
  img.style.width = target + 'px';
  img.style.height = snapped + 'px';
  img.style.objectFit = 'cover';
}

/** Drag the corner handle: a free-form resize, aspect-locked, unsnapped. */
function startResize(e, ctx) {
  e.preventDefault();
  e.stopPropagation();
  if (!currentImg) return;
  const img = currentImg;
  const startX = e.clientX;
  const startRect = img.getBoundingClientRect();
  const aspect = (img.naturalWidth && img.naturalHeight)
    ? img.naturalHeight / img.naturalWidth
    : (startRect.height / (startRect.width || 1) || 0.6);
  img.dataset.size = 'custom';
  img.style.objectFit = '';

  function onMove(ev) {
    const w = Math.max(60, Math.round(startRect.width + (ev.clientX - startX)));
    img.style.width = w + 'px';
    img.style.height = Math.round(w * aspect) + 'px';
    repositionImageUi();
  }
  function onUp() {
    removeEventListener('mousemove', onMove);
    removeEventListener('mouseup', onUp);
    afterChange(ctx);
  }
  addEventListener('mousemove', onMove);
  addEventListener('mouseup', onUp);
}

/* ---------- init ---------- */

export function init(ctx) {
  ctx.registerToolbarButton('insert', {
    title: 'Insert an image', icon: icon('image'),
    run: () => pickFile(ctx)
  });
  ctx.registerSlashItem({ key: 'image', label: 'Image', hint: 'From a file', run: () => pickFile(ctx) });

  ctx.sheet.addEventListener('dragover', (e) => { if (hasImageFiles(e.dataTransfer)) e.preventDefault(); });
  ctx.sheet.addEventListener('drop', (e) => onDrop(e, ctx));

  ctx.sheet.addEventListener('click', (e) => {
    const img = e.target && e.target.closest ? e.target.closest('img.write-img') : null;
    if (img && ctx.sheet.contains(img)) selectImage(img, ctx);
    else if (currentImg) deselectImage();
  });
  document.addEventListener('click', (e) => { if (currentImg && !isInsideImageUi(e.target)) deselectImage(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && currentImg) deselectImage(); });
  addEventListener('scroll', repositionImageUi, true);
  addEventListener('resize', repositionImageUi);
}
