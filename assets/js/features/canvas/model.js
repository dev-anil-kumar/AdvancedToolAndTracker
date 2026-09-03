/**
 * The drawing model: plain data, and the geometry that operates on it.
 *
 * A scene is `{ id, name, shapes: [...], view: {x, y, zoom} }` and a shape is
 * one of five kinds:
 *
 *   rect · ellipse · container   x, y, w, h, text, ink, parent
 *   arrow                        points [x1,y1,x2,y2], from, to, ink
 *   text                         x, y, w, h, text, ink, parent
 *
 * `parent` is a container id: moving a container moves everything whose centre
 * sits inside it. `from`/`to` bind an arrow's ends to shapes, so the arrow
 * follows them around. No DOM here — the editor renders, this file computes.
 */
import {
  DEFAULT_FILLS, DEFAULT_SHAPE_H, DEFAULT_SHAPE_W, FILL_ALPHA, FONTS, INKS, SNAP
} from '../../core/config.js';
import { uid } from '../../core/dom.js';

export const KINDS = ['rect', 'ellipse', 'arrow', 'text', 'note', 'container'];
export const BOXY = ['rect', 'ellipse', 'container', 'text', 'note'];

/** Tool shortcuts. */
export const SHORTCUTS = {
  v: 'select', r: 'rect', c: 'ellipse', a: 'arrow', t: 'text', n: 'note', f: 'container'
};

/** Kinds whose text sits in the middle of the shape. */
export const CENTRED = ['rect', 'ellipse', 'note', 'arrow'];
export const isCentred = (kind) => CENTRED.includes(kind);

/** Resolve a background key to a paintable colour. */
export function fillColour(key) {
  if (!key || key === 'none') return 'none';
  const found = INKS.find(i => i.key === key);
  if (!found) return 'none';
  const n = parseInt(found.hex.replace('#', ''), 16);
  return 'rgba(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',') + ',' + FILL_ALPHA + ')';
}

export function fontOf(key) {
  return FONTS.find(f => f.key === key) || FONTS[0];
}

export const isBoxy = (s) => BOXY.includes(s.kind);
export const snap = (v) => Math.round(v / SNAP) * SNAP;

export function newScene(name) {
  return { id: uid(), name: name || 'Untitled drawing', shapes: [], view: { x: -80, y: -60, zoom: 1 } };
}

export function shapeById(scene, id) {
  return id ? (scene.shapes.find(s => s.id === id) || null) : null;
}

/** A shape from a drag, normalised so width and height are positive. */
export function makeShape(kind, x0, y0, x1, y1, ink, style) {
  const base = {
    id: uid(), kind, ink, text: '', parent: null,
    fill: (style && style.fill) || DEFAULT_FILLS[kind] || 'none',
    font: (style && style.font) || 'sans'
  };
  if (kind === 'arrow') return { ...base, points: [x0, y0, x1, y1], from: null, to: null };
  return {
    ...base,
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0)
  };
}

/** A click rather than a drag still deserves a shape, at a sensible size. */
export function defaultSized(kind, x, y, ink, style) {
  if (kind === 'arrow') return makeShape('arrow', x, y, x + DEFAULT_SHAPE_W, y, ink, style);
  const w = kind === 'text' ? 160 : (kind === 'note' ? 200 : (kind === 'container' ? DEFAULT_SHAPE_W * 2 : DEFAULT_SHAPE_W));
  const h = kind === 'text' ? 30 : (kind === 'note' ? 90 : (kind === 'container' ? DEFAULT_SHAPE_H * 2 : DEFAULT_SHAPE_H));
  return makeShape(kind, x - w / 2, y - h / 2, x + w / 2, y + h / 2, ink, style);
}

export function bounds(s) {
  if (s.kind === 'arrow') {
    const [x1, y1, x2, y2] = s.points;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

export function centre(s) {
  const b = bounds(s);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function hitTest(s, px, py, slack) {
  const pad = slack || 0;
  if (s.kind === 'arrow') {
    const [x1, y1, x2, y2] = s.points;
    return distanceToSegment(px, py, x1, y1, x2, y2) <= (pad || 8);
  }
  if (s.kind === 'ellipse') {
    const c = centre(s), rx = s.w / 2 + pad, ry = s.h / 2 + pad;
    if (!rx || !ry) return false;
    const dx = (px - c.x) / rx, dy = (py - c.y) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return px >= s.x - pad && px <= s.x + s.w + pad && py >= s.y - pad && py <= s.y + s.h + pad;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Containers paint first, so their children sit on top of them. */
export function drawOrder(scene) {
  const containers = scene.shapes.filter(s => s.kind === 'container');
  return containers.concat(scene.shapes.filter(s => s.kind !== 'container'));
}

/** The topmost shape under a point; a container loses to its own children. */
export function shapeAt(scene, x, y) {
  const ordered = drawOrder(scene);
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (hitTest(ordered[i], x, y)) return ordered[i];
  }
  return null;
}

/* ---------- Containers ---------- */

export function childrenOf(scene, containerId) {
  return scene.shapes.filter(s => s.parent === containerId);
}

/** The smallest container holding a point, ignoring one shape. */
export function containerAt(scene, x, y, exceptId) {
  return scene.shapes
    .filter(s => s.kind === 'container' && s.id !== exceptId && hitTest(s, x, y))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
}

/**
 * Re-home a shape: whichever container its centre falls into now owns it.
 * Containers never nest — one level is the whole point of keeping this simple.
 */
export function reparent(scene, shape) {
  if (shape.kind === 'container') return;
  const c = centre(shape);
  const owner = containerAt(scene, c.x, c.y, shape.id);
  shape.parent = owner ? owner.id : null;
}

/**
 * Re-home every shape at once. Called after anything that can change what sits
 * inside what: drawing a container around existing shapes, moving a container
 * over them, resizing one, or dragging a shape out of one.
 */
export function reparentAll(scene) {
  scene.shapes.forEach(s => { if (s.kind !== 'container') reparent(scene, s); });
}

/** Move a shape — and, for a container, everything inside it. */
export function moveShape(scene, shape, dx, dy) {
  translate(shape, dx, dy);
  if (shape.kind === 'container') {
    childrenOf(scene, shape.id).forEach(child => translate(child, dx, dy));
  }
}

function translate(s, dx, dy) {
  if (s.kind === 'arrow') {
    s.points = [s.points[0] + dx, s.points[1] + dy, s.points[2] + dx, s.points[3] + dy];
  } else {
    s.x += dx;
    s.y += dy;
  }
}

/* ---------- Arrows ---------- */

/**
 * What an arrow end would attach to at this point. A real shape always wins
 * over a container, so dropping an end inside a container still connects to
 * the box you aimed at.
 */
export function connectTargetAt(scene, x, y, exceptId) {
  const candidates = scene.shapes.filter(s =>
    s.id !== exceptId && s.kind !== 'arrow' && hitTest(s, x, y, 6));
  return candidates.find(s => s.kind !== 'container') || candidates[0] || null;
}

/** Bind an arrow's ends to whatever shapes they were dropped on. */
export function bindArrow(scene, arrow) {
  const [x1, y1, x2, y2] = arrow.points;
  const from = connectTargetAt(scene, x1, y1, arrow.id);
  const to = connectTargetAt(scene, x2, y2, arrow.id);
  arrow.from = from ? from.id : null;
  arrow.to = (to && (!from || to.id !== from.id)) ? to.id : null;
}

/**
 * Where an arrow actually starts and ends: a bound end is pulled to the border
 * of its shape, so the line touches without overlapping.
 */
export function arrowEnds(scene, arrow) {
  const [x1, y1, x2, y2] = arrow.points;
  const from = shapeById(scene, arrow.from);
  const to = shapeById(scene, arrow.to);
  let a = { x: x1, y: y1 };
  let b = { x: x2, y: y2 };
  if (from) a = borderPoint(from, to ? centre(to) : b);
  if (to) b = borderPoint(to, from ? centre(from) : a);
  return [a, b];
}

/**
 * Pull every bound arrow's stored points onto the ends it is actually drawn
 * with. Without this an attached arrow keeps the two shape centres as its
 * geometry, so its clickable line runs through the middle of both shapes and
 * steals their clicks. Call after anything that moves or resizes a shape.
 */
export function syncArrows(scene) {
  scene.shapes.forEach(a => {
    if (a.kind !== 'arrow' || (!a.from && !a.to)) return;
    const [p1, p2] = arrowEnds(scene, a);
    a.points = [p1.x, p1.y, p2.x, p2.y];
  });
}

/** The point on a shape's border, on the ray from its centre towards a point. */
export function borderPoint(s, towards) {
  const c = centre(s);
  const dx = towards.x - c.x, dy = towards.y - c.y;
  if (!dx && !dy) return c;
  if (s.kind === 'ellipse') {
    const rx = (s.w / 2) || 1, ry = (s.h / 2) || 1;
    const k = 1 / Math.hypot(dx / rx, dy / ry);
    return { x: c.x + dx * k, y: c.y + dy * k };
  }
  const hw = (s.w || 1) / 2, hh = (s.h || 1) / 2;
  const scale = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

/** Does a shape overlap a rectangle? Used by marquee selection. */
export function intersectsRect(s, rect) {
  const b = bounds(s);
  return b.x < rect.x + rect.w && b.x + b.w > rect.x &&
         b.y < rect.y + rect.h && b.y + b.h > rect.y;
}

/** Hold shift while drawing: a perfect square or circle. */
export function constrainBox(x0, y0, x1, y1) {
  const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return {
    x: x0 + Math.sign(x1 - x0 || 1) * size,
    y: y0 + Math.sign(y1 - y0 || 1) * size
  };
}

/** Hold shift while drawing an arrow: snap it to the nearest 45°. */
export function constrainLine(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: x0 + Math.cos(angle) * len, y: y0 + Math.sin(angle) * len };
}

/* ---------- Alignment snapping ---------- */

/**
 * The lines worth snapping to: every other shape's edges and centres.
 * `skip` is the set of ids being dragged, which must not snap to themselves.
 */
export function snapCandidates(scene, skip) {
  const xs = [], ys = [];
  scene.shapes.forEach(s => {
    if (skip.has(s.id)) return;
    const b = bounds(s);
    xs.push({ v: b.x, from: b }, { v: b.x + b.w / 2, from: b }, { v: b.x + b.w, from: b });
    ys.push({ v: b.y, from: b }, { v: b.y + b.h / 2, from: b }, { v: b.y + b.h, from: b });
  });
  return { xs, ys };
}

/**
 * Nudge a box onto the nearest alignment line within `tol`, and report the
 * guides that matched so the editor can draw them. Edges and centres both
 * count, which is what makes a row of boxes line up without any effort.
 */
export function snapToGuides(box, candidates, tol) {
  const result = { dx: 0, dy: 0, guides: [] };
  const edgesX = [box.x, box.x + box.w / 2, box.x + box.w];
  const edgesY = [box.y, box.y + box.h / 2, box.y + box.h];

  let bestX = null;
  candidates.xs.forEach(c => {
    edgesX.forEach(e => {
      const d = c.v - e;
      if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, v: c.v, from: c.from };
    });
  });
  let bestY = null;
  candidates.ys.forEach(c => {
    edgesY.forEach(e => {
      const d = c.v - e;
      if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, v: c.v, from: c.from };
    });
  });

  if (bestX) { result.dx = bestX.d; result.guides.push({ axis: 'x', v: bestX.v, from: bestX.from }); }
  if (bestY) { result.dy = bestY.d; result.guides.push({ axis: 'y', v: bestY.v, from: bestY.from }); }
  return result;
}

/** The box that encloses a set of shapes. */
export function boundsOfAll(shapes) {
  if (!shapes.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  shapes.forEach(s => {
    const b = bounds(s);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  });
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** How tall a shape must be for its text to fit. */
export function textHeight(shape, fontSize, lineCount) {
  const pad = shape.kind === 'container' ? 30 : 22;
  return Math.ceil(lineCount * fontSize * 1.3 + pad);
}

/* ---------- Text ---------- */

/** Greedy wrap, honouring explicit newlines. */
export function wrapText(text, maxChars) {
  const lines = [];
  String(text || '').split('\n').forEach(raw => {
    if (raw.length <= maxChars) { lines.push(raw); return; }
    let line = '';
    raw.split(/\s+/).forEach(word => {
      if (!line) line = word;
      else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
      else { lines.push(line); line = word; }
    });
    lines.push(line);
  });
  return lines;
}

/* ---------- Serialisation ---------- */

export const FILE_TYPE = 'folio-drawing';
export const FILE_VERSION = 1;

export function serialize(scene) {
  return JSON.stringify({
    type: FILE_TYPE,
    version: FILE_VERSION,
    name: scene.name,
    shapes: scene.shapes,
    view: scene.view
  }, null, 2);
}

/** Parse an exported drawing. Throws something readable on anything else. */
export function parseScene(json, fallbackName) {
  let data;
  try { data = JSON.parse(json); }
  catch (err) { throw new Error('That file isn’t valid JSON.'); }
  if (!data || data.type !== FILE_TYPE || !Array.isArray(data.shapes)) {
    throw new Error('That doesn’t look like a Folio drawing.');
  }
  const shapes = data.shapes.filter(s => s && KINDS.includes(s.kind)).map(s => ({
    id: s.id || uid(),
    kind: s.kind,
    ink: s.ink || '#3d4650',
    text: typeof s.text === 'string' ? s.text : '',
    parent: s.parent || null,
    fill: s.fill || DEFAULT_FILLS[s.kind] || 'none',
    font: fontOf(s.font).key,
    ...(s.kind === 'arrow'
      ? { points: (s.points || [0, 0, 60, 0]).map(Number), from: s.from || null, to: s.to || null }
      : { x: Number(s.x) || 0, y: Number(s.y) || 0, w: Number(s.w) || 60, h: Number(s.h) || 40 })
  }));

  const ids = new Set(shapes.map(s => s.id));
  shapes.forEach(s => {                        // drop dangling references
    if (s.parent && !ids.has(s.parent)) s.parent = null;
    if (s.kind === 'arrow') {
      if (s.from && !ids.has(s.from)) s.from = null;
      if (s.to && !ids.has(s.to)) s.to = null;
    }
  });

  return {
    id: uid(),
    name: String(data.name || fallbackName || 'Imported drawing').slice(0, 90),
    shapes,
    view: (data.view && typeof data.view.zoom === 'number') ? data.view : { x: -80, y: -60, zoom: 1 }
  };
}

/** The bounding box of everything, padded. Used to frame and to export. */
export function sceneBounds(scene, pad) {
  const p = pad == null ? 40 : pad;
  if (!scene.shapes.length) return { x: -320, y: -200, w: 640, h: 400 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  scene.shapes.forEach(s => {
    const b = bounds(s);
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  });
  return { x: minX - p, y: minY - p, w: (maxX - minX) + p * 2, h: (maxY - minY) + p * 2 };
}
