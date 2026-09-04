/**
 * The table: an array of objects as rows and columns.
 *
 * Most JSON that is worth staring at is a list of records, and a list of
 * records is a table. The tree can show one, but only a table lets you scan
 * down a single field, which is usually the question being asked.
 *
 * Rows arrive in batches and cells never recurse: a nested object shows as a
 * chip with its size, and clicking it hands the reader back to the tree.
 */
import { TABLE_CHUNK } from '../../core/config.js';
import { el } from '../../core/dom.js';
import { childCount, columnsOf, compareCells, isBranch, peek, typeOf } from './model.js';

export function createTable(opts) {
  const host = opts.host;
  const onOpen = opts.onOpen || (() => {});     // "look at this cell in the tree"

  let rows = [];
  let cols = [];
  let order = { col: null, dir: 1 };
  let filter = '';
  let shown = 0;
  let view = [];

  function apply() {
    const needle = filter.trim().toLowerCase();
    view = rows.map((row, i) => ({ row, i }));
    if (needle) {
      view = view.filter(({ row }) => cols.some(c => {
        const cell = isBranch(row) ? row[c] : row;
        return cell !== undefined && String(peek(cell, 400)).toLowerCase().includes(needle);
      }));
    }
    if (order.col !== null) {
      view.sort((a, b) => {
        const va = isBranch(a.row) ? a.row[order.col] : a.row;
        const vb = isBranch(b.row) ? b.row[order.col] : b.row;
        return compareCells(va, vb) * order.dir;
      });
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
    cols.forEach(c => {
      const th = el('th');
      const b = el('button', 'jt-sort', c === '' ? 'value' : c);
      b.type = 'button';
      if (order.col === c) b.classList.add(order.dir > 0 ? 'up' : 'down');
      b.addEventListener('click', () => {
        order = order.col === c ? { col: c, dir: -order.dir } : { col: c, dir: 1 };
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

    const more = el('button', 'btn jt-more');
    more.type = 'button';
    more.addEventListener('click', paintRows);
    host.appendChild(more);

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

  function rowFor({ row, i }) {
    const tr = el('tr');
    tr.appendChild(el('td', 'jt-n', String(i)));
    cols.forEach(c => {
      const value = isBranch(row) && !Array.isArray(row) ? row[c] : (c === '' ? row : undefined);
      tr.appendChild(cellFor(value, i, c));
    });
    return tr;
  }

  function cellFor(value, i, col) {
    const td = el('td');
    if (value === undefined) {
      td.className = 'jt-empty';
      td.textContent = '—';
      return td;
    }
    const t = typeOf(value);
    td.dataset.type = t;
    if (isBranch(value)) {
      const b = el('button', 'jchip link-chip',
        (Array.isArray(value) ? '[' + childCount(value) + ']' : '{' + childCount(value) + '}'));
      b.type = 'button';
      b.title = 'Show this in the tree';
      b.addEventListener('click', () => onOpen(i, col));
      td.appendChild(b);
      return td;
    }
    const span = el('span', 'jlit ' + t, peek(value, 160));
    if (t === 'string' && String(value).length > 160) span.title = String(value).slice(0, 2000);
    td.appendChild(span);
    return td;
  }

  return {
    setRows(list) {
      rows = Array.isArray(list) ? list : [];
      cols = columnsOf(rows);
      order = { col: null, dir: 1 };
      apply();
    },
    setFilter(text) { filter = String(text || ''); apply(); },
    shownCount: () => view.length,
    columnCount: () => cols.length,
    clear() { rows = []; cols = []; view = []; host.innerHTML = ''; }
  };
}
