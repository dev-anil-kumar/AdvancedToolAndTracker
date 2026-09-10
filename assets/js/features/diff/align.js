/**
 * From a list of edits to a list of rows.
 *
 * The comparison engines answer in ranges — "lines 40 to 48 of A are gone,
 * lines 40 to 51 of B are new". A reader needs something else: one row per line
 * of the screen, with a left half and a right half that belong together, so
 * that two panes scrolled in step line up whatever was done to the file. That
 * translation is this module, and three decisions in it are what make a
 * comparison readable rather than merely correct.
 *
 * Pairing. Eight lines gone and eleven arrived might be eight rewrites and
 * three additions, or eleven unrelated arrivals. Which it is decides whether
 * the reader gets to see the word that changed, so the two runs are matched up
 * by how alike their lines are before anything is drawn.
 *
 * Folding. Two files that differ in four places are, mostly, two identical
 * files. Ten thousand unchanged rows between one change and the next are not
 * context, they are a wall, so a long unchanged run keeps a few rows either end
 * and offers the rest behind a single row that says how many there are. This
 * is also what lets the row count stay small enough to keep the panes quick.
 *
 * A uniform row height. Every row is exactly one line tall, folds included,
 * which is what makes it possible to draw only the rows on screen and put the
 * scrollbar in the right place without measuring anything.
 */
import { DIFF_CONTEXT, DIFF_FOLD_MIN, DIFF_PAIR_WINDOW, DIFF_REFINE_ROWS } from '../../core/config.js';
import { pairUp, refine } from './tokens.js';

/** A row that carries no change: unchanged, folded away, or explicitly ignored. */
export const isQuiet = (row) => row.k === 'eq' || row.k === 'fold' || !!row.soft;

/* ---------- Operations into rows ---------- */

/**
 * @param {object[]} ops  from text.js
 * @param {string[]} aLines
 * @param {string[]} bLines
 * @param {object} opts   `words` decides whether rewritten lines are refined
 * @returns {object[]} rows, one per screen line
 */
export function rowsFromOps(ops, aLines, bLines, opts) {
  const options = opts || {};
  const rows = [];
  let refined = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.t === 'eq') {
      for (let n = 0; n < op.aN - op.a0; n++) {
        rows.push(row('eq', aLines[op.a0 + n], bLines[op.b0 + n], op.a0 + n, op.b0 + n));
      }
      continue;
    }
    /* A removal followed straight away by an addition is one change with two
       halves; anything else is a plain removal or a plain addition. */
    const next = ops[i + 1];
    if (op.t === 'del' && next && next.t === 'ins' && !op.soft && !next.soft) {
      refined = changeBlock(rows, aLines, bLines, op, next, options, refined);
      i++;
      continue;
    }
    const lines = op.t === 'del' ? aLines : bLines;
    const from = op.t === 'del' ? op.a0 : op.b0;
    const to = op.t === 'del' ? op.aN : op.bN;
    for (let n = from; n < to; n++) {
      const made = op.t === 'del' ? row('del', lines[n], null, n, null) : row('ins', null, lines[n], null, n);
      if (op.soft) made.soft = true;
      if (op.move) made.move = op.move;
      rows.push(made);
    }
  }
  return rows;
}

function row(k, a, b, ai, bi) {
  return { k, a, b, ai: ai === null ? null : ai + 1, bi: bi === null ? null : bi + 1 };
}

/**
 * One block of removals against one block of additions.
 *
 * The lines that are alike become paired rows with the changed words marked;
 * the rest keep their own row. Pairs are drawn in order, with the unpaired
 * removals and additions around them where they belong.
 */
function changeBlock(rows, aLines, bLines, del, ins, opts, refined) {
  const aRun = aLines.slice(del.a0, del.aN);
  const bRun = bLines.slice(ins.b0, ins.bN);
  const pairs = pairUp(aRun, bRun, DIFF_PAIR_WINDOW);
  const partnerOf = new Map();
  pairs.forEach(([x, y]) => partnerOf.set(x, y));

  let ai = 0, bi = 0;
  let spent = refined;
  while (ai < aRun.length || bi < bRun.length) {
    const partner = partnerOf.has(ai) ? partnerOf.get(ai) : -1;
    if (partner >= 0) {
      /* Everything of B that comes before this line's partner arrived here. */
      while (bi < partner) { rows.push(mark(row('ins', null, bRun[bi], null, ins.b0 + bi), ins)); bi++; }
      const made = row('chg', aRun[ai], bRun[bi], del.a0 + ai, ins.b0 + bi);
      if (opts.words !== false && spent < DIFF_REFINE_ROWS) {
        const worked = refine(aRun[ai], bRun[bi]);
        if (worked) { made.aSegs = worked.a; made.bSegs = worked.b; }
        spent++;
      }
      rows.push(made);
      ai++; bi++;
      continue;
    }
    if (ai < aRun.length) { rows.push(mark(row('del', aRun[ai], null, del.a0 + ai, null), del)); ai++; continue; }
    rows.push(mark(row('ins', null, bRun[bi], null, ins.b0 + bi), ins));
    bi++;
  }
  return spent;
}

function mark(made, op) {
  if (op.move) made.move = op.move;
  if (op.soft) made.soft = true;
  return made;
}

/* ---------- Folding ---------- */

/**
 * The rows actually put on screen.
 *
 * A run of quiet rows longer than it takes to be a wall keeps `context` rows at
 * each end and hands the middle to a single fold row. A fold remembers where it
 * came from, so opening it is a matter of naming its start.
 *
 * @param {object[]} rows
 * @param {number} context  quiet rows kept beside a change
 * @param {Set<number>} opened  folds the reader has opened, by start index
 * @returns {{view:object[], folded:number, hidden:number}}
 */
export function foldRows(rows, context, opened) {
  const keep = context === undefined ? DIFF_CONTEXT : context;
  const open = opened || new Set();
  if (!(keep >= 0) || keep === Infinity) return { view: rows.slice(), folded: 0, hidden: 0 };

  const view = [];
  let folded = 0, hidden = 0;
  let i = 0;
  while (i < rows.length) {
    if (!isQuiet(rows[i])) { view.push(rows[i]); i++; continue; }
    let j = i;
    while (j < rows.length && isQuiet(rows[j])) j++;
    const run = j - i;
    /* Both ends of the file need only one side of context. */
    const head = i === 0 ? 0 : keep;
    const tail = j === rows.length ? 0 : keep;
    if (run < head + tail + DIFF_FOLD_MIN || open.has(i)) {
      for (let n = i; n < j; n++) view.push(rows[n]);
      i = j;
      continue;
    }
    for (let n = i; n < i + head; n++) view.push(rows[n]);
    const count = run - head - tail;
    view.push({ k: 'fold', a: null, b: null, ai: null, bi: null, at: i, count, from: i + head, to: j - tail });
    folded++;
    hidden += count;
    for (let n = j - tail; n < j; n++) view.push(rows[n]);
    i = j;
  }
  return { view, folded, hidden };
}

/* ---------- What the comparison found ---------- */

export function statsOf(rows) {
  let added = 0, removed = 0, changed = 0, same = 0, ignored = 0;
  const moves = new Set();
  rows.forEach(r => {
    if (r.move) moves.add(r.move);
    if (r.soft) { ignored++; return; }
    if (r.k === 'eq') same++;
    else if (r.k === 'chg') changed++;
    else if (r.k === 'del') removed++;
    else if (r.k === 'ins') added++;
  });
  const touched = added + removed + changed;
  return {
    added, removed, changed, same, ignored,
    moved: moves.size,
    identical: touched === 0,
    similarity: touched + same === 0 ? 1 : same / (same + touched)
  };
}

/**
 * The change blocks, as offsets into a set of rows.
 *
 * Used twice: to step from one change to the next, and to draw the ribbon down
 * the edge of the panes that shows at a glance where in the file the work is.
 */
export function blocksOf(rows) {
  const blocks = [];
  let i = 0;
  while (i < rows.length) {
    if (isQuiet(rows[i])) { i++; continue; }
    const start = i;
    let kinds = 0;
    while (i < rows.length && !isQuiet(rows[i])) {
      kinds |= rows[i].k === 'del' ? 1 : rows[i].k === 'ins' ? 2 : 4;
      i++;
    }
    blocks.push({
      start,
      end: i - 1,
      moved: !!rows[start].move,
      kind: kinds === 1 ? 'del' : kinds === 2 ? 'ins' : 'chg'
    });
  }
  return blocks;
}

/* ---------- A patch, for anyone who wants one ---------- */

/**
 * The comparison as a unified diff.
 *
 * Written from the rows rather than from the edits, so the file that comes out
 * says exactly what the screen said. A block of rewrites becomes its removals
 * followed by its additions, which is what the format asks for.
 */
export function unifiedPatch(rows, aName, bName, context) {
  const keep = context === undefined ? DIFF_CONTEXT : context;
  const real = rows.filter(r => r.k !== 'fold');
  const interesting = real.map(r => !isQuiet(r));
  if (!interesting.some(Boolean)) return '';

  const out = ['--- ' + (aName || 'a'), '+++ ' + (bName || 'b')];
  let i = 0;
  while (i < real.length) {
    if (!interesting[i]) { i++; continue; }
    const start = Math.max(0, i - keep);
    let end = i;
    /* Grow the hunk while the next change is close enough to share context. */
    while (end < real.length) {
      let next = end + 1;
      while (next < real.length && !interesting[next]) next++;
      if (next < real.length && next - end <= keep * 2) { end = next; continue; }
      break;
    }
    end = Math.min(real.length - 1, end + keep);

    const slice = real.slice(start, end + 1);
    const aFrom = firstNumber(slice, 'ai'), bFrom = firstNumber(slice, 'bi');
    let aCount = 0, bCount = 0;
    slice.forEach(r => { if (r.ai !== null) aCount++; if (r.bi !== null) bCount++; });
    out.push('@@ -' + (aCount ? aFrom : 0) + ',' + aCount + ' +' + (bCount ? bFrom : 0) + ',' + bCount + ' @@');

    /* Removals before additions, in runs, which is the shape of the format. */
    let n = 0;
    while (n < slice.length) {
      const r = slice[n];
      if (isQuiet(r) && r.k !== 'del' && r.k !== 'ins') { out.push(' ' + (r.a === null ? r.b : r.a)); n++; continue; }
      let m = n;
      while (m < slice.length && !(isQuiet(slice[m]) && slice[m].k !== 'del' && slice[m].k !== 'ins')) m++;
      for (let q = n; q < m; q++) if (slice[q].a !== null) out.push('-' + slice[q].a);
      for (let q = n; q < m; q++) if (slice[q].b !== null) out.push('+' + slice[q].b);
      n = m;
    }
    i = end + 1;
  }
  return out.join('\n') + '\n';
}

function firstNumber(slice, field) {
  for (const r of slice) if (r[field] !== null) return r[field];
  return 0;
}
