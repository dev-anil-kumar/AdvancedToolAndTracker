/**
 * The note editor: the dialog behind *New note*.
 *
 * The body is plain Markdown in a textarea, because that is the format the
 * rest of the app already reads and the one a note can be exported as without
 * losing anything. Images are the only part that needs machinery: whichever
 * way one arrives — the file picker, a paste, a drop — it is stored once and a
 * reference to it is written at the caret, so the text stays legible.
 *
 * Opening the dialog for an existing note is the same code path with the
 * fields filled in; features/notes.js treats a save with an id as a rewrite.
 */
import { IMAGE_MAX_BYTES } from '../core/config.js';
import { $, el } from '../core/dom.js';
import { formatBytes, plural } from '../core/format.js';
import { imageById, noteById } from '../core/state.js';
import { addImage, imageMarkdown, pruneImages, refsIn } from '../features/note-images.js';
import { saveOwnNote } from '../features/notes.js';

const dlg = $('#noteDlg');
const body = $('#noteBody');
const title = $('#noteTitle');
let editingId = null;
let busy = false;

/** Open the editor, empty or on an existing note of your own. */
export function openNoteEditor(id) {
  const note = id ? noteById(id) : null;
  editingId = note ? note.id : null;
  $('#noteDlgTitle').textContent = note ? 'Edit note' : 'New note';
  $('#noteSave').textContent = note ? 'Save changes' : 'Save note';
  title.value = note ? note.title || '' : '';
  body.value = note ? note.body || '' : '';
  $('#noteErr').textContent = '';
  renderThumbs();

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  setTimeout(() => (note ? body : title).focus(), 30);
}

/* ---------- Images ---------- */

/** Put an image reference where the caret is, and keep typing from there. */
function insertAtCaret(text) {
  const at = body.selectionStart == null ? body.value.length : body.selectionStart;
  const end = body.selectionEnd == null ? at : body.selectionEnd;
  const before = body.value.slice(0, at);
  const after = body.value.slice(end);
  /* An image wants a blank line of its own, unless it is already at one. */
  const lead = !before || /\n\n$/.test(before) ? '' : (/\n$/.test(before) ? '\n' : '\n\n');
  const tail = after.startsWith('\n') ? '' : '\n';
  body.value = before + lead + text + tail + after;
  const caret = (before + lead + text + tail).length;
  body.selectionStart = body.selectionEnd = caret;
  body.focus();
  renderThumbs();
}

async function take(files) {
  const pictures = [...files].filter(f => f && /^image\//.test(f.type || ''));
  if (!pictures.length) {
    fail('That was not an image. PNG, JPEG, GIF, WebP, SVG and AVIF work, up to ' +
      formatBytes(IMAGE_MAX_BYTES) + ' each.');
    return;
  }
  if (busy) return;
  busy = true;
  $('#noteErr').textContent = '';
  for (const file of pictures) {
    try {
      insertAtCaret(imageMarkdown(await addImage(file)));
    } catch (err) {
      fail(err.message || String(err));
    }
  }
  busy = false;
}

const fail = (message) => { $('#noteErr').textContent = message; };

/** The images this note refers to, as a strip you can remove one from. */
function renderThumbs() {
  const strip = $('#noteThumbs');
  const ids = refsIn(body.value);
  strip.innerHTML = '';
  strip.hidden = ids.length === 0;
  $('#noteCount').textContent = [
    body.value.trim() ? plural(body.value.length, 'character', 'characters') : '',
    ids.length ? plural(ids.length, 'image', 'images') : ''
  ].filter(Boolean).join(' · ');

  ids.forEach(id => {
    const rec = imageById(id);
    const item = el('div', 'note-thumb' + (rec ? '' : ' missing'));
    if (rec) {
      const img = el('img');
      img.src = rec.data;
      img.alt = rec.name;
      img.loading = 'lazy';
      item.appendChild(img);
    } else {
      item.appendChild(el('span', 'gone', 'missing'));
    }
    const drop = el('button', 'note-thumb-x', '×');
    drop.type = 'button';
    drop.title = rec ? 'Remove ' + rec.name : 'Remove this reference';
    drop.setAttribute('aria-label', 'Remove ' + (rec ? rec.name : 'this image'));
    drop.addEventListener('click', () => {
      /* Take out the whole image line, reference and all. */
      body.value = body.value
        .replace(new RegExp('!\\[[^\\]]*\\]\\(folio-img:' + id + '\\)\\n?\\n?', 'g'), '')
        .replace(new RegExp('folio-img:' + id, 'g'), '');
      renderThumbs();
      body.focus();
    });
    item.appendChild(drop);
    if (rec) item.title = rec.name + ' · ' + formatBytes(rec.size);
    strip.appendChild(item);
  });
}

/* ---------- Wiring ---------- */

$('#noteAddImage').addEventListener('click', () => $('#noteImageInput').click());
$('#noteImageInput').addEventListener('change', e => { take(e.target.files); e.target.value = ''; });

body.addEventListener('input', renderThumbs);

/* A screenshot on the clipboard is the quickest way in, so it is handled first. */
body.addEventListener('paste', e => {
  const data = e.clipboardData;
  if (!data) return;
  const files = data.files && data.files.length ? [...data.files]
    : [...(data.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
  const pictures = files.filter(f => /^image\//.test(f.type || ''));
  if (!pictures.length) return;                 // ordinary text paste, untouched
  e.preventDefault();
  take(pictures);
});

/* Dropping on the dialog must not reach the window handler, which would try to
   read the image as a Markdown document. */
let depth = 0;
const dropZone = $('#noteDrop');
dlg.addEventListener('dragenter', e => {
  e.preventDefault();
  e.stopPropagation();
  depth++;
  dropZone.hidden = false;
});
dlg.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
dlg.addEventListener('dragleave', e => {
  e.stopPropagation();
  depth = Math.max(0, depth - 1);
  if (!depth) dropZone.hidden = true;
});
dlg.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  depth = 0;
  dropZone.hidden = true;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) take(e.dataTransfer.files);
});

$('#noteForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!body.value.trim() && !title.value.trim()) {
    fail('Nothing written yet.');
    return;
  }
  await saveOwnNote({ id: editingId, title: title.value, body: body.value });
  dlg.close();
  title.value = '';
  body.value = '';
  editingId = null;
});

/* Cancelling leaves any pictures that were added behind; sweep them up. */
dlg.addEventListener('close', () => { pruneImages(); });

$('#noteForm').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    $('#noteForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
});
