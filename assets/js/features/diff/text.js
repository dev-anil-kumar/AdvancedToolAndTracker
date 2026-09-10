/**
 * Comparing two files line by line.
 *
 * Everything here exists to make the matching in myers.js and histogram.js
 * cheap enough to run on a file worth calling large:
 *
 *   Interning     a line becomes an integer, once. The inner loops compare
 *                 integers; comparing strings a few million times is what makes
 *                 a naive diff feel broken on a big file.
 *   Normalising   what is *compared* is not what is *shown*. "Ignore trailing
 *                 space" trims the key and leaves the line alone, so the reader
 *                 still sees the file as it is.
 *   Pruning       a line that occurs nowhere in the other file cannot possibly
 *                 be part of any match, so it is set aside before the expensive
 *                 part starts. On two files with a thousand lines inserted in
 *                 the middle, this alone removes the whole insertion from the
 *                 search. (GNU diff calls this discarding confusing lines.)
 *
 * The result is a flat list of operations over line ranges — equal, removed,
 * added — plus which blocks turned out to be the same lines in a new place.
 * Turning that into something on screen is align.js's job.
 */
import { DIFF_MOVE_MAX, DIFF_MOVE_MIN } from '../../core/config.js';
import { anchorRange } from './histogram.js';
import { matchRange } from './myers.js';

/**
 * Split text into lines, without inventing one at the end.
 *
 * A file that ends in a newline has not got an extra empty last line, and
 * saying so is the difference between an honest comparison and one that reports
 * a change nobody made.
 */
export function splitLines(text) {
  const src = String(text == null ? '' : text);
  /* No text at all is no lines at all. Splitting '' yields one empty string,
     which would have an empty file reporting a line nobody wrote. */
  if (!src) return { lines: [], crlf: false, trailing: false };
  const crlf = /\r\n/.test(src);
  const flat = crlf || src.includes('\r') ? src.replace(/\r\n?/g, '\n') : src;
  const lines = flat.split('\n');
  const trailing = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  return { lines, crlf, trailing };
}

/** The form of a line that gets compared. What is shown is never touched. */
export function lineKey(line, opts) {
  let s = line;
  if (opts.allSpace) s = s.replace(/\s+/g, '');
  else if (opts.trimEnd) s = s.replace(/[ \t\f\v]+$/, '');
  if (opts.caseless) s = s.toLowerCase();
  return s;
}

/** True when a line has nothing in it but space. */
export const isBlank = (line) => !/\S/.test(line);

/**
 * Compare two arrays of lines.
 *
 * @param {string[]} aLines
 * @param {string[]} bLines
 * @param {object} opts  algo, and the ignore-* switches from DIFF_OPTIONS
 * @returns {{ops:object[], exact:boolean, moves:number}}
 */
export function diffLines(aLines, bLines, opts) {
  const options = opts || {};
  const table = new Map();
  const aIds = intern(aLines, options, table);
  const bIds = intern(bLines, options, table);

  /* Which lines could match anything at all. */
  const inA = new Uint8Array(table.size);
  const inB = new Uint8Array(table.size);
  for (let i = 0; i < aIds.length; i++) inA[aIds[i]] = 1;
  for (let j = 0; j < bIds.length; j++) inB[bIds[j]] = 1;

  const aKeep = keepable(aIds, inB);
  const bKeep = keepable(bIds, inA);

  const pairs = [];
  let exact = true;
  if (aKeep.ids.length && bKeep.ids.length) {
    const algo = options.algo === 'myers' ? 'myers' : options.algo === 'patience' ? 'patience' : 'histogram';
    if (algo === 'myers') {
      exact = matchRange(aKeep.ids, 0, aKeep.ids.length, bKeep.ids, 0, bKeep.ids.length, pairs, options.maxD);
    } else {
      exact = anchorRange(aKeep.ids, 0, aKeep.ids.length, bKeep.ids, 0, bKeep.ids.length, pairs,
        { patience: algo === 'patience', maxD: options.maxD });
    }
    /* Back from the pruned sequences to the real line numbers. */
    for (let k = 0; k < pairs.length; k += 2) {
      pairs[k] = aKeep.at[pairs[k]];
      pairs[k + 1] = bKeep.at[pairs[k + 1]];
    }
  }

  const ops = opsFrom(pairs, aLines.length, bLines.length);
  softenBlanks(ops, aLines, bLines, options);
  const moves = options.moves === false ? 0 : findMoves(ops, aIds, bIds);
  return { ops, exact, moves };
}

function intern(lines, opts, table) {
  const ids = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const key = lineKey(lines[i], opts);
    let id = table.get(key);
    if (id === undefined) { id = table.size; table.set(key, id); }
    ids[i] = id;
  }
  return ids;
}

/** The lines that occur at least once in the other file, and where they were. */
function keepable(ids, other) {
  const at = [];
  for (let i = 0; i < ids.length; i++) if (other[ids[i]]) at.push(i);
  const kept = new Int32Array(at.length);
  for (let k = 0; k < at.length; k++) kept[k] = ids[at[k]];
  return { ids: kept, at };
}

/**
 * Matched pairs into operations over ranges.
 *
 * Runs of equal lines are collapsed into one operation, and a gap becomes a
 * removal followed by an addition — adjacent, so align.js can recognise the two
 * halves of a rewrite.
 */
function opsFrom(pairs, aLen, bLen) {
  const ops = [];
  let ai = 0, bi = 0, k = 0;
  const gap = (aTo, bTo) => {
    if (aTo > ai) ops.push({ t: 'del', a0: ai, aN: aTo, b0: bi, bN: bi });
    if (bTo > bi) ops.push({ t: 'ins', a0: aTo, aN: aTo, b0: bi, bN: bTo });
  };
  while (k < pairs.length) {
    const pa = pairs[k], pb = pairs[k + 1];
    /* A pair that would step backwards cannot be used; skipping it degrades
       the answer rather than corrupting the row stream. */
    if (pa < ai || pb < bi) { k += 2; continue; }
    if (pa > ai || pb > bi) { gap(pa, pb); ai = pa; bi = pb; }
    let ea = pa, eb = pb;
    k += 2;
    while (k < pairs.length && pairs[k] === ea + 1 && pairs[k + 1] === eb + 1) { ea++; eb++; k += 2; }
    ops.push({ t: 'eq', a0: pa, aN: ea + 1, b0: pb, bN: eb + 1 });
    ai = ea + 1; bi = eb + 1;
  }
  gap(aLen, bLen);
  return ops;
}

/**
 * "Ignore blank lines" does not mean hiding them — it means not shouting about
 * them. A change made entirely of blank lines is marked soft: still on screen,
 * still where it belongs, but not counted and not worth jumping to.
 */
function softenBlanks(ops, aLines, bLines, opts) {
  if (!opts.blankLines) return;
  ops.forEach(op => {
    if (op.t === 'eq') return;
    const lines = op.t === 'del' ? aLines : bLines;
    const from = op.t === 'del' ? op.a0 : op.b0;
    const to = op.t === 'del' ? op.aN : op.bN;
    let allBlank = true;
    for (let i = from; i < to && allBlank; i++) if (!isBlank(lines[i])) allBlank = false;
    if (allBlank) op.soft = true;
  });
}

/**
 * Blocks that only changed place.
 *
 * A block of lines removed from one part of the file and added, unchanged, to
 * another is not two edits — it is one move, and reading it as two edits is how
 * a reordered set of functions turns into an unreadable diff. Each removal and
 * addition is fingerprinted by its sequence of interned lines; equal
 * fingerprints on opposite sides are the same block in a new place.
 */
function findMoves(ops, aIds, bIds) {
  const dels = [], inses = [];
  ops.forEach(op => {
    if (op.soft) return;
    if (op.t === 'del' && op.aN - op.a0 >= DIFF_MOVE_MIN) dels.push(op);
    if (op.t === 'ins' && op.bN - op.b0 >= DIFF_MOVE_MIN) inses.push(op);
  });
  if (!dels.length || !inses.length) return 0;
  if (dels.length + inses.length > DIFF_MOVE_MAX) return 0;

  const shelf = new Map();
  dels.forEach(op => {
    const sig = fingerprint(aIds, op.a0, op.aN);
    const bucket = shelf.get(sig);
    if (bucket) bucket.push(op); else shelf.set(sig, [op]);
  });

  let moved = 0;
  inses.forEach(op => {
    const bucket = shelf.get(fingerprint(bIds, op.b0, op.bN));
    if (!bucket || !bucket.length) return;
    const partner = bucket.shift();
    moved++;
    partner.move = moved;
    op.move = moved;
  });
  return moved;
}

/** Length, then a rolling hash of the interned lines. Collisions are unlikely
    and harmless — a mislabelled move, never a wrong line. */
function fingerprint(ids, from, to) {
  let h = 0x811c9dc5;
  for (let i = from; i < to; i++) {
    h ^= ids[i];
    h = (h * 0x01000193) >>> 0;
  }
  return (to - from) + ':' + h.toString(36);
}
