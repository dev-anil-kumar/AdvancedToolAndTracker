/**
 * The Canvas view: the tool strip, the ink swatches, the drawing's title, and
 * the import/export controls. The editor owns the drawing surface; this file
 * owns everything around it.
 */
import { on, EVENTS } from '../core/bus.js';
import { FILLS, FONTS, INKS } from '../core/config.js';
import { $, $$, el } from '../core/dom.js';
import { formatWhen, plural } from '../core/format.js';
import { drawingById, drawings, drawingsByRecency } from '../core/state.js';
import { route } from '../core/router.js';
import { toast } from '../core/toast.js';
import { saveBinaryFile, saveOneFile } from '../features/exporter.js';
import {
  createDrawing, importDrawing, removeDrawing, renameDrawing, toScene
} from '../features/drawings.js';
import {
  activeFill, activeFont, attachEditor, activeScene, activeTool, canRedo, canUndo,
  clearSelection, commitText, copySelection, cutSelection, isToolLocked, onTextInput,
  pasteClipboard, reorderSelection, setFill, setFont, setToolLocked,
  deleteSelection, detachSelection, duplicateSelection, editSelectionText, fitView,
  flushSave, hideTextEditor, isEditingText, loadScene, nudgeSelection, onTextBlur, redo,
  render, saveStatus, selectAll, selection, selectedShapes, selectionCount,
  setInk, setTool, toJSON, toPNG, toSVG, undo, zoomBy
} from '../features/canvas/editor.js';
import { fillColour, SHORTCUTS } from '../features/canvas/model.js';

const TOOLS = [
  { tool: 'select', key: 'V', label: 'Select', hint: 'Select and move — drag empty space to marquee, space-drag to pan' },
  { tool: 'rect', key: 'R', label: 'Rectangle', hint: 'Rectangle' },
  { tool: 'ellipse', key: 'C', label: 'Circle', hint: 'Circle' },
  { tool: 'arrow', key: 'A', label: 'Arrow', hint: 'Arrow — drop an end on a shape to connect it' },
  { tool: 'text', key: 'T', label: 'Text', hint: 'A single text label' },
  { tool: 'note', key: 'N', label: 'Text box', hint: 'Text box — a text container with no visible boundary' },
  { tool: 'container', key: 'F', label: 'Container', hint: 'Container — moving it moves everything inside' }
];

const ICONS = {
  select: '<path d="M5 3l6 15 2.2-5.6L19 10 5 3z"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6.5"/>',
  arrow: '<path d="M4 18L20 6M20 6h-6M20 6v6"/>',
  text: '<path d="M5 6h14M12 6v13"/>',
  note: '<rect x="3.5" y="6" width="17" height="12" rx="2" stroke-dasharray="2.5 2.5"/><path d="M8 10.5h8M8 14h5"/>',
  container: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke-dasharray="3 2.5"/><path d="M7 10h4"/>'
};

let ready = false;

/** Build the toolbar once, then open a drawing. */
export function openDrawing(id) {
  const rec = drawingById(id);
  if (!rec) { toast('That drawing is no longer here.'); return; }
  initCanvas();
  loadScene(toScene(rec));
  route('canvas');
  requestAnimationFrame(render);
}

export async function newDrawing() {
  initCanvas();
  const scene = await createDrawing('Untitled drawing');
  loadScene(scene);
  route('canvas');
  requestAnimationFrame(render);
  setTool('rect');
}

function initCanvas() {
  if (ready) return;
  ready = true;
  renderTools();
  renderInks();
  renderFills();
  renderFonts();
  attachEditor({ onChange: syncToolbar });
}

/* ---------- Toolbar ---------- */

function renderTools() {
  const bar = $('#cTools');
  bar.innerHTML = '';
  TOOLS.forEach(t => {
    const b = el('button', 'ctool');
    b.type = 'button';
    b.dataset.tool = t.tool;
    b.title = t.hint + '  (' + t.key + ')';
    b.setAttribute('aria-label', t.label + ' (' + t.key + ')');
    b.setAttribute('aria-pressed', String(t.tool === activeTool()));
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[t.tool] + '</svg>' +
      '<span class="k">' + t.key + '</span>';
    b.addEventListener('click', () => setTool(t.tool));
    bar.appendChild(b);
  });
}

function renderInks() {
  const box = $('#cInks');
  box.innerHTML = '';
  INKS.forEach(i => {
    const b = el('button', 'swatch');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', 'Line colour: ' + i.label);
    b.title = 'Line: ' + i.label;
    b.dataset.ink = i.hex;
    b.style.background = i.hex;
    b.appendChild(el('span'));
    b.addEventListener('click', () => setInk(i.hex));
    box.appendChild(b);
  });
}

function renderFills() {
  const box = $('#cFills');
  box.innerHTML = '';
  FILLS.forEach(key => {
    const b = el('button', 'swatch fill' + (key === 'none' ? ' empty' : ''));
    b.type = 'button';
    b.setAttribute('role', 'radio');
    const label = key === 'none' ? 'No background' : 'Background: ' + key;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.dataset.fill = key;
    if (key !== 'none') b.style.background = fillColour(key).replace(/[\d.]+\)$/, '0.55)');
    b.appendChild(el('span'));
    b.addEventListener('click', () => setFill(key));
    box.appendChild(b);
  });
}

function renderFonts() {
  const box = $('#cFonts');
  box.innerHTML = '';
  FONTS.forEach(f => {
    const b = el('button', null, 'Aa');
    b.type = 'button';
    b.dataset.font = f.key;
    b.title = f.label;
    b.setAttribute('aria-label', 'Font: ' + f.label);
    b.style.fontFamily = f.stack;
    b.addEventListener('click', () => setFont(f.key));
    box.appendChild(b);
  });
}

/** Reflect editor state: active tool, ink, undo availability, shape count. */
export function syncToolbar() {
  const scene = activeScene();
  $('#cTools').querySelectorAll('.ctool').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === activeTool()));
  });
  const chosen = selectedShapes();
  const one = (list) => (list.size === 1 ? [...list][0] : null);
  const currentInk = one(new Set(chosen.map(s => s.ink)));
  const currentFill = chosen.length ? one(new Set(chosen.map(s => s.fill))) : activeFill();
  const currentFont = chosen.length ? one(new Set(chosen.map(s => s.font))) : activeFont();
  $('#cInks').querySelectorAll('.swatch').forEach(b => {
    b.setAttribute('aria-checked', String(currentInk ? b.dataset.ink === currentInk : false));
  });
  $('#cFills').querySelectorAll('.swatch').forEach(b => {
    b.setAttribute('aria-checked', String(currentFill ? b.dataset.fill === currentFill : false));
  });
  $('#cFonts').querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.font === currentFont));
  });
  $('#cUndo').disabled = !canUndo();
  $('#cRedo').disabled = !canRedo();
  $('#cDelete').disabled = !chosen.length;
  $('#cLabel').disabled = selectionCount() !== 1;
  $('#cDetach').disabled = !chosen.some(s => s.kind === 'arrow' && (s.from || s.to));
  $('#cFront').disabled = !chosen.length;
  $('#cBack').disabled = !chosen.length;
  $('#cLock').setAttribute('aria-pressed', String(isToolLocked()));
  $('#cName').value = scene ? scene.name : '';
  $('#cZoom').textContent = scene ? Math.round(scene.view.zoom * 100) + '%' : '';
  $('#cCount').textContent = scene
    ? (chosen.length
        ? plural(chosen.length, 'shape', 'shapes') + ' selected'
        : plural(scene.shapes.length, 'shape', 'shapes'))
    : '';
  $('#cSaved').textContent = scene ? (saveStatus() === 'saved' ? 'Saved' : 'Editing…') : '';
}

/* ---------- Shortcuts ---------- */

const SHORTCUT_GROUPS = [
  ['Tools', [
    ['R', 'Rectangle'], ['C', 'Circle'], ['A', 'Arrow'],
    ['T', 'Text label'], ['N', 'Text box'], ['F', 'Container'], ['V', 'Select']
  ]],
  ['Editing', [
    ['Double-click', 'Write inside a shape — or on empty canvas for a new text box'],
    ['Enter', 'Write inside the selected shape'],
    ['⌘C / ⌘V / ⌘X', 'Copy, paste, cut'],
    ['⌘D', 'Duplicate'], ['Alt-drag', 'Drag off a copy'],
    ['⌘Z / ⇧⌘Z', 'Undo, redo'], ['Delete', 'Remove the selection']
  ]],
  ['Arranging', [
    ['Drag a side dot', 'Pull out an arrow that stays attached'],
    ['Drag a corner', 'Resize'], ['Shift-drag', 'Keep to one axis, or keep it square'],
    ['Arrows', 'Nudge — hold shift for bigger steps'],
    ['⌘] / ⌘[', 'Bring to front, send to back']
  ]],
  ['Canvas', [
    ['Drag empty space', 'Select several'], ['Shift-click', 'Add to the selection'],
    ['Space-drag', 'Pan'], ['⌘-wheel', 'Zoom'], ['⌘A', 'Select all'], ['?', 'This list']
  ]]
];

function openShortcuts() {
  const body = $('#shortcutsBody');
  if (!body.childElementCount) {
    SHORTCUT_GROUPS.forEach(([title, rows]) => {
      const section = el('div', 'keys-group');
      section.appendChild(el('h3', null, title));
      const list = el('dl');
      rows.forEach(([key, what]) => {
        list.appendChild(el('dt')).appendChild(el('kbd', null, key));
        list.appendChild(el('dd', null, what));
      });
      section.appendChild(list);
      body.appendChild(section);
    });
  }
  const dlg = $('#shortcutsDlg');
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

/* ---------- Drawing picker on Home ---------- */

export function renderDrawings() {
  const list = $('#drawingRows');
  const section = $('#secDrawings');
  section.hidden = drawings.length === 0;
  $('#drawingsCount').textContent = drawings.length ? plural(drawings.length, 'drawing', 'drawings') : '';
  list.innerHTML = '';
  drawingsByRecency().forEach(rec => list.appendChild(drawingRow(rec)));
}

function drawingRow(rec) {
  const li = el('li', 'row-item');
  const main = el('button', 'row-main');
  main.type = 'button';
  const name = el('div', 'row-name');
  name.appendChild(el('span', 't', rec.name));
  name.appendChild(el('span', 'kind', 'Drawing'));
  main.append(name, el('div', 'row-sub',
    [formatWhen(rec.updatedAt), plural((rec.shapes || []).length, 'shape', 'shapes')].join(' · ')));
  main.addEventListener('click', () => openDrawing(rec.id));

  const acts = el('div', 'row-act');
  const save = el('button', 'btn tiny ghost', 'Save');
  save.type = 'button';
  save.title = 'Export this drawing as .json';
  save.addEventListener('click', e => {
    e.stopPropagation();
    saveOneFile(rec.name, JSON.stringify({
      type: 'folio-drawing', version: 1, name: rec.name, shapes: rec.shapes, view: rec.view
    }, null, 2), 'json');
  });
  const del = el('button', 'btn tiny ghost danger', 'Delete');
  del.type = 'button';
  del.addEventListener('click', e => { e.stopPropagation(); removeDrawing(rec.id); });
  acts.append(save, del);

  li.append(main, acts);
  return li;
}

/* ---------- Import ---------- */

export function pickDrawingFile() { $('#drawingInput').click(); }

export async function importFiles(list) {
  for (const file of [...list].slice(0, 4)) {
    try {
      const scene = await importDrawing(await file.text(), file.name.replace(/\.json$/i, ''));
      initCanvas();
      loadScene(scene);
      route('canvas');
      requestAnimationFrame(() => { fitView(); render(); });
    } catch (err) {
      toast('Couldn’t import “' + file.name + '”: ' + (err.message || err));
    }
  }
}

/* ---------- Wiring ---------- */

$('#cName').addEventListener('change', () => {
  const scene = activeScene();
  if (!scene) return;
  scene.name = $('#cName').value.trim().slice(0, 90) || 'Untitled drawing';
  renameDrawing(scene.id, scene.name);
  syncToolbar();
});
$('#cUndo').addEventListener('click', undo);
$('#cRedo').addEventListener('click', redo);
$('#cDelete').addEventListener('click', deleteSelection);
$('#cLabel').addEventListener('click', editSelectionText);
$('#cFront').addEventListener('click', () => reorderSelection(true));
$('#cBack').addEventListener('click', () => reorderSelection(false));
$('#cLock').addEventListener('click', () => setToolLocked(!isToolLocked()));
$('#cHelp').addEventListener('click', () => openShortcuts());
$$('#shortcutsDlg [data-close]').forEach(b => b.addEventListener('click', () => $('#shortcutsDlg').close()));
$('#cDetach').addEventListener('click', detachSelection);
$('#cFit').addEventListener('click', fitView);
$('#cZoomIn').addEventListener('click', () => zoomBy(1.2));
$('#cZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
$('#cImport').addEventListener('click', pickDrawingFile);
$('#cExportJson').addEventListener('click', () => {
  const scene = activeScene();
  if (scene) saveOneFile(scene.name, toJSON(scene), 'json');
});
$('#cExportSvg').addEventListener('click', () => {
  const scene = activeScene();
  if (scene) saveOneFile(scene.name, toSVG(), 'svg');
});
$('#cExportPng').addEventListener('click', async () => {
  const scene = activeScene();
  if (!scene) return;
  const blob = await toPNG(2);
  if (!blob) { toast('This browser can’t rasterise the drawing — export SVG instead.'); return; }
  saveBinaryFile(scene.name, blob, 'png');
});
$('#cNew').addEventListener('click', newDrawing);
$('#canvasNew').addEventListener('click', newDrawing);
$('#drawingInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });

$('#textEditArea').addEventListener('blur', onTextBlur);
$('#textEditArea').addEventListener('input', onTextInput);
$('#textEditArea').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); hideTextEditor(); }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitText(); }
});

/**
 * Keyboard shortcuts, live only while the canvas is on screen and the user is
 * not typing. Single letters pick a tool: c, a, r as asked for, plus v/t/f.
 */
document.addEventListener('keydown', e => {
  if (document.body.dataset.view !== 'canvas' || !activeScene()) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (isEditingText()) return;

  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelection(); return; }
  if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAll(); return; }
  if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySelection(); return; }
  if (mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); cutSelection(); return; }
  if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteClipboard(); return; }
  if (mod && e.key === ']') { e.preventDefault(); reorderSelection(true); return; }
  if (mod && e.key === '[') { e.preventDefault(); reorderSelection(false); return; }
  if (mod) return;

  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }

  const key = e.key.toLowerCase();
  if (SHORTCUTS[key]) { e.preventDefault(); setTool(SHORTCUTS[key]); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape') { setTool('select'); clearSelection(); return; }
  if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); editSelectionText(); return; }

  const step = e.shiftKey ? 20 : 5;
  const nudges = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (nudges[e.key] && selection()) { e.preventDefault(); nudgeSelection(...nudges[e.key]); }
});

/* Drop an exported drawing anywhere on the canvas. */
$('#canvasHost').addEventListener('dragover', e => e.preventDefault());
$('#canvasHost').addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();           // the window handler must not read it again
  if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
});

on(EVENTS.DRAWINGS, renderDrawings);
on(EVENTS.VIEW, name => {
  if (name === 'canvas' && activeScene()) requestAnimationFrame(render);
  if (name !== 'canvas' && activeScene()) { commitText(); flushSave(); }
});
