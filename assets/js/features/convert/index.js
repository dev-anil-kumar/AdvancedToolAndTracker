/**
 * Which reader a file belongs to, and turning it into something Folio reads.
 *
 * Everything ends up as Markdown. That is the point: a PDF or a spreadsheet
 * converted here opens in a pane, sits beside other documents, takes notes,
 * exports and reads in focus mode without one line of the reading view knowing
 * that PDFs exist.
 */
import { FILE_KINDS } from '../../core/config.js';
import { pdfToMarkdown } from './pdf.js';
import { sheetToMarkdown } from './sheet.js';

export const extensionOf = (name) => {
  const at = String(name || '').lastIndexOf('.');
  return at > 0 ? String(name).slice(at + 1).toLowerCase() : '';
};

export const baseNameOf = (name) => {
  const file = String(name || '').split(/[\\/]/).pop();
  const at = file.lastIndexOf('.');
  return (at > 0 ? file.slice(0, at) : file) || 'document';
};

/**
 * The reader a file goes to: 'markdown', 'pdf', 'sheet', 'json' or 'unknown'.
 * The extension decides, because it is what the user sees and more dependable
 * than the type a browser guesses; the MIME type is the fallback.
 */
export function sniff(file) {
  const name = typeof file === 'string' ? file : (file && file.name) || '';
  const ext = extensionOf(name);
  for (const kind of Object.keys(FILE_KINDS)) {
    if (FILE_KINDS[kind].includes(ext)) return kind;
  }
  const type = String((file && file.type) || '').toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (/spreadsheet|excel|csv/.test(type)) return 'sheet';
  if (type === 'application/json') return 'json';
  if (type.startsWith('text/')) return 'markdown';
  return 'unknown';
}

/** True when a name or type is something Folio can read at all. */
export const canRead = (file) => sniff(file) !== 'unknown';

/**
 * Read a PDF or a spreadsheet into a document record's worth of fields.
 * Markdown never comes through here — it is already what we want.
 *
 * @param {ArrayBuffer} buffer
 * @param {string} name  the file's name, used for the title
 * @param {'pdf'|'sheet'} kind
 */
export async function convert(buffer, name, kind) {
  if (kind === 'pdf') {
    const made = await pdfToMarkdown(buffer);
    return {
      content: made.markdown,
      kind: 'pdf',
      meta: { pages: made.pages, read: made.read },
      title: made.title || ''
    };
  }
  if (kind === 'sheet') {
    const made = await sheetToMarkdown(buffer, baseNameOf(name));
    return {
      content: made.markdown,
      kind: 'sheet',
      meta: { sheets: made.sheets, rows: made.rows },
      title: ''
    };
  }
  throw new Error('Folio does not read that kind of file.');
}

export { pdfToMarkdown, sheetToMarkdown };
