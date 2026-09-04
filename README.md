# Folio

A quiet, local-first reader for Markdown and JSON. Open documents from your disk or a
public URL, read several side by side, keep notes from anything you select, sketch a
diagram, and pick apart a JSON dump — including the JSON that arrives stuffed inside a
string. Everything is stored in your browser — no accounts, no server, no telemetry.

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
npm test      # integration smoke test: 344 assertions through the real module graph
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
    responsive.css          breakpoints, and the last word on [hidden]
  js/
    main.js                 wiring and boot
    core/                   dom · bus · config · db · state · router · format · toast
    md/renderer.js          marked → DOMPurify → highlight.js → enhancements
    features/               theme · highlight · library · workspaces · panes ·
                            pane-resize · notes · exporter · focus · drawings ·
                            jsondocs
    features/canvas/        model · editor
    features/json/          model · tree · table · graph · code
    ui/                     shell · home · notes-view · dialogs · canvas-view ·
                            json-view
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

IndexedDB (`folio`, stores `files` / `notes` / `prefs` / `drawings` / `jsondocs`), wrapped in `core/db.js` with
an in-memory fallback so a browser that blocks storage degrades to session-only
instead of breaking. Writes go through `persist()`, which never rejects — it warns
once and carries on. Nothing uses `localStorage`.

### Security

All Markdown is parsed by `marked` and sanitised by `DOMPurify` before it reaches the
DOM; `md/renderer.js` is the only module that writes HTML. Fetching a URL is the only
network request the app makes on its own.

### Dependencies

Four, all pinned, all from a CDN, all loaded by `index.html`:

| Library | Version | Why |
| --- | --- | --- |
| marked | 12.0.2 | GFM parsing |
| DOMPurify | 3.1.6 | Sanitising rendered HTML |
| highlight.js | 11.9.0 | Fenced code, dark in both themes |
| Google Fonts | — | Source Serif 4 and Inter |

The JSON view adds no dependencies: its parser is `JSON.parse`, and its colouring is a
tokeniser in `features/json/model.js`. highlight.js would have done the job, except that
it paints an object's key and a string value the same colour — which is exactly the
distinction a reader of unfamiliar data needs.

## Features

- **Sources** — local files (picker or drop anywhere), any public URL that allows
  cross-origin reads (GitHub `/blob/` links are converted to raw automatically), or
  pasted text saved to the library like anything else.
- **Reading tabs** — independent sets of open documents; the same document can be open
  in more than one tab.
- **Panes** — laid out as rows of *N* (configurable, 1–6). Drag any divider to resize,
  in either axis, with arrow-key support. Drag a title bar to float a document into a
  freely resizable window, and dock it back.
- **Notes** — select a passage and save it. A note remembers its document, block, and
  section; clicking it reopens the document at that spot with the quote highlighted in
  a colour you choose.
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
- **Accessibility** — real tab/tabpanel, tree/treeitem and separator roles, visible focus
  rings, `prefers-reduced-motion` respected, keyboard paths for the drag interactions.
