/**
 * The two modal forms: open-from-URL and paste-Markdown. Native <dialog>, so
 * focus trapping and Escape come for free.
 */
import { $, $$ } from '../core/dom.js';
import { addDoc, deriveName, loadFromUrl } from '../features/library.js';
import { openDoc } from '../features/panes.js';

$$('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

function openDialog(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');           // very old browsers: inline fallback
}

const urlDlg = $('#urlDlg');
export function promptUrl() { $('#urlErr').textContent = ''; openDialog(urlDlg); setTimeout(() => $('#urlField').focus(), 30); }
$('#urlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#urlSubmit'), value = $('#urlField').value.trim();
  if (!value) return;
  $('#urlErr').textContent = '';
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    await loadFromUrl(value);
    urlDlg.close();
    $('#urlField').value = '';
  } catch (err) {
    $('#urlErr').textContent = err.message || String(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Download & read';
  }
});

const pasteDlg = $('#pasteDlg');
export function promptPaste() {
  $('#pasteErr').textContent = '';
  openDialog(pasteDlg);
  setTimeout(() => $('#pasteText').focus(), 30);
}
$('#pasteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#pasteText').value;
  if (!text.trim()) { $('#pasteErr').textContent = 'Nothing to save yet.'; return; }
  const title = $('#pasteTitle').value.trim();
  const rec = await addDoc({ name: title || deriveName(text), kind: 'paste', source: 'pasted', content: text });
  pasteDlg.close();
  $('#pasteText').value = ''; $('#pasteTitle').value = '';
  openDoc(rec.id);
});
