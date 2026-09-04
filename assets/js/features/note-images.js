/**
 * Images inside notes.
 *
 * A note is Markdown, so an image has to be something Markdown can refer to.
 * Storing the picture inside the note's text would work — a `data:` URL is a
 * legal image source — but a note carrying three screenshots would then be
 * eight megabytes of base64 that has to be re-read and re-parsed every time
 * the Notes page draws. So the pictures live in their own store and the note
 * refers to them:
 *
 *     ![Screenshot](folio-img:9f2c…)
 *
 * `resolve()` swaps those references for the real data URL just before the
 * Markdown is parsed, which keeps md/renderer.js unaware of any of this and
 * keeps the note's text short enough to read and edit by hand.
 */
import { emit, EVENTS } from '../core/bus.js';
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from '../core/config.js';
import { dbDel, dbPut, persist } from '../core/db.js';
import { uid } from '../core/dom.js';
import { formatBytes } from '../core/format.js';
import { imageById, images, notes, setImages } from '../core/state.js';

const REF = /folio-img:([A-Za-z0-9_-]+)/g;
export const imageRef = (id) => 'folio-img:' + id;

/** The Markdown that puts an image in a note. */
export function imageMarkdown(rec) {
  const alt = String(rec.name || 'image').replace(/[[\]]/g, '').slice(0, 80);
  return '![' + alt + '](' + imageRef(rec.id) + ')';
}

/** Every image id a piece of Markdown refers to. */
export function refsIn(markdown) {
  const found = new Set();
  String(markdown || '').replace(REF, (whole, id) => { found.add(id); return whole; });
  return [...found];
}

/**
 * Markdown with every reference replaced by the picture itself. An id with no
 * image behind it is left alone rather than blanked, so a broken reference
 * shows up as a broken image instead of vanishing silently.
 */
export function resolve(markdown) {
  return String(markdown || '').replace(REF, (whole, id) => {
    const rec = imageById(id);
    return rec && rec.data ? rec.data : whole;
  });
}

/** Read a File into a stored image record. Rejects with a readable message. */
export async function addImage(file) {
  const type = String(file.type || '').toLowerCase();
  if (!IMAGE_TYPES.includes(type)) {
    throw new Error('“' + (file.name || 'that file') + '” is not an image Folio can show.');
  }
  if (file.size > IMAGE_MAX_BYTES) {
    throw new Error('That image is ' + formatBytes(file.size) + ' — the limit is ' +
      formatBytes(IMAGE_MAX_BYTES) + '.');
  }
  const data = await readAsDataUrl(file);
  const rec = {
    id: uid(),
    name: (file.name || 'image').slice(0, 120),
    type,
    size: file.size,
    data,
    createdAt: Date.now()
  };
  setImages(images.concat([rec]));
  await persist(dbPut('images', rec));
  return rec;
}

function readAsDataUrl(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(String(reader.result || ''));
    reader.onerror = () => rej(new Error('That image could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Delete every stored image that no note refers to any more.
 *
 * Called after a note is saved or deleted. `spare` holds ids that are in an
 * editor but not yet in a note, so a picture added and then saved a second
 * later is not swept up in between.
 */
export async function pruneImages(spare) {
  const kept = new Set(spare || []);
  notes.forEach(note => refsIn(note.body).forEach(id => kept.add(id)));
  const doomed = images.filter(im => !kept.has(im.id));
  if (!doomed.length) return 0;
  setImages(images.filter(im => kept.has(im.id)));
  for (const im of doomed) await persist(dbDel('images', im.id));
  emit(EVENTS.NOTES);
  return doomed.length;
}

/** What the images in one note add up to, for the note's own byline. */
export function weightOf(markdown) {
  return refsIn(markdown).reduce((sum, id) => {
    const rec = imageById(id);
    return sum + (rec ? rec.size || 0 : 0);
  }, 0);
}
