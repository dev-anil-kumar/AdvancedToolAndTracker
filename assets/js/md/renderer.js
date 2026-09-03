/**
 * Markdown → safe DOM.
 *
 *   marked (GFM)  →  DOMPurify  →  highlight.js  →  enhancements
 *
 * The libraries arrive as globals from pinned CDN <script> tags in index.html.
 * Nothing is inserted into the document without passing through DOMPurify.
 */
import { el } from '../core/dom.js';

marked.use({ gfm: true, breaks: false });

export function renderMarkdown(article, src) {
  const html = marked.parse(src == null ? '' : String(src));
  article.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] });
  enhance(article);
}

function slugify(text, seen) {
  const base = (text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')) || 'section';
  let s = base, i = 2;
  while (seen.has(s)) s = base + '-' + i++;
  seen.add(s);
  return s;
}

export function enhance(root) {
  const seen = new Set();

  /* Index top-level blocks: notes remember their position by this number. */
  [...root.children].forEach((child, i) => child.setAttribute('data-b', String(i)));

  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    if (!h.id) h.id = slugify(h.textContent || '', seen);
    if (/^H[23]$/.test(h.tagName)) {
      const a = el('a', 'anchor', '#');
      a.href = '#' + h.id;
      a.setAttribute('aria-label', 'Link to this section');
      h.insertBefore(a, h.firstChild);
    }
  });

  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });

  root.querySelectorAll('table').forEach(t => {
    if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
    const wrap = el('div', 'table-wrap');
    t.replaceWith(wrap);
    wrap.appendChild(t);
  });

  root.querySelectorAll('li > input[type="checkbox"]').forEach(cb => {
    const li = cb.closest('li');
    li.classList.add('task');
    if (cb.checked) li.classList.add('done');
    cb.disabled = true;
  });

  root.querySelectorAll('pre > code').forEach(code => {
    try { hljs.highlightElement(code); } catch (e) { /* unknown language */ }
  });
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const btn = el('button', 'copy', 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.innerText); btn.textContent = 'Copied'; }
      catch (e) { btn.textContent = 'Press ⌘C'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    });
    wrap.appendChild(btn);
  });
}
