/**
 * Fetching a library the moment it is first needed, and never again.
 *
 * pdf.js and SheetJS are pinned like every other dependency, but they are not
 * in index.html: between them they are some ten times the size of Folio, and
 * most sessions never open a PDF or a spreadsheet. So they arrive as ordinary
 * classic scripts the first time a file needs one, and the promise is cached —
 * a second PDF waits on the same load rather than starting another.
 *
 * A library that is already on the page is used as it stands, which is also
 * what lets the tests supply their own.
 */
import { PDF_LIB, PDF_WORKER, SHEET_LIB } from '../../core/config.js';

const loading = new Map();

/** Load a script once. Rejects with something worth showing the reader. */
export function loadScript(url) {
  if (loading.has(url)) return loading.get(url);
  const job = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('No document to load into.')); return; }
    const tag = document.createElement('script');
    tag.src = url;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => {
      loading.delete(url);        // let a later attempt try again
      reject(new Error('Couldn’t load the reader for this file type. Check your connection.'));
    };
    document.head.appendChild(tag);
  });
  loading.set(url, job);
  return job;
}

/** pdf.js, with its worker pointed at the matching pinned build. */
export async function pdfLib() {
  if (typeof self.pdfjsLib === 'undefined') await loadScript(PDF_LIB);
  const lib = self.pdfjsLib;
  if (!lib) throw new Error('The PDF reader did not load.');
  /* Without a worker pdf.js parses on the main thread and freezes the tab. */
  if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  }
  return lib;
}

export async function sheetLib() {
  if (typeof self.XLSX === 'undefined') await loadScript(SHEET_LIB);
  const lib = self.XLSX;
  if (!lib) throw new Error('The spreadsheet reader did not load.');
  return lib;
}
