/**
 * Every tunable constant in the app. Nothing here depends on anything else,
 * so this is the file to read first when changing behaviour.
 */

/* ---------- Storage ---------- */
export const DB_NAME = 'folio';
export const DB_VER = 4;
export const STORES = ['files', 'notes', 'prefs', 'drawings', 'jsondocs'];

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

/* ---------- Limits ---------- */
export const MAX_OPEN_AT_ONCE = 6;    // files accepted from one drop or picker
export const NOTE_QUOTE_MAX = 4000;   // characters stored per note
export const RECENT_VISIBLE = 8;      // Home rows before "Show all"
export const NOTE_CLAMP_CHARS = 240;  // longer than this gets an Expand control
export const NOTE_CLAMP_LINES = 4;

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

/* ---------- Note highlight palette ---------- */
export const HIGHLIGHTS = [
  { key: 'harbor', label: 'Harbor blue', hex: '#1f5f7d' },
  { key: 'amber',  label: 'Amber',       hex: '#c98a1b' },
  { key: 'moss',   label: 'Moss green',  hex: '#4a7c46' },
  { key: 'rose',   label: 'Rose',        hex: '#b4526b' },
  { key: 'violet', label: 'Violet',      hex: '#6c5aa8' },
  { key: 'slate',  label: 'Slate',       hex: '#5c6670' }
];
