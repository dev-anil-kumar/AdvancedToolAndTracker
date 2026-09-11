/**
 * The code view: the whole document, formatted, coloured, with line numbers.
 *
 * highlight.js is already in the page, but it colours a key and a string value
 * identically — the distinction a reader most wants. So the colouring here goes
 * through the tokeniser in model.js instead, one span per token, built into a
 * fragment rather than an HTML string so nothing has to be escaped or trusted.
 *
 * Above JSON_CODE_MAX characters the spans are dropped and the text is written
 * as-is: a million-node document is still readable, and still opens at once.
 */
import { JSON_CODE_MAX } from '../../core/config.js';
import { el, markInto } from '../../core/dom.js';
import { tokenize } from './model.js';

/**
 * @param {HTMLElement} host   emptied and filled
 * @param {string} text        the formatted JSON to show
 * @param {string} highlight   a term to mark, or ''
 * @returns {{ lines: number, coloured: boolean, marks: number }}
 */
export function renderCode(host, text, highlight) {
  host.innerHTML = '';
  const src = String(text == null ? '' : text);
  const lines = src ? src.split('\n').length : 0;

  const gutter = el('div', 'jc-gutter');
  gutter.setAttribute('aria-hidden', 'true');
  const numbers = [];
  for (let i = 1; i <= lines; i++) numbers.push(i);
  gutter.textContent = numbers.join('\n');

  const code = el('pre', 'jc-code');
  code.tabIndex = 0;
  code.setAttribute('aria-label', 'Formatted JSON');

  let marks = 0;
  const coloured = src.length <= JSON_CODE_MAX;
  const needle = String(highlight || '').trim().toLowerCase();

  if (!coloured) {
    code.textContent = src;
  } else {
    const frag = document.createDocumentFragment();
    tokenize(src).forEach(tok => {
      /* Whitespace and punctuation take the block's own colour, so they need
         no element — which is a third of the spans on a large document. */
      if (tok.kind === 'space' || tok.kind === 'punct') {
        if (needle && tok.text.toLowerCase().includes(needle)) {
          const holder = el('span');
          marks += markInto(holder, tok.text, needle, 'jc-hit');
          frag.appendChild(holder);
        } else {
          frag.appendChild(document.createTextNode(tok.text));
        }
        return;
      }
      const span = el('span', 'jc-' + tok.kind);
      if (needle && tok.text.toLowerCase().includes(needle)) {
        marks += markInto(span, tok.text, needle, 'jc-hit');
      } else {
        span.textContent = tok.text;
      }
      frag.appendChild(span);
    });
    code.appendChild(frag);
  }

  host.append(gutter, code);
  return { lines, coloured, marks };
}
