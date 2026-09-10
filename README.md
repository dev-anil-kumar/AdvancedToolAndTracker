# Folio

A quiet, local-first reader for Markdown, PDF, spreadsheets and JSON. Open documents
from your disk or a public URL, read several side by side, keep notes from anything you
select, sketch a diagram, pick apart a JSON dump — including the JSON that arrives
stuffed inside a string — and compare two files of almost any kind, line by line or by
their structure. Everything is stored in your browser — no accounts, no server, no
telemetry.

Static files only: **no build step, no bundler, no framework.** Deploys to GitHub Pages
by pushing.

---

## Running it locally

Any static file server will do. The app uses ES modules, so it must be served over
`http://` — opening `index.html` from the filesystem will not work.

```bash
python3 -m http.server 8000      # or: npm start
# → http://localhost:8000
```

## Deploying to GitHub Pages

1. Push to GitHub.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, pick your
   branch and `/ (root)`.
3. Wait a minute; the site appears at `https://<user>.github.io/<repo>/`.

Every path in `index.html` is relative (`./assets/...`), so the app works from a
repository subpath without configuration. `.nojekyll` keeps Pages from running the
files through Jekyll.

Nothing needs to be built or committed beyond the source itself — `node_modules` is
only for the tests and is git-ignored.

## Tests and linting

Optional, and only needed for development:

```bash
npm install
npm test      # integration smoke test: 533 assertions through the real module graph
npm run lint  # ESLint; no-undef is what catches a missing import with no bundler
```

`tests/smoke.mjs` builds the DOM from `index.html` in jsdom, supplies the browser
APIs the modules expect, and imports `assets/js/main.js` — so a broken import or a
missing export fails the test run instead of the browser.

---

## Architecture

```
index.html                  markup only: the shell, the dialogs, the sample document
assets/
  css/
    tokens.css              palette, themes, resets — the only place colours live
    base.css                header, tabs, buttons, popover, toast, dialogs
    markdown.css            the reading surface
    workspace.css           tab strip, pane grid, gutters, floating panes, focus mode
    views.css               Home and Notes pages
    canvas.css              tool strip, drawing surface, shapes
    json.css                JSON toolbar, tree, table, code, source pane
    compare.css             compare toolbar, the two panes, rows, ribbon
    responsive.css          breakpoints, and the last word on [hidden]
  js/
    main.js                 wiring and boot
    core/                   dom · bus · config · db · state · router · format · toast
    md/renderer.js          marked → DOMPurify → highlight.js → enhancements
    features/               theme · highlight · library · workspaces · panes ·
                            pane-resize · notes · note-images · exporter ·
                            focus · drawings · jsondocs · compares
    features/convert/       loader · pdf · sheet — other formats, into Markdown
    features/canvas/        model · editor
    features/json/          model · tree · table · graph · code
    features/diff/          myers · histogram · text · tokens · syntax ·
                            json · table · align · detect · index · worker
    ui/                     shell · home · notes-view · note-editor · dialogs ·
                            canvas-view · json-view · compare-view
```

### The one rule

Imports point **downwards** only:

```
main.js  →  ui/  →  features/  →  md/  →  core/
```

A feature never imports a view. When a feature changes something it emits on the
bus (`core/bus.js`) and the interested views re-render themselves. That is what keeps
the graph acyclic and makes any module readable on its own.

```js
// features/library.js
await persist(dbPut('files', rec));
emit(EVENTS.LIBRARY);          // Home and the shell counters update themselves
```

Layering is checked mechanically — see the layer assertion in the project history, or
re-run it any time:

```bash
python3 - <<'PY'
import pathlib, re
root = pathlib.Path('assets/js'); rank = {'core':0,'md':1,'features':2,'ui':3,'entry':4}
for f in sorted(root.rglob('*.js')):
    parts = f.relative_to(root).parts
    layer = parts[0] if len(parts) > 1 else 'entry'
    for imp in re.findall(r"from '([^']+)'", f.read_text()):
        t = (f.parent / imp).resolve().relative_to(root.resolve())
        tl = t.parts[0] if len(t.parts) > 1 else 'entry'
        if rank[tl] > rank[layer]: print('VIOLATION', f, '->', t)
PY
```

### State

`core/state.js` is the single source of truth. Collections are exported as live
bindings, so any module can read `files` or `notes` directly, but a collection is only
ever *replaced* through a setter in that file — one place to look when asking who
changed an array. Questions are asked through selectors (`fileById`, `panesIn`,
`anyPaneFor`, …) rather than by filtering in the caller.

### Storage

IndexedDB (`folio`, stores `files` / `notes` / `prefs` / `drawings` / `jsondocs` / `images` / `compares`), wrapped in `core/db.js` with
an in-memory fallback so a browser that blocks storage degrades to session-only
instead of breaking. Writes go through `persist()`, which never rejects — it warns
once and carries on. Nothing uses `localStorage`.

### Security

All Markdown is parsed by `marked` and sanitised by `DOMPurify` before it reaches the
DOM; `md/renderer.js` is the only module that writes HTML. Fetching a URL is the only
network request the app makes on its own.

### Dependencies

All pinned, all from a CDN. The first four are loaded by `index.html`; the last two are
fetched the first time a file needs them:

| Library | Version | Why | Loaded |
| --- | --- | --- | --- |
| marked | 12.0.2 | GFM parsing | always |
| DOMPurify | 3.1.6 | Sanitising rendered HTML | always |
| highlight.js | 11.9.0 | Fenced code, dark in both themes | always |
| Google Fonts | — | Source Serif 4 and Inter | always |
| pdf.js | 3.11.174 | Reading the text out of a PDF | on demand |
| SheetJS | 0.18.5 | Reading a workbook | on demand |

Those last two are together some ten times the size of Folio, and most sessions never
open a PDF or a spreadsheet, so loading them up front would make every visit pay for a
feature most visits do not use. `features/convert/loader.js` appends the script the first
time one is needed and caches the promise; a library already on the page is used as it
stands, which is also what lets the tests supply their own.

Compare adds none either. `features/diff/` is Myers' algorithm, histogram anchoring,
detection and a small tokeniser, written out — some four hundred lines of algorithm
against the several hundred kilobytes a diff library would have cost, and the reason the
same code can run in a worker without a bundler to make a second copy of it.

The JSON view adds no dependencies: its parser is `JSON.parse`, and its colouring is a
tokeniser in `features/json/model.js`. highlight.js would have done the job, except that
it paints an object's key and a string value the same colour — which is exactly the
distinction a reader of unfamiliar data needs.

## Features

- **Sources** — local files (picker or drop anywhere), any public URL that allows
  cross-origin reads (GitHub `/blob/` links are converted to raw automatically), or
  pasted text saved to the library like anything else.
- **File types** — `.md` and `.txt` are read as they are. A **PDF** or a **spreadsheet**
  (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.csv`, `.tsv`, `.ods`) is converted to Markdown on
  the way in, so from that point on it *is* a document: it opens in a pane, sits beside
  other documents, takes notes with block indices, searches, exports and reads in focus
  mode without one line of the reading view knowing that PDFs exist. A `.json` goes to
  the JSON view instead. Anything else is refused by name, with a list of what works.
  - **PDF** — a PDF has no paragraphs; it has glyphs at coordinates. Runs on one baseline
    become a line, a gap wider than a fraction of the type size becomes the space it
    stands for, and lines are then joined into prose: a word broken across a line end is
    mended, a short line that ends a sentence ends the paragraph, a fresh indent starts
    one. Heading levels come from the document's own ranking of type sizes rather than
    fixed ratios, so a report set in 22pt and 14pt gets an `h1` and an `h2` — not an `h1`
    and an `h3`. Running heads and page numbers that repeat across pages are dropped
    (digits are blanked first, so "Page 3 of 12" and "Page 4 of 12" count as the same
    furniture). Bullets and numbered lines become lists. What it gives up is layout and
    images: for a document you mean to *read*, that is the right trade; for one you need
    to see exactly, it is not. A scan with no text layer says so rather than opening
    blank.
  - **Spreadsheets** — every sheet becomes a Markdown table with the row and column
    count above it. The header row is used as headers, nameless columns are given names,
    columns that are mostly numbers are set to the right, a `|` in a cell is escaped and
    a newline in one becomes a `<br>`, and trailing empty rows and columns are trimmed.
    Formulas arrive as their values, dates as the sheet formatted them. Very large sheets
    are clipped, and say by how much.
  - Converted documents store the Markdown they became, not the original bytes — the
    file on your disk is still the original. Exporting one writes the Markdown, named
    after the file rather than after the format (`report.pdf` → `report.md`).
- **Reading tabs** — independent sets of open documents; the same document can be open
  in more than one tab.
- **Panes** — laid out as rows of *N* (configurable, 1–6). Drag any divider to resize,
  in either axis, with arrow-key support. Drag a title bar to float a document into a
  freely resizable window, and dock it back.
- **Notes** — two kinds, kept in one list.
  - **Keep a passage.** Select text in the reading view and save it. The note remembers
    its document, block, and section; clicking it reopens the document at that spot with
    the quote highlighted in a colour you choose.
  - **Write one yourself.** *New note* on the Notes page (or <kbd>n</kbd> there, or
    *Write a note* on Home) opens an editor: a title and a Markdown body, rendered by the
    same pipeline as a document — headings, lists, task lists, code, tables and all.
    These belong to no document, so they sit in a group of their own at the top.
  - **Images.** Paste a screenshot straight into the editor, drop one on it, or pick a
    file. Pictures are stored in their own IndexedDB store and the note refers to them —
    `![Shot](folio-img:9f2c…)` — so the note's text stays short enough to edit by hand
    and the Notes page is not re-parsing megabytes of base64 on every draw. The
    references are resolved to the real image just before the Markdown is parsed. A
    thumbnail strip shows what is attached, and taking one out removes it from the text.
    Deleting a note deletes the pictures nothing else refers to.
  - **Export** writes a written note as itself, with the images inlined as data URLs, so
    the `.md` file stands alone with no folder of pictures to lose.
- **Focus mode** — hides every piece of chrome. Escape returns.
- **Export** — any document, any note, or everything, written into a folder you pick
  via the File System Access API, falling back to ordinary downloads elsewhere.
- **Canvas** — a deliberately small diagram editor. Press <kbd>R</kbd>, <kbd>C</kbd> or
  <kbd>A</kbd> and drag to draw a rectangle, circle or arrow; <kbd>T</kbd> for text and
  <kbd>F</kbd> for a container. <kbd>shift</kbd> constrains to squares, circles and 45°
  arrows.
  - **Text on everything** — rectangles, circles, containers, text boxes and arrows all
    take a label: double-click, or select and press <kbd>Enter</kbd>, or use *Add text*.
    Text inside a shape is centred both ways; a container's label sits top-left.
  - **Text box** (<kbd>N</kbd>) — a text container with no visible boundary. It shows a
    faint dashed edge only while selected or empty, so it can still be found.
  - **Colour** — five line colours and five backgrounds (plus none). Every new shape
    arrives with a background chosen for its kind, so nothing looks unfinished.
  - **Fonts** — sans, serif or hand-drawn, per shape.
  - **⌘C / ⌘V / ⌘X** — copy, paste and cut real objects, links between them intact.
  - **Resize from any corner**, with <kbd>shift</kbd> to keep it square.
  - **Connections** — select a shape and drag one of its four side ports to pull out an
    arrow that stays attached; the target highlights as you aim. A bound arrow re-routes
    to the shape's border whenever either end moves, and *Detach* frees it again.
  - **Containers** — draw one around existing shapes and it adopts them. Moving it moves
    everything inside, arrows included.
  - **Alignment guides** — dragging a shape snaps its edges and centre onto nearby
    shapes, with a guide line showing the match.
  - Marquee-select by dragging empty space, <kbd>shift</kbd>-click to add, <kbd>space</kbd>-drag
    or middle-drag to pan, ⌘-wheel to zoom, ⌘Z/⇧⌘Z undo, ⌘D duplicate, ⌘A select all.
  - Alt-drag to pull off a copy, shift-drag to keep to one axis, ⌘]/⌘[ for stacking
    order, a padlock to keep a tool selected, and <kbd>?</kbd> for the full shortcut list.
  - Double-click empty canvas to start writing there; a shape grows to fit its text.
  - Rectangle is the tool a fresh canvas starts on: open one and drag.
  - Autosaves; exports `.json` (lossless, re-importable), `.svg` or `.png`; imports by
    button or by dropping a file on the canvas.
- **JSON** — open a `.json` file, paste it, or fetch a URL; it lands in the library like
  any other document. Six ways to look at the same data, switched with the segmented
  control, <kbd>1</kbd>–<kbd>6</kbd>, or <kbd>[</kbd> and <kbd>]</kbd>:
  - **Tree** — collapsible and coloured by type, with a summary beside every closed
    branch. Children are built when a branch opens and long arrays arrive 200 at a time,
    so a three-megabyte dump opens instantly. Real `tree`/`treeitem` roles and arrow-key
    navigation; click a row for its path in JavaScript accessor notation.
  - **Table** — any array of records as rows and columns, sortable per column, filtered
    by the same Find box. Every array of records in the document is offered by path,
    embedded ones included.
    A column is a *leaf*, not a top-level key: `recording: {bytes, format}` becomes
    `recording.bytes` and `recording.format`, and a field that is itself JSON in a string
    is opened out the same way — a cell reading `{3}` answers nothing. Arrays stay one
    cell, listed inline, with a chip that takes you to them in the tree.
  - **Graph** — the document as a map: a tidy left-to-right layout, one box per value,
    coloured by type, with the branches you have opened drawn and the rest offered. This
    is the view for a payload you have never seen before — how wide, how deep, where the
    weight sits, and which fields are really documents smuggled through a string (drawn
    with a dashed border). Click a box to open or close it, drag to pan, wheel to zoom,
    *Fit* to frame the lot, double-click to jump to that value in the tree. A branch too
    wide to draw shows its first fourteen children and a `+ N more` box; the whole map is
    capped, because a map of a thousand boxes is not a map.
  - **Code** — the whole thing formatted, coloured and numbered, keys distinguished from
    string values. *Unwrap* replaces every JSON-inside-a-string with the document it
    holds, which is usually the difference between unreadable and obvious.
  - **Raw** — the text exactly as it arrived, untouched.
  - **Edit** — a source pane that says what broke and on which line, then puts the caret
    there. V8 stopped reporting a character position in 2023, so Folio finds it itself.
    *Format*, *Minify* and *Sort keys* rewrite the source in place.
  - **JSON inside a string** — a field like `"queue": "[{\"callState\":\"STARTED\"}]"` is
    recognised as the document it is and expands like any other branch, however many
    times it is nested. Editing a value inside one is written back out through the
    string. One that was truncated in transit is labelled rather than shown as a wall of
    escapes.
  - **Find** — one box, and each view answers it in its own way: the tree and the graph
    filter down to the matches and their ancestors, the table filters rows, the code view
    marks them. What counts as a match is decided in one place, so the views agree.
  - **Editing without spoiling the reading** — the tree grows no controls at all until
    *Edit values* is switched on. Then a click edits a value, a double-click renames a
    key, and `+`/`×` add and remove entries; what you type is read as JSON if it parses
    and as a string if it does not. Everything autosaves.
- **Compare** — two files, side by side, aligned row for row. Each side is uploaded,
  pasted, downloaded from a URL, or taken from something already in your library; drop
  two files on the window while the Compare tab is open and it takes both. Comparisons
  can be kept, so you come back to one rather than setting it up again.
  - **What kind of file is this?** The extension decides when there is one. When there
    is not — pasted text, a URL ending in a slash, a file called `dump` — the content
    is asked instead: first the shapes that can be *confirmed* rather than guessed
    (JSON parses or it does not; a CSV has the same number of delimiters on every
    line), then a weighted vote over the phrases that only ever appear in one language.
    `fun x(` with `val` is Kotlin; `fun x(` with `let mut` is Rust; `public class` with
    `void` is Java. No single line proves anything, which is why they are weighed
    rather than searched for. Two files that turn out to be different languages are
    compared as lines and told so.
  - **How they are matched depends on what they are.** JSON key by key, CSV row by row,
    everything else line by line — and what the file turns out to be also decides which
    options arrive switched on, because trailing space matters in a fixture and not in
    source. A strategy that cannot run (JSON that does not parse) falls back to lines
    and says why rather than refusing.
  - **Lines** — Myers' O(ND) algorithm in linear space, so two ten-megabyte files are
    matched in O(N) memory instead of O(N·M). But a *shortest* edit path is often a
    nonsense one: given two functions that both end in `}` and `return null;` it will
    pair the closing brace of one with the closing brace of the other and shred both
    bodies around them. So lines are counted first and the comparison is anchored on
    the *rarest* ones — patience diff by way of `git diff --histogram` — and rarity is
    taken in tiers, the rarest tier that yields anything at all winning outright. A
    line unique to both sides is almost certainly the same line; a closing brace is
    almost certainly not, and deferring the braces to the gaps *between* the anchors is
    the whole difference between reading a diff and staring at one. All the candidate
    anchors are used at once, chained by the longest increasing subsequence of their
    positions — patience sorting, O(R log R) — rather than one at a time, because
    picking one and recursing throws away half the file when every candidate scores the
    same. **Patience** (anchor only on lines unique to both) and **Myers** (fewest
    changed lines, readability be damned) are both offered, because on a minified or
    generated file the trade goes the other way.
  - **Words** — a pair of rows reading `const timeout = 30;` and `const timeout = 45;`
    in solid red and solid green tells you nothing you could not see for yourself. So a
    rewritten line is compared again over *tokens* — characters find edits inside words
    and produce confetti; tokens find the word that changed. Which lines are a rewrite
    at all is decided first, by how alike they are (Sørensen–Dice over character
    pairs), so three lines replaced by five come out as three rewrites and two
    additions rather than five of each.
  - **Moved blocks** — a block removed from one place and added, unchanged, to another
    is one move, not two edits, and reading it as two is how a reordered set of
    functions becomes an unreadable diff. Each block is fingerprinted by its lines;
    equal fingerprints on opposite sides are the same block in a new place, marked as
    moved rather than as lost and gained.
  - **JSON, by structure** — reordering an object's keys changes nothing about what the
    document says, and a line comparison reports every one of them. So both sides are
    parsed and walked together, and the key *lists* are matched by longest common
    subsequence so an added field lands where it belongs instead of at the end. Arrays
    are the interesting part: `[{id: 1}, {id: 2}]` against `[{id: 2}, {id: 1}]` holds
    the same two records. An array of records is examined for a field that identifies
    them — `id`, `key`, `name`, or whatever else turns out to be present everywhere and
    unique on both sides — and matched on that, so a record in a different position is
    one record that *moved*, with whatever else changed about it still compared. Failing
    that, elements are matched on a canonical hash of their contents and the leftovers
    paired positionally, so you are told which field of the third element changed rather
    than that the third element is new. JSON smuggled through a string is recognised and
    compared as the document it is.
  - **CSV and TSV, by row and column** — headers matched by name, so a column inserted
    at the front is one column added rather than every line changed; records matched by
    their first column when it identifies them and by a row hash when it does not; and
    every cell padded to its column's width so the two panes line up column for column
    and a field can be read down the page.
  - **Ignore** — trailing space, all whitespace, blank lines, case. Ignoring blank lines
    does not hide them: a change made entirely of blank lines stays on screen, in place,
    but is not counted and not worth jumping to.
  - **Reading it** — drag the divider to give either side more room (arrow keys work,
    Enter evens them up); scroll the two panes **Linked** or **Free**; switch to a
    **Unified** column; step through the changes with the arrows or <kbd>n</kbd> and
    <kbd>p</kbd>; and use the ribbon down the right edge, which is a map of the whole
    file showing how much changed and where. Changed lines are coloured; unchanged ones
    are syntax-coloured — never both, because a line marked twice over is harder to read
    than a line marked once.
  - **Large files** — a comparison of two hundred-thousand-line files is two hundred
    thousand rows, and a browser asked to hold that many elements stops being a browser.
    Every row is exactly one line tall, so the row under any scroll position is
    arithmetic rather than measurement: the pane gets a spacer of the full height and
    the forty-odd rows on screen are drawn into a box translated to the right offset.
    Both panes draw from the same row list, which is why their halves always align and
    why linking them is just copying a scroll position. A long unchanged run keeps a
    little context at each end and offers the rest behind one row. Lines are interned to
    integers before any matching starts, lines that occur nowhere in the other file are
    set aside before the expensive part begins, and the matching itself goes to a module
    worker so the tab never stops answering. Every search that could run long has a
    ceiling: a region too tangled to match inside its budget is reported as a rewrite —
    honestly and instantly, rather than correctly in a minute — and the comparison says
    so when that happened.
  - **Out** — copy or save the whole thing as a unified diff, written from the rows so
    the `.diff` file says exactly what the screen said.
  - Shortcuts: <kbd>n</kbd>/<kbd>p</kbd> next and previous change, <kbd>u</kbd> unified,
    <kbd>s</kbd> scroll mode, <kbd>x</kbd> show every line, <kbd>w</kbd> swap the sides.
- **Accessibility** — real tab/tabpanel, tree/treeitem and separator roles, visible focus
  rings, `prefers-reduced-motion` respected, keyboard paths for the drag interactions.
