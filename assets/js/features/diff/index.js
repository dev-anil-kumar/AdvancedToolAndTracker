/**
 * Comparing two files: the one door into everything else in this folder.
 *
 * Given two sources it works out what they are, picks how to match them up,
 * runs it, and hands back a list of rows and a count of what changed. A caller
 * needs to know none of the rest — which is the point, because "which algorithm
 * should this be" is a question about Java and JSON and CSV, not a question a
 * view should be asked.
 *
 *   structure  JSON, matched key to key and record to record
 *   table      CSV and TSV, matched row to row and column to column
 *   lines      everything else, matched line to line
 *
 * A strategy that cannot run says so and the comparison falls back to lines
 * rather than refusing: two files that were supposed to be JSON and turn out
 * not to parse are still two files somebody wants to see side by side.
 *
 * Large files go through a worker (worker.js) so the page never stops
 * answering. Everything here works without one — a browser with no module
 * workers, or a test harness with no workers at all, gets the same answer on
 * the main thread.
 */
import { DIFF_WORKER_MIN } from '../../core/config.js';
import { blocksOf, foldRows, isQuiet, rowsFromOps, statsOf, unifiedPatch } from './align.js';
import { defaultOptions, delimiterFor, detectPair, looksBinary, strategyFor } from './detect.js';
import { diffJson } from './json.js';
import { diffTable } from './table.js';
import { diffLines, splitLines } from './text.js';

export { blocksOf, foldRows, isQuiet, statsOf, unifiedPatch };
export { defaultOptions, detectOne, detectPair } from './detect.js';
export { LANGS } from './detect.js';
export { createSyntax } from './syntax.js';

/** Which strategy the pair would get left to itself. */
export const autoStrategy = (type) => strategyFor(type.family);

/**
 * Compare two sources.
 *
 * @param {{name:string, text:string}} a
 * @param {{name:string, text:string}} b
 * @param {object} opts  strategy, algo, and the ignore-* switches
 * @returns {object} a comparison: rows, stats, and what is worth telling
 */
export function compareNow(a, b, opts) {
  const options = opts || {};
  const type = options.type || detectPair(a, b).type;
  const notes = [];
  const asked = options.strategy && options.strategy !== 'auto' ? options.strategy : strategyFor(type.family);

  if (looksBinary(a.text) || looksBinary(b.text)) {
    notes.push('One of these does not look like text. What follows may not mean much.');
  }

  let built = null;
  if (asked === 'structure') {
    const found = diffJson(a.text, b.text, options);
    if (found.ok) built = { strategy: 'structure', rows: found.rows, truncated: found.truncated, moves: found.moves, exact: true };
    else notes.push(found.error + ' Compared line by line instead.');
  } else if (asked === 'table') {
    const found = diffTable(a.text, b.text, options, delimiterFor(type.id));
    if (found.ok) {
      built = { strategy: 'table', rows: found.rows, truncated: found.truncated, exact: true, columns: found.columns };
      if (found.added) notes.push(found.added + (found.added === 1 ? ' column was added.' : ' columns were added.'));
      if (found.dropped) notes.push(found.dropped + (found.dropped === 1 ? ' column was dropped.' : ' columns were dropped.'));
    } else notes.push(found.error + ' Compared line by line instead.');
  }

  if (!built) built = lineCompare(a.text, b.text, options);
  return finish(a, b, type, built, notes, options);
}

/** The line path, shared by the direct call and by the worker's reply. */
function lineCompare(aText, bText, options) {
  const aLines = splitLines(aText).lines;
  const bLines = splitLines(bText).lines;
  const found = diffLines(aLines, bLines, options);
  return {
    strategy: 'lines',
    rows: rowsFromOps(found.ops, aLines, bLines, options),
    exact: found.exact,
    moves: found.moves,
    aLines, bLines
  };
}

function finish(a, b, type, built, notes, options) {
  const stats = statsOf(built.rows);
  if (!built.exact) {
    notes.push('Part of this was too tangled to match exactly, and is shown as a rewrite.');
  }
  if (built.truncated) {
    notes.push('The comparison was cut short — these files are larger than one screenful of rows can describe.');
  }
  return {
    a: { name: a.name || '', lines: built.aLines ? built.aLines.length : countSide(built.rows, 'ai') },
    b: { name: b.name || '', lines: built.bLines ? built.bLines.length : countSide(built.rows, 'bi') },
    type,
    strategy: built.strategy,
    algo: options.algo || 'histogram',
    rows: built.rows,
    columns: built.columns || null,
    aLines: built.aLines || null,
    bLines: built.bLines || null,
    stats,
    moves: built.moves || stats.moved,
    exact: built.exact !== false,
    truncated: !!built.truncated,
    notes,
    blocks: blocksOf(built.rows)
  };
}

const countSide = (rows, field) => rows.reduce((n, r) => n + (r[field] !== null ? 1 : 0), 0);

/* ---------- The same thing, without stopping the page ---------- */

const HELLO_MS = 4000;   // a worker that has not said hello by now is not going to

let pool = null;      // one worker, reused for every comparison
let alive = null;     // resolves true once it has proved it runs
let ticket = 0;
let broken = false;   // a worker that failed once is not asked again

function worker() {
  if (broken) return null;
  if (pool) return pool;
  if (typeof Worker === 'undefined') { broken = true; return null; }
  try {
    pool = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    broken = true;
    pool = null;
    return null;
  }
  /* Wait for it to say hello. A module worker whose imports fail is constructed
     without complaint and then never answers, so trusting the constructor alone
     is how a comparison ends up waiting forever on nothing. */
  alive = new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const hello = (event) => {
      if (event.data && event.data.ready) { pool.removeEventListener('message', hello); finish(true); }
    };
    pool.addEventListener('message', hello);
    pool.addEventListener('error', () => finish(false));
    setTimeout(() => finish(false), HELLO_MS);
  });
  return pool;
}

/**
 * Compare two sources, using a worker when the files are big enough for it to
 * matter. Resolves with exactly what compareNow would have returned, whether or
 * not this browser has a worker to give.
 */
export async function compare(a, b, opts) {
  const options = opts || {};
  const type = options.type || detectPair(a, b).type;
  const withType = Object.assign({}, options, { type });
  const asked = options.strategy && options.strategy !== 'auto' ? options.strategy : strategyFor(type.family);
  /* Roughly forty characters to a line — near enough to decide whether this is
     worth crossing a thread boundary for, and it costs nothing to work out. */
  const heavy = (a.text.length + b.text.length) / 40 > DIFF_WORKER_MIN;

  if (asked !== 'lines' || !heavy) return compareNow(a, b, withType);
  const hand = worker();
  if (!hand || !(await alive)) { broken = true; return compareNow(a, b, withType); }

  const id = ++ticket;
  return new Promise((resolve) => {
    let settled = false;
    const stop = () => {
      hand.removeEventListener('message', onMessage);
      hand.removeEventListener('error', onFailure);
      hand.removeEventListener('messageerror', onFailure);
    };
    const done = (value) => { if (!settled) { settled = true; stop(); resolve(value); } };
    function onFailure() { broken = true; done(compareNow(a, b, withType)); }
    function onMessage(event) {
      const reply = event.data || {};
      if (reply.id !== id) return;         // an earlier comparison, now irrelevant
      if (!reply.ok) { done(compareNow(a, b, withType)); return; }
      const aLines = splitLines(a.text).lines;
      const bLines = splitLines(b.text).lines;
      done(finish(a, b, type, {
        strategy: 'lines',
        rows: rowsFromOps(reply.ops, aLines, bLines, withType),
        exact: reply.exact,
        moves: reply.moves,
        aLines, bLines
      }, [], withType));
    }
    hand.addEventListener('message', onMessage);
    hand.addEventListener('error', onFailure);
    hand.addEventListener('messageerror', onFailure);
    try {
      hand.postMessage({ id, aText: a.text, bText: b.text, opts: plain(withType) });
    } catch (err) {
      onFailure();                         // nothing to send it with; do it here
    }
  });
}

/** Only what survives being posted to a worker. */
function plain(options) {
  const out = {};
  ['algo', 'trimEnd', 'allSpace', 'blankLines', 'caseless', 'words', 'moves', 'maxD']
    .forEach(key => { if (options[key] !== undefined) out[key] = options[key]; });
  return out;
}

/** Seed a fresh set of options for a pair of files. */
export function optionsFor(type) {
  return Object.assign({ strategy: 'auto', algo: 'histogram' }, defaultOptions(type.family));
}
