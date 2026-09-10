/**
 * Anchored matching — the part that decides *which* of the many correct answers
 * a reader is shown.
 *
 * Myers finds a shortest edit path, and a shortest path is often a nonsense
 * one: given two functions that both end in `}` and `return null;`, it will
 * happily pair the closing brace of one with the closing brace of the other and
 * shred both bodies around them. The fix, from patience diff and from JGit's
 * HistogramDiff (`git diff --histogram`), is to stop treating all lines as
 * equal. Count how often each line occurs, anchor on the *rarest* shared lines,
 * and only then look at what is left. A line that appears once in each file is
 * almost certainly the same line, and hanging the comparison off those turns a
 * wall of red and green into the change that was actually made.
 *
 * How the anchors are chosen matters as much as choosing to have them. Picking
 * one rare run per region and recursing either side of it — JGit's shape — is
 * fine on code and falls apart on repetitive input, because when every
 * candidate scores the same the tie is broken arbitrarily and half the region
 * is thrown away with it. So all the candidates are taken at once and the
 * longest chain that runs forwards through both files is kept: sort the
 * candidate pairs by their position in A, and the answer is the longest
 * strictly increasing subsequence of their positions in B. That is patience
 * sorting, it is O(R log R), and it is the algorithm patience diff is named
 * after. Then the gaps between anchors are matched the same way, one level
 * down, where lines too repetitive to anchor on at file scale are often rare
 * enough to anchor on locally.
 *
 *   patience   anchor only on lines unique to both sides
 *   histogram  anchor on the rarest shared lines, as many as the budget allows
 *
 * A region with nothing rare enough to anchor on goes to Myers, so the answer
 * is defined everywhere.
 */
import { DIFF_HIST_CHAIN, DIFF_HIST_MIN } from '../../core/config.js';
import { matchRange } from './myers.js';

const MAX_DEPTH = 400;
const CANDIDATE_MAX = 300000;   // anchor pairs considered per region

/* How often a line may occur and still be trusted as an anchor. Taken in
   order: the first tier that yields a chain is the one used. */
const TIERS = [1, 2, 4, 12, DIFF_HIST_CHAIN];

/**
 * Matched pairs between two ranges, anchored on their rarest shared lines.
 *
 * @param {Int32Array|number[]} a  interned lines
 * @param {Int32Array|number[]} b
 * @param {number[]} out  matched pairs, pushed flat: a-index, b-index, …
 * @param {{patience?:boolean, maxD?:number}} opts
 * @returns {boolean} whether every region was settled exactly
 */
export function anchorRange(a, a0, aN, b, b0, bN, out, opts) {
  return walk(a, a0, aN, b, b0, bN, out, opts || {}, 0);
}

function walk(a, a0, aN, b, b0, bN, out, opts, depth) {
  /* The ends first: identical heads and tails are the common case, cost
     nothing to strip, and stripping them is what shrinks a region enough for
     the index below to be worth building. */
  while (a0 < aN && b0 < bN && a[a0] === b[b0]) { out.push(a0, b0); a0++; b0++; }
  let tail = 0;
  while (aN > a0 && bN > b0 && a[aN - 1] === b[bN - 1]) { aN--; bN--; tail++; }

  let exact = true;
  const n = aN - a0, m = bN - b0;
  if (n > 0 && m > 0) {
    if (n + m < DIFF_HIST_MIN || depth >= MAX_DEPTH) {
      exact = matchRange(a, a0, aN, b, b0, bN, out, opts.maxD);
    } else {
      const anchors = chooseAnchors(a, a0, aN, b, b0, bN, opts);
      if (anchors === null) {
        /* Shared lines, but none rare enough to trust. Myers settles it. */
        exact = matchRange(a, a0, aN, b, b0, bN, out, opts.maxD);
      } else {
        /* Every gap between two anchors is a smaller problem of the same
           shape, so the same routine finishes it. */
        let pa = a0, pb = b0;
        for (let k = 0; k < anchors.length; k += 2) {
          const ai = anchors[k], bi = anchors[k + 1];
          if (ai > pa && bi > pb && !walk(a, pa, ai, b, pb, bi, out, opts, depth + 1)) exact = false;
          out.push(ai, bi);
          pa = ai + 1; pb = bi + 1;
        }
        if (pa < aN && pb < bN && !walk(a, pa, aN, b, pb, bN, out, opts, depth + 1)) exact = false;
      }
    }
  }
  for (let i = 0; i < tail; i++) out.push(aN + i, bN + i);
  return exact;
}

/**
 * The anchors for one region: pairs of positions, increasing in both files.
 *
 * Rarity is taken in tiers, and the rarest tier that yields anything at all
 * wins. That is the whole difference between a readable comparison and a
 * shredded one. A closing brace occurs six times in each file; a function
 * signature occurs once. Both are shared lines, and letting them compete on
 * equal footing means the chain of anchors can be made of braces — which
 * matches every brace to some brace and cuts every function body to ribbons
 * around them. So the lines unique to both sides are asked first; only if there
 * are none does the next tier get a turn. The commoner lines are not thrown
 * away, they are deferred: inside the gap between two anchors a brace is often
 * the only brace, and there it is exactly the anchor that is wanted.
 *
 * @returns {number[]|null} the chosen pairs, flat — empty when the two ranges
 *   share no line at all, and null when they share lines but nothing could be
 *   anchored on.
 */
function chooseAnchors(a, a0, aN, b, b0, bN, opts) {
  const ca = new Map(), cb = new Map();
  for (let i = a0; i < aN; i++) ca.set(a[i], (ca.get(a[i]) || 0) + 1);
  for (let j = b0; j < bN; j++) cb.set(b[j], (cb.get(b[j]) || 0) + 1);

  /* Every line the two ranges share, with how rare it is and how many candidate
     pairs admitting it would cost. */
  const limit = opts.patience ? 1 : DIFF_HIST_CHAIN;
  const shared = [];
  let anyShared = false;
  ca.forEach((na, id) => {
    const nb = cb.get(id);
    if (!nb) return;
    anyShared = true;
    if (na <= limit && nb <= limit) shared.push({ id, rare: na > nb ? na : nb, cost: na * nb });
  });
  if (!shared.length) return anyShared ? null : [];
  shared.sort((x, y) => x.rare - y.rare || x.cost - y.cost);

  const usable = new Set();
  let budget = CANDIDATE_MAX;
  let at = 0;
  for (const cap of TIERS) {
    if (cap > limit) break;
    let grew = false;
    while (at < shared.length && shared[at].rare <= cap) {
      const row = shared[at];
      if (row.cost <= budget) { budget -= row.cost; usable.add(row.id); grew = true; }
      at++;
    }
    if (!grew) continue;
    const chosen = chainOver(a, a0, aN, b, b0, bN, usable);
    if (chosen.length) return chosen;
  }
  return null;
}

/**
 * The longest chain of anchors that runs forwards through both ranges.
 *
 * Sort the candidate pairs by their position in A and the answer is the longest
 * strictly increasing subsequence of their positions in B — the classic
 * reduction of longest common subsequence to longest increasing subsequence,
 * solved by patience sorting in O(R log R).
 */
function chainOver(a, a0, aN, b, b0, bN, usable) {
  /* Where each usable line sits in B, ascending. */
  const posB = new Map();
  for (let j = b0; j < bN; j++) {
    const id = b[j];
    if (!usable.has(id)) continue;
    const found = posB.get(id);
    if (found) found.push(j); else posB.set(id, [j]);
  }

  /* Candidate pairs, ordered by position in A ascending and — for one line of A
     that matches several of B — by position in B *descending*. That ordering is
     what makes a plain increasing subsequence pick at most one partner per
     line. Two flat arrays rather than an array of pairs: this is the hot loop. */
  const candA = [], candB = [];
  for (let i = a0; i < aN; i++) {
    const list = posB.get(a[i]);
    if (!list) continue;
    for (let k = list.length - 1; k >= 0; k--) { candA.push(i); candB.push(list[k]); }
  }
  if (!candA.length) return [];

  /* tails[k] is the smallest B position that can end a chain of length k+1;
     `from` remembers each link so the chain can be walked back out. */
  const total = candA.length;
  const tails = [], tailAt = [];
  const from = new Int32Array(total).fill(-1);
  for (let c = 0; c < total; c++) {
    const j = candB[c];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
    tails[lo] = j;
    tailAt[lo] = c;
    from[c] = lo > 0 ? tailAt[lo - 1] : -1;
  }

  const picked = [];
  for (let cursor = tailAt[tails.length - 1]; cursor >= 0; cursor = from[cursor]) picked.push(cursor);
  const chosen = new Array(picked.length * 2);
  for (let k = 0, w = 0; k < picked.length; k++) {
    const c = picked[picked.length - 1 - k];
    chosen[w++] = candA[c];
    chosen[w++] = candB[c];
  }
  return chosen;
}
