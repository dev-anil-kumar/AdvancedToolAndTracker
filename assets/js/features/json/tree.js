/**
 * The tree: the reading view.
 *
 * Three things shape this file.
 *
 * 1. *Nothing is built until it is seen.* A node's children are created when it
 *    opens, and long arrays arrive in batches, so a document with a hundred
 *    thousand nodes opens as fast as one with ten.
 * 2. *Embedded JSON is structure.* A string that is really a document expands
 *    like any other branch; the parsed value is cached on the node and written
 *    back through JSON.stringify if anything inside it is edited.
 * 3. *Editing is opt-in.* Reading is the default and stays untouched — no input
 *    boxes, no controls in the margin — until the reader asks for them.
 */
import { JSON_CHUNK, STRING_FULL, STRING_INLINE } from '../../core/config.js';
import { el } from '../../core/dom.js';
import {
  PATH_SEP as SEP, childCount, embedded, isBranch, looksTruncated, matchPaths,
  pathKey as keyOf, pathString, peek, summarise, typeOf
} from './model.js';

/**
 * @param {object} opts
 *   host      element to render into
 *   onChange  called after an edit, with the node that changed
 *   onSelect  called when the selected row changes
 */
export function createTree(opts) {
  const host = opts.host;
  const onChange = opts.onChange || (() => {});
  const onSelect = opts.onSelect || (() => {});

  let rootValue = null;
  let rootBox = null;
  let editable = false;
  let open = new Set();            // path keys of expanded nodes
  let keep = null;                 // path keys a search left visible, or null
  let query = '';
  let selected = null;
  let hits = 0;
  let want = null;                 // a path being brought into view
  let openBefore = null;           // what was open before a search took over

  /* ---------- Nodes ---------- */

  function node(key, value, container, parent, embedHost) {
    const segments = parent ? parent.segments.concat([{ key }]) : [];
    const n = {
      key, value, container, parent,
      host: embedHost || null,
      segments,
      pathKey: keyOf(segments),
      depth: parent ? parent.depth + 1 : 0,
      embedValue: undefined
    };
    return n;
  }

  /** The value a node's children come from: its own, or its embedded document. */
  function branchValue(n) {
    if (n.embedValue !== undefined) return n.embedValue;
    if (isBranch(n.value)) return n.value;
    const inner = embedded(n.value);
    if (inner !== undefined) { n.embedValue = inner; return inner; }
    return null;
  }
  const isEmbed = (n) => n.embedValue !== undefined || (typeof n.value === 'string' && embedded(n.value) !== undefined);
  const expandable = (n) => branchValue(n) !== null && childCount(branchValue(n)) > 0;

  function childrenOf(n) {
    const value = branchValue(n);
    if (!value) return [];
    const embedHost = isEmbed(n) ? n : n.host;
    const parentForPath = isEmbed(n) ? embedSegment(n) : n;
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
    return keys.map(k => node(k, value[k], value, parentForPath, embedHost));
  }

  /* An embedded document adds a step to the path, so a copied path shows the
     boundary rather than pretending the fields were there all along. */
  function embedSegment(n) {
    const segments = n.segments.concat([{ embedded: true }]);
    return { segments, depth: n.depth, pathKey: keyOf(segments) };
  }

  /* ---------- Editing ---------- */

  /** Push an edited embedded document back into the string that carried it. */
  function reencode(n) {
    let h = n && n.host;
    while (h) {
      h.container[h.key] = JSON.stringify(h.embedValue);
      h.value = h.container[h.key];
      h = h.host;
    }
  }

  function commit(n) {
    reencode(n);
    onChange(n);
  }

  /** Text the reader typed, read as JSON where it can be, otherwise a string. */
  function readValue(text) {
    const trimmed = text.trim();
    if (!trimmed) return '';
    try { return JSON.parse(trimmed); } catch (err) { return text; }
  }

  function setValue(n, next) {
    n.container[n.key] = next;
    if (!n.parent) rootValue = next;      // the root is held in its own box
    n.value = next;
    n.embedValue = undefined;
    commit(n);
    redrawRow(n);
  }

  function renameKey(n, nextKey) {
    const name = String(nextKey);
    if (!name || name === String(n.key) || Array.isArray(n.container)) return;
    /* Rebuild the object so the renamed key keeps its position. */
    const entries = Object.entries(n.container).map(([k, v]) => [k === n.key ? name : k, v]);
    Object.keys(n.container).forEach(k => { delete n.container[k]; });
    entries.forEach(([k, v]) => { n.container[k] = v; });
    open = new Set();
    commit(n);
    draw();
  }

  function removeNode(n) {
    if (Array.isArray(n.container)) n.container.splice(Number(n.key), 1);
    else delete n.container[n.key];
    open.delete(n.pathKey);
    commit(n);
    draw();
  }

  function addChild(n) {
    const value = branchValue(n);
    if (!value) return;
    if (Array.isArray(value)) {
      value.push('');
    } else {
      let name = 'newKey', i = 2;
      while (Object.prototype.hasOwnProperty.call(value, name)) name = 'newKey' + i++;
      value[name] = '';
    }
    open.add(n.pathKey);
    commit(n);
    draw();
  }

  /* ---------- Search ---------- */

  /** Ask model.js what matches, then let only those paths through. */
  function runSearch(text) {
    query = String(text || '').trim();
    if (!query) {
      keep = null;
      hits = 0;
      if (openBefore) { open = openBefore; openBefore = null; }
      return 0;
    }
    if (!openBefore) openBefore = new Set(open);
    const found = matchPaths(rootValue, query);
    keep = found.paths;
    hits = found.hits;
    open = new Set([...keep]);        // matches arrive already opened
    return hits;
  }

  const visible = (n) => !keep || keep.has(n.pathKey) || keep.has(n.pathKey + SEP + '»');

  /* ---------- Rows ---------- */

  function rowFor(n) {
    /* ARIA's nested tree pattern: the wrapper is the treeitem, the row is its
       label, and the children live in a role="group" inside it. The wrapper is
       what takes focus, so arrow-key navigation and the roles agree. */
    const wrap = el('div', 'jnode');
    wrap.style.setProperty('--d', String(n.depth));   /* the guide line reads this */
    wrap.tabIndex = -1;
    wrap.setAttribute('role', 'treeitem');
    wrap.setAttribute('aria-level', String(n.depth + 1));
    const row = el('div', 'jrow');
    row.style.setProperty('--d', String(n.depth));
    row.dataset.type = typeOf(n.value);
    if (selected === n.pathKey) row.classList.add('sel');
    wrap._node = n;

    const branch = expandable(n);
    if (branch) wrap.setAttribute('aria-expanded', String(open.has(n.pathKey)));
    wrap.setAttribute('aria-label', nameFor(n, branch));
    const twisty = el('button', 'jtwist');
    twisty.type = 'button';
    twisty.tabIndex = -1;
    if (branch) {
      twisty.setAttribute('aria-label', open.has(n.pathKey) ? 'Collapse' : 'Expand');
      twisty.textContent = '▸';
      twisty.addEventListener('click', e => { e.stopPropagation(); toggle(n, wrap); });
    } else {
      twisty.className = 'jtwist blank';
      twisty.tabIndex = -1;
      twisty.setAttribute('aria-hidden', 'true');
      twisty.disabled = true;
    }
    row.appendChild(twisty);

    if (n.parent || n.depth > 0) {
      const label = el('span', 'jkey', String(n.key));
      if (typeof n.key === 'number') label.classList.add('idx');
      if (editable && !Array.isArray(n.container)) {
        label.title = 'Double-click to rename';
        label.addEventListener('dblclick', e => { e.stopPropagation(); editKey(n, label); });
      }
      row.append(label, el('span', 'jcolon', ':'));
    } else {
      row.appendChild(el('span', 'jkey root', '$'));
      row.appendChild(el('span', 'jcolon', ''));
    }

    row.appendChild(valueCell(n, branch));

    const acts = el('div', 'jacts');
    acts.append(
      tinyBtn('Path', 'Copy the path to this value', () => copy(pathString(n.segments))),
      tinyBtn('Copy', 'Copy this value as JSON', () => copy(jsonOf(n)))
    );
    if (editable && n.parent) {
      acts.appendChild(tinyBtn('×', 'Remove this entry', () => removeNode(n), 'danger'));
    }
    if (editable && branchValue(n)) {
      acts.insertBefore(tinyBtn('+', 'Add an entry inside', () => addChild(n)), acts.firstChild);
    }
    row.appendChild(acts);

    row.addEventListener('click', () => { select(n, row); wrap.focus({ preventScroll: true }); });
    if (branch) row.addEventListener('dblclick', e => {
      if (e.target.closest('.jval,.jkey,.jacts')) return;
      toggle(n, wrap);
    });

    wrap.appendChild(row);
    if (open.has(n.pathKey) && branch) wrap.appendChild(kidsFor(n));
    else if (branch) wrap.classList.add('closed');
    return wrap;
  }

  /** The value half of a row: a summary for branches, the value for leaves. */
  function valueCell(n, branch) {
    const cell = el('span', 'jval');
    const value = n.value;
    const t = typeOf(value);

    if (isEmbed(n)) {
      const inner = branchValue(n);
      cell.classList.add('embed');
      cell.append(
        el('span', 'jchip', 'JSON in a string'),
        el('span', 'jbrace', Array.isArray(inner) ? '[…]' : '{…}'),
        el('span', 'jsum', summarise(inner))
      );
      return cell;
    }
    if (branch || isBranch(value)) {
      cell.append(
        el('span', 'jbrace', Array.isArray(value) ? '[' + (childCount(value) ? '…' : '') + ']'
                                                  : '{' + (childCount(value) ? '…' : '') + '}'),
        el('span', 'jsum', summarise(value))
      );
      return cell;
    }

    const text = el('span', 'jlit ' + t);
    if (t === 'string') {
      /* A string that will not fit on a row keeps the row one line tall and
         opens out underneath when selected. Without this, one field holding a
         megabyte of text would decide the height of the whole view. */
      const multiline = /[\n\r\t]/.test(value);
      const long = value.length > STRING_INLINE;
      cell.appendChild(text);
      if (multiline || long) {
        text.textContent = peek(value, STRING_INLINE);
        cell.appendChild(el('span', 'jchip soft',
          multiline ? 'multi-line' : value.length.toLocaleString() + ' chars'));
        cell.appendChild(el('pre', 'jstring-full',
          value.length > STRING_FULL ? value.slice(0, STRING_FULL) + '\n…' : value));
        cell.classList.add('has-full');
      } else {
        text.textContent = value;
      }
      if (looksTruncated(value)) cell.appendChild(el('span', 'jchip warn', 'truncated JSON'));
    } else {
      text.textContent = t === 'null' ? 'null' : String(value);
      cell.appendChild(text);
    }
    if (editable) {
      cell.classList.add('editable');
      cell.title = 'Click to edit';
      cell.addEventListener('click', e => { e.stopPropagation(); editValue(n, cell); });
    }
    return cell;
  }

  /* ---------- Children, in batches ---------- */

  function kidsFor(n) {
    const box = el('div', 'jkids');
    box.setAttribute('role', 'group');
    const kids = childrenOf(n).filter(visible);
    let shown = 0;
    const more = el('button', 'jmore');
    more.type = 'button';

    const paint = () => {
      const upto = Math.min(kids.length, shown + JSON_CHUNK);
      for (let i = shown; i < upto; i++) box.insertBefore(rowFor(kids[i]), more);
      shown = upto;
      const left = kids.length - shown;
      more.hidden = left <= 0;
      more.textContent = 'Show ' + Math.min(left, JSON_CHUNK) + ' more of ' + kids.length;
      more.style.setProperty('--d', String(n.depth + 1));
    };
    more.addEventListener('click', e => { e.stopPropagation(); paint(); });
    box.appendChild(more);
    paint();
    /* Painting stops at a batch edge; keep going while the row we are looking
       for is still on the far side of it. */
    const wanted = () => want && kids.slice(shown).some(k => want === k.pathKey || want.startsWith(k.pathKey + SEP));
    while (shown < kids.length && wanted()) paint();
    return box;
  }

  function toggle(n, wrap) {
    if (open.has(n.pathKey)) {
      open.delete(n.pathKey);
      const kids = wrap.querySelector(':scope > .jkids');
      if (kids) kids.remove();
      wrap.classList.add('closed');
    } else {
      open.add(n.pathKey);
      wrap.classList.remove('closed');
      wrap.appendChild(kidsFor(n));
    }
    const shown = open.has(n.pathKey);
    wrap.setAttribute('aria-expanded', String(shown));
    const t = wrap.querySelector(':scope > .jrow > .jtwist');
    if (t) t.setAttribute('aria-label', shown ? 'Collapse' : 'Expand');
  }

  function redrawRow(n) {
    const wrap = [...host.querySelectorAll('.jnode')].find(w => w._node && w._node.pathKey === n.pathKey);
    if (!wrap) { draw(); return; }
    wrap.replaceWith(rowFor(n));
  }

  /* ---------- Inline edit ---------- */

  function editValue(n, cell) {
    if (cell.querySelector('input')) return;
    const t = typeOf(n.value);
    const input = el('input', 'jedit');
    input.value = t === 'string' ? n.value : JSON.stringify(n.value);
    input.setAttribute('aria-label', 'Value of ' + n.key);
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) setValue(n, readValue(input.value));
      else redrawRow(n);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
  }

  function editKey(n, label) {
    const input = el('input', 'jedit key');
    input.value = String(n.key);
    input.setAttribute('aria-label', 'Rename ' + n.key);
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) renameKey(n, input.value.trim());
      else draw();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', e => e.stopPropagation());
  }

  /* ---------- Helpers ---------- */

  /** What a screen reader should say for a row: its key, then what it holds. */
  function nameFor(n, branch) {
    const what = branch ? summarise(branchValue(n))
      : (n.value === null ? 'null' : peek(n.value, 60));
    return (n.parent || n.depth > 0 ? String(n.key) : 'root') + ': ' + what;
  }

  function jsonOf(n) {
    const v = branchValue(n) !== null && isEmbed(n) ? n.embedValue : n.value;
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
    opts.onCopy && opts.onCopy(text);
  }
  function tinyBtn(label, title, run, extra) {
    const b = el('button', 'jtiny' + (extra ? ' ' + extra : ''), label);
    b.type = 'button';
    b.title = title;
    b.tabIndex = -1;
    b.addEventListener('click', e => { e.stopPropagation(); run(); });
    return b;
  }
  function select(n, row) {
    selected = n.pathKey;
    host.querySelectorAll('.jrow.sel').forEach(r => r.classList.remove('sel'));
    row.classList.add('sel');
    onSelect({ path: pathString(n.segments), value: n.value, type: typeOf(n.value), node: n });
  }

  /* ---------- Drawing and the public surface ---------- */

  function draw() {
    host.innerHTML = '';
    if (rootValue === null || rootValue === undefined) return;
    /* The root lives in a one-key box, so editing it works like anything else. */
    rootBox = { $: rootValue };
    host.appendChild(rowFor(node('$', rootValue, rootBox, null, null)));
  }

  /** Open every branch down to `depth`, counted from the root. */
  function openToDepth(depth) {
    open = new Set();
    (function walk(value, segments, level) {
      if (level >= depth) return;
      const inner = typeof value === 'string' ? embedded(value) : undefined;
      const branch = isBranch(value) ? value : inner;
      if (!branch) return;
      open.add(keyOf(segments));
      const base = inner !== undefined ? segments.concat([{ embedded: true }]) : segments;
      if (inner !== undefined) open.add(keyOf(base));
      const keys = Array.isArray(branch) ? branch.map((_, i) => i) : Object.keys(branch);
      keys.forEach(k => walk(branch[k], base.concat([{ key: k }]), level + 1));
    })(rootValue, [], 0);
  }

  /** Open everything, up to a node budget — "expand all" on a huge document
      would otherwise be a way to hang the tab. */
  function openAll(budget = 20000) {
    open = new Set();
    let left = budget;
    (function walk(value, segments) {
      if (left-- <= 0) return;
      const inner = typeof value === 'string' ? embedded(value) : undefined;
      const branch = isBranch(value) ? value : inner;
      if (!branch) return;
      open.add(keyOf(segments));
      const base = inner !== undefined ? segments.concat([{ embedded: true }]) : segments;
      if (inner !== undefined) open.add(keyOf(base));
      const keys = Array.isArray(branch) ? branch.map((_, i) => i) : Object.keys(branch);
      keys.forEach(k => walk(branch[k], base.concat([{ key: k }])));
    })(rootValue, []);
    return left > 0;
  }

  /* Roving focus over the treeitems, so the tree is usable without a mouse.
     querySelectorAll returns document order, which for a nested tree is the
     order the rows appear on screen. */
  host.addEventListener('keydown', e => {
    const items = [...host.querySelectorAll('.jnode')];
    if (!items.length) return;
    const active = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('.jnode') : null;
    const at = items.indexOf(active);
    const go = (i) => {
      e.preventDefault();
      const item = items[Math.max(0, Math.min(items.length - 1, i))];
      item.focus();
      const row = item.querySelector(':scope > .jrow');
      if (row) select(item._node, row);
    };
    if (e.key === 'ArrowDown') return go(at + 1);
    if (e.key === 'ArrowUp') return go(at < 0 ? 0 : at - 1);
    if (e.key === 'Home') return go(0);
    if (e.key === 'End') return go(items.length - 1);
    if (at < 0 || !active._node) return;
    const n = active._node;
    if (e.key === 'ArrowRight' && expandable(n) && !open.has(n.pathKey)) { e.preventDefault(); toggle(n, active); }
    if (e.key === 'ArrowLeft' && open.has(n.pathKey)) { e.preventDefault(); toggle(n, active); }
    if (e.key === 'Enter' && editable) {
      const cell = active.querySelector(':scope > .jrow > .jval.editable');
      if (cell) { e.preventDefault(); editValue(n, cell); }
    }
  });

  return {
    setRoot(value, depth) {
      rootValue = value;
      open = new Set();
      keep = null;
      query = '';
      selected = null;
      if (typeof depth === 'number') openToDepth(depth);
      draw();
    },
    setEditable(on) { editable = !!on; draw(); },
    isEditable: () => editable,
    expandAll() { const whole = openAll(); draw(); return whole; },
    collapseAll() { open = new Set(); draw(); },
    expandToDepth(d) { openToDepth(d); draw(); },
    search(text) { const n = runSearch(text); draw(); return n; },
    /**
     * Open the path to a value, scroll to it and select it. This is how the
     * table view hands a cell back: the reader clicks a nested object and
     * arrives at exactly that row in the tree.
     */
    reveal(segments) {
      const target = keyOf(segments);
      keep = null;
      want = target;
      let acc = [];
      open.add(keyOf(acc));
      segments.forEach(seg => { acc = acc.concat([seg]); open.add(keyOf(acc)); });
      draw();
      want = null;
      const wrap = [...host.querySelectorAll('.jnode')].find(w => w._node && w._node.pathKey === target);
      if (!wrap) return false;
      const row = wrap.querySelector(':scope > .jrow');
      if (row) {
        row.click();
        row.focus();
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
      }
      return true;
    },
    searchHits: () => hits,
    query: () => query,
    redraw: draw,
    /* Editing the root itself replaces it in the box, so the view reads it back. */
    root: () => (rootBox ? rootBox.$ : rootValue),
    selectedPath: () => selected
  };
}
