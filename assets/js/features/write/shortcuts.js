/**
 * The Write keymap, and Markdown autoformat while typing.
 *
 * Split into pure matchers (`lineTrigger`, `inlineTrigger`, `keyCombo`) and a
 * pair of thin DOM-facing functions that use them — the matchers take and
 * return plain strings/objects, so tests/smoke.mjs can exercise the pattern
 * matching without simulating a real contenteditable selection.
 *
 * `createWriteShortcuts(actions)` turns a table of named actions into one
 * keydown handler; an action the caller did not supply (typically because
 * the feature that would answer it — find, open, download, print — belongs
 * to a Phase-2 agent and is still a stub) falls back to a toast rather than
 * doing nothing silently.
 */
import { toast } from '../../core/toast.js';

/** A KeyboardEvent, boiled down to a comparable string like "mod+shift+l". */
export function keyCombo(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === ' ') key = 'space';
  parts.push(key);
  return parts.join('+');
}

/**
 * The whole keymap from the plan, as [combo, action name] pairs. `combo`
 * matches what keyCombo() produces; `action` is a key into the table passed
 * to createWriteShortcuts.
 */
export const WRITE_KEYMAP = [
  ['mod+b', 'bold'], ['mod+i', 'italic'], ['mod+u', 'underline'],
  ['mod+shift+x', 'strike'], ['mod+e', 'inlineCode'], ['mod+shift+h', 'highlight'],
  ['mod+k', 'link'],
  ['alt+1', 'h1'], ['alt+2', 'h2'], ['alt+3', 'h3'], ['alt+0', 'paragraph'],
  ['mod+shift+7', 'numberList'], ['mod+shift+8', 'bulletList'], ['mod+shift+9', 'checklist'],
  ['mod+shift+.', 'quote'], ['alt+c', 'codeBlock'],
  ['mod+]', 'indent'], ['mod+[', 'outdent'],
  ['mod+shift+l', 'alignLeft'], ['mod+shift+e', 'alignCenter'],
  ['mod+shift+r', 'alignRight'], ['mod+shift+j', 'alignJustify'],
  ['mod+\\', 'clearFormat'],
  ['mod+f', 'find'], ['mod+h', 'replace'], ['mod+s', 'save'], ['mod+o', 'open'],
  ['mod+shift+s', 'download'], ['mod+p', 'print'],
  ['mod+z', 'undo'], ['mod+shift+z', 'redo'],
  ['mod+/', 'shortcutSheet'], ['mod+shift+f', 'focusMode']
];

/**
 * One keydown handler for the whole keymap. `actions` maps an action name to
 * a function; a combo whose action has no function toasts instead of doing
 * nothing, since a silently dead shortcut looks like a bug rather than an
 * unfinished feature.
 */
export function createWriteShortcuts(actions) {
  const byCombo = new Map(WRITE_KEYMAP);
  return function onKeydown(e) {
    const combo = keyCombo(e);
    const name = byCombo.get(combo);
    if (!name) return;
    e.preventDefault();
    const fn = actions[name];
    if (typeof fn === 'function') fn(e);
    else toast('That isn’t ready yet.');
  };
}

/* ---------- Markdown autoformat ---------- */

/**
 * Does the text typed so far on this line start a block the way Markdown
 * would? `text` is everything in the block up to the caret, and the trigger
 * only fires right after the caller types the trailing space (or, for a
 * fence, the third backtick) — so "1. " matches but "1.x" does not.
 */
export function lineTrigger(text) {
  const t = String(text || '');
  let m;
  if ((m = /^(#{1,3}) $/.exec(t))) return { type: 'heading', level: m[1].length, cut: m[0].length };
  if (/^[-*] $/.test(t)) return { type: 'bullet', cut: 2 };
  if (/^\d+\. $/.test(t)) return { type: 'number', cut: t.length };
  if (/^\[\] $/.test(t)) return { type: 'checklist', cut: 3 };
  if (/^> $/.test(t)) return { type: 'quote', cut: 2 };
  if (/^```$/.test(t)) return { type: 'code', cut: 3 };
  return null;
}

/**
 * Is there an inline span — **bold**, *italic*, or `code` — that has just
 * been closed at the very end of `text`? Bold is checked before italic since
 * `**x**` also looks like two empty `*..*` pairs. Returns the match bounds
 * (as offsets into `text`) and the text the delimiters wrap.
 */
export function inlineTrigger(text) {
  const t = String(text || '');
  let m;
  if ((m = /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/.exec(t))) {
    return { type: 'bold', start: m.index, end: t.length, inner: m[1] };
  }
  if ((m = /(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/.exec(t))) {
    const start = m.index + (m[0].length - (1 + m[1].length + 1));
    return { type: 'italic', start, end: t.length, inner: m[1] };
  }
  if ((m = /`([^`]+)`$/.exec(t))) {
    return { type: 'code', start: m.index, end: t.length, inner: m[1] };
  }
  return null;
}

/**
 * Wire autoformat onto a live sheet. Kept deliberately small: it reacts to
 * plain typing only (`e.inputType === 'insertText'`), reads the current
 * block's text up to the caret, and asks the pure matchers above what to do.
 * `cmds` is the command layer (features/write/commands.js) already bound to
 * this sheet.
 */
export function attachAutoformat(sheet, cmds) {
  sheet.addEventListener('input', (e) => {
    if (e.inputType && e.inputType !== 'insertText') return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const before = node.data.slice(0, range.startOffset);

    /* A fence is the one trigger with no trailing space, so check it first
       and only where the block is otherwise empty. */
    const line = lineTrigger(before);
    if (line && isLineStart(node, range)) {
      node.data = node.data.slice(range.startOffset);
      applyLineTrigger(line, cmds);
      return;
    }
    const inline = inlineTrigger(before);
    if (inline) applyInlineTrigger(node, range, inline, cmds);
  });
}

/** Is everything before the trigger text, in this block, blank? */
function isLineStart(node, range) {
  let block = node.parentElement;
  while (block && !/^(P|DIV|LI|H1|H2|H3)$/.test(block.tagName)) block = block.parentElement;
  if (!block) return true;
  const full = block.textContent || '';
  const before = (node.data || '').slice(0, range.startOffset);
  return full.trim() === before.trim();
}

function applyLineTrigger(line, cmds) {
  if (line.type === 'heading') cmds.heading(line.level);
  else if (line.type === 'bullet') cmds.bulletList();
  else if (line.type === 'number') cmds.numberList();
  else if (line.type === 'checklist') cmds.checklist();
  else if (line.type === 'quote') cmds.quote();
  else if (line.type === 'code') cmds.codeBlock();
}

function applyInlineTrigger(node, range, hit, cmds) {
  const text = node.data;
  const before = text.slice(0, hit.start);
  const after = text.slice(hit.end, range.startOffset) + text.slice(range.startOffset);
  node.data = before + hit.inner + after;
  const sel = window.getSelection();
  const wrap = document.createRange();
  wrap.setStart(node, before.length);
  wrap.setEnd(node, before.length + hit.inner.length);
  sel.removeAllRanges();
  sel.addRange(wrap);
  if (hit.type === 'bold') cmds.bold();
  else if (hit.type === 'italic') cmds.italic();
  else if (hit.type === 'code') cmds.inlineCode();
  sel.collapseToEnd();
}
