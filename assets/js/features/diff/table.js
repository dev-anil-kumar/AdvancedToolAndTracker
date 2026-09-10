/**
 * Comparing two delimited files as tables.
 *
 * A CSV is not really lines of text; it is rows of cells, and comparing it as
 * lines gets two things wrong that matter. Insert a column at the front and
 * every line differs, though nothing in the data moved. Sort the rows and the
 * whole file is new. What a reader wants to know is which records changed,
 * which fields of them changed, and which columns came and went.
 *
 * So the headers are matched by name — a longest common subsequence of the two
 * header rows, which places a new column where it belongs and reports a dropped
 * one as dropped — and the records are matched by their first column when that
 * column identifies them, and by a hash of the whole row when it does not.
 * Cells are then compared cell against cell, and every cell is padded to its
 * column width so that the two panes line up column for column and a field can
 * be read down the page.
 *
 * That padding is why this is a view of the two files rather than their text.
 * The Lines strategy is there when the text itself is the question.
 */
import { DIFF_TABLE_COLS } from '../../core/config.js';
import { match } from './myers.js';

const CELL_MIN = 3;
const CELL_MAX = 44;
const SAMPLE = 400;             // rows measured to fix the column widths
const GAP = ' │ ';         // what sits between two cells on screen
const ROW_MAX = 300000;

/**
 * @returns {{ok:boolean, rows?:object[], columns?:object[], added?:number,
 *            dropped?:number, truncated?:boolean, error?:string}}
 */
export function diffTable(aText, bText, opts, delim) {
  const sep = delim || ',';
  const aRows = parseDelimited(aText, sep);
  const bRows = parseDelimited(bText, sep);
  if (!aRows.length || !bRows.length) return { ok: false, error: 'One of the two files has no rows to line up.' };

  const aHead = aRows[0], bHead = bRows[0];
  if (aHead.length > DIFF_TABLE_COLS || bHead.length > DIFF_TABLE_COLS) {
    return { ok: false, error: 'More columns than a tabular comparison lines up (' + DIFF_TABLE_COLS + ' at most).' };
  }

  const columns = matchColumns(aHead, bHead);
  measure(columns, aRows, bRows);

  const aBody = aRows.slice(1), bBody = bRows.slice(1);
  const entries = matchRecords(aBody, bBody);

  const ctx = { rows: [], an: 0, bn: 0, truncated: false, words: !opts || opts.words !== false };
  emit(ctx, columns, aHead, bHead, 'head');
  entries.forEach(e => {
    if (ctx.truncated) return;
    emit(ctx, columns, e.a === null ? null : aBody[e.a], e.b === null ? null : bBody[e.b], 'body', e.move);
  });

  return {
    ok: true,
    rows: ctx.rows,
    columns,
    added: columns.filter(c => c.a === null).length,
    dropped: columns.filter(c => c.b === null).length,
    truncated: ctx.truncated
  };
}

/* ---------- Reading the file ---------- */

/**
 * A delimited file into rows of cells, honouring quotes and the newlines inside
 * them. Written out rather than done with a split, because a quoted cell
 * containing a line break is exactly the case a split gets wrong.
 */
export function parseDelimited(text, delim) {
  const src = String(text == null ? '' : text);
  const rows = [];
  let row = [], cell = '', quoted = false, seen = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !cell) { quoted = true; seen = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; seen = true; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; seen = false; continue; }
    if (ch === '\r') continue;
    cell += ch;
    seen = true;
  }
  if (seen || cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ---------- Columns ---------- */

/**
 * Line the two header rows up by name.
 *
 * When the headers share no names at all — a file of numbers with no header
 * row, most likely — position is all there is to go on, and going by position
 * is better than reporting every column as both dropped and added.
 */
function matchColumns(aHead, bHead) {
  const shared = aHead.filter(name => bHead.includes(name)).length;
  if (!shared) {
    const wide = Math.max(aHead.length, bHead.length);
    const out = [];
    for (let i = 0; i < wide; i++) {
      out.push({
        name: aHead[i] !== undefined ? aHead[i] : bHead[i],
        a: i < aHead.length ? i : null,
        b: i < bHead.length ? i : null,
        width: CELL_MIN
      });
    }
    return out;
  }

  const numbered = interned(aHead, bHead);
  const { pairs } = match(numbered[0], numbered[1]);
  const cols = [];
  let ai = 0, bi = 0;
  const gap = (aTo, bTo) => {
    for (let i = ai; i < aTo; i++) cols.push({ name: aHead[i], a: i, b: null, width: CELL_MIN });
    for (let j = bi; j < bTo; j++) cols.push({ name: bHead[j], a: null, b: j, width: CELL_MIN });
  };
  for (let k = 0; k < pairs.length; k += 2) {
    const pa = pairs[k], pb = pairs[k + 1];
    if (pa < ai || pb < bi) continue;
    gap(pa, pb);
    cols.push({ name: aHead[pa], a: pa, b: pb, width: CELL_MIN });
    ai = pa + 1; bi = pb + 1;
  }
  gap(aHead.length, bHead.length);
  return cols;
}

/** Two lists of strings, numbered together so equal strings compare equal. */
function interned(x, y) {
  const table = new Map();
  const ids = (list) => {
    const out = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      let id = table.get(list[i]);
      if (id === undefined) { id = table.size; table.set(list[i], id); }
      out[i] = id;
    }
    return out;
  };
  return [ids(x), ids(y)];
}

/** How wide each column has to be for the two panes to line up. */
function measure(columns, aRows, bRows) {
  columns.forEach(col => { col.width = Math.max(CELL_MIN, Math.min(String(col.name || '').length, CELL_MAX)); });
  const look = (rows, side) => {
    const upto = Math.min(rows.length, SAMPLE);
    for (let i = 0; i < upto; i++) {
      const row = rows[i];
      columns.forEach(col => {
        const at = col[side];
        if (at === null) return;
        const cell = row[at];
        if (cell && cell.length > col.width) col.width = Math.min(cell.length, CELL_MAX);
      });
    }
  };
  look(aRows, 'a');
  look(bRows, 'b');
}

/* ---------- Records ---------- */

/**
 * Line the two sets of records up.
 *
 * By the first column when it identifies a record — which is what an id column,
 * a date column or a primary key looks like — and otherwise by a hash of the
 * whole row. Then whatever is left unmatched is paired positionally, so an
 * edited field reads as an edited field rather than as one record gone and
 * another arrived.
 */
function matchRecords(aRows, bRows) {
  const keyed = identifies(aRows) && identifies(bRows);
  const ka = aRows.map(r => (keyed ? r[0] : r.join(' ')));
  const kb = bRows.map(r => (keyed ? r[0] : r.join(' ')));
  const numbered = interned(ka, kb);
  const { pairs } = match(numbered[0], numbered[1]);

  const entries = [];
  let ai = 0, bi = 0;
  const gap = (aTo, bTo) => {
    for (let i = ai; i < aTo; i++) entries.push({ a: i, b: null });
    for (let j = bi; j < bTo; j++) entries.push({ a: null, b: j });
  };
  for (let k = 0; k < pairs.length; k += 2) {
    const pa = pairs[k], pb = pairs[k + 1];
    if (pa < ai || pb < bi) continue;
    gap(pa, pb);
    entries.push({ a: pa, b: pb });
    ai = pa + 1; bi = pb + 1;
  }
  gap(aRows.length, bRows.length);

  /* A record with the same key on both sides of the subsequence is one record
     that changed place, so the two halves are merged into a single row. */
  const waiting = new Map();
  entries.forEach((e, i) => {
    if (e.a === null || e.b !== null) return;
    const bucket = waiting.get(ka[e.a]);
    if (bucket) bucket.push(i); else waiting.set(ka[e.a], [i]);
  });
  const merged = new Set();
  let moves = 0;
  entries.forEach((e, i) => {
    if (e.b === null || e.a !== null) return;
    const bucket = waiting.get(kb[e.b]);
    if (!bucket || !bucket.length) return;
    const at = bucket.shift();
    entries[at].b = e.b;
    entries[at].move = ++moves;
    merged.add(i);
  });
  const linked = merged.size ? entries.filter((_, i) => !merged.has(i)) : entries;
  return keyed ? linked : pairRuns(linked);
}

/** The first column names every record, and names each one once. */
function identifies(rows) {
  if (!rows.length) return false;
  const seen = new Set();
  for (const row of rows) {
    const v = row[0];
    if (v === undefined || v === '') return false;
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

/** Unmatched removals and arrivals sitting together are usually edits. */
function pairRuns(entries) {
  const out = [];
  let i = 0;
  while (i < entries.length) {
    if (entries[i].a === null || entries[i].b !== null) { out.push(entries[i]); i++; continue; }
    let j = i;
    while (j < entries.length && entries[j].a !== null && entries[j].b === null) j++;
    let k = j;
    while (k < entries.length && entries[k].a === null && entries[k].b !== null) k++;
    const dels = entries.slice(i, j), inses = entries.slice(j, k);
    const both = Math.min(dels.length, inses.length);
    for (let n = 0; n < both; n++) out.push({ a: dels[n].a, b: inses[n].b });
    for (let n = both; n < dels.length; n++) out.push(dels[n]);
    for (let n = both; n < inses.length; n++) out.push(inses[n]);
    i = k;
  }
  return out;
}

/* ---------- Drawing a row ---------- */

const fit = (cell, width) => {
  const s = cell === undefined || cell === null ? '' : String(cell);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
};

/**
 * One row of the comparison: the two lines, and which cells differ.
 *
 * The segments are the same shape the word-level refinement produces, so the
 * view paints a changed cell exactly as it paints a changed word.
 */
function emit(ctx, columns, aRow, bRow, band, move) {
  if (ctx.rows.length >= ROW_MAX) { ctx.truncated = true; return; }
  const aSegs = [], bSegs = [];
  let aText = aRow ? '' : null, bText = bRow ? '' : null;
  let differs = false;

  columns.forEach((col, i) => {
    const inA = !!aRow && col.a !== null;
    const inB = !!bRow && col.b !== null;
    const aCell = inA ? fit(aRow[col.a], col.width) : ' '.repeat(col.width);
    const bCell = inB ? fit(bRow[col.b], col.width) : ' '.repeat(col.width);
    const same = inA === inB && (!inA || String(aRow[col.a] || '') === String(bRow[col.b] || ''));
    if (!same) differs = true;
    if (i) {
      if (aText !== null) { aText += GAP; push(aSegs, true, GAP); }
      if (bText !== null) { bText += GAP; push(bSegs, true, GAP); }
    }
    if (aText !== null) { aText += aCell; push(aSegs, same, aCell); }
    if (bText !== null) { bText += bCell; push(bSegs, same, bCell); }
  });

  const kind = aText === null ? 'ins' : bText === null ? 'del' : differs ? 'chg' : 'eq';
  const row = {
    k: kind, a: aText, b: bText, depth: 0, band,
    ai: aText === null ? null : ++ctx.an,
    bi: bText === null ? null : ++ctx.bn
  };
  if (move) row.move = move;
  if (kind === 'chg' && ctx.words) { row.aSegs = aSegs; row.bSegs = bSegs; }
  ctx.rows.push(row);
}

function push(segs, eq, text) {
  const last = segs[segs.length - 1];
  if (last && last.eq === eq) last.text += text;
  else segs.push({ eq, text });
}
