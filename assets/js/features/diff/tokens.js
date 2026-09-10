/**
 * Inside a changed line.
 *
 * A pair of rows reading `const timeout = 30;` and `const timeout = 45;` in
 * solid red and solid green tells the reader nothing they could not see for
 * themselves. What they want is the `30` and the `45`. So a rewritten line is
 * compared again, one level down, over tokens rather than characters —
 * characters find edits inside words and produce confetti; tokens find the word
 * that changed, which is the answer to the question being asked.
 *
 * The other job here is deciding which lines are a rewrite in the first place.
 * A block with three lines gone and three arrived might be three rewrites, or
 * three unrelated removals and additions, and only a look at how alike they are
 * can tell the two apart. Likeness is the Sørensen–Dice coefficient over
 * character pairs: cheap, no allocation per comparison beyond one set, and
 * stable enough to put a single threshold on.
 */
import { DIFF_PAIR_MIN, DIFF_REFINE_CHARS } from '../../core/config.js';
import { match } from './myers.js';

/* A word, a run of space, or one character of punctuation. Splitting this way
   is what keeps `foo(bar)` → `foo(baz)` down to one highlighted token. */
const TOKENS = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;

export function tokenize(line) {
  const out = String(line).match(TOKENS);
  return out || [];
}

/**
 * How alike two lines are, from 0 to 1.
 *
 * Dice over the set of adjacent character pairs: two lines sharing most of
 * their pairs are a rewrite of one another, two that share few are not. Space
 * is dropped first so that re-indenting a line does not make it look new.
 */
export function similarity(a, b) {
  const x = String(a).replace(/\s+/g, ' ').trim();
  const y = String(b).replace(/\s+/g, ' ').trim();
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  if (x.length === 1 || y.length === 1) return x === y ? 1 : 0;
  const seen = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const pair = x.slice(i, i + 2);
    seen.set(pair, (seen.get(pair) || 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const pair = y.slice(i, i + 2);
    const left = seen.get(pair);
    if (left) { shared++; seen.set(pair, left - 1); }
  }
  return (2 * shared) / (x.length - 1 + y.length - 1);
}

/** Whether two lines are close enough to be read as one rewritten line. */
export const isRewrite = (a, b) => similarity(a, b) >= DIFF_PAIR_MIN;

/**
 * The two halves of a rewritten line, each as a run of segments.
 *
 * A segment is `{ eq, text }`. When almost nothing survived, the whole line is
 * returned as one changed segment: a line where every other token is marked is
 * harder to read than a line simply marked as different.
 *
 * @returns {{a:object[], b:object[], ratio:number}|null} null when the pair is
 *   too long to be worth refining.
 */
export function refine(aLine, bLine) {
  if (aLine.length > DIFF_REFINE_CHARS || bLine.length > DIFF_REFINE_CHARS) return null;
  const at = tokenize(aLine), bt = tokenize(bLine);
  if (!at.length || !bt.length) return null;

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
  const { pairs } = match(ids(at), ids(bt));

  /* Walk the matched tokens, collecting what each side kept and what it did not. */
  const aSegs = [], bSegs = [];
  let ai = 0, bi = 0, kept = 0;
  const put = (segs, list, from, to, eq) => {
    if (to <= from) return;
    const text = list.slice(from, to).join('');
    const last = segs[segs.length - 1];
    if (last && last.eq === eq) last.text += text;
    else segs.push({ eq, text });
  };
  for (let k = 0; k < pairs.length; k += 2) {
    const pa = pairs[k], pb = pairs[k + 1];
    if (pa < ai || pb < bi) continue;
    put(aSegs, at, ai, pa, false);
    put(bSegs, bt, bi, pb, false);
    put(aSegs, at, pa, pa + 1, true);
    put(bSegs, bt, pb, pb + 1, true);
    kept += at[pa].length;
    ai = pa + 1; bi = pb + 1;
  }
  put(aSegs, at, ai, at.length, false);
  put(bSegs, bt, bi, bt.length, false);

  const ratio = (2 * kept) / (aLine.length + bLine.length || 1);
  if (ratio < 0.2) return null;      // barely anything in common: mark the line, not its parts
  return { a: aSegs, b: bSegs, ratio };
}

/**
 * Pair up the removals and additions inside one changed block.
 *
 * Equal counts are paired straight down — which is what a run of edited lines
 * looks like, and the answer a reader expects. Otherwise every candidate pairing
 * inside a small window is scored and the best ones taken greedily, so three
 * lines replaced by five come out as three rewrites and two additions rather
 * than five of each.
 *
 * @returns {Array<[number, number]>} pairs of offsets into the two runs
 */
export function pairUp(aRun, bRun, window) {
  const pairs = [];
  if (!aRun.length || !bRun.length) return pairs;
  if (aRun.length === bRun.length) {
    for (let i = 0; i < aRun.length; i++) pairs.push([i, i]);
    return pairs;
  }
  const reach = window || 12;
  const scored = [];
  for (let i = 0; i < aRun.length; i++) {
    const lo = Math.max(0, i - reach), hi = Math.min(bRun.length, i + reach + 1);
    for (let j = lo; j < hi; j++) {
      const s = similarity(aRun[i], bRun[j]);
      if (s >= DIFF_PAIR_MIN) scored.push({ i, j, s });
    }
  }
  scored.sort((x, y) => y.s - x.s || (x.i - x.j) - (y.i - y.j));
  const usedA = new Set(), usedB = new Set();
  scored.forEach(({ i, j }) => {
    if (usedA.has(i) || usedB.has(j)) return;
    usedA.add(i); usedB.add(j);
    pairs.push([i, j]);
  });
  /* Crossing pairs would draw two rewrites that swap places, which reads as a
     mistake; keep the longest run that stays in order. */
  pairs.sort((x, y) => x[0] - y[0]);
  const out = [];
  let last = -1;
  pairs.forEach(p => { if (p[1] > last) { out.push(p); last = p[1]; } });
  return out;
}
