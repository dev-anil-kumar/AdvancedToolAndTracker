# Plan — "Write": an advanced rich-text editor for Folio

## Goal
A new **Write** tab: a calm, paper-like rich-text editor that feels native to Folio
(vanilla ES modules, no build step, IndexedDB, bus-driven views, tokens.css palette).

## UX principles
- **Content first.** Paper sheet centered on a soft background; chrome fades while typing.
- **One compact toolbar** (sticky, grouped, icon + tooltip with shortcut) + a **floating
  selection bubble** (B / I / U / link / highlight / clear) near the selection.
- **Slash menu** (`/` on an empty line) for headings, lists, checklist, quote, code,
  table, divider, image — keyboard-first, filterable.
- **Everything reachable by keyboard**; `Ctrl/⌘ + /` opens a shortcut cheat-sheet.
- Autosave (debounced) with a quiet "Saved" indicator; word/char count + reading time in a
  slim status bar.
- Light/dark via existing tokens; responsive down to phone width (toolbar scrolls, bubble
  still works).

## Features
### 1. Documents
- Store `writedocs` (new IndexedDB store, DB_VER 7): `{id, name, html, page, font, createdAt, updatedAt}`.
- Library list in a left rail (search by name, rename inline, duplicate, delete), plus a
  Home section "Writing" like the other kinds.
- New / Open file / Download.

### 2. Rich formatting
Bold, italic, underline, strike, inline code, highlight (palette), text colour, font family
(Sans / Serif / Mono / Hand), size, H1–H3, paragraph, quote, code block, bullet / numbered /
checklist, indent/outdent, align L/C/R/Justify, link (insert/edit/remove), horizontal rule,
table (insert, add/remove row/col), clear formatting, undo/redo.
Implementation: `contenteditable` + a small command layer (`execCommand` where reliable,
Range-based wrappers for the rest) so it stays dependency-free.

### 3. Smart paste (preserve style)
- `text/html` paste → sanitize with DOMPurify (already loaded) through an **allowlist** that
  keeps semantic tags and a whitelisted subset of inline style (color, background-color,
  font-weight, font-style, text-decoration, text-align, font-size, font-family) — handles
  Word/Google Docs/web pages (strips `mso-*`, classes, scripts, event attrs).
- Plain text paste: Markdown-looking text → rendered via `marked`; URLs → links.
- `Ctrl/⌘+Shift+V` = paste as plain text.
- Pasted/dropped images → stored as data URLs/blobs (reuse `note-images.js` approach),
  inserted inline.

### 4. Images
Toolbar button (file picker), paste, drag-drop. Click an image → resize handles (S/M/L/Full
or drag), alignment (left/center/right), alt text, delete. Downscale huge images on insert.

### 5. Search & replace in content
`Ctrl/⌘+F` opens an inline bar: live match count, highlight all (CSS Custom Highlight API
with `<mark>` fallback), next/prev (Enter / Shift+Enter), case / whole-word toggles,
replace / replace all (`Ctrl/⌘+H`). Esc closes.

### 6. Open any file → text, download
- Open: `.txt .md .html .rtf(basic) .json .csv .js/.ts/.py/…` any file read as text;
  HTML/MD rendered to rich; code/text into a code-styled block or plain paragraphs;
  binary files detected (NUL bytes) → friendly message, show hex/text preview.
- Also reuse existing PDF/Excel converters (`features/convert`) → rich content.
- Download menu: **.html** (self-contained), **.md** (HTML→MD converter), **.txt**, **.doc**
  (Word-compatible HTML), **Print / PDF** (print stylesheet respects page style), and
  "Download original" when opened from a file.

### 7. Page styles
Picker with live thumbnails: **Blank, Lined (ruled), Graph (fine 5 mm), Grid (large
cells), Dotted, Legal pad (margin line)**, plus page tint (white / cream / dark) and
page width (Narrow / Normal / Wide / Full).
- Rendered with CSS backgrounds sized from CSS vars (`--line-h`) so text **snaps to the
  ruling**: line-height, paragraph margins, headings, lists and images use multiples of the
  line height, so content sits on the lines in every format.
- **Lined:** hovering a line shows a copy button in the gutter → copies that visual line's
  text (uses Range.getClientRects to map a y-position to text). Also "copy paragraph".
- **Grid/Graph:** hover highlights the cell under pointer; click the copy chip to copy the
  text inside that cell's rectangle; optional "cell mode" toggle where the page becomes a
  real editable grid (table of cells) — each cell selectable, copyable, Tab moves between cells.
- Page style persisted per document.

### 8. Extras (enhancements)
Focus/zen mode (reuse `focus.js`), typewriter scrolling, outline panel (from headings,
click to jump), word goal, emoji-free clean icons (inline SVG), print styles, spellcheck
toggle, markdown shortcuts while typing (`# `, `- `, `1. `, `> `, `[] `, ``` ``` ```, `**x**`).

## Shortcuts (⌘ on mac, Ctrl elsewhere)
B/I/U bold/italic/underline · ⇧X strike · E inline code · ⇧H highlight · K link ·
Alt+1/2/3 headings · Alt+0 paragraph · ⇧7 numbered · ⇧8 bullets · ⇧9 checklist ·
⇧. quote · Alt+C code block · ] / [ indent/outdent · ⇧L/E/R/J align · \\ clear format ·
F find · H replace · S save now · O open · ⇧S download · P print · Z / ⇧Z undo/redo ·
/ shortcut sheet · ⇧F focus mode.

## Architecture (files)
- `assets/js/features/writedocs.js` — CRUD + persistence + bus event `WRITEDOCS`.
- `assets/js/features/write/commands.js` — formatting command layer.
- `assets/js/features/write/paste.js` — sanitize/normalise paste + drop.
- `assets/js/features/write/images.js` — insert/resize/downscale.
- `assets/js/features/write/search.js` — find/replace engine.
- `assets/js/features/write/io.js` — open any file → html, export formats.
- `assets/js/features/write/pages.js` — page styles, line/cell hit-testing + copy, cell mode.
- `assets/js/features/write/shortcuts.js` — keymap + markdown autoformat.
- `assets/js/ui/write-view.js` — toolbar, bubble, slash menu, rail, status bar, dialogs.
- `assets/css/write.css` — all styling, tokens only.
- Wiring: `index.html` (tab + section + css), `router.js`, `config.js` (store + DB_VER),
  `state.js`, `bus.js`, `main.js` (boot + drop routing), `home.js` section.
- Tests: extend `tests/smoke.mjs` (sanitize allowlist, search engine, io conversions,
  line mapping helpers where testable in jsdom).

## Execution (Sonnet agents)
1. **Agent A — foundation (sequential first):** store, wiring, view shell, toolbar, command
   layer, shortcuts, autosave, status bar, CSS base. Exposes extension hooks.
2. **Parallel after A:**
   - **Agent B — paste + images + search/replace.**
   - **Agent C — page styles + line/grid copy + cell mode.**
   - **Agent D — open any file + downloads/print + home section + tests.**
3. **Review:** lint + tests, manual browser check, fix pass.
