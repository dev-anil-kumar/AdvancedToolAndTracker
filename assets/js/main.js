/**
 * Folio — entry point.
 *
 * A local-first Markdown reader: no accounts, no server, no build step. Open
 * documents from disk or a public URL, read several side by side, and keep
 * notes from anything you select. Everything is stored in this browser.
 *
 * Layering (imports only ever point downwards)
 *
 *   main.js          wiring and boot
 *     └ ui/          views that render state and own their page's DOM
 *         └ features/  behaviour that owns a slice of state
 *             └ md/     the Markdown pipeline
 *               └ core/  dom, bus, config, db, state, router, format, toast
 *
 * Features never import views. When a feature changes something, it emits on
 * the bus and the interested views re-render themselves.
 */
import { emit, EVENTS } from './core/bus.js';
import { $ } from './core/dom.js';
import { dbAll } from './core/db.js';
import { hashView, route } from './core/router.js';
import {
  loadPrefs, setActiveWs, setDrawings, setFiles, setNotes, workspaces
} from './core/state.js';

import { applyTheme, toggleTheme } from './features/theme.js';
import { applyHighlight } from './features/highlight.js';
import { handleFiles, openSample } from './features/library.js';
import { addWorkspace, selectWorkspace } from './features/workspaces.js';
import { closeAllPanes } from './features/panes.js';
import { isZen, setZen } from './features/focus.js';

import { initShell } from './ui/shell.js';
import { renderHome, toggleShowAll } from './ui/home.js';
import { renderNotes } from './ui/notes-view.js';
import { promptPaste, promptUrl } from './ui/dialogs.js';
import { pickDrawingFile, renderDrawings } from './ui/canvas-view.js';

/* ================= Wiring ================= */
const pickFile = () => $('#fileInput').click();

$('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

$('#qOpen').addEventListener('click', pickFile);
$('#rOpen').addEventListener('click', pickFile);
$('#emptyOpen').addEventListener('click', pickFile);
$('#qUrl').addEventListener('click', promptUrl);
$('#rUrl').addEventListener('click', promptUrl);
$('#qPaste').addEventListener('click', promptPaste);
$('#rPaste').addEventListener('click', promptPaste);
$('#qSample').addEventListener('click', openSample);
$('#rCloseAll').addEventListener('click', closeAllPanes);
$('#wsAdd').addEventListener('click', () => { addWorkspace(); route('read'); });
$('#viewAllNotes').addEventListener('click', () => route('notes'));
$('#showAllFiles').addEventListener('click', toggleShowAll);
$('#importDrawing').addEventListener('click', pickDrawingFile);
$('#themeBtn').addEventListener('click', toggleTheme);
$('#zenBtn').addEventListener('click', () => setZen(!isZen()));
$('#zenExit').addEventListener('click', () => { setZen(false); $('#zenBtn').focus(); });

/* Drop a Markdown file anywhere on the window. */
let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; });
addEventListener('dragover', e => { e.preventDefault(); });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); });
addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

/* ================= Boot ================= */
(async function boot() {
  applyTheme();
  initShell();

  try {
    const [f, n, dr] = await Promise.all([dbAll('files'), dbAll('notes'), dbAll('drawings')]);
    setFiles(f || []);
    setNotes((n || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    setDrawings(dr || []);
  } catch (err) {
    console.warn('Folio: could not read saved data', err);
  }

  await loadPrefs();
  applyHighlight();

  addWorkspace('Tab 1', { quiet: true });
  setActiveWs(workspaces[0].id);
  selectWorkspace(workspaces[0].id);

  renderHome();
  renderNotes();
  renderDrawings();
  emit(EVENTS.PANES);
  route(hashView() || 'home', { replace: true });
})();
