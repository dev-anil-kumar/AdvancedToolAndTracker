/**
 * What are these two files?
 *
 * The answer decides three things: how they are matched (JSON key by key, CSV
 * row by row, everything else line by line), which options start switched on
 * (trailing space matters in a fixture and not in source), and how the text is
 * coloured.
 *
 * The name is asked first, because an extension is what the reader themselves
 * would go by and it is nearly always right. When there is no extension, or it
 * is one nobody recognises — pasted text, a URL ending in a slash, a file
 * called `dump` — the content is asked instead: first the shapes that can be
 * confirmed rather than guessed (JSON parses or it does not; a CSV has the same
 * number of delimiters on every line), then a weighted vote over the phrases
 * that only ever appear in one language. `fun x(` with `val` is Kotlin; `fun x(`
 * with `let mut` is Rust; `public class` with `void` is Java. No single line
 * proves anything, which is why they are weighed rather than searched for.
 */

/* ---------- The languages, and what each one is made of ----------
   `line` and `block` are what syntax.js colours by; `words` is its keyword set.
   Everything is lower case, and every list is deliberately short: these are the
   words that carry a language's shape, not its whole vocabulary. */
const C_STR = ['"', "'", '`'];

export const LANGS = {
  java: {
    label: 'Java', family: 'code', ext: ['java'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null'
  },
  kotlin: {
    label: 'Kotlin', family: 'code', ext: ['kt', 'kts'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'as break by class companion const constructor continue crossinline data delegate do dynamic else enum expect external false field file final finally for fun get if import in infix init inline inner interface internal is it lateinit noinline null object open operator out override package private protected public reified return sealed set suspend super tailrec this throw true try typealias typeof val var vararg when where while annotation abstract'
  },
  javascript: {
    label: 'JavaScript', family: 'code', ext: ['js', 'mjs', 'cjs', 'jsx'],
    line: ['//'], block: ['/*', '*/'], strings: C_STR,
    words: 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined'
  },
  typescript: {
    label: 'TypeScript', family: 'code', ext: ['ts', 'tsx', 'mts', 'cts'],
    line: ['//'], block: ['/*', '*/'], strings: C_STR,
    words: 'abstract any as asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends finally for from function get implements import in infer instanceof interface is keyof let module namespace never new number of override private protected public readonly return satisfies set static string super switch symbol this throw try type typeof undefined unique unknown var void while yield true false null'
  },
  python: {
    label: 'Python', family: 'code', ext: ['py', 'pyw', 'pyi'],
    line: ['#'], block: null, strings: ['"', "'"], triple: true,
    words: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield True False None self cls'
  },
  go: {
    label: 'Go', family: 'code', ext: ['go'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', '`', "'"],
    words: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false make new len cap append error string int int64 float64 bool byte rune'
  },
  rust: {
    label: 'Rust', family: 'code', ext: ['rs'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while box macro_rules derive Some None Ok Err Vec String'
  },
  c: {
    label: 'C', family: 'code', ext: ['c', 'h'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while include define ifdef ifndef endif pragma NULL true false'
  },
  cpp: {
    label: 'C++', family: 'code', ext: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ipp'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'alignas alignof and auto bool break case catch char class co_await co_return co_yield concept const consteval constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator or private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile while include define pragma'
  },
  csharp: {
    label: 'C#', family: 'code', ext: ['cs'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile where while yield'
  },
  swift: {
    label: 'Swift', family: 'code', ext: ['swift'],
    line: ['//'], block: ['/*', '*/'], strings: ['"'],
    words: 'associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate for func guard if import in init inout internal is lazy let mutating nil open operator override private protocol public repeat rethrows return self Self static struct subscript super switch throw throws true try typealias var weak where while'
  },
  ruby: {
    label: 'Ruby', family: 'code', ext: ['rb', 'rake', 'gemspec'],
    line: ['#'], block: null, strings: ['"', "'"],
    words: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo require require_relative rescue retry return self super then true undef unless until when while yield attr_accessor attr_reader puts lambda proc'
  },
  php: {
    label: 'PHP', family: 'code', ext: ['php', 'phtml'],
    line: ['//', '#'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null'
  },
  scala: {
    label: 'Scala', family: 'code', ext: ['scala', 'sc'],
    line: ['//'], block: ['/*', '*/'], strings: ['"'],
    words: 'abstract case catch class def do else extends false final finally for forSome given if implicit import lazy match new null object override package private protected return sealed super this throw trait true try type val var while with yield'
  },
  dart: {
    label: 'Dart', family: 'code', ext: ['dart'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield'
  },
  shell: {
    label: 'Shell', family: 'code', ext: ['sh', 'bash', 'zsh', 'fish', 'ksh'],
    line: ['#'], block: null, strings: ['"', "'"],
    words: 'if then else elif fi for while until do done case esac in function return break continue local export readonly declare source alias unset echo printf shift exit trap set eval exec'
  },
  sql: {
    label: 'SQL', family: 'code', ext: ['sql', 'ddl'],
    line: ['--'], block: ['/*', '*/'], strings: ["'", '"'], caseless: true,
    words: 'add all alter and as asc begin between by case cast check column commit constraint create cross cursor database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references right rollback select set table then top transaction union unique update using values view when where with'
  },
  css: {
    label: 'CSS', family: 'code', ext: ['css', 'scss', 'sass', 'less'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
    words: 'important media supports keyframes import charset font-face include mixin extend use forward and not only screen print all from to'
  },
  html: {
    label: 'HTML', family: 'markup', ext: ['html', 'htm', 'xhtml', 'vue', 'svelte'],
    line: [], block: ['<!--', '-->'], strings: ['"', "'"], tags: true,
    words: ''
  },
  xml: {
    label: 'XML', family: 'markup', ext: ['xml', 'svg', 'xsl', 'xsd', 'plist', 'rss', 'atom'],
    line: [], block: ['<!--', '-->'], strings: ['"', "'"], tags: true,
    words: ''
  },
  yaml: {
    label: 'YAML', family: 'data', ext: ['yml', 'yaml'],
    line: ['#'], block: null, strings: ['"', "'"],
    words: 'true false null yes no on off'
  },
  toml: {
    label: 'TOML', family: 'data', ext: ['toml', 'ini', 'cfg', 'conf', 'properties', 'env'],
    line: ['#', ';'], block: null, strings: ['"', "'"],
    words: 'true false'
  },
  json: {
    label: 'JSON', family: 'json', ext: ['json', 'jsonc', 'geojson', 'ndjson', 'jsonl', 'map'],
    line: ['//'], block: ['/*', '*/'], strings: ['"'],
    words: 'true false null'
  },
  csv: {
    label: 'CSV', family: 'table', ext: ['csv'], delim: ',',
    line: [], block: null, strings: ['"'], words: ''
  },
  tsv: {
    label: 'TSV', family: 'table', ext: ['tsv', 'tab'], delim: '\t',
    line: [], block: null, strings: ['"'], words: ''
  },
  markdown: {
    label: 'Markdown', family: 'prose', ext: ['md', 'markdown', 'mdown', 'mkd', 'mdwn', 'rst', 'adoc'],
    line: [], block: null, strings: [], words: ''
  },
  patch: {
    label: 'Patch', family: 'code', ext: ['diff', 'patch'],
    line: [], block: null, strings: [], words: ''
  },
  text: {
    label: 'Plain text', family: 'prose', ext: ['txt', 'text', 'log', 'me', 'nfo'],
    line: [], block: null, strings: [], words: ''
  }
};

/** Extension → language, worked out once from the table above. */
const BY_EXT = new Map();
Object.keys(LANGS).forEach(id => (LANGS[id].ext || []).forEach(ext => {
  if (!BY_EXT.has(ext)) BY_EXT.set(ext, id);
}));

/* ---------- Voting on content ----------
   Each test is a phrase that a language uses and its neighbours mostly do not,
   with a weight for how much it proves. A language wins by accumulating votes,
   never on one match: `import` is in six of these, `data class` is in one. */
const SIGNS = [
  ['java', [[/^\s*package\s+[\w.]+\s*;/m, 3], [/\b(public|private|protected)\s+(static\s+)?(final\s+)?[\w<>\[\], ]+\s+\w+\s*\(/, 3],
    [/^\s*import\s+(static\s+)?[\w.]+\s*;/m, 2], [/\bSystem\.out\.print/, 3], [/\b(extends|implements)\s+[A-Z]\w*/, 2],
    [/@Override\b/, 2], [/\bnew\s+[A-Z]\w*\s*\(/, 1]]],
  ['kotlin', [[/^\s*fun\s+\w+\s*[(<]/m, 4], [/\b(val|var)\s+\w+\s*(:\s*[\w<>?.]+)?\s*=/, 2], [/\bdata\s+class\b/, 4],
    [/\bcompanion\s+object\b/, 4], [/\?:\s*\w/, 2], [/\bsuspend\s+fun\b/, 4], [/^\s*package\s+[\w.]+\s*$/m, 2],
    [/\bwhen\s*\(/, 2], [/\bprintln\s*\(/, 1]]],
  ['typescript', [[/\binterface\s+\w+\s*\{/, 3], [/:\s*(string|number|boolean|void|any|unknown)\b/, 3],
    [/\bexport\s+(type|interface|enum)\b/, 3], [/\bas\s+(const|string|number)\b/, 2], [/\breadonly\s+\w+\s*:/, 2]]],
  ['javascript', [[/\b(const|let)\s+\w+\s*=/, 2], [/\bfunction\s*\w*\s*\(/, 2], [/=>\s*[{(]/, 2],
    [/\bmodule\.exports\b/, 3], [/\brequire\s*\(\s*['"]/, 3], [/\bconsole\.log\s*\(/, 2], [/\bexport\s+default\b/, 2]]],
  ['python', [[/^\s*def\s+\w+\s*\(.*\)\s*(->[^:]+)?:\s*$/m, 4], [/^\s*(from\s+[\w.]+\s+)?import\s+\w/m, 2],
    [/^\s*class\s+\w+(\(.*\))?\s*:\s*$/m, 4], [/\bself\b/, 2], [/\b(True|False|None)\b/, 2], [/\bprint\s*\(/, 1],
    [/^\s*(if|for|while|with|try|elif|else)\b.*:\s*$/m, 2], [/\bif\s+__name__\s*==/, 4]]],
  ['go', [[/^\s*package\s+\w+\s*$/m, 3], [/^\s*func\s+(\(\w+\s+\*?\w+\)\s*)?\w*\s*\(/m, 4], [/\b\w+\s*:=\s*/, 3],
    [/\bfmt\.(Print|Sprint|Errorf)/, 4], [/\berr\s*!=\s*nil\b/, 4], [/\btype\s+\w+\s+struct\s*\{/, 3]]],
  ['rust', [[/^\s*(pub\s+)?fn\s+\w+/m, 4], [/\blet\s+mut\b/, 4], [/\bimpl\s+\w/, 3], [/->\s*Result<|Option</, 3],
    [/^\s*use\s+[\w:]+\s*;/m, 3], [/\bprintln!\s*\(/, 4], [/&(str|mut\s)/, 2], [/\.unwrap\(\)/, 3]]],
  ['csharp', [[/\bnamespace\s+[\w.]+/, 3], [/\busing\s+[\w.]+\s*;/, 2], [/\bConsole\.Write/, 4],
    [/\bpublic\s+(async\s+)?(Task|void|string|int|bool)\b/, 3], [/\{\s*get;\s*set;\s*\}/, 4], [/\bvar\s+\w+\s*=\s*new\b/, 2]]],
  ['cpp', [[/^\s*#include\s*[<"]/m, 3], [/\bstd::/, 4], [/\btemplate\s*</, 3], [/\bnamespace\s+\w+\s*\{/, 3],
    [/\bcout\s*<</, 4], [/::\w+\s*\(/, 2]]],
  ['c', [[/^\s*#include\s*[<"]/m, 3], [/^\s*#(define|ifndef|ifdef|pragma)\b/m, 2], [/\bprintf\s*\(/, 3],
    [/\b(struct|typedef)\s+\w+/, 2], [/\bint\s+main\s*\(/, 3], [/\bmalloc\s*\(|\bsizeof\s*\(/, 2]]],
  ['ruby', [[/^\s*def\s+\w+[?!]?\s*(\(.*\))?\s*$/m, 4], [/\bend\s*$/m, 2], [/^\s*require(_relative)?\s+['"]/m, 3],
    [/\bdo\s*\|\w/, 4], [/\battr_(accessor|reader|writer)\b/, 4], [/\bputs\b/, 2], [/@\w+\s*=/, 2]]],
  ['php', [[/<\?php/, 5], [/\$\w+\s*=/, 3], [/\bfunction\s+\w+\s*\(\s*\$/, 4], [/->\w+\s*\(/, 1], [/\becho\b/, 2]]],
  ['swift', [[/^\s*(public\s+|private\s+)?func\s+\w+/m, 4], [/\blet\s+\w+\s*(:\s*\w+)?\s*=/, 2], [/\bguard\s+let\b/, 4],
    [/^\s*import\s+(Foundation|UIKit|SwiftUI)/m, 5], [/\bvar\s+body:\s*some\s+View/, 5], [/\?\?/, 1]]],
  ['scala', [[/^\s*(case\s+)?class\s+\w+\s*\(/m, 3], [/\bdef\s+\w+\s*(\[.*\])?\s*\(/, 3], [/\bobject\s+\w+\s*(extends|\{)/, 4],
    [/\bmatch\s*\{/, 3], [/=>\s*$/m, 1]]],
  ['dart', [[/\bWidget\s+build\s*\(/, 5], [/^\s*import\s+'package:/m, 5], [/\bfinal\s+\w+\s*=/, 2], [/\basync\s*\{/, 1]]],
  ['shell', [[/^#!.*\b(ba|z|k)?sh\b/, 6], [/^\s*(if|for|while)\b.*;\s*then\b/m, 4], [/\bfi\s*$/m, 3],
    [/\$\{?\w+\}?/, 1], [/^\s*(echo|export|cd|mkdir|rm|cp|mv)\b/m, 2], [/\bdone\s*$/m, 3]]],
  ['sql', [[/\bselect\b[\s\S]{0,200}\bfrom\b/i, 4], [/\b(create|alter|drop)\s+(table|view|index|database)\b/i, 5],
    [/\binsert\s+into\b/i, 4], [/\bwhere\b.*=/i, 2], [/\bjoin\b.*\bon\b/i, 3]]],
  ['css', [[/^[^{}\n]*\{[^{}]*:[^{}]*;[^{}]*\}/m, 4], [/^\s*(@media|@import|@keyframes|@font-face)\b/m, 4],
    [/^\s*[.#][\w-]+\s*[,{]/m, 3], [/:\s*(#[0-9a-f]{3,8}|\d+px|\d+rem)\s*;/im, 3], [/^\s*--[\w-]+\s*:/m, 3]]],
  ['yaml', [[/^---\s*$/m, 3], [/^[\w.-]+:\s*$/m, 3], [/^\s{2,}[\w.-]+:(\s|$)/m, 3],
    [/^[ \t]*[\w.-]+:[ \t]+\S/m, 2], [/^\s*-\s+[\w"'{[]/m, 2], [/^\s*#/m, 1]]],
  ['toml', [[/^\s*\[[\w.\-"']+\]\s*$/m, 4], [/^\s*[\w.-]+\s*=\s*/m, 2], [/^\s*;/m, 1]]],
  ['markdown', [[/^#{1,6}\s+\S/m, 4], [/^\s*[-*+]\s+\S/m, 1], [/^```/m, 4], [/\[[^\]]+\]\([^)]+\)/, 3],
    [/^\s*\|.*\|\s*$/m, 2], [/\*\*\S/, 1]]]
];

/* ---------- Shapes that can be confirmed rather than guessed ---------- */

const looksJson = (text) => {
  const head = text.slice(0, 1 << 16).trimStart();
  if (!/^[[{]/.test(head)) return false;
  /* Parsing is the only real test, and above a few megabytes it is not worth
     paying for twice — the first and last character carry the guess instead. */
  if (text.length > 4 << 20) return /[\]}]\s*$/.test(text.slice(-64));
  try { JSON.parse(text); return true; } catch (e) { return /["}\]]\s*[,}\]]/.test(head); }
};

const looksNdjson = (text) => {
  const rows = text.split('\n').filter(l => l.trim()).slice(0, 12);
  if (rows.length < 2) return false;
  return rows.every(l => { try { JSON.parse(l); return true; } catch (e) { return false; } });
};

/** A table has the same number of separators on every line, and more than none. */
function looksTabular(text, delim) {
  const rows = text.split('\n').filter(l => l.trim()).slice(0, 20);
  if (rows.length < 2) return false;
  const counts = rows.map(l => split(l, delim).length);
  const first = counts[0];
  if (first < 2) return false;
  return counts.every(c => c === first);
}

/** One line of a delimited file, honouring quotes. Used by the sniff and by the
    tabular comparison, so they can never disagree about where a cell ends. */
export function split(line, delim) {
  const out = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delim) { out.push(cell); cell = ''; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

/** Bytes no text file has. A file with these is not worth comparing as text. */
export function looksBinary(text) {
  const upto = Math.min(text.length, 4096);
  let odd = 0;
  for (let i = 0; i < upto; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) odd++;
  }
  return upto > 0 && odd / upto > 0.06;
}

export const extensionOf = (name) => {
  const file = String(name || '').split(/[\\/?#]/)[0] === String(name || '')
    ? String(name || '') : String(name || '').split(/[?#]/)[0];
  const at = file.lastIndexOf('.');
  return at > 0 ? file.slice(at + 1).toLowerCase() : '';
};

/**
 * What one file is.
 *
 * @param {string} name  the file's name, or '' for pasted text
 * @param {string} text
 * @returns {{id:string, label:string, family:string, from:'name'|'content'|'default', score:number}}
 */
export function detectOne(name, text) {
  const ext = extensionOf(name);
  const named = BY_EXT.get(ext);
  if (named) return { id: named, label: LANGS[named].label, family: LANGS[named].family, from: 'name', score: 9 };

  const body = String(text || '');
  if (!body.trim()) return { id: 'text', label: LANGS.text.label, family: 'prose', from: 'default', score: 0 };

  if (looksJson(body) || looksNdjson(body)) return sniffed('json', 9);
  if (/^\s*<\?xml/.test(body)) return sniffed('xml', 9);
  if (/^\s*<(!doctype\s+html|html\b)/i.test(body)) return sniffed('html', 9);
  if (/^(diff --git |Index: |--- .*\n\+\+\+ )/m.test(body)) return sniffed('patch', 9);
  if (looksTabular(body, '\t')) return sniffed('tsv', 8);
  if (looksTabular(body, ',')) return sniffed('csv', 7);
  if (/^\s*</.test(body) && /<\/\w+>/.test(body)) return sniffed('xml', 5);

  /* The vote. Only the first stretch is read: a language announces itself in
     its first hundred lines, and a ten-megabyte file should not be scanned
     twenty times over to learn what its first page already said. */
  const head = body.slice(0, 1 << 15);
  let best = null;
  SIGNS.forEach(([id, tests]) => {
    let score = 0;
    tests.forEach(([re, weight]) => { if (re.test(head)) score += weight; });
    if (score && (!best || score > best.score)) best = { id, score };
  });
  if (best && best.score >= 5) return sniffed(best.id, best.score);
  return { id: 'text', label: LANGS.text.label, family: 'prose', from: 'default', score: best ? best.score : 0 };
}

const sniffed = (id, score) => ({ id, label: LANGS[id].label, family: LANGS[id].family, from: 'content', score });

/**
 * What the *pair* is, which is not always what either one is.
 *
 * A named file beats a sniffed one, and two files that disagree are compared as
 * lines with the disagreement reported — quietly forcing a Java file through a
 * JSON comparison because the other side happened to be JSON would be worse
 * than saying so.
 */
export function detectPair(a, b) {
  const left = detectOne(a.name, a.text);
  const right = detectOne(b.name, b.text);
  const empty = (s) => !String(s.text || '').trim();
  let chosen = left, agree = true;
  if (empty(a) && !empty(b)) chosen = right;
  else if (empty(b) && !empty(a)) chosen = left;
  else if (left.id !== right.id) {
    agree = false;
    const win = right.score > left.score ? right : left;
    /* Two dialects of one family are not really a disagreement. */
    if (left.family === right.family) agree = true;
    chosen = win;
  }
  return { type: chosen, a: left, b: right, agree };
}

/** How a family of file is best matched up. */
export function strategyFor(family) {
  if (family === 'json') return 'structure';
  if (family === 'table') return 'table';
  return 'lines';
}

/** Which options a family of file should arrive with. */
export function defaultOptions(family) {
  const code = family === 'code' || family === 'data' || family === 'markup' || family === 'json';
  return {
    trimEnd: true,
    allSpace: false,
    blankLines: false,
    caseless: false,
    words: true,
    moves: code,
    syntax: family !== 'prose' && family !== 'table'
  };
}

/** The delimiter a tabular file uses. */
export const delimiterFor = (id) => (LANGS[id] && LANGS[id].delim) || ',';
