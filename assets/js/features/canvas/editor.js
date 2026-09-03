/**
 * The canvas editor: renders a scene as SVG and handles every interaction.
 *
 *   r / c / a / t / f      pick a tool, then drag to draw (shift constrains)
 *   drag a shape           move it; a container brings its contents along
 *   shift-click            add to the selection; drag empty space to marquee
 *   drag a side port        pull a connected arrow out of a shape
 *   double-click / Enter   write text inside a shape
 *   space-drag, middle-drag, wheel   pan;  ⌘/ctrl + wheel   zoom
 *   ⌘Z / ⇧⌘Z, ⌘D, Delete  undo / redo, duplicate, delete
 *
 * The scene re-renders on every change. Scenes are small, and the simplicity
 * buys more than the frames it costs.
 */
import {
  ARROW_HEAD, AUTOSAVE_MS, CANVAS_FONT, DEFAULT_TOOL, GRID, HISTORY_MAX,
  MIN_SHAPE, STROKE_W, ZOOM_MAX, ZOOM_MIN, INKS
} from '../../core/config.js';
import { $, clamp } from '../../core/dom.js';
import { toast } from '../../core/toast.js';
import { saveDrawing } from '../drawings.js';
import {
  arrowEnds, bindArrow, bounds, centre, connectTargetAt, constrainBox, constrainLine,
  boundsOfAll, defaultSized, drawOrder, fillColour, fontOf, intersectsRect, isCentred,
  makeShape, moveShape, reparentAll, sceneBounds, serialize, shapeAt, shapeById, snap,
  snapCandidates, snapToGuides, syncArrows, textHeight, wrapText
} from './model.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const node = document.createElementNS(NS, tag);
  Object.keys(attrs || {}).forEach(k => node.setAttribute(k, String(attrs[k])));
  return node;
};

let scene = null;
let tool = DEFAULT_TOOL;
let ink = INKS[0].hex;
let fillKey = null;              // null = each kind's own default
let fontKey = 'sans';
let clipboard = [];
let toolLocked = false;          // keep the tool after drawing, for repeat work
let selectedIds = new Set();
let drag = null;                 // the interaction in flight
let spaceDown = false;
let past = [], future = [];
let saveTimer = null;
let saveState = 'saved';         // 'saved' | 'editing'
let textOpenedAt = 0;
let onChange = () => {};

/* ---------- Lifecycle ---------- */

export function attachEditor(handlers) {
  onChange = (handlers && handlers.onChange) || onChange;
  const host = $('#canvasHost');
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onHover);
  host.addEventListener('dblclick', onDoubleClick);
  host.addEventListener('wheel', onWheel, { passive: false });
  addEventListener('resize', () => { if (scene) render(); });
}

export function loadScene(next) {
  scene = next;
  selectedIds = new Set();
  past = []; future = [];
  saveState = 'saved';
  hideTextEditor();
  syncArrows(scene);
  render();
  onChange();
}

export const activeScene = () => scene;
export const activeTool = () => tool;
export const activeInk = () => ink;
export const activeFill = () => fillKey;
export const activeFont = () => fontKey;
export const clipboardSize = () => clipboard.length;
export const isToolLocked = () => toolLocked;
export function setToolLocked(on) { toolLocked = !!on; onChange(); }
export const saveStatus = () => saveState;
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;

/** The selection, in scene order. */
export function selectedShapes() {
  return scene ? scene.shapes.filter(s => selectedIds.has(s.id)) : [];
}
/** The single selected shape, or null when zero or several are selected. */
export function selection() {
  const list = selectedShapes();
  return list.length === 1 ? list[0] : null;
}
export const selectionCount = () => selectedIds.size;

function setSelection(ids) {
  selectedIds = new Set(ids);
  render();
  onChange();
}
export function clearSelection() { setSelection([]); }
export function selectAll() { setSelection(scene ? scene.shapes.map(s => s.id) : []); }

export function setTool(next) {
  tool = next;
  const host = $('#canvasHost');
  if (host) host.dataset.tool = next;
  onChange();
}

export function setInk(hex) {
  ink = hex;
  const chosen = selectedShapes();
  if (chosen.length) commit(() => { chosen.forEach(s => { s.ink = hex; }); });
  else onChange();
}

/** Background colour — 'none' is a real choice, not the absence of one. */
export function setFill(key) {
  fillKey = key;
  const chosen = selectedShapes();
  if (chosen.length) commit(() => { chosen.forEach(s => { s.fill = key; }); });
  else onChange();
}

export function setFont(key) {
  fontKey = key;
  const chosen = selectedShapes();
  if (chosen.length) commit(() => { chosen.forEach(s => { s.font = key; }); });
  else onChange();
}

/** The style a new shape is born with. */
function newStyle(kind) {
  return { fill: fillKey === null ? undefined : fillKey, font: fontKey };
}

/* ---------- History and saving ---------- */

function pushHistory(snapshot) {
  past.push(snapshot == null ? serialize(scene) : snapshot);
  if (past.length > HISTORY_MAX) past.shift();
  future = [];
}

/** Run a mutation, keeping it undoable and scheduling a save. */
function commit(mutate) {
  if (!scene) return;
  pushHistory();
  mutate();
  render();
  scheduleSave();
  onChange();
}

function restore(json) {
  const data = JSON.parse(json);
  scene.name = data.name;
  scene.shapes = data.shapes;
  scene.view = data.view;
  selectedIds = new Set([...selectedIds].filter(id => shapeById(scene, id)));
  syncArrows(scene);
  render();
  scheduleSave();
  onChange();
}

export function undo() {
  if (!past.length) return;
  future.push(serialize(scene));
  restore(past.pop());
}

export function redo() {
  if (!future.length) return;
  past.push(serialize(scene));
  restore(future.pop());
}

function scheduleSave() {
  saveState = 'editing';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!scene) return;
    await saveDrawing(scene);
    saveState = 'saved';
    onChange();
  }, AUTOSAVE_MS);
}

/** Flush a pending save — used when leaving the view. */
export function flushSave() {
  clearTimeout(saveTimer);
  if (!scene) return;
  saveDrawing(scene).then(() => { saveState = 'saved'; onChange(); });
}

/* ---------- Coordinates ---------- */

function hostRect() { return $('#canvasHost').getBoundingClientRect(); }

function toScene(clientX, clientY) {
  const r = hostRect();
  return {
    x: scene.view.x + (clientX - r.left) / scene.view.zoom,
    y: scene.view.y + (clientY - r.top) / scene.view.zoom
  };
}

export function zoomBy(factor, anchor) {
  if (!scene) return;
  const r = hostRect();
  const a = anchor || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const before = toScene(a.x, a.y);
  scene.view.zoom = clamp(scene.view.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  const after = toScene(a.x, a.y);
  scene.view.x += before.x - after.x;
  scene.view.y += before.y - after.y;
  render();
  onChange();
}

/** Frame the drawing — or the selection, when there is one. */
export function fitView() {
  if (!scene) return;
  const r = hostRect();
  const chosen = selectedShapes();
  const b = chosen.length
    ? padded(chosen.map(bounds).reduce(union), 60)
    : sceneBounds(scene, 60);
  const zoom = clamp(Math.min((r.width || 800) / b.w, (r.height || 600) / b.h), ZOOM_MIN, ZOOM_MAX);
  scene.view.zoom = zoom;
  scene.view.x = b.x + b.w / 2 - (r.width || 800) / (2 * zoom);
  scene.view.y = b.y + b.h / 2 - (r.height || 600) / (2 * zoom);
  render();
  scheduleSave();
  onChange();
}

const union = (a, b) => ({
  x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
  w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
  h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y)
});
const padded = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 });

/* ---------- Rendering ---------- */

export function render() {
  const svg = $('#scene');
  if (!svg || !scene) return;
  const r = hostRect();
  const w = (r.width || 800) / scene.view.zoom;
  const h = (r.height || 600) / scene.view.zoom;
  svg.setAttribute('viewBox', scene.view.x + ' ' + scene.view.y + ' ' + w + ' ' + h);

  const frag = document.createDocumentFragment();
  frag.appendChild(gridLayer(scene.view.x, scene.view.y, w, h));
  drawOrder(scene).forEach(s => frag.appendChild(shapeNode(s)));

  if (drag && drag.preview) frag.appendChild(shapeNode(drag.preview, true));
  if (drag && drag.marquee) frag.appendChild(svgEl('rect', {
    class: 'marquee', x: drag.marquee.x, y: drag.marquee.y,
    width: drag.marquee.w, height: drag.marquee.h,
    'stroke-width': 1 / scene.view.zoom
  }));
  const chosen = selectedShapes();
  if (chosen.length) frag.appendChild(selectionLayer(chosen));
  if (drag && drag.guides && drag.guides.length) frag.appendChild(guideLayer(drag.guides, w, h));

  svg.replaceChildren(frag);
  $('#canvasEmpty').hidden = scene.shapes.length > 0;
}

/** The thin lines that appear when a shape lines up with its neighbours. */
function guideLayer(guides, w, h) {
  const g = svgEl('g', { class: 'guides', 'aria-hidden': 'true' });
  const width = 1 / scene.view.zoom;
  guides.forEach(line => {
    g.appendChild(line.axis === 'x'
      ? svgEl('line', { x1: line.v, y1: scene.view.y, x2: line.v, y2: scene.view.y + h, 'stroke-width': width })
      : svgEl('line', { x1: scene.view.x, y1: line.v, x2: scene.view.x + w, y2: line.v, 'stroke-width': width }));
  });
  return g;
}

function gridLayer(x, y, w, h) {
  const g = svgEl('g', { class: 'grid', 'aria-hidden': 'true' });
  const first = (v) => Math.floor(v / GRID) * GRID;
  for (let gx = first(x); gx < x + w + GRID; gx += GRID) {
    for (let gy = first(y); gy < y + h + GRID; gy += GRID) {
      g.appendChild(svgEl('circle', { cx: gx, cy: gy, r: 1 }));
    }
  }
  return g;
}

function shapeNode(s, preview) {
  const hovered = drag && drag.hoverId === s.id;
  const g = svgEl('g', {
    class: 'shape' + (preview ? ' preview' : '') + (hovered ? ' hover-target' : ''),
    'data-id': s.id,
    'data-kind': s.kind
  });

  if (s.kind === 'arrow') {
    const [a, b] = arrowEnds(scene, s);
    g.appendChild(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'hit' }));
    g.appendChild(svgEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: s.ink, 'stroke-width': STROKE_W, 'stroke-linecap': 'round', fill: 'none'
    }));
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const wing = (spread) => svgEl('line', {
      x1: b.x, y1: b.y,
      x2: b.x - ARROW_HEAD * Math.cos(angle - spread),
      y2: b.y - ARROW_HEAD * Math.sin(angle - spread),
      stroke: s.ink, 'stroke-width': STROKE_W, 'stroke-linecap': 'round'
    });
    g.appendChild(wing(0.42));
    g.appendChild(wing(-0.42));
    /* A bound end gets a small collar, so an attached arrow reads as attached. */
    if (s.from) g.appendChild(svgEl('circle', { cx: a.x, cy: a.y, r: 3, fill: s.ink, class: 'bound' }));
    if (s.text) g.appendChild(textNode(s, (a.x + b.x) / 2, (a.y + b.y) / 2 - 11, 'middle', true));
    return g;
  }

  const fill = fillColour(s.fill);
  if (s.kind === 'ellipse') {
    g.appendChild(svgEl('ellipse', {
      cx: s.x + s.w / 2, cy: s.y + s.h / 2, rx: Math.max(1, s.w / 2), ry: Math.max(1, s.h / 2),
      fill, stroke: s.ink, 'stroke-width': STROKE_W
    }));
  } else if (s.kind === 'container') {
    g.appendChild(svgEl('rect', {
      x: s.x, y: s.y, width: Math.max(1, s.w), height: Math.max(1, s.h), rx: 10,
      fill, stroke: s.ink, 'stroke-width': STROKE_W, 'stroke-dasharray': '7 5'
    }));
  } else if (s.kind === 'note') {
    /* A text container: no boundary of its own. It shows a faint dashed edge
       only while selected or empty, so it can still be found and grabbed. */
    const bare = selectedIds.has(s.id) || !s.text;
    g.appendChild(svgEl('rect', {
      x: s.x, y: s.y, width: Math.max(1, s.w), height: Math.max(1, s.h), rx: 8,
      fill, stroke: bare ? s.ink : 'none',
      'stroke-width': bare ? 1 : 0,
      'stroke-dasharray': '4 4',
      'stroke-opacity': bare ? 0.5 : 0,
      class: 'note-edge'
    }));
  } else if (s.kind === 'rect') {
    g.appendChild(svgEl('rect', {
      x: s.x, y: s.y, width: Math.max(1, s.w), height: Math.max(1, s.h), rx: 7,
      fill, stroke: s.ink, 'stroke-width': STROKE_W
    }));
  } else {
    g.appendChild(svgEl('rect', {
      x: s.x, y: s.y, width: Math.max(1, s.w), height: Math.max(1, s.h),
      fill: 'transparent', stroke: 'none'
    }));
  }

  if (s.text) {
    if (s.kind === 'container') g.appendChild(textNode(s, s.x + 12, s.y + 20, 'start'));
    else if (s.kind === 'text') g.appendChild(textNode(s, s.x, s.y + CANVAS_FONT, 'start'));
    else g.appendChild(textNode(s, s.x + s.w / 2, s.y + s.h / 2, 'middle'));
  } else if (s.kind === 'text' || s.kind === 'note') {
    const hint = s.kind === 'note' ? 'Text box' : 'Text';
    g.appendChild(s.kind === 'note'
      ? textNode({ ...s, text: hint }, s.x + s.w / 2, s.y + s.h / 2, 'middle', false, true)
      : textNode({ ...s, text: hint }, s.x, s.y + CANVAS_FONT, 'start', false, true));
  }
  return g;
}

/** Half a cap height, as a fraction of the font size. */
const CAP_CENTRE = 0.35;

function textNode(s, cx, cy, anchor, badge, faded) {
  const box = bounds(s);
  const font = fontOf(s.font);
  const size = CANVAS_FONT * font.scale;
  const lineHeight = size * 1.3;
  const maxChars = Math.max(6, Math.floor((box.w - 18) / (size * 0.52)));
  const lines = wrapText(s.text, s.kind === 'arrow' ? 26 : maxChars);
  const centred = anchor === 'middle' || badge;

  /*
   * Vertical centring, done by arithmetic rather than by dominant-baseline.
   * `y` on an SVG text is its *baseline*, so centring means lifting the block
   * by half its height and then dropping the first baseline by roughly half
   * the cap height. Browsers disagree about dominant-baseline on tspans, and
   * SVG viewers that open an exported file often ignore it altogether — this
   * lands in the same place everywhere.
   */
  const blockLift = ((lines.length - 1) * lineHeight) / 2;
  const top = centred ? cy - blockLift + size * CAP_CENTRE : cy;

  const text = svgEl('text', {
    x: cx, y: top.toFixed(2),
    'text-anchor': anchor,
    fill: faded ? 'var(--ink-3)' : s.ink,
    'font-size': size.toFixed(1),
    'font-family': font.stack,
    'font-weight': s.kind === 'container' ? 600 : 400,
    class: 'label' + (badge ? ' badge' : '')
  });
  lines.forEach((line, i) => {
    text.appendChild(svgEl('tspan', { x: cx, dy: i === 0 ? 0 : lineHeight })).textContent = line;
  });
  return text;
}

function selectionLayer(chosen) {
  const g = svgEl('g', { class: 'selection', 'aria-hidden': 'true' });
  const z = scene.view.zoom;

  chosen.forEach(s => {
    const b = bounds(s);
    g.appendChild(svgEl('rect', {
      x: b.x - 5, y: b.y - 5, width: b.w + 10, height: b.h + 10, rx: 6,
      fill: 'none', 'stroke-width': 1 / z
    }));
  });

  if (chosen.length !== 1) return g;

  const s = chosen[0];
  const b = bounds(s);
  const handle = (x, y, role) => svgEl('rect', {
    x: x - 4, y: y - 4, width: 8, height: 8, rx: 2, class: 'handle', 'data-handle': role
  });

  if (s.kind === 'arrow') {
    g.appendChild(handle(s.points[0], s.points[1], 'p1'));
    g.appendChild(handle(s.points[2], s.points[3], 'p2'));
    return g;
  }

  CORNERS.forEach(role => {
    const at = cornerPoint(b, role);
    g.appendChild(handle(at.x, at.y, role));
  });

  /* Connection ports: drag one out to draw an arrow that stays attached. */
  PORTS.forEach(p => {
    const at = portPoint(s, p);
    g.appendChild(svgEl('circle', {
      cx: at.x, cy: at.y, r: 4.5, class: 'port', 'data-port': p, 'data-shape': s.id
    }));
  });
  return g;
}

const SNAP_TOL = 6;              // px on screen before a shape lines up with a neighbour

const CORNERS = ['nw', 'ne', 'se', 'sw'];
function cornerPoint(b, role) {
  return {
    x: role === 'nw' || role === 'sw' ? b.x : b.x + b.w,
    y: role === 'nw' || role === 'ne' ? b.y : b.y + b.h
  };
}

const PORTS = ['top', 'right', 'bottom', 'left'];
function portPoint(s, side) {
  const b = bounds(s);
  if (side === 'top') return { x: b.x + b.w / 2, y: b.y };
  if (side === 'bottom') return { x: b.x + b.w / 2, y: b.y + b.h };
  if (side === 'left') return { x: b.x, y: b.y + b.h / 2 };
  return { x: b.x + b.w, y: b.y + b.h / 2 };
}

/* ---------- Pointer interaction ---------- */

function inTextEditor(e) {
  return !!(e.target && e.target.closest && e.target.closest('#textEdit'));
}

function onPointerDown(e) {
  if (!scene) return;
  /* The text editor lives inside the host: never steal its clicks. */
  if (inTextEditor(e)) return;

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    drag = { mode: 'pan', originX: e.clientX, originY: e.clientY, viewX: scene.view.x, viewY: scene.view.y };
    return;
  }
  if (e.button !== 0) return;

  const point = toScene(e.clientX, e.clientY);
  const port = e.target.closest && e.target.closest('[data-port]');
  if (port) {
    const owner = shapeById(scene, port.dataset.shape);
    if (owner) {
      const start = portPoint(owner, port.dataset.port);
      drag = {
        mode: 'connect', fromId: owner.id, before: serialize(scene),
        preview: makeShape('arrow', start.x, start.y, point.x, point.y, ink, newStyle('arrow'))
      };
      drag.preview.from = owner.id;
      render();
      return;
    }
  }

  const handle = e.target.closest && e.target.closest('[data-handle]');
  const single = selection();
  if (handle && single) {
    drag = { mode: 'resize', role: handle.dataset.handle, id: single.id, before: serialize(scene) };
    return;
  }

  if (tool !== 'select') {
    /* Remember what was already here: a click (rather than a drag) on an
       existing shape should select it, not stamp a new one on top — which is
       also what lets double-click reach the text editor with a draw tool up. */
    drag = {
      mode: 'create', kind: tool, start: point, before: serialize(scene),
      over: shapeAt(scene, point.x, point.y),
      preview: makeShape(tool, snap(point.x), snap(point.y), snap(point.x), snap(point.y), ink, newStyle(tool))
    };
    return;
  }

  const hit = shapeAt(scene, point.x, point.y);
  if (hit) {
    if (e.shiftKey) {
      const next = new Set(selectedIds);
      next.has(hit.id) ? next.delete(hit.id) : next.add(hit.id);
      selectedIds = next;
    } else if (!selectedIds.has(hit.id)) {
      selectedIds = new Set([hit.id]);
    }
    const before = serialize(scene);
    if (e.altKey) {                               // alt-drag leaves the original behind
      pushHistory(before);
      selectedIds = new Set(cloneInto(selectedShapes(), 0, 0));
    }
    drag = {
      mode: 'move', origin: point, before, moved: false, applied: { x: 0, y: 0 },
      startBox: boundsOfAll(selectedShapes()),
      candidates: snapCandidates(scene, new Set(selectedIds))
    };
    render();
    onChange();
    return;
  }

  if (!e.shiftKey) selectedIds = new Set();
  drag = { mode: 'marquee', start: point, marquee: { x: point.x, y: point.y, w: 0, h: 0 } };
  render();
  onChange();
}

/** Highlight what an arrow would attach to, before the pointer is down. */
function onHover(e) {
  if (!scene || drag || tool !== 'arrow') return;
  const point = toScene(e.clientX, e.clientY);
  const target = connectTargetAt(scene, point.x, point.y, null);
  const next = target ? target.id : null;
  if (next !== hoverId) { hoverId = next; renderHoverOnly(); }
}
let hoverId = null;
function renderHoverOnly() {
  drag = drag || null;
  const svg = $('#scene');
  if (!svg) return;
  svg.querySelectorAll('.shape').forEach(g => {
    g.classList.toggle('hover-target', g.dataset.id === hoverId);
  });
}

function onPointerMove(e) {
  if (!drag || !scene) return;
  const point = toScene(e.clientX, e.clientY);

  if (drag.mode === 'pan') {
    scene.view.x = drag.viewX - (e.clientX - drag.originX) / scene.view.zoom;
    scene.view.y = drag.viewY - (e.clientY - drag.originY) / scene.view.zoom;
    render();
    return;
  }

  if (drag.mode === 'marquee') {
    drag.marquee = {
      x: Math.min(drag.start.x, point.x), y: Math.min(drag.start.y, point.y),
      w: Math.abs(point.x - drag.start.x), h: Math.abs(point.y - drag.start.y)
    };
    selectedIds = new Set(scene.shapes.filter(s => intersectsRect(s, drag.marquee)).map(s => s.id));
    render();
    onChange();
    return;
  }

  if (drag.mode === 'connect') {
    const target = connectTargetAt(scene, point.x, point.y, drag.fromId);
    drag.hoverId = target ? target.id : null;
    const from = shapeById(scene, drag.fromId);
    const end = target ? centre(target) : { x: snap(point.x), y: snap(point.y) };
    drag.preview.points = [centre(from).x, centre(from).y, end.x, end.y];
    drag.preview.to = target ? target.id : null;
    render();
    return;
  }

  if (drag.mode === 'create') {
    let x1 = point.x, y1 = point.y;
    if (e.shiftKey) {
      const fixed = drag.kind === 'arrow'
        ? constrainLine(drag.start.x, drag.start.y, x1, y1)
        : constrainBox(drag.start.x, drag.start.y, x1, y1);
      x1 = fixed.x; y1 = fixed.y;
    }
    drag.preview = makeShape(drag.kind, snap(drag.start.x), snap(drag.start.y), snap(x1), snap(y1), ink, newStyle(drag.kind));
    if (drag.kind === 'arrow') {
      const target = connectTargetAt(scene, x1, y1, null);
      drag.hoverId = target ? target.id : null;
    }
    render();
    return;
  }

  if (drag.mode === 'move') {
    let wanted = { x: point.x - drag.origin.x, y: point.y - drag.origin.y };
    if (e.shiftKey) {                             // hold shift to keep to one axis
      if (Math.abs(wanted.x) > Math.abs(wanted.y)) wanted.y = 0; else wanted.x = 0;
    }
    wanted = { x: snap(wanted.x), y: snap(wanted.y) };

    /* Alignment beats the grid: if an edge or centre is close to one on a
       neighbour, land on it exactly and show the guide. */
    const moved = {
      x: drag.startBox.x + wanted.x, y: drag.startBox.y + wanted.y,
      w: drag.startBox.w, h: drag.startBox.h
    };
    const fit = snapToGuides(moved, drag.candidates, SNAP_TOL / scene.view.zoom);
    wanted.x += fit.dx;
    wanted.y += fit.dy;
    drag.guides = fit.guides;

    const step = { x: wanted.x - drag.applied.x, y: wanted.y - drag.applied.y };
    if (!step.x && !step.y) return;
    movable().forEach(s => moveShape(scene, s, step.x, step.y));
    syncArrows(scene);
    drag.applied = wanted;
    drag.moved = true;
    render();
    return;
  }

  if (drag.mode === 'resize') {
    const shape = shapeById(scene, drag.id);
    if (!shape) return;
    if (shape.kind === 'arrow') {
      const i = drag.role === 'p1' ? 0 : 2;
      shape.points[i] = snap(point.x);
      shape.points[i + 1] = snap(point.y);
      const target = connectTargetAt(scene, point.x, point.y, shape.id);
      drag.hoverId = target ? target.id : null;
    } else {
      resizeCorner(shape, drag.role, snap(point.x), snap(point.y), e.shiftKey);
    }
    render();
  }
}

/** Drag any corner: the two edges that meet there follow the pointer. */
function resizeCorner(shape, role, x, y, square) {
  const right = shape.x + shape.w, bottom = shape.y + shape.h;
  if (role.includes('e')) shape.w = Math.max(MIN_SHAPE, x - shape.x);
  if (role.includes('s')) shape.h = Math.max(MIN_SHAPE, y - shape.y);
  if (role.includes('w')) {
    const nx = Math.min(x, right - MIN_SHAPE);
    shape.w = right - nx;
    shape.x = nx;
  }
  if (role.includes('n')) {
    const ny = Math.min(y, bottom - MIN_SHAPE);
    shape.h = bottom - ny;
    shape.y = ny;
  }
  if (square) {
    const size = Math.max(shape.w, shape.h);
    if (role.includes('w')) shape.x = right - size;
    if (role.includes('n')) shape.y = bottom - size;
    shape.w = size;
    shape.h = size;
  }
}

/** Selected shapes to move — a child whose container is also selected is skipped. */
function movable() {
  const chosen = selectedShapes();
  const ids = new Set(chosen.map(s => s.id));
  return chosen.filter(s => !(s.parent && ids.has(s.parent)));
}

function onPointerUp() {
  if (!drag || !scene) return;
  const finished = drag;
  drag = null;

  if (finished.mode === 'pan') { scheduleSave(); return; }

  if (finished.mode === 'marquee') {
    render();
    onChange();
    return;
  }

  if (finished.mode === 'connect') {
    const preview = finished.preview;
    pushHistory(finished.before);
    const arrow = makeShape('arrow', preview.points[0], preview.points[1], preview.points[2], preview.points[3], ink, newStyle('arrow'));
    arrow.from = preview.from;
    arrow.to = preview.to;
    if (!arrow.to) bindArrow(scene, arrow);
    scene.shapes.push(arrow);
    reparentAll(scene);
    syncArrows(scene);
    selectedIds = new Set([arrow.id]);
    render();
    scheduleSave();
    onChange();
    return;
  }

  if (finished.mode === 'create') {
    const b = bounds(finished.preview);
    const tiny = b.w < MIN_SHAPE && b.h < MIN_SHAPE;
    if (tiny && finished.over) {                  // a click on something: select it
      selectedIds = new Set([finished.over.id]);
      render();
      onChange();
      return;
    }
    const shape = tiny
      ? defaultSized(finished.kind, snap(finished.start.x), snap(finished.start.y), ink, newStyle(finished.kind))
      : finished.preview;
    pushHistory(finished.before);
    scene.shapes.push(shape);
    if (shape.kind === 'arrow') bindArrow(scene, shape);
    reparentAll(scene);
    syncArrows(scene);
    selectedIds = new Set([shape.id]);
    if (!toolLocked) setTool('select');
    render();
    scheduleSave();
    onChange();
    /* Only the text tool implies typing. Shapes get a label on double-click,
       Enter, or the Add text button — drawing three boxes in a row should not
       drop you into a textarea three times. */
    if (shape.kind === 'text' || shape.kind === 'note') editText(shape);
    return;
  }

  if (finished.mode === 'move' && !finished.moved) return;   // a plain click

  pushHistory(finished.before);
  selectedShapes().forEach(s => { if (s.kind === 'arrow') bindArrow(scene, s); });
  if (finished.mode === 'resize') {
    const shape = shapeById(scene, finished.id);
    if (shape && shape.kind === 'arrow') bindArrow(scene, shape);
  }
  reparentAll(scene);
  syncArrows(scene);
  render();
  scheduleSave();
  onChange();
}

addEventListener('pointermove', onPointerMove);
addEventListener('pointerup', onPointerUp);
addEventListener('pointercancel', onPointerUp);
addEventListener('keydown', e => {
  if (e.code === 'Space' || e.key === ' ') {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    spaceDown = true;
    const host = $('#canvasHost');
    if (host) host.dataset.pan = '1';
  }
});
addEventListener('keyup', e => {
  if (e.code === 'Space' || e.key === ' ') {
    spaceDown = false;
    const host = $('#canvasHost');
    if (host) delete host.dataset.pan;
  }
});

function onWheel(e) {
  if (!scene) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX, y: e.clientY });
    return;
  }
  scene.view.x += e.deltaX / scene.view.zoom;
  scene.view.y += e.deltaY / scene.view.zoom;
  render();
  scheduleSave();
}

/* ---------- Text inside shapes ---------- */

function onDoubleClick(e) {
  if (!scene || inTextEditor(e)) return;
  const point = toScene(e.clientX, e.clientY);
  const hit = shapeAt(scene, point.x, point.y);

  if (!hit) {
    /* Double-clicking nothing means "I want to write here". */
    commit(() => {
      const note = defaultSized('note', snap(point.x), snap(point.y), ink, newStyle('note'));
      scene.shapes.push(note);
      reparentAll(scene);
      selectedIds = new Set([note.id]);
      editText(note);
    });
    return;
  }
  selectedIds = new Set([hit.id]);
  render();
  editText(hit);
}

/**
 * Edit a shape's text in a textarea floated over it.
 *
 * Focus is taken on the next frame: the click that opened the editor is still
 * being dispatched, and focusing inside it would be undone immediately.
 */
export function editText(shape) {
  if (!shape || !scene) return;
  const wrap = $('#textEdit');
  const area = $('#textEditArea');
  const b = bounds(shape);
  const z = scene.view.zoom;
  const font = fontOf(shape.font);

  /* An arrow has no interior, so its label is edited over its midpoint. */
  const box = shape.kind === 'arrow'
    ? { x: b.x + b.w / 2 - 80, y: b.y + b.h / 2 - 20, w: 160, h: 40 }
    : b;
  const left = (box.x - scene.view.x) * z;
  const top = (box.y - scene.view.y) * z;
  const isLabel = shape.kind === 'container';

  wrap.hidden = false;
  wrap.dataset.kind = shape.kind;
  wrap.style.left = Math.round(left) + 'px';
  wrap.style.top = Math.round(isLabel ? top + 4 : top) + 'px';
  wrap.style.width = Math.round(Math.max(130, box.w * z)) + 'px';
  wrap.style.height = Math.round(Math.max(36, (isLabel ? 36 : box.h) * z)) + 'px';
  area.style.fontFamily = font.stack;
  area.style.fontSize = (CANVAS_FONT * font.scale * Math.min(z, 1.6)).toFixed(1) + 'px';
  area.style.lineHeight = '1.3';
  area.style.textAlign = isCentred(shape.kind) ? 'center' : 'left';
  centreTextArea(area, isCentred(shape.kind));
  area.value = shape.text || '';
  area.dataset.shapeId = shape.id;
  textOpenedAt = Date.now();

  requestAnimationFrame(() => {
    if ($('#textEdit').hidden) return;
    area.focus();
    area.select();
  });
}

/**
 * Vertically centre what is being typed inside the editor box.
 *
 * A textarea cannot centre its own content: `align-content` only landed in
 * very recent browsers, and there is no vertical equivalent of text-align. So
 * measure the content and pad the top by half the slack — which also keeps the
 * caret exactly where the finished text will be drawn.
 */
export function centreTextArea(area, centred) {
  if (!area) return;
  area.style.paddingTop = '0px';
  if (!centred) return;
  const content = area.scrollHeight || 0;
  const boxHeight = area.clientHeight || 0;
  const slack = boxHeight - content;
  if (slack > 2) area.style.paddingTop = Math.floor(slack / 2) + 'px';
}

export function hideTextEditor() {
  const wrap = $('#textEdit');
  if (wrap) wrap.hidden = true;
}

/** Re-centre as the text changes; wired to the textarea's input event. */
export function onTextInput() {
  const wrap = $('#textEdit');
  const area = $('#textEditArea');
  if (!wrap || wrap.hidden || !area || !scene) return;
  const shape = shapeById(scene, area.dataset.shapeId);
  centreTextArea(area, !!shape && isCentred(shape.kind));
}

export function commitText() {
  const wrap = $('#textEdit');
  const area = $('#textEditArea');
  if (!wrap || wrap.hidden || !area || !scene) return;
  const shape = shapeById(scene, area.dataset.shapeId);
  const value = area.value;
  hideTextEditor();
  if (!shape) return;

  /* An empty text shape is invisible — drop it rather than leave a ghost. */
  if ((shape.kind === 'text' || shape.kind === 'note') && !value.trim() && !shape.textEverSet) {
    commit(() => {
      scene.shapes = scene.shapes.filter(s => s.id !== shape.id);
      selectedIds.delete(shape.id);
    });
    return;
  }
  if (shape.text === value) return;
  commit(() => {
    shape.text = value;
    growToFit(shape);
  });
}

/** Give a shape the height its text needs, never taking any away. */
function growToFit(shape) {
  if (shape.kind === 'arrow' || !shape.text) return;
  const font = fontOf(shape.font);
  const size = CANVAS_FONT * font.scale;
  const maxChars = Math.max(6, Math.floor((shape.w - 18) / (size * 0.52)));
  const lines = wrapText(shape.text, maxChars);
  const needed = textHeight(shape, size, lines.length);
  if (needed > shape.h) shape.h = needed;
}

/** A blur in the first moments after opening means focus was stolen, not given up. */
export function onTextBlur() {
  const area = $('#textEditArea');
  if (!area || $('#textEdit').hidden) return;
  if (Date.now() - textOpenedAt < 250) { area.focus(); return; }
  commitText();
}

export function isEditingText() {
  const wrap = $('#textEdit');
  return !!wrap && !wrap.hidden;
}

/** Edit the selected shape's text — the toolbar and Enter both land here. */
export function editSelectionText() {
  const shape = selection();
  if (!shape) { toast('Select one shape first, then add text.'); return; }
  editText(shape);
}

/* ---------- Commands ---------- */

export function deleteSelection() {
  const chosen = selectedShapes();
  if (!chosen.length) return;
  const containers = chosen.filter(s => s.kind === 'container').length;
  commit(() => {
    const doomed = new Set(chosen.map(s => s.id));
    chosen.filter(s => s.kind === 'container').forEach(c => {
      scene.shapes.filter(s => s.parent === c.id).forEach(s => doomed.add(s.id));
    });
    scene.shapes = scene.shapes.filter(s => !doomed.has(s.id));
    scene.shapes.forEach(s => {
      if (s.kind === 'arrow') {
        if (doomed.has(s.from)) s.from = null;
        if (doomed.has(s.to)) s.to = null;
      }
    });
    syncArrows(scene);
    selectedIds = new Set();
  });
  toast(containers ? 'Container and its contents deleted.' : 'Deleted.');
}

/** ⌘C — keep a deep copy of the selection, and offer it to the system too. */
export function copySelection() {
  const chosen = selectedShapes();
  if (!chosen.length) return false;
  clipboard = JSON.parse(JSON.stringify(chosen));
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(JSON.stringify({ type: 'folio-shapes', shapes: clipboard })).catch(() => {});
    }
  } catch (err) { /* clipboard permission — the internal copy still works */ }
  onChange();
  return true;
}

export function cutSelection() {
  if (!copySelection()) return;
  deleteSelection();
}

/** ⌘V — paste the clipboard, offset a little, with its internal links intact. */
export async function pasteClipboard() {
  if (!scene) return;
  let items = clipboard;
  if (!items.length) {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text);
      if (data && data.type === 'folio-shapes' && Array.isArray(data.shapes)) items = data.shapes;
    } catch (err) { /* nothing usable on the system clipboard */ }
  }
  if (!items || !items.length) { toast('Nothing copied yet.'); return; }
  commit(() => {
    selectedIds = new Set(cloneInto(items, 24, 24));
  });
}

/** Copy shapes into the scene with fresh ids, remapping links among them. */
function cloneInto(items, dx, dy) {
  const map = new Map();
  const copies = items.map(s => {
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    map.set(s.id, copy.id);
    return copy;
  });
  copies.forEach(c => {
    c.parent = (c.parent && map.has(c.parent)) ? map.get(c.parent) : null;
    if (c.kind === 'arrow') {
      c.from = map.get(c.from) || null;
      c.to = map.get(c.to) || null;
    }
    moveShape(scene, c, dx, dy);
    scene.shapes.push(c);
  });
  syncArrows(scene);
  return copies.map(c => c.id);
}

export function duplicateSelection() {
  const chosen = selectedShapes();
  if (!chosen.length) return;
  commit(() => { selectedIds = new Set(cloneInto(chosen, 24, 24)); });
}

/** Bring the selection to the front, or send it to the back. */
export function reorderSelection(toFront) {
  const chosen = selectedShapes();
  if (!chosen.length) return;
  commit(() => {
    const ids = new Set(chosen.map(s => s.id));
    const rest = scene.shapes.filter(s => !ids.has(s.id));
    scene.shapes = toFront ? rest.concat(chosen) : chosen.concat(rest);
  });
}

export function nudgeSelection(dx, dy) {
  if (!selectedIds.size) return;
  commit(() => { movable().forEach(s => moveShape(scene, s, dx, dy)); syncArrows(scene); });
}

/** Detach the selected arrows from the shapes they are bound to. */
export function detachSelection() {
  const arrows = selectedShapes().filter(s => s.kind === 'arrow' && (s.from || s.to));
  if (!arrows.length) { toast('Select an attached arrow first.'); return; }
  commit(() => {
    arrows.forEach(a => {
      const [p1, p2] = arrowEnds(scene, a);
      a.points = [p1.x, p1.y, p2.x, p2.y];
      a.from = null;
      a.to = null;
    });
  });
  toast(arrows.length === 1 ? 'Arrow detached.' : 'Arrows detached.');
}

/* ---------- Export ---------- */

/** Serialise the drawing to a standalone SVG, framed to its contents. */
export function toSVG() {
  if (!scene) return '';
  const b = sceneBounds(scene, 32);
  const svg = svgEl('svg', {
    xmlns: NS, width: Math.round(b.w), height: Math.round(b.h),
    viewBox: [b.x, b.y, b.w, b.h].join(' ')
  });
  svg.appendChild(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: '#ffffff' }));
  const style = document.createElementNS(NS, 'style');
  style.textContent = '.label{font-family:Inter,-apple-system,"Segoe UI",Helvetica,sans-serif}' +
    '.hit{stroke:none;fill:none}';
  svg.appendChild(style);
  const saved = drag;
  drag = null;                                  // never export a drag preview
  drawOrder(scene).forEach(s => svg.appendChild(shapeNode(s)));
  drag = saved;
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Rasterise the SVG to a PNG blob, for pasting into somewhere that cannot
 * take an SVG. Resolves null where the browser has no canvas support.
 */
export function toPNG(scale) {
  if (!scene) return Promise.resolve(null);
  const b = sceneBounds(scene, 32);
  const factor = scale || 2;
  const markup = toSVG();
  return new Promise(resolve => {
    let canvas;
    try {
      canvas = document.createElement('canvas');
      canvas.width = Math.round(b.w * factor);
      canvas.height = Math.round(b.h * factor);
    } catch (err) { resolve(null); return; }
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) { resolve(null); return; }

    const img = new Image();
    img.onload = () => {
      try {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob ? canvas.toBlob(resolve, 'image/png') : resolve(null);
      } catch (err) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  });
}

export { serialize as toJSON };
export const inks = () => INKS;
export const shapeCount = () => (scene ? scene.shapes.length : 0);
