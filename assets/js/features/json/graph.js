/**
 * The graph: the document drawn as a map.
 *
 * The tree answers "what is in this field"; the graph answers "what shape is
 * this thing" — how wide, how deep, where the weight sits, which branches are
 * really documents smuggled through a string. It is the view you want when the
 * payload is unfamiliar and you do not yet know what to ask.
 *
 * A tidy left-to-right layout: x is the depth, y is assigned by walking the
 * visible leaves in order and giving each one a slot, with every parent centred
 * on its children. Only what is open is laid out, a branch draws at most
 * GRAPH_FANOUT children before offering the rest, and the whole thing stops at
 * GRAPH_MAX_NODES — a map of a thousand boxes is not a map.
 *
 * Sizing comes from the viewBox rather than the host's measurements, so the
 * drawing fits whatever space it is given without having to measure anything.
 */
import {
  GRAPH_FANOUT, GRAPH_GAP_X, GRAPH_GAP_Y, GRAPH_MAX_NODES, GRAPH_NODE_H, GRAPH_NODE_W,
  GRAPH_ZOOM_MAX, GRAPH_ZOOM_MIN
} from '../../core/config.js';
import { clamp } from '../../core/dom.js';
import {
  PATH_SEP, childrenOf, embedded, isBranch, matchPaths, pathKey, pathString, peek, summarise, typeOf
} from './model.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const node = document.createElementNS(NS, tag);
  Object.keys(attrs || {}).forEach(k => node.setAttribute(k, String(attrs[k])));
  return node;
};
const PAD = 26;
/* Characters that fit, at the 11px monospace the labels are drawn in. */
const KEY_CHARS = 17;
const VAL_CHARS = 18;
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

export function createGraph(opts) {
  const host = opts.host;
  const onSelect = opts.onSelect || (() => {});
  const onReveal = opts.onReveal || (() => {});

  let rootValue = null;
  let open = new Set();
  let fanout = new Map();          // path → how many children it is showing
  let keep = null;                 // paths a search left visible, or null
  let hits = 0;
  let selected = null;
  let drawn = { nodes: [], links: [], bounds: null, stopped: false };
  let zoom = 1;
  let centre = { x: 0, y: 0 };
  let svg = null;

  const shownFor = (key) => fanout.get(key) || GRAPH_FANOUT;
  const visible = (item) => !keep || keep.has(pathKey(item.segments));

  /* ---------- Layout ---------- */

  function layout() {
    const nodes = [], links = [];
    let cursor = 0;
    let stopped = false;

    function place(item, depth) {
      if (nodes.length >= GRAPH_MAX_NODES) { stopped = true; return null; }
      const key = pathKey(item.segments);
      const { branch, children } = childrenOf(item.value, item.segments);
      const kids = children.filter(visible);
      const expandable = !!branch && kids.length > 0;
      const isOpen = expandable && open.has(key);
      const rec = {
        key, item, depth, branch, expandable, open: isOpen,
        count: kids.length,
        embed: typeof item.value === 'string' && embedded(item.value) !== undefined,
        x: depth * (GRAPH_NODE_W + GRAPH_GAP_X),
        y: 0
      };
      nodes.push(rec);

      if (!isOpen) {
        rec.y = cursor;
        cursor += GRAPH_NODE_H + GRAPH_GAP_Y;
        return rec;
      }

      const limit = shownFor(key);
      const placed = [];
      for (const child of kids.slice(0, limit)) {
        const made = place(child, depth + 1);
        if (made) placed.push(made);
      }
      if (kids.length > limit) {
        const rest = {
          key: key + PATH_SEP + '+', more: kids.length - limit, forPath: key,
          depth: depth + 1, x: (depth + 1) * (GRAPH_NODE_W + GRAPH_GAP_X), y: cursor
        };
        cursor += GRAPH_NODE_H + GRAPH_GAP_Y;
        nodes.push(rest);
        placed.push(rest);
      }
      placed.forEach(child => links.push({ from: rec, to: child }));
      if (placed.length) {
        rec.y = (placed[0].y + placed[placed.length - 1].y) / 2;
      } else {
        rec.y = cursor;
        cursor += GRAPH_NODE_H + GRAPH_GAP_Y;
      }
      return rec;
    }

    if (rootValue !== null && rootValue !== undefined) {
      place({ key: '$', value: rootValue, segments: [] }, 0);
    }

    const bounds = nodes.length ? {
      x: -PAD,
      y: Math.min(...nodes.map(n => n.y)) - PAD,
      w: Math.max(...nodes.map(n => n.x)) + GRAPH_NODE_W + PAD * 2,
      h: Math.max(...nodes.map(n => n.y)) + GRAPH_NODE_H + PAD * 2 - Math.min(...nodes.map(n => n.y))
    } : { x: 0, y: 0, w: 100, h: 100 };

    return { nodes, links, bounds, stopped };
  }

  /* ---------- Drawing ---------- */

  function draw() {
    drawn = layout();
    host.innerHTML = '';
    svg = svgEl('svg', {
      class: 'jg',
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'A map of the document'
    });
    host.appendChild(svg);

    const linkLayer = svgEl('g', { class: 'jg-links' });
    const nodeLayer = svgEl('g', { class: 'jg-nodes' });
    svg.append(linkLayer, nodeLayer);

    drawn.links.forEach(link => linkLayer.appendChild(linkPath(link)));
    drawn.nodes.forEach(rec => nodeLayer.appendChild(rec.more ? moreNode(rec) : nodeGroup(rec)));

    applyView();
  }

  function linkPath({ from, to }) {
    const x1 = from.x + GRAPH_NODE_W, y1 = from.y + GRAPH_NODE_H / 2;
    const x2 = to.x, y2 = to.y + GRAPH_NODE_H / 2;
    const mid = x1 + (x2 - x1) / 2;
    return svgEl('path', {
      class: 'jg-link',
      d: 'M' + x1 + ' ' + y1 + 'C' + mid + ' ' + y1 + ' ' + mid + ' ' + y2 + ' ' + x2 + ' ' + y2
    });
  }

  function nodeGroup(rec) {
    const item = rec.item;
    const t = typeOf(item.value);
    const g = svgEl('g', {
      class: 'jg-node' + (rec.embed ? ' embed' : '') + (selected === rec.key ? ' sel' : ''),
      transform: 'translate(' + rec.x + ' ' + rec.y + ')',
      'data-type': rec.embed ? 'embed' : t,
      'data-depth': rec.depth,
      tabindex: '0',
      role: 'button',
      'aria-label': label(rec) + (rec.expandable ? (rec.open ? ', open' : ', closed') : '')
    });
    g._rec = rec;

    /* Labels are cut to fit the box, so the whole of it lives in a <title> —
       the browser's own tooltip, no JavaScript involved. */
    const full = svgEl('title');
    full.textContent = label(rec);
    g.appendChild(full);

    g.appendChild(svgEl('rect', {
      class: 'jg-box', x: 0, y: 0, width: GRAPH_NODE_W, height: GRAPH_NODE_H, rx: 7
    }));
    g.appendChild(svgEl('circle', { class: 'jg-dot', cx: 13, cy: GRAPH_NODE_H / 2, r: 3.5 }));

    const key = svgEl('text', { class: 'jg-key', x: 24, y: GRAPH_NODE_H / 2 + 4 });
    key.textContent = cut(rec.depth === 0 ? '$' : String(item.key), KEY_CHARS);
    g.appendChild(key);

    const right = rec.expandable ? GRAPH_NODE_W - 26 : GRAPH_NODE_W - 10;
    const value = svgEl('text', { class: 'jg-val', x: right, y: GRAPH_NODE_H / 2 + 4, 'text-anchor': 'end' });
    value.textContent = cut(valueText(rec), VAL_CHARS);
    g.appendChild(value);

    if (rec.expandable) {
      g.appendChild(svgEl('circle', {
        class: 'jg-twist', cx: GRAPH_NODE_W - 14, cy: GRAPH_NODE_H / 2, r: 8
      }));
      const sign = svgEl('text', {
        class: 'jg-sign', x: GRAPH_NODE_W - 14, y: GRAPH_NODE_H / 2 + 3.5, 'text-anchor': 'middle'
      });
      sign.textContent = rec.open ? '−' : '+';
      g.appendChild(sign);
    }

    g.addEventListener('click', () => activate(rec));
    g.addEventListener('dblclick', () => onReveal(item.segments));
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(rec); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); onReveal(item.segments); }
    });
    return g;
  }

  function moreNode(rec) {
    const g = svgEl('g', {
      class: 'jg-node more',
      transform: 'translate(' + rec.x + ' ' + rec.y + ')',
      tabindex: '0',
      role: 'button',
      'aria-label': 'Show ' + rec.more + ' more'
    });
    g._rec = rec;
    g.appendChild(svgEl('rect', {
      class: 'jg-box', x: 0, y: 0, width: GRAPH_NODE_W, height: GRAPH_NODE_H, rx: 7
    }));
    const text = svgEl('text', { class: 'jg-more-text', x: GRAPH_NODE_W / 2, y: GRAPH_NODE_H / 2 + 4, 'text-anchor': 'middle' });
    text.textContent = '+ ' + rec.more + ' more';
    g.appendChild(text);
    const grow = () => {
      fanout.set(rec.forPath, shownFor(rec.forPath) + GRAPH_FANOUT);
      draw();
    };
    g.addEventListener('click', grow);
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); grow(); } });
    return g;
  }

  /** A branch says what it holds; a leaf says what it is. */
  function valueText(rec) {
    if (rec.embed) return summarise(childrenOf(rec.item.value, rec.item.segments).branch);
    if (isBranch(rec.item.value)) return summarise(rec.item.value);
    return rec.item.value === null ? 'null' : peek(rec.item.value, 60);
  }
  const label = (rec) => (rec.depth === 0 ? 'root' : String(rec.item.key)) + ': ' + valueText(rec);

  /** Clicking a node opens it if it can open, and always selects it. */
  function activate(rec) {
    if (rec.expandable) {
      if (open.has(rec.key)) open.delete(rec.key);
      else open.add(rec.key);
    }
    selected = rec.key;
    const held = keepCentre(rec);
    draw();
    if (held) restoreCentre(held, rec.key);
    onSelect({
      path: pathString(rec.item.segments),
      value: rec.item.value,
      type: rec.embed ? 'embedded document' : typeOf(rec.item.value)
    });
  }

  /* Opening a branch moves everything below it; holding the clicked node still
     is what keeps the map from jumping out from under the pointer. */
  const keepCentre = (rec) => ({ dx: rec.x - centre.x, dy: rec.y - centre.y });
  function restoreCentre(held, key) {
    const found = drawn.nodes.find(n => n.key === key);
    if (!found) return;
    centre = { x: found.x - held.dx, y: found.y - held.dy };
    applyView();
  }

  /* ---------- View: fit, zoom, pan ---------- */

  function applyView() {
    if (!svg) return;
    const b = drawn.bounds;
    const w = b.w / zoom, h = b.h / zoom;
    svg.setAttribute('viewBox', (centre.x - w / 2) + ' ' + (centre.y - h / 2) + ' ' + w + ' ' + h);
  }

  function fit() {
    const b = drawn.bounds;
    zoom = 1;
    centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    applyView();
  }

  function zoomBy(factor) {
    zoom = clamp(zoom * factor, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX);
    applyView();
  }

  /** Pixels of pointer travel, in scene units. */
  function perPixel() {
    const box = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null;
    const width = box && box.width ? box.width : 1000;
    return (drawn.bounds.w / zoom) / width;
  }

  host.addEventListener('pointerdown', e => {
    if (e.target.closest && e.target.closest('.jg-node')) return;   // nodes take their own clicks
    const scale = perPixel();
    const from = { x: e.clientX, y: e.clientY, cx: centre.x, cy: centre.y };
    host.classList.add('panning');
    const move = (ev) => {
      centre = { x: from.cx - (ev.clientX - from.x) * scale, y: from.cy - (ev.clientY - from.y) * scale };
      applyView();
    };
    const up = () => {
      host.classList.remove('panning');
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  host.addEventListener('wheel', e => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  /* ---------- Opening ---------- */

  function openToDepth(depth) {
    open = new Set();
    (function walk(item, level) {
      if (level >= depth) return;
      const { branch, children } = childrenOf(item.value, item.segments);
      if (!branch) return;
      open.add(pathKey(item.segments));
      children.forEach(child => walk(child, level + 1));
    })({ key: '$', value: rootValue, segments: [] }, 0);
  }

  /**
   * Open everything the map can hold, breadth first so it fills evenly rather
   * than running down one arm of the document.
   *
   * The budget counts boxes that will actually be *drawn*, which is at most
   * GRAPH_FANOUT per branch — spending it on a branch's full child count would
   * mean a single 9000-item array closed the map to everything else.
   */
  function openAll() {
    open = new Set();
    let budget = GRAPH_MAX_NODES;
    let frontier = [{ key: '$', value: rootValue, segments: [] }];
    let whole = true;
    while (frontier.length) {
      const next = [];
      for (const item of frontier) {
        const { branch, children } = childrenOf(item.value, item.segments);
        if (!branch || !children.length) continue;
        const drawing = Math.min(children.length, GRAPH_FANOUT);
        if (budget - drawing < 0) { whole = false; continue; }
        budget -= drawing;
        open.add(pathKey(item.segments));
        children.slice(0, drawing).forEach(child => next.push(child));
        if (children.length > drawing) whole = false;
      }
      frontier = next;
    }
    return whole;
  }

  return {
    setRoot(value, depth) {
      rootValue = value;
      open = new Set();
      fanout = new Map();
      keep = null;
      hits = 0;
      selected = null;
      if (typeof depth === 'number') openToDepth(depth);
      draw();
      fit();
    },
    /* Expanding keeps the current framing: fitting a map of seven hundred
       boxes would answer "what shape is it" by making it unreadable. Fit is a
       button of its own for when that is what you want. */
    expandAll() { const whole = openAll(); draw(); return whole; },
    collapseAll() { open = new Set(); fanout = new Map(); draw(); fit(); },
    search(text) {
      const found = matchPaths(rootValue, text);
      keep = found.paths;
      hits = found.hits;
      if (keep) open = new Set([...keep]);
      draw();
      fit();
      return hits;
    },
    searchHits: () => hits,
    /** Open the path to a value and centre the map on it. */
    reveal(segments) {
      keep = null;
      let acc = [];
      open.add(pathKey(acc));
      segments.forEach(seg => { acc = acc.concat([seg]); open.add(pathKey(acc)); });
      selected = pathKey(segments);
      draw();
      const found = drawn.nodes.find(n => n.key === selected);
      if (!found) return false;
      centre = { x: found.x + GRAPH_NODE_W / 2, y: found.y + GRAPH_NODE_H / 2 };
      applyView();
      return true;
    },
    fit,
    zoomBy,
    zoomLevel: () => zoom,
    info: () => ({ nodes: drawn.nodes.length, links: drawn.links.length, partial: drawn.stopped }),
    redraw: draw
  };
}
