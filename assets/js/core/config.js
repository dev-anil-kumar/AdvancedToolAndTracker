/**
 * Every tunable constant in the app. Nothing here depends on anything else,
 * so this is the file to read first when changing behaviour.
 */

/* ---------- Storage ---------- */
export const DB_NAME = 'folio';
export const DB_VER = 6;
export const STORES = ['files', 'notes', 'prefs', 'drawings', 'jsondocs', 'images', 'compares'];

/* ---------- Layout ---------- */
export const PER_ROW_MIN = 1;
export const PER_ROW_MAX = 6;
export const PER_ROW_DEFAULT = 3;
export const MIN_PANE = 190;          // px, narrowest a docked pane may become
export const MIN_ROW = 130;           // px, shortest a pane row may become
export const FLOAT_MIN_W = 260;
export const FLOAT_MIN_H = 180;
export const DRAG_THRESHOLD = 8;      // px of travel before a pane pops out
export const RESIZE_STEP = 32;        // px per arrow key press
export const RESIZE_STEP_BIG = 96;    // px with shift held

/* ---------- Other file types ----------
   Two big libraries, pinned like the rest, but fetched only when someone
   actually opens one of these files: together they are ten times the size of
   the whole application, so loading them up front would make every visit pay
   for a feature most visits do not use. */
export const PDF_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
export const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
export const SHEET_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

export const PDF_PAGE_MAX = 400;      // pages read from one document
export const SHEET_ROW_MAX = 4000;    // rows kept per sheet
export const SHEET_COL_MAX = 40;      // columns kept per sheet
export const HEAD_RATIO = 1.18;       // a line this much bigger than the body is a heading
export const CHROME_SHARE = 0.4;      // a line on this share of pages is a header or footer

/* Which reader a file goes to. Extension first: it is what the user sees, and
   more dependable than the type a browser guesses. */
export const FILE_KINDS = {
  markdown: ['md', 'markdown', 'mdown', 'mkd', 'mdwn', 'txt', 'text'],
  pdf: ['pdf'],
  sheet: ['xlsx', 'xlsm', 'xlsb', 'xls', 'csv', 'tsv', 'ods'],
  json: ['json', 'jsonc', 'geojson', 'ndjson']
};

/* ---------- Limits ---------- */
export const MAX_OPEN_AT_ONCE = 6;    // files accepted from one drop or picker
export const NOTE_QUOTE_MAX = 4000;   // characters stored per note
export const RECENT_VISIBLE = 8;      // Home rows before "Show all"
export const NOTE_CLAMP_CHARS = 240;  // longer than this gets an Expand control
export const NOTE_CLAMP_LINES = 4;
export const NOTE_BODY_MAX = 40000;   // characters in a note you write yourself
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;   // per image, before it is refused
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'];

/* ---------- Canvas ---------- */
export const GRID = 20;               // dot spacing, in scene units
export const SNAP = 5;                // shapes snap to this while drawing
export const MIN_SHAPE = 16;          // a drag smaller than this is a click
export const DEFAULT_SHAPE_W = 140;
export const DEFAULT_SHAPE_H = 80;
export const ARROW_HEAD = 11;
export const STROKE_W = 2;
export const CANVAS_FONT = 14;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const HISTORY_MAX = 60;
export const AUTOSAVE_MS = 700;

export const DEFAULT_TOOL = 'rect';   // drag on a fresh canvas and you get a box

/* The whole drawing palette. Deliberately short: five inks, five backgrounds,
   three fonts, one stroke width — the constraint is the feature. */
export const INKS = [
  { key: 'graphite', label: 'Graphite', hex: '#3d4650' },
  { key: 'harbor',   label: 'Harbor',   hex: '#1f6f95' },
  { key: 'amber',    label: 'Amber',    hex: '#b4791b' },
  { key: 'moss',     label: 'Moss',     hex: '#42734a' },
  { key: 'rose',     label: 'Rose',     hex: '#a8465f' }
];

/** Backgrounds. Each is a wash of an ink, so any pairing looks deliberate. */
export const FILL_ALPHA = 0.13;
export const FILLS = ['none', 'graphite', 'harbor', 'amber', 'moss', 'rose'];

/** A sensible default background per kind — nothing arrives colourless. */
export const DEFAULT_FILLS = {
  rect: 'harbor',
  ellipse: 'amber',
  container: 'graphite',
  note: 'none',
  text: 'none',
  arrow: 'none'
};

/** Three fonts, each with the size tweak that makes it sit right. */
export const FONTS = [
  { key: 'sans', label: 'Sans', stack: 'Inter, -apple-system, "Segoe UI", Helvetica, sans-serif', scale: 1 },
  { key: 'serif', label: 'Serif', stack: '"Source Serif 4", Iowan Old Style, Georgia, serif', scale: 1.06 },
  { key: 'hand', label: 'Hand', stack: 'Caveat, "Bradley Hand", "Segoe Print", cursive', scale: 1.42 }
];

/* ---------- JSON viewer ---------- */
export const JSON_INDENT = 2;         // spaces, everywhere JSON is written out
export const JSON_CHUNK = 200;        // tree children rendered per batch
export const TABLE_CHUNK = 100;       // table rows rendered per batch
export const TABLE_COLS_MAX = 120;    // columns a table will show
export const TABLE_DEPTH = 4;         // levels of nesting flattened into columns
export const TABLE_SCAN = 400;        // rows sampled to work out the columns
export const JSON_OPEN_DEPTH = 2;     // levels expanded when a document opens
export const JSON_CODE_MAX = 500000;  // chars before the code view stops colouring
export const JSON_SEARCH_HITS = 500;  // matches a search will chase before stopping
export const JSON_PEEK = 72;          // chars of a collapsed value shown inline
export const STRING_INLINE = 240;     // chars of a string shown on its own row
export const STRING_FULL = 20000;     // chars of it shown when the row is opened
export const JSON_SAVE_MS = 600;      // debounce before an edit reaches storage

/** The six ways to look at a document. Order is the order of the switch. */
export const JSON_MODES = [
  { key: 'tree',  label: 'Tree',  hint: 'Collapsible outline — the default reading view' },
  { key: 'table', label: 'Table', hint: 'Any array of records, as rows and columns' },
  { key: 'graph', label: 'Graph', hint: 'The shape of the document, drawn as a map' },
  { key: 'code',  label: 'Code',  hint: 'Formatted and coloured, with line numbers' },
  { key: 'raw',   label: 'Raw',   hint: 'Exactly the text you opened, untouched' },
  { key: 'edit',  label: 'Edit',  hint: 'Change the text, with live validation' }
];

/* ---------- The graph ---------- */
export const GRAPH_NODE_W = 264;      // scene units; the label is fitted to this
export const GRAPH_NODE_H = 27;
export const GRAPH_CHAR_W = 6.9;      // upper bound on one char of the 11px mono stack
export const GRAPH_KEY_MIN = 8;       // a name is useless below this many characters
export const GRAPH_VAL_MIN = 6;
export const GRAPH_VAL_SHARE = 0.55;  // of the label, before the key gets the rest
export const GRAPH_DOTS = 22;         // background dot spacing, in scene units
export const GRAPH_GAP_X = 58;        // room for the link between two levels
export const GRAPH_GAP_Y = 9;
export const GRAPH_FANOUT = 14;       // children drawn per branch before "+N more"
export const GRAPH_MAX_NODES = 700;   // a map of more than this is not a map
export const GRAPH_OPEN_DEPTH = 2;
export const GRAPH_ZOOM_MIN = 0.15;
export const GRAPH_ZOOM_MAX = 6;

/* ---------- Compare ----------
   Two files, side by side. The numbers here are what keep a large comparison
   smooth: a row is a fixed height so only the visible ones are ever in the
   DOM, and every search that could run long has a ceiling. */
export const DIFF_ROW_H = 20;          // px per row — uniform, which is what makes virtualising it possible
export const DIFF_OVERSCAN = 14;       // rows drawn beyond the viewport, so a fast flick stays filled
export const DIFF_CONTEXT = 3;         // unchanged rows kept either side of a change
export const DIFF_FOLD_MIN = 10;       // unchanged rows in a row before the middle is folded away
export const DIFF_MAX_D = 2600;        // Myers search depth before a region is simply called a rewrite
export const DIFF_HIST_CHAIN = 64;     // times a line may repeat before histogram gives up on it
export const DIFF_HIST_MIN = 12;       // region smaller than this goes straight to Myers
export const DIFF_REFINE_ROWS = 6000;  // changed rows refined word by word
export const DIFF_REFINE_CHARS = 3000; // chars in a line before word refinement is skipped
export const DIFF_PAIR_WINDOW = 12;    // how far apart two lines may sit and still be one rewrite
export const DIFF_PAIR_MIN = 0.32;     // similarity below which two lines are unrelated, not rewritten
export const DIFF_MOVE_MIN = 3;        // lines in a block before a move is worth reporting
export const DIFF_MOVE_MAX = 4000;     // blocks examined for moves
export const DIFF_COLOUR_MAX = 200000; // lines before syntax colouring is dropped
export const DIFF_WORKER_MIN = 2500;   // lines before the work is handed to a worker
export const DIFF_STORE_MAX = 4 * 1024 * 1024;   // per side, before a comparison is kept for the session only
export const DIFF_FETCH_MAX = 24 * 1024 * 1024;  // bytes accepted from a URL
export const DIFF_TABLE_COLS = 200;    // columns a tabular comparison will line up
export const DIFF_SAVE_MS = 700;

/** Side by side, or one column with the old above the new. */
export const DIFF_LAYOUTS = [
  { key: 'split',   label: 'Side by side', hint: 'Two panes, aligned row for row' },
  { key: 'unified', label: 'Unified',      hint: 'One column, removals above additions' }
];

/** What the two panes do when you scroll one of them. */
export const DIFF_SCROLLS = [
  { key: 'linked', label: 'Linked', hint: 'Scrolling either pane scrolls both, in step' },
  { key: 'free',   label: 'Free',   hint: 'Each pane scrolls on its own' }
];

/** How the two files are matched up. 'auto' picks from what they turn out to be. */
export const DIFF_STRATEGIES = [
  { key: 'auto',      label: 'Auto',       hint: 'Chosen from what the files turn out to be' },
  { key: 'structure', label: 'Structural', hint: 'JSON matched key by key, so a reordered key is not a change' },
  { key: 'table',     label: 'Tabular',    hint: 'CSV matched row by row and column by column' },
  { key: 'lines',     label: 'Lines',      hint: 'Plain line comparison, whatever the file is' }
];

/** The line-matching algorithms, in the order the picker offers them. */
export const DIFF_ALGOS = [
  { key: 'histogram', label: 'Histogram', hint: 'Anchors on the rarest shared lines first — best for code' },
  { key: 'patience',  label: 'Patience',  hint: 'Anchors only on lines unique to both sides' },
  { key: 'myers',     label: 'Myers',     hint: 'Fewest changed lines, with no regard for readability' }
];

/** Every comparison option that has an on/off state, named once. */
export const DIFF_OPTIONS = [
  { key: 'trimEnd',    label: 'Ignore trailing space', hint: 'Space and tabs at the end of a line', code: true,  prose: true },
  { key: 'allSpace',   label: 'Ignore all whitespace', hint: 'Indentation and runs of spaces inside a line', code: false, prose: false },
  { key: 'blankLines', label: 'Ignore blank lines',    hint: 'Empty lines on either side', code: false, prose: false },
  { key: 'caseless',   label: 'Ignore case',           hint: 'Compare letters without regard to case', code: false, prose: false },
  { key: 'words',      label: 'Word detail',           hint: 'Mark which words changed inside a rewritten line', code: true, prose: true },
  { key: 'moves',      label: 'Find moved blocks',     hint: 'A block that only changed place is marked as moved, not rewritten', code: true, prose: false },
  { key: 'syntax',     label: 'Syntax colour',         hint: 'Colour comments, strings and keywords', code: true, prose: false }
];

/* ---------- Note highlight palette ---------- */
export const HIGHLIGHTS = [
  { key: 'harbor', label: 'Harbor blue', hex: '#1f5f7d' },
  { key: 'amber',  label: 'Amber',       hex: '#c98a1b' },
  { key: 'moss',   label: 'Moss green',  hex: '#4a7c46' },
  { key: 'rose',   label: 'Rose',        hex: '#b4526b' },
  { key: 'violet', label: 'Violet',      hex: '#6c5aa8' },
  { key: 'slate',  label: 'Slate',       hex: '#5c6670' }
];
