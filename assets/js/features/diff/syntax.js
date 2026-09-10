/**
 * Colouring a line of code, on its own.
 *
 * Only the visible rows of a comparison are ever in the DOM, which means a line
 * has to be colourable without its neighbours — and a line cannot be coloured
 * without its neighbours, because whether a line reading `done();` is code or
 * the inside of a comment depends on what came before it. Both are true at
 * once, so the file is scanned once, up front, and all that is kept is one
 * small number per line: the state
 * the tokeniser was in when that line began. Scanning is linear and happens
 * off the back of a comparison that already walked every line; after that any
 * row can be coloured in isolation, in any order, as many times as it is
 * scrolled past.
 *
 * The tokeniser is deliberately shallow — comments, strings, numbers, keywords,
 * punctuation, and for markup the parts of a tag. That is every distinction a
 * reader of a *diff* needs; a full parse per language would be a great deal of
 * code to make `int` a slightly different colour from `count`.
 */
import { DIFF_COLOUR_MAX } from '../../core/config.js';
import { LANGS } from './detect.js';

/* Strings that run past the end of a line, which is the only other thing
   besides a block comment that a line's state has to remember. */
const MULTILINE = {
  python: ['"""', "'''"],
  javascript: ['`'], typescript: ['`'], go: ['`'], kotlin: ['"""'],
  scala: ['"""'], dart: ["'''", '"""'], csharp: ['@"'], swift: ['"""'],
  ruby: [], php: [], sql: []
};

const CODE = 0, BLOCK = 1, MULTI = 2;   // …and MULTI + n for the nth multiline delimiter

const keywordCache = new Map();
function keywordsOf(id) {
  let set = keywordCache.get(id);
  if (!set) {
    const spec = LANGS[id] || {};
    set = new Set(String(spec.words || '').split(/\s+/).filter(Boolean));
    keywordCache.set(id, set);
  }
  return set;
}

/**
 * A colourer for one file.
 *
 * @param {string[]} lines
 * @param {string} langId
 * @returns {{ spans(i:number):Array<{k:string,text:string}>|null, active:boolean }}
 */
export function createSyntax(lines, langId) {
  const spec = LANGS[langId];
  const usable = !!spec && lines.length <= DIFF_COLOUR_MAX &&
    ((spec.line && spec.line.length) || spec.block || (spec.strings && spec.strings.length) || spec.tags ||
      keywordsOf(langId).size);
  if (!usable) return { spans: () => null, active: false };

  const multi = MULTILINE[langId] || [];
  const words = keywordsOf(langId);
  const caseless = !!spec.caseless;
  let states = null;

  /* One pass over the file, recording where each line starts. Deferred until
     the first row is drawn, so opening a comparison never pays for it. */
  function scan() {
    states = new Uint8Array(lines.length + 1);
    let state = CODE;
    for (let i = 0; i < lines.length; i++) {
      states[i] = state;
      state = run(lines[i], state, null);
    }
    states[lines.length] = state;
  }

  /**
   * Walk one line. With `out` given, push spans onto it; without, only the
   * state at the end of the line is wanted, which is the scanning pass.
   */
  function run(line, state, out) {
    const len = line.length;
    let i = 0;
    const push = (k, from, to) => {
      if (to <= from || !out) return;
      const last = out[out.length - 1];
      if (last && last.k === k) last.text += line.slice(from, to);
      else out.push({ k, text: line.slice(from, to) });
    };

    if (state === BLOCK && spec.block) {
      const close = line.indexOf(spec.block[1], i);
      if (close < 0) { push('com', 0, len); return BLOCK; }
      push('com', 0, close + spec.block[1].length);
      i = close + spec.block[1].length;
      state = CODE;
    } else if (state >= MULTI) {
      const delim = multi[state - MULTI] || '';
      const close = delim ? line.indexOf(delim, i) : -1;
      if (close < 0) { push('str', 0, len); return state; }
      push('str', 0, close + delim.length);
      i = close + delim.length;
      state = CODE;
    }

    while (i < len) {
      const ch = line[i];

      /* Block comment */
      if (spec.block && line.startsWith(spec.block[0], i)) {
        const close = line.indexOf(spec.block[1], i + spec.block[0].length);
        if (close < 0) { push('com', i, len); return BLOCK; }
        push('com', i, close + spec.block[1].length);
        i = close + spec.block[1].length;
        continue;
      }
      /* Line comment — but not a `//` that is part of a URL inside a string,
         which is why strings are consumed whole below rather than skipped. */
      let lineComment = false;
      for (const mark of (spec.line || [])) {
        if (mark && line.startsWith(mark, i)) { push('com', i, len); lineComment = true; break; }
      }
      if (lineComment) return CODE;

      /* A string that may not end on this line */
      let opened = -1;
      for (let d = 0; d < multi.length; d++) {
        if (multi[d] && line.startsWith(multi[d], i)) { opened = d; break; }
      }
      if (opened >= 0) {
        const delim = multi[opened];
        const close = line.indexOf(delim, i + delim.length);
        if (close < 0) { push('str', i, len); return MULTI + opened; }
        push('str', i, close + delim.length);
        i = close + delim.length;
        continue;
      }

      /* An ordinary string */
      if ((spec.strings || []).includes(ch)) {
        let j = i + 1;
        while (j < len) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === ch) { j++; break; }
          j++;
        }
        push('str', i, Math.min(j, len));
        i = Math.min(j, len);
        continue;
      }

      /* Markup: the pieces of a tag */
      if (spec.tags && ch === '<') {
        const end = line.indexOf('>', i);
        const stop = end < 0 ? len : end + 1;
        tagSpans(line, i, stop, push);
        i = stop;
        continue;
      }

      /* A number */
      if (ch >= '0' && ch <= '9') {
        let j = i;
        while (j < len && /[0-9a-fA-FxXoObBeE._+-]/.test(line[j])) {
          /* A sign only belongs to a number straight after an exponent. */
          if ((line[j] === '+' || line[j] === '-') && !/[eE]/.test(line[j - 1] || '')) break;
          j++;
        }
        push('num', i, j);
        i = j;
        continue;
      }

      /* A word: a keyword, or just a name */
      if (/[A-Za-z_$@À-￿]/.test(ch)) {
        let j = i;
        while (j < len && /[\w$@À-￿-]/.test(line[j])) j++;
        const raw = line.slice(i, j);
        const probe = caseless ? raw.toLowerCase() : raw;
        push(words.has(probe) || words.has(probe.replace(/^[@#]/, '')) ? 'kw' : 'txt', i, j);
        i = j;
        continue;
      }

      /* Punctuation, one character at a time so runs coalesce in push(). */
      push(/[\s]/.test(ch) ? 'txt' : 'punct', i, i + 1);
      i++;
    }
    return CODE;
  }

  /** `<div class="x">` split into its name, its attributes and their values. */
  function tagSpans(line, from, to, push) {
    let i = from;
    if (line.startsWith('<!--', i)) { push('com', i, to); return; }
    push('punct', i, i + 1);
    i++;
    if (line[i] === '/' || line[i] === '!' || line[i] === '?') { push('punct', i, i + 1); i++; }
    let j = i;
    while (j < to && /[\w:.-]/.test(line[j])) j++;
    push('kw', i, j);
    i = j;
    while (i < to) {
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        let k = i + 1;
        while (k < to && line[k] !== ch) k++;
        push('str', i, Math.min(k + 1, to));
        i = Math.min(k + 1, to);
      } else if (/[\w:.-]/.test(ch)) {
        let k = i;
        while (k < to && /[\w:.-]/.test(line[k])) k++;
        push('attr', i, k);
        i = k;
      } else {
        push('punct', i, i + 1);
        i++;
      }
    }
  }

  return {
    active: true,
    spans(i) {
      if (i < 0 || i >= lines.length) return null;
      if (!states) scan();
      const out = [];
      run(lines[i], states[i], out);
      return out;
    }
  };
}
