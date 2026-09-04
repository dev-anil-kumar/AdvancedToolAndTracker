/**
 * The table: an array of records as rows and columns.
 *
 * Most JSON worth staring at is a list of records, and a list of records is a
 * table. The tree can show one, but only a table lets you scan a single field
 * down the page, which is usually the question being asked.
 *
 * A column is a *leaf*, not a top-level key — see flattenRow in model.js. A
 * cell showing "{3}" is a cell that answers nothing, so nested objects and
 * JSON-in-a-string are opened out into columns of their own. Arrays stay whole
 * and show as a chip: clicking it hands the reader to that spot in the tree.
 *
 * Rows arrive in batches, and a row is only flattened when it is painted.
 */
import { TABLE_CHUNK } from '../../core/config.js';
import { el } from '../../core/dom.js';
import { childCount, columnsOf, compareCells, flattenRow, isBranch, peek, typeOf } from './model.js';

export function createTable(opts) {
  const host = opts.host;
  const onOpen = opts.onOpen || (() => {});     // "show me this cell in the tree"

  let rows = [];
  let cols = [];
  let note = { dropped: 0, scanned: 0 };
  let flat = new Map();                          // row index → flattened fields
  let order = { col: null, dir: 1 };
  let filter = '';
  let shown = 0;
  let view = [];

  /** Flattening is not free, so each row is done once and kept. */
  function fieldsOf(i) {
    let fields = flat.get(i);
    if (!fields) { fields = flattenRow(rows[i]); flat.set(i, fields); }
    return fields;
  }
  const cellOf = (i, label) => {
    const found = fieldsOf(i).get(label);
    return found ? found.value : undefined;
  };

  function apply() {
    const needle = filter.trim().toLowerCase();
    view = rows.map((row, i) => i);
    if (needle) {
      view = view.filter(i => {
        for (const [, field] of fieldsOf(i)) {
          if (field.value !== undefined && String(peek(field.value, 400)).toLowerCase().includes(needle)) return true;
        }
        return false;
      });
    }
    if (order.col !== null) {
      view.sort((a, b) => compareCells(cellOf(a, order.col), cellOf(b, order.col)) * order.dir);
    }
    shown = 0;
    draw();
  }

  function draw() {
    host.innerHTML = '';
    if (!rows.length) return;

    const scroller = el('div', 'jt-scroll');
    const table = el('table', 'jt');
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', 'jt-n', '#'));
    cols.forEach(label => {
      const th = el('th');
      const b = el('button', 'jt-sort');
      b.type = 'button';
      b.title = 'Sort by ' + (label || 'value');
      /* The last segment is the field; its parents are shown quieter, so a
         wide table still reads as a list of fields rather than of paths. */
      const parts = String(label).split('.');
      const leaf = parts.pop();
      if (parts.length) b.appendChild(el('span', 'jt-path', parts.join('.') + '.'));
      b.appendChild(el('span', 'jt-leaf', leaf || 'value'));
      if (order.col === label) b.classList.add(order.dir > 0 ? 'up' : 'down');
      b.addEventListener('click', () => {
        order = order.col === label ? { col: label, dir: -order.dir } : { col: label, dir: 1 };
        apply();
      });
      th.appendChild(b);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    table.appendChild(tbody);
    scroller.appendChild(table);
    host.appendChild(scroller);

    const foot = el('div', 'jt-foot');
    const more = el('button', 'btn');
    more.type = 'button';
    more.addEventListener('click', paintRows);
    foot.appendChild(more);
    if (note.dropped) {
      foot.appendChild(el('span', 'jmeta',
        note.dropped + ' more field' + (note.dropped === 1 ? '' : 's') + ' than a table can hold — the tree has them all'));
    }
    host.appendChild(foot);

    function paintRows() {
      const upto = Math.min(view.length, shown + TABLE_CHUNK);
      for (let i = shown; i < upto; i++) tbody.appendChild(rowFor(view[i]));
      shown = upto;
      const left = view.length - shown;
      more.hidden = left <= 0;
      more.textContent = 'Show ' + Math.min(left, TABLE_CHUNK) + ' more — ' + left + ' left';
    }
    paintRows();
  }

  function rowFor(i) {
    const tr = el('tr');
    tr.appendChild(el('td', 'jt-n', String(i)));
    const fields = fieldsOf(i);
    cols.forEach(label => tr.appendChild(cellFor(fields.get(label), i, label)));
    return tr;
  }

  function cellFor(field, i, label) {
    const td = el('td');
    if (!field || field.value === undefined) {
      td.className = 'jt-empty';
      td.textContent = '—';
      return td;
    }
    const value = field.value;
    const t = typeOf(value);
    td.dataset.type = t;
    if (isBranch(value)) {
      /* Only arrays and empty objects reach here — everything else was
         flattened into columns of its own. */
      const b = el('button', 'jchip link-chip',
        Array.isArray(value) ? '[' + childCount(value) + ']' : '{' + childCount(value) + '}');
      b.type = 'button';
      b.title = 'Show this in the tree';
      b.addEventListener('click', () => onOpen(i, label, field.segments));
      td.appendChild(b);
      if (Array.isArray(value) && childCount(value) && !value.some(isBranch)) {
        td.appendChild(el('span', 'jt-list', value.map(v => peek(v, 24)).join(', ')));
      }
      return td;
    }
    const span = el('span', 'jlit ' + t, peek(value, 160));
    if (t === 'string' && String(value).length > 60) td.title = String(value).slice(0, 4000);
    td.appendChild(span);
    return td;
  }

  return {
    setRows(list) {
      rows = Array.isArray(list) ? list : [];
      flat = new Map();
      const worked = columnsOf(rows);
      cols = worked.cols;
      note = { dropped: worked.dropped, scanned: worked.scanned };
      order = { col: null, dir: 1 };
      apply();
    },
    setFilter(text) { filter = String(text || ''); apply(); },
    shownCount: () => view.length,
    columnCount: () => cols.length,
    clear() { rows = []; cols = []; view = []; flat = new Map(); host.innerHTML = ''; }
  };
}
