/**
 * Every tunable constant in the app. Nothing here depends on anything else,
 * so this is the file to read first when changing behaviour.
 */

/* ---------- Storage ---------- */
export const DB_NAME = 'folio';
export const DB_VER = 3;
export const STORES = ['files', 'notes', 'prefs', 'drawings'];

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

/* ---------- Note highlight palette ---------- */
export const HIGHLIGHTS = [
  { key: 'harbor', label: 'Harbor blue', hex: '#1f5f7d' },
  { key: 'amber',  label: 'Amber',       hex: '#c98a1b' },
  { key: 'moss',   label: 'Moss green',  hex: '#4a7c46' },
  { key: 'rose',   label: 'Rose',        hex: '#b4526b' },
  { key: 'violet', label: 'Violet',      hex: '#6c5aa8' },
  { key: 'slate',  label: 'Slate',       hex: '#5c6670' }
];
