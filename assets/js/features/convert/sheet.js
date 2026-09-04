/**
 * Spreadsheet → Markdown.
 *
 * A sheet is already a table, and Markdown already has tables, so this is the
 * happy case: almost nothing is lost. What the conversion has to decide is
 * which row is the header, which columns hold numbers (so they can be set to
 * the right, where numbers are read), and where to stop — a sheet with fifty
 * thousand rows is not a document anybody reads top to bottom.
 *
 * Formulas arrive as their computed values, dates as the sheet formatted them.
 * gridToMarkdown is pure, so all of that judgement is testable on its own.
 */
import { SHEET_COL_MAX, SHEET_ROW_MAX } from '../../core/config.js';
import { plural } from '../../core/format.js';
import { sheetLib } from './loader.js';

const NUMERIC = /^-?[$€£¥]?\s?-?[\d,]+(\.\d+)?\s?%?$/;

/** A cell, safe to put between two pipes. */
function cell(value) {
  const text = value == null ? '' : String(value);
  return text
    .replace(/\|/g, '\\|')
    .replace(/\r\n?|\n/g, '<br>')     // a table row is one line, whatever the cell holds
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Drop the empty rows and columns that trail almost every real sheet. */
export function trimGrid(rows) {
  const grid = (rows || []).map(row => (Array.isArray(row) ? row.map(cell) : [cell(row)]));
  let last = -1;
  grid.forEach((row, i) => { if (row.some(c => c !== '')) last = i; });
  const kept = grid.slice(0, last + 1);
  let width = 0;
  kept.forEach(row => {
    for (let c = row.length - 1; c >= 0; c--) {
      if (row[c] !== '') { width = Math.max(width, c + 1); break; }
    }
  });
  return kept.map(row => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}

/**
 * One sheet as a Markdown table.
 * @returns {{ markdown: string, rows: number, columns: number, clipped: boolean }}
 */
export function gridToMarkdown(rows, name) {
  const grid = trimGrid(rows);
  if (!grid.length || !grid[0].length) {
    return { markdown: '', rows: 0, columns: 0, clipped: false };
  }

  const clippedCols = grid[0].length > SHEET_COL_MAX;
  const width = Math.min(grid[0].length, SHEET_COL_MAX);
  const head = grid[0].slice(0, width).map((text, i) => text || 'Column ' + (i + 1));
  const bodyRows = grid.slice(1);
  const clippedRows = bodyRows.length > SHEET_ROW_MAX;
  const shown = bodyRows.slice(0, SHEET_ROW_MAX).map(row => row.slice(0, width));

  /* Right-align a column when the numbers in it clearly outnumber the words. */
  const aligns = head.map((_, c) => {
    let numbers = 0, filled = 0;
    shown.forEach(row => {
      const text = row[c];
      if (!text) return;
      filled++;
      if (NUMERIC.test(text)) numbers++;
    });
    return filled >= 2 && numbers / filled > 0.8 ? '---:' : '---';
  });

  const line = (cells) => '| ' + cells.join(' | ') + ' |';
  const table = [line(head), line(aligns)].concat(shown.map(row => line(row))).join('\n');

  let markdown = (name ? '## ' + name + '\n\n' : '') +
    '_' + plural(bodyRows.length, 'row', 'rows') + ' × ' + plural(grid[0].length, 'column', 'columns') + '_\n\n' +
    table + '\n';
  if (clippedRows || clippedCols) {
    markdown += '\n*Showing ' + shown.length + ' of ' + bodyRows.length + ' rows' +
      (clippedCols ? ' and ' + width + ' of ' + grid[0].length + ' columns' : '') + '.*\n';
  }
  return {
    markdown,
    rows: bodyRows.length,
    columns: grid[0].length,
    clipped: clippedRows || clippedCols
  };
}

/**
 * Read a workbook into Markdown, one section per sheet.
 * @returns {{ markdown: string, sheets: number, rows: number }}
 */
export async function sheetToMarkdown(buffer, title) {
  const lib = await sheetLib();
  let book;
  try {
    book = lib.read(new Uint8Array(buffer), { type: 'array', cellDates: true, cellText: true });
  } catch (err) {
    throw new Error('That file could not be opened as a spreadsheet.');
  }
  const names = book.SheetNames || [];
  if (!names.length) throw new Error('That workbook has no sheets in it.');

  const parts = [];
  let sheets = 0, rows = 0;
  names.forEach(name => {
    const grid = lib.utils.sheet_to_json(book.Sheets[name], {
      header: 1, raw: false, defval: '', blankrows: false
    });
    const made = gridToMarkdown(grid, names.length > 1 ? name : name);
    if (!made.markdown) return;
    sheets++;
    rows += made.rows;
    parts.push(made.markdown);
  });

  if (!parts.length) throw new Error('Every sheet in that workbook is empty.');
  const heading = title ? '# ' + title + '\n\n' : '';
  return { markdown: heading + parts.join('\n\n'), sheets, rows };
}
