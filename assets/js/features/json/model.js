/**
 * Everything the JSON views need to know about JSON, and nothing about the DOM.
 *
 * The one idea worth explaining is *embedded* JSON. A field like
 *
 *   "queue": "[{\"callState\":\"STARTED\"},{\"callState\":\"ANSWERED\"}]"
 *
 * is a string as far as JSON.parse is concerned, but it is a document in its
 * own right, and reading it as a string is miserable. `embedded()` recognises
 * one and hands back its parsed value; every view then treats it as structure.
 * The nesting can repeat, so an embedded document may contain another.
 */
import {
  JSON_INDENT, JSON_PEEK, JSON_SEARCH_HITS, TABLE_COLS_MAX, TABLE_DEPTH, TABLE_SCAN
} from '../../core/config.js';

/* ---------- Types ---------- */

/** The type name a view colours by. Distinguishes the two container kinds. */
export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object') return 'object';
  if (t === 'number') return Number.isFinite(v) ? 'number' : 'null';
  if (t === 'boolean') return 'boolean';
  if (t === 'string') return 'string';
  return 'null';
}
export const isBranch = (v) => v !== null && typeof v === 'object';
export const childCount = (v) => (Array.isArray(v) ? v.length : isBranch(v) ? Object.keys(v).length : 0);

/* ---------- Parsing ---------- */

/**
 * Parse, and on failure say *where*.
 *
 * Where is the hard part. Engines disagree, and V8 dropped the character
 * position from its message in 2023 — "Unexpected token '}', ...\"b\": [1, 2, }\"
 * is not valid JSON" tells a person nothing about which line to look at. So
 * when the message has no position in it, locate() finds one: JSON is a small
 * enough grammar to scan for the first thing that cannot be there.
 */
export function parse(text) {
  const src = String(text == null ? '' : text).replace(/^﻿/, '');
  if (!src.trim()) return { ok: false, error: 'Nothing to read yet.', line: 0, column: 0, index: -1 };
  try {
    return { ok: true, value: JSON.parse(src) };
  } catch (err) {
    const msg = String((err && err.message) || err);
    const said = msg.match(/position (\d+)/);
    const index = said ? Number(said[1]) : locate(src);
    const spot = index >= 0 ? place(src, index) : lineOf(msg);
    return { ok: false, error: tidyError(msg), line: spot.line, column: spot.column, index };
  }
}

/**
 * The offset of the first character that breaks the grammar, or -1 if the text
 * is in fact valid JSON. A plain recursive-descent scan: it builds nothing and
 * keeps nothing, so it costs one pass and is only ever run on text that has
 * already failed to parse.
 */
function locate(src) {
  const n = src.length;
  let i = 0;
  const fail = () => { throw i; };
  const digit = (c) => c >= '0' && c <= '9';
  const ws = () => { while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++; };

  function str() {
    if (src[i] !== '"') fail();
    i++;
    while (i < n) {
      const c = src[i];
      if (c === '"') { i++; return; }
      if (c === '\\') {
        i++;
        const esc = src[i];
        if (esc === 'u') {
          i++;
          for (let k = 0; k < 4; k++) { if (!/[0-9a-fA-F]/.test(src[i] || '')) fail(); i++; }
          continue;
        }
        if (esc === undefined || '"\\/bfnrt'.indexOf(esc) === -1) fail();
        i++;
        continue;
      }
      if (c < ' ') fail();          // a raw newline or tab inside a string
      i++;
    }
    fail();                          // ran out before the closing quote
  }

  function num() {
    if (src[i] === '-') i++;
    if (src[i] === '0') i++;
    else if (digit(src[i])) { while (digit(src[i])) i++; }
    else fail();
    if (src[i] === '.') { i++; if (!digit(src[i])) fail(); while (digit(src[i])) i++; }
    if (src[i] === 'e' || src[i] === 'E') {
      i++;
      if (src[i] === '+' || src[i] === '-') i++;
      if (!digit(src[i])) fail();
      while (digit(src[i])) i++;
    }
  }

  function value() {
    ws();
    const c = src[i];
    if (c === undefined) fail();
    if (c === '{') {
      i++; ws();
      if (src[i] === '}') { i++; return; }
      for (;;) {
        ws(); str(); ws();
        if (src[i] !== ':') fail();
        i++; value(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return; }
        fail();
      }
    }
    if (c === '[') {
      i++; ws();
      if (src[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return; }
        fail();
      }
    }
    if (c === '"') { str(); return; }
    for (const word of ['true', 'false', 'null']) {
      if (src.startsWith(word, i)) { i += word.length; return; }
    }
    num();
  }

  try {
    value();
    ws();
    if (i < n) fail();
    return -1;
  } catch (at) {
    return typeof at === 'number' ? at : Math.min(i, n);
  }
}

/** A character offset, as a 1-based line and column. */
function place(src, index) {
  const upto = src.slice(0, Math.max(0, Math.min(index, src.length)));
  const lines = upto.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/* Safari and Firefox report "line 3 column 9" instead of a position. */
function lineOf(msg) {
  const m = msg.match(/line (\d+) column (\d+)/i);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : { line: 0, column: 0 };
}

/** Engine messages, trimmed to the part a person can act on. */
function tidyError(msg) {
  return msg
    .replace(/^JSON\.parse:\s*/, '')
    /* V8, 2023 onwards: Unexpected token '}', ..."b": [1, 2, }" is not valid JSON */
    .replace(/^Unexpected token '(.+?)',[\s\S]*$/, 'Unexpected “$1”')
    .replace(/^Unexpected token (.+?) in JSON at position \d+.*$/, 'Unexpected “$1”')
    .replace(/^(Expected [\s\S]+?) at line \d+ column \d+.*$/, '$1')
    .replace(/\s+in JSON at position \d+.*$/, '')
    .replace(/^(Unexpected non-whitespace character after JSON).*$/, 'Something follows the end of the document')
    .replace(/\s*is not valid JSON\.?$/, '')
    .replace(/^Unexpected end of JSON input$/, 'The document stops before it is finished')
    .trim() || 'That is not valid JSON.';
}

/**
 * Is this string a JSON document in disguise? Only objects and arrays count —
 * treating "12" or "true" as structure would turn ordinary data into noise.
 * Returns the parsed value, or undefined.
 */
export function embedded(value) {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s.length < 2) return undefined;
  const open = s[0], close = s[s.length - 1];
  if (!((open === '{' && close === '}') || (open === '[' && close === ']'))) return undefined;
  try {
    const parsed = JSON.parse(s);
    return isBranch(parsed) ? parsed : undefined;
  } catch (err) {
    return undefined;
  }
}

/** True when a string looks like JSON but will not parse — a truncated field. */
export function looksTruncated(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 8 || (s[0] !== '{' && s[0] !== '[')) return false;
  return embedded(value) === undefined;
}

/* ---------- Writing it back out ---------- */

export const pretty = (value, indent = JSON_INDENT) => JSON.stringify(value, null, indent);
export const minify = (value) => JSON.stringify(value);

/** Sort every object's keys, recursively. Arrays keep their order. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isBranch(value)) return value;
  const out = {};
  Object.keys(value).sort((a, b) => a.localeCompare(b)).forEach(k => { out[k] = sortKeys(value[k]); });
  return out;
}

/**
 * Replace every embedded JSON string with the document it contains, all the
 * way down. This is what makes the code view readable for data that arrived
 * with JSON stuffed inside JSON.
 */
export function unwrap(value) {
  if (Array.isArray(value)) return value.map(unwrap);
  if (isBranch(value)) {
    const out = {};
    Object.keys(value).forEach(k => { out[k] = unwrap(value[k]); });
    return out;
  }
  const inner = embedded(value);
  return inner === undefined ? value : unwrap(inner);
}

/* ---------- Describing a value ---------- */

/** The one-line summary shown beside a collapsed branch. */
export function summarise(value) {
  const n = childCount(value);
  if (Array.isArray(value)) return n === 1 ? '1 item' : n + ' items';
  const keys = Object.keys(value);
  if (!keys.length) return 'empty';
  const head = keys.slice(0, 3).join(', ');
  return (n === 1 ? '1 key' : n + ' keys') + ' · ' + head + (keys.length > 3 ? '…' : '');
}

/** A leaf, shortened for a collapsed row or a table cell. */
export function peek(value, max = JSON_PEEK) {
  const t = typeOf(value);
  if (t === 'string') {
    const one = value.replace(/\s+/g, ' ');
    return one.length > max ? one.slice(0, max) + '…' : one;
  }
  if (t === 'null') return 'null';
  return String(value);
}

/* ---------- Paths ---------- */

/**
 * A path is a list of segments: { key } for a member, { embedded: true } for
 * the step from a string into the document it holds. pathKey() flattens one
 * into a string so it can go in a Set — every view identifies nodes this way.
 */
export const PATH_SEP = '\u0000';
export const pathKey = (segments) =>
  segments.map(seg => (seg.embedded ? '»' : String(seg.key))).join(PATH_SEP);

/**
 * A value's children, whether they are its own or come out of an embedded
 * document. `base` is the path its children hang off — one step longer than
 * `segments` when a string had to be opened to reach them.
 */
export function childrenOf(value, segments) {
  const inner = typeof value === 'string' ? embedded(value) : undefined;
  const branch = inner !== undefined ? inner : (isBranch(value) ? value : null);
  if (!branch) return { branch: null, base: segments, children: [] };
  const base = inner !== undefined ? segments.concat([{ embedded: true }]) : segments;
  const keys = Array.isArray(branch) ? branch.map((_, i) => i) : Object.keys(branch);
  return {
    branch,
    base,
    children: keys.map(k => ({ key: k, value: branch[k], segments: base.concat([{ key: k }]) }))
  };
}

/**
 * The paths a search leaves visible: every key or value that matches, and
 * every ancestor of one. Bounded twice over — by hits and by nodes walked —
 * so a search on a very large document answers rather than hangs.
 *
 * Shared, because the tree and the graph must agree on what a match is.
 */
export function matchPaths(root, query, opts) {
  const options = opts || {};
  const limit = options.limit || JSON_SEARCH_HITS;
  let budget = options.budget || 400000;
  const needle = String(query || '').trim().toLowerCase();
  const paths = new Set();
  let hits = 0;
  if (!needle) return { paths: null, hits: 0 };
  const test = (v) => String(v).toLowerCase().includes(needle);

  (function walk(value, segments, trail) {
    if (budget-- <= 0 || hits >= limit) return;
    const { branch, children } = childrenOf(value, segments);
    const last = segments.length ? segments[segments.length - 1] : null;
    const keyHit = last && !last.embedded && test(last.key);
    const leafHit = !branch && test(value === null ? 'null' : value);
    if (keyHit || leafHit) {
      hits++;
      paths.add(pathKey(segments));
      trail.forEach(p => paths.add(p));
    }
    if (!branch) return;
    const nextTrail = trail.concat([pathKey(segments)]);
    children.forEach(child => walk(child.value, child.segments, nextTrail));
  })(root, [], []);

  return { paths, hits };
}

/** JavaScript accessor notation, so a copied path can be pasted into code. */
export function pathString(segments) {
  return segments.reduce((acc, seg) => {
    if (seg.embedded) return acc + ' » ';
    if (typeof seg.key === 'number') return acc + '[' + seg.key + ']';
    return acc + (/^[A-Za-z_$][\w$]*$/.test(seg.key) ? (acc && !acc.endsWith(' » ') ? '.' : '') + seg.key
      : '["' + String(seg.key).replace(/"/g, '\\"') + '"]');
  }, '') || '$';
}

/* ---------- Tabular data ---------- */

/**
 * Every array of objects in the document, embedded ones included, so the table
 * view can offer them by name instead of asking the reader to hunt.
 */
export function tables(root, limit = 60) {
  const found = [];
  (function walk(value, segments, depth) {
    if (found.length >= limit || depth > 12) return;
    if (Array.isArray(value)) {
      if (value.length && value.some(isBranch)) {
        found.push({ path: pathString(segments), segments, rows: value.length, value });
      }
      value.slice(0, 40).forEach((v, i) => walk(v, segments.concat([{ key: i }]), depth + 1));
      return;
    }
    if (isBranch(value)) {
      Object.keys(value).forEach(k => walk(value[k], segments.concat([{ key: k }]), depth + 1));
      return;
    }
    const inner = embedded(value);
    if (inner !== undefined) walk(inner, segments.concat([{ embedded: true }]), depth + 1);
  })(root, [], 0);
  return found;
}

/**
 * One record, flattened to the fields a table can show.
 *
 * A column per *leaf*, not per top-level key: `{recording: {bytes, format}}`
 * becomes `recording.bytes` and `recording.format`, because a column reading
 * "{2}" tells the reader nothing. Embedded JSON strings are walked into for
 * the same reason. Arrays are left whole — flattening one list of forty into
 * forty columns would wreck the table it was meant to fix.
 *
 * Returns label → { value, segments }, the segments being the real path, so a
 * cell can still hand the reader back to the tree.
 */
export function flattenRow(row, maxDepth = TABLE_DEPTH) {
  const out = new Map();
  (function walk(value, label, segments, depth) {
    const inner = typeof value === 'string' ? embedded(value) : undefined;
    const here = inner !== undefined ? inner : value;
    const base = inner !== undefined ? segments.concat([{ embedded: true }]) : segments;
    const plain = isBranch(here) && !Array.isArray(here);
    const keys = plain ? Object.keys(here) : [];
    if (plain && keys.length && depth < maxDepth) {
      keys.forEach(k => walk(here[k], label ? label + '.' + k : String(k),
        base.concat([{ key: k }]), depth + 1));
      return;
    }
    out.set(label, { value: here, segments: base });
  })(row, '', [], 0);
  return out;
}

/**
 * The columns of an array of records: the union of their flattened fields,
 * first seen first. Capped, and it says how many it had to leave out.
 */
export function columnsOf(rows) {
  const cols = [];
  const seen = new Set();
  let dropped = 0;
  rows.slice(0, TABLE_SCAN).forEach(row => {
    flattenRow(row).forEach((_, label) => {
      if (seen.has(label)) return;
      seen.add(label);
      if (cols.length < TABLE_COLS_MAX) cols.push(label);
      else dropped++;
    });
  });
  return { cols, dropped, scanned: Math.min(rows.length, TABLE_SCAN) };
}

/** Sort comparator that keeps numbers numeric and pushes blanks to the end. */
export function compareCells(a, b) {
  const rank = (v) => (v === undefined || v === null ? 2 : 0);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return String(peek(a, 400)).localeCompare(String(peek(b, 400)), undefined, { numeric: true });
}

/* ---------- Statistics ---------- */

/**
 * Node, key and depth counts for the status line.
 *
 * Embedded documents are counted as the structure they are, because that is
 * what the tree shows: a reader told "10 nodes" about a three-megabyte file
 * would rightly think the count was broken. Bounded, so it stays cheap.
 */
export function stats(value, budget = 200000) {
  let nodes = 0, leaves = 0, objects = 0, arrays = 0, deepest = 0, embeds = 0, stopped = false;
  (function walk(v, depth) {
    if (nodes > budget) { stopped = true; return; }
    nodes++;
    if (depth > deepest) deepest = depth;
    if (Array.isArray(v)) { arrays++; v.forEach(x => walk(x, depth + 1)); return; }
    if (isBranch(v)) { objects++; Object.keys(v).forEach(k => walk(v[k], depth + 1)); return; }
    leaves++;
    if (typeof v !== 'string') return;
    const inner = embedded(v);
    if (inner !== undefined) { embeds++; walk(inner, depth + 1); }
  })(value, 1);
  return { nodes, leaves, objects, arrays, depth: deepest, embeds, partial: stopped };
}

/* ---------- Colouring the code view ---------- */

/**
 * A tokeniser rather than a regex sweep: JSON is small enough a grammar that
 * walking it once is both simpler to reason about and faster than backtracking,
 * and it is the only way to tell a key from a string value reliably.
 *
 * Yields { text, kind } where kind is one of
 * key · string · number · boolean · null · punct · space.
 */
export function tokenize(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  const push = (kind, text) => { if (text) out.push({ kind, text }); };

  while (i < n) {
    const ch = src[i];

    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      const text = src.slice(i, j);
      /* A string followed by a colon is a key. */
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      push(src[k] === ':' ? 'key' : 'string', text);
      i = j;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < n && /[\d.eE+-]/.test(src[j])) j++;
      push('number', src.slice(i, j));
      i = j;
      continue;
    }
    if (src.startsWith('true', i) || src.startsWith('false', i)) {
      const word = src.startsWith('true', i) ? 'true' : 'false';
      push('boolean', word);
      i += word.length;
      continue;
    }
    if (src.startsWith('null', i)) { push('null', 'null'); i += 4; continue; }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      let j = i;
      while (j < n && /\s/.test(src[j])) j++;
      push('space', src.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < n && '{}[],:'.includes(src[j])) j++;
    if (j === i) j = i + 1;                 // never stall on an unexpected byte
    push('punct', src.slice(i, j));
    i = j;
  }
  return out;
}
