/**
 * Comparing two JSON documents by their structure, not their text.
 *
 * Reordering the keys of an object changes nothing about what the document
 * says, and a line comparison will report every one of them. Add a field near
 * the top and every line below it shifts. Re-indent a file and the whole thing
 * is a change. None of that is a difference in the *data*, which is what
 * someone comparing two API payloads or two fixtures came to find out.
 *
 * So both sides are parsed and walked together. Keys are matched to keys, and
 * because a matched key can sit in a different place on each side, the key
 * lists themselves are matched by longest common subsequence, which puts an
 * added field where it belongs rather than at the end.
 *
 * Arrays are the interesting part. `[{id: 1}, {id: 2}]` against
 * `[{id: 2}, {id: 1}]` holds the same two records, and a comparison that says
 * both changed has answered the wrong question. So an array of records is
 * examined for a field that identifies them — `id`, `key`, `name`, or whatever
 * else turns out to be present everywhere and unique on both sides — and the
 * records are matched on that. Two records with the same identity in a
 * different position are one record that *moved*. Where there is no such field,
 * elements are matched on a canonical hash of their contents instead, and what
 * is left over is paired up positionally so a reader can see which field of the
 * third element changed rather than being told the third element is new.
 *
 * The output is the same row model the line comparison produces, so the view
 * neither knows nor cares which of them ran. Rows show no trailing commas: this
 * is a reading of the data, like the JSON tree elsewhere in Folio, and a comma
 * moving from one line to another is exactly the kind of non-difference the
 * whole exercise is meant to get rid of. The Lines strategy is there for
 * anybody who does want the text compared as text.
 */
import { JSON_INDENT } from '../../core/config.js';
import { embedded, isBranch, parse, typeOf } from '../json/model.js';
import { match } from './myers.js';
import { refine } from './tokens.js';

const ROW_MAX = 300000;       // rows before the walk stops and says so
const DEPTH_MAX = 200;
const IDENTITY_KEYS = ['id', '_id', 'uuid', 'guid', 'key', 'code', 'sku', 'slug', 'name', 'path', 'email', 'username'];

/**
 * @returns {{ok:boolean, rows?:object[], truncated?:boolean, error?:string}}
 */
export function diffJson(aText, bText, opts) {
  const ra = parse(aText), rb = parse(bText);
  if (!ra.ok) return { ok: false, error: 'The left document is not valid JSON — ' + ra.error };
  if (!rb.ok) return { ok: false, error: 'The right document is not valid JSON — ' + rb.error };

  const ctx = { rows: [], an: 0, bn: 0, truncated: false, opts: opts || {}, moves: 0 };
  walkValue(ctx, ra.value, rb.value, '', 0);
  return { ok: true, rows: ctx.rows, truncated: ctx.truncated, moves: ctx.moves };
}

/* ---------- Emitting rows ---------- */

const pad = (depth) => ' '.repeat(depth * JSON_INDENT);

function put(ctx, k, a, b, depth, extra) {
  if (ctx.rows.length >= ROW_MAX) { ctx.truncated = true; return null; }
  const row = {
    k, a, b, depth,
    ai: a === null ? null : ++ctx.an,
    bi: b === null ? null : ++ctx.bn
  };
  if (ctx.move) row.move = ctx.move;
  if (extra) Object.assign(row, extra);
  ctx.rows.push(row);
  return row;
}

/** Put a comma on the last row of a group that has a line on the given side. */
function comma(ctx, from, side) {
  for (let i = ctx.rows.length - 1; i >= from; i--) {
    const row = ctx.rows[i];
    if (side === 'a') { if (row.a !== null) { row.a += ','; return; } }
    else if (row.b !== null) { row.b += ','; return; }
  }
}

const scalar = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));
const opener = (v) => (Array.isArray(v) ? '[' : '{');
const closer = (v) => (Array.isArray(v) ? ']' : '}');
const empty = (v) => (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);

/* ---------- One value against another ---------- */

function walkValue(ctx, av, bv, label, depth) {
  if (ctx.truncated) return;
  if (depth > DEPTH_MAX) { put(ctx, 'eq', pad(depth) + label + '…', pad(depth) + label + '…', depth); return; }

  const ta = typeOf(av), tb = typeOf(bv);
  const bothBranch = isBranch(av) && isBranch(bv) && ta === tb;

  /* JSON smuggled through a string is the document it holds, and comparing two
     of them as strings would report one long unreadable change. */
  if (!bothBranch && ta === 'string' && tb === 'string' && av !== bv && ctx.opts.embedded !== false) {
    const ea = embedded(av), eb = embedded(bv);
    if (ea !== undefined && eb !== undefined && typeOf(ea) === typeOf(eb)) {
      walkBranch(ctx, ea, eb, label, depth, true);
      return;
    }
  }

  if (bothBranch) { walkBranch(ctx, av, bv, label, depth, false); return; }

  if (ta === tb && ta !== 'object' && ta !== 'array') {
    const at = pad(depth) + label + scalar(av);
    const bt = pad(depth) + label + scalar(bv);
    if (av === bv || (ta === 'number' && Number.isNaN(av) && Number.isNaN(bv))) {
      put(ctx, 'eq', at, bt, depth);
    } else {
      put(ctx, 'chg', at, bt, depth, segments(at, bt, ctx));
    }
    return;
  }

  /* A number where an object used to be is not an edited line; it is one thing
     gone and another arrived, and drawing it that way is the honest reading. */
  if (isBranch(av) || isBranch(bv)) {
    oneSide(ctx, av, label, depth, 'a');
    oneSide(ctx, bv, label, depth, 'b');
    return;
  }
  const at = pad(depth) + label + scalar(av);
  const bt = pad(depth) + label + scalar(bv);
  put(ctx, 'chg', at, bt, depth, segments(at, bt, ctx));
}

function segments(at, bt, ctx) {
  if (ctx.opts.words === false) return null;
  const worked = refine(at, bt);
  return worked ? { aSegs: worked.a, bSegs: worked.b } : null;
}

/** An object or an array, present on both sides. */
function walkBranch(ctx, av, bv, label, depth, embed) {
  const open = label + opener(av);
  const shut = closer(av);
  if (empty(av) && empty(bv)) {
    put(ctx, 'eq', pad(depth) + label + opener(av) + shut, pad(depth) + label + opener(bv) + shut, depth, embed ? { embed: true } : null);
    return;
  }
  put(ctx, 'eq', pad(depth) + open, pad(depth) + open, depth, embed ? { embed: true } : null);
  const entries = Array.isArray(av) ? arrayEntries(av, bv, ctx) : objectEntries(av, bv);
  emitEntries(ctx, av, bv, entries, depth + 1);
  put(ctx, 'eq', pad(depth) + shut, pad(depth) + shut, depth);
}

/** Walk the paired-up entries of one container, commas and all. */
function emitEntries(ctx, av, bv, entries, depth) {
  let lastA = -1, lastB = -1;
  entries.forEach((e, i) => { if (e.a !== null) lastA = i; if (e.b !== null) lastB = i; });

  entries.forEach((e, i) => {
    if (ctx.truncated) return;
    const from = ctx.rows.length;
    const labelA = e.a === null ? '' : keyLabel(av, e.a);
    const labelB = e.b === null ? '' : keyLabel(bv, e.b);

    if (e.a !== null && e.b !== null) {
      const held = ctx.move;
      if (e.move) ctx.move = e.move;
      if (labelA === labelB) {
        walkValue(ctx, valueAt(av, e.a), valueAt(bv, e.b), labelA, depth);
      } else {
        /* Same record under a different key: one row per side, so both labels
           stay visible. */
        oneSide(ctx, valueAt(av, e.a), labelA, depth, 'a', e.move);
        oneSide(ctx, valueAt(bv, e.b), labelB, depth, 'b', e.move);
      }
      ctx.move = held;
      if (i !== lastA) comma(ctx, from, 'a');
      if (i !== lastB) comma(ctx, from, 'b');
      return;
    }
    if (e.a !== null) {
      oneSide(ctx, valueAt(av, e.a), labelA, depth, 'a', e.move);
      if (i !== lastA) comma(ctx, from, 'a');
      return;
    }
    oneSide(ctx, valueAt(bv, e.b), labelB, depth, 'b', e.move);
    if (i !== lastB) comma(ctx, from, 'b');
  });
}

const keyLabel = (container, at) => (Array.isArray(container) ? '' : JSON.stringify(at) + ': ');
const valueAt = (container, at) => container[at];

/** A whole subtree that exists on one side only. */
function oneSide(ctx, v, label, depth, side, move) {
  if (ctx.truncated) return;
  const kind = side === 'a' ? 'del' : 'ins';
  const extra = move ? { move } : null;
  const line = (text) => (side === 'a' ? put(ctx, kind, text, null, depth, extra) : put(ctx, kind, null, text, depth, extra));

  if (!isBranch(v)) { line(pad(depth) + label + scalar(v)); return; }
  if (empty(v)) { line(pad(depth) + label + opener(v) + closer(v)); return; }
  line(pad(depth) + label + opener(v));
  const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
  keys.forEach((key, i) => {
    const from = ctx.rows.length;
    oneSide(ctx, v[key], keyLabel(v, key), depth + 1, side, move);
    if (i !== keys.length - 1) comma(ctx, from, side);
  });
  line(pad(depth) + closer(v));
}

/* ---------- Pairing up the entries of a container ---------- */

/**
 * Match two key lists, in place.
 *
 * The longest common subsequence of the two orderings decides what lines up;
 * anything outside it is a key on one side only. A key that exists on both
 * sides but fell outside the subsequence is a key that moved.
 */
function objectEntries(ao, bo) {
  const ak = Object.keys(ao), bk = Object.keys(bo);
  /* The order of an object's keys says nothing, so a key that sits in a
     different place on each side is not a change and is not worth marking. */
  const entries = pairSequences(ak, bk, intern(ak, bk), false);
  return entries.map(e => ({
    a: e.a === null ? null : ak[e.a],
    b: e.b === null ? null : bk[e.b]
  }));
}

/**
 * Match two arrays.
 *
 * By an identity field when the elements have one, and by a hash of their
 * contents when they do not — in which case whatever is left unmatched is
 * paired up positionally, so a changed field inside an element reads as a
 * changed field rather than as a wholly new element.
 */
function arrayEntries(av, bv, ctx) {
  const key = identityKey(av, bv);
  if (key) {
    const ka = av.map(v => stamp(v[key]));
    const kb = bv.map(v => stamp(v[key]));
    const entries = pairSequences(ka, kb, intern(ka, kb), true);
    ctx.moves += entries.filter(e => e.move).length;
    return entries;
  }
  const ha = av.map(canonical);
  const hb = bv.map(canonical);
  const entries = pairSequences(ha, hb, intern(ha, hb), true);
  ctx.moves += entries.filter(e => e.move).length;
  return pairLeftovers(entries, av, bv);
}

/** A field that names every element of both arrays, and names each one once. */
function identityKey(av, bv) {
  const usable = (arr) => arr.length > 0 && arr.length < 200000 && arr.every(v => v !== null && typeof v === 'object' && !Array.isArray(v));
  if (!usable(av) || !usable(bv)) return null;

  const shared = Object.keys(av[0]).filter(k => Object.prototype.hasOwnProperty.call(bv[0], k));
  if (!shared.length) return null;
  const ranked = shared.slice().sort((x, y) => rank(x) - rank(y));

  for (const key of ranked) {
    if (identifies(av, key) && identifies(bv, key)) return key;
  }
  return null;
}

const rank = (key) => {
  const at = IDENTITY_KEYS.indexOf(String(key).toLowerCase());
  return at < 0 ? IDENTITY_KEYS.length : at;
};

/** Present on every element, scalar, and never repeated. */
function identifies(arr, key) {
  const seen = new Set();
  for (const row of arr) {
    const v = row[key];
    if (v === undefined || v === null || typeof v === 'object') return false;
    const s = stamp(v);
    if (seen.has(s)) return false;
    seen.add(s);
  }
  return true;
}

const stamp = (v) => typeOf(v) + ':' + String(v);

/** A stable text for a value: sorted keys, so key order cannot affect a hash. */
function canonical(v, depth) {
  const d = depth || 0;
  if (d > 12) return '…';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) || 'undefined';
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x, d + 1)).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k], d + 1)).join(',') + '}';
}

/** Intern two lists of strings into one shared numbering. */
function intern(x, y) {
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
  return { a: ids(x), b: ids(y) };
}

/**
 * Two orderings into a list of entries.
 *
 * An entry is `{a, b}` — an index on each side, or null where there is nothing.
 * Something named the same on both sides but left outside the common
 * subsequence is one entry that changed place: the two halves are merged into a
 * single row so that whatever *else* changed about it is still compared, and
 * `markMoves` decides whether moving is itself worth reporting. For an object
 * it is not — key order carries no meaning. For an array it is the point.
 */
function pairSequences(aList, bList, ids, markMoves) {
  const { pairs } = match(ids.a, ids.b);
  const entries = [];
  let ai = 0, bi = 0;
  const gap = (aTo, bTo) => {
    const spare = [];
    for (let i = ai; i < aTo; i++) spare.push({ a: i, b: null });
    for (let j = bi; j < bTo; j++) spare.push({ a: null, b: j });
    spare.forEach(e => entries.push(e));
  };
  for (let k = 0; k < pairs.length; k += 2) {
    const pa = pairs[k], pb = pairs[k + 1];
    if (pa < ai || pb < bi) continue;
    gap(pa, pb);
    entries.push({ a: pa, b: pb });
    ai = pa + 1; bi = pb + 1;
  }
  gap(aList.length, bList.length);

  /* Anything named the same on both sides but left over is one entry in a new
     place, not a removal and an arrival. */
  const waiting = new Map();
  entries.forEach((e, i) => {
    if (e.a === null || e.b !== null) return;
    const name = aList[e.a];
    const bucket = waiting.get(name);
    if (bucket) bucket.push(i); else waiting.set(name, [i]);
  });
  const merged = new Set();
  let moves = 0;
  entries.forEach((e, i) => {
    if (e.b === null || e.a !== null) return;
    const bucket = waiting.get(bList[e.b]);
    if (!bucket || !bucket.length) return;
    const at = bucket.shift();
    moves++;
    entries[at].b = e.b;
    if (markMoves) entries[at].move = moves;
    merged.add(i);
  });
  return merged.size ? entries.filter((_, i) => !merged.has(i)) : entries;
}

/**
 * Pair up what the hash match could not.
 *
 * Runs of removed and added elements sitting next to each other are usually the
 * same elements with a field changed, so they are matched positionally and
 * recursed into. Only same-shaped values are paired: an object against a number
 * would be two rows pretending to be one.
 */
function pairLeftovers(entries, av, bv) {
  const out = [];
  let i = 0;
  while (i < entries.length) {
    if (entries[i].a === null || entries[i].b !== null) { out.push(entries[i]); i++; continue; }
    let j = i;
    while (j < entries.length && entries[j].b === null && entries[j].a !== null) j++;
    let k = j;
    while (k < entries.length && entries[k].a === null && entries[k].b !== null) k++;
    const dels = entries.slice(i, j), inses = entries.slice(j, k);
    const both = Math.min(dels.length, inses.length);
    for (let n = 0; n < both; n++) {
      const left = av[dels[n].a], right = bv[inses[n].b];
      if (typeOf(left) === typeOf(right)) out.push({ a: dels[n].a, b: inses[n].b });
      else { out.push(dels[n]); out.push(inses[n]); }
    }
    for (let n = both; n < dels.length; n++) out.push(dels[n]);
    for (let n = both; n < inses.length; n++) out.push(inses[n]);
    i = k;
  }
  return out;
}
