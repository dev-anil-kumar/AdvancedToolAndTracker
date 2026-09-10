/**
 * Myers' O(ND) difference algorithm, in linear space.
 *
 * The one primitive every other comparison in Folio is built on. It works on
 * arrays of *numbers* — interned lines, interned tokens, character codes —
 * never on strings, because the inner loop runs millions of times and an
 * integer compare is the whole game.
 *
 * "Linear space" is the divide-and-conquer refinement from §4b of the paper:
 * instead of keeping the whole edit graph, walk it forwards from the start and
 * backwards from the end at the same time until the two searches overlap. That
 * meeting point is the middle of the shortest edit path, so the problem splits
 * in two and recursion finishes it — O(N) memory instead of O(N·M), which is
 * the difference between comparing two ten-megabyte files and crashing the tab.
 *
 * Two ceilings keep a pathological pair from hanging the browser. A search that
 * has not met in the middle within `maxD` steps gives up, and a region it gives
 * up on is reported as a rewrite: honest, instantly, rather than correct in a
 * minute. `exact` on the result says whether any region was settled that way.
 */
import { DIFF_MAX_D } from '../../core/config.js';

const MAX_DEPTH = 900;      // deeper than any real file goes; a runaway stops here

/**
 * Find the middle of the shortest edit path between two ranges.
 *
 * @returns {{x:number,y:number}|null} the split point, relative to the range's
 *   start, or null when the two searches never met inside the budget.
 */
function bisect(a, a0, aN, b, b0, bN, maxD) {
  const n = aN - a0, m = bN - b0;
  const max = Math.min(maxD, Math.ceil((n + m) / 2));
  const off = max + 1;
  const len = 2 * max + 3;
  /* One row of the edit graph per direction. -1 means "not reached yet". */
  const fwd = new Int32Array(len).fill(-1);
  const rev = new Int32Array(len).fill(-1);
  fwd[off + 1] = 0;
  rev[off + 1] = 0;
  const delta = n - m;
  /* Whichever direction ends on an odd diagonal is the one that can detect the
     overlap; checking the other would find it one step late. */
  const front = (delta % 2) !== 0;
  let fs = 0, fe = 0, rs = 0, re = 0;   // diagonals that have run off an edge

  for (let d = 0; d < max; d++) {
    for (let k = -d + fs; k <= d - fe; k += 2) {
      const o = off + k;
      let x = (k === -d || (k !== d && fwd[o - 1] < fwd[o + 1])) ? fwd[o + 1] : fwd[o - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      fwd[o] = x;
      if (x > n) fe += 2;
      else if (y > m) fs += 2;
      else if (front) {
        const ro = off + delta - k;
        if (ro >= 0 && ro < len && rev[ro] !== -1 && x >= n - rev[ro]) return { x, y };
      }
    }
    for (let k = -d + rs; k <= d - re; k += 2) {
      const o = off + k;
      let x = (k === -d || (k !== d && rev[o - 1] < rev[o + 1])) ? rev[o + 1] : rev[o - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[aN - x - 1] === b[bN - y - 1]) { x++; y++; }
      rev[o] = x;
      if (x > n) re += 2;
      else if (y > m) rs += 2;
      else if (!front) {
        const fo = off + delta - k;
        if (fo >= 0 && fo < len && fwd[fo] !== -1 && fwd[fo] >= n - x) {
          return { x: fwd[fo], y: off + fwd[fo] - fo };
        }
      }
    }
  }
  return null;
}

/**
 * The matched pairs between two ranges, in order.
 *
 * Pairs are pushed onto `out` flat — a-index, b-index, a-index, b-index — which
 * is what a caller wants to walk and costs nothing to allocate.
 *
 * @returns {boolean} true when the answer is exact; false when some region was
 *   too expensive to match and was left as a rewrite.
 */
export function matchRange(a, a0, aN, b, b0, bN, out, maxD) {
  return walk(a, a0, aN, b, b0, bN, out, maxD || DIFF_MAX_D, 0);
}

function walk(a, a0, aN, b, b0, bN, out, maxD, depth) {
  /* Trim the ends first. It is cheap, it is what most edits leave untouched,
     and it is what stops the recursion below from standing still. */
  while (a0 < aN && b0 < bN && a[a0] === b[b0]) { out.push(a0, b0); a0++; b0++; }
  let tail = 0;
  while (aN > a0 && bN > b0 && a[aN - 1] === b[bN - 1]) { aN--; bN--; tail++; }

  let exact = true;
  const n = aN - a0, m = bN - b0;
  if (n > 0 && m > 0) {
    if (depth >= MAX_DEPTH) exact = false;
    else {
      const split = bisect(a, a0, aN, b, b0, bN, maxD);
      /* Falling out of the search having spent the full budget means the two
         searches never met, which for an unclipped budget is itself the answer:
         the ranges share nothing. Only a *clipped* budget leaves a real doubt. */
      const clipped = maxD < Math.ceil((n + m) / 2);
      /* A split at either corner would hand a child the whole problem again. */
      if (!split) {
        exact = !clipped;
      } else if ((split.x === 0 && split.y === 0) || (split.x === n && split.y === m)) {
        exact = false;
      } else {
        const left = walk(a, a0, a0 + split.x, b, b0, b0 + split.y, out, maxD, depth + 1);
        const right = walk(a, a0 + split.x, aN, b, b0 + split.y, bN, out, maxD, depth + 1);
        exact = left && right;
      }
    }
  }
  for (let i = 0; i < tail; i++) out.push(aN + i, bN + i);
  return exact;
}

/** The matched pairs between two whole arrays. */
export function match(a, b, maxD) {
  const out = [];
  const exact = matchRange(a, 0, a.length, b, 0, b.length, out, maxD);
  return { pairs: out, exact };
}
