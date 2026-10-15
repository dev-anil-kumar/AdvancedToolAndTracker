/**
 * ```mermaid fences → diagrams, shared by the reader (md/renderer.js) and
 * Write's Markdown paste (features/write/paste.js).
 *
 * Each `pre > code.language-mermaid` is swapped for a centred <img> whose
 * src is the rendered SVG as a data: URL — an <img> survives both sanitizers
 * and is stored inline in a Write document like any other image. Mermaid is
 * ~3 MB, so it is only fetched the first time a diagram appears.
 */
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

let loading = null;
let seq = 0;

function load() {
  if (!loading) {
    loading = import(MERMAID_URL).then(m => {
      const mermaid = m.default;
      // htmlLabels off: <foreignObject> labels don't render inside an <img>.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false, flowchart: { htmlLabels: false } });
      return mermaid;
    });
    loading.catch(() => { loading = null; });   // offline: retry next time
  }
  return loading;
}

/** Render every mermaid fence under `root` in place. Bad diagrams stay as code. */
export async function renderMermaid(root) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  if (!blocks.length) return;
  let mermaid;
  try { mermaid = await load(); } catch (e) { return; }
  await Promise.all(blocks.map(async code => {
    const block = code.parentElement.closest('.code-wrap') || code.parentElement;
    try {
      const { svg: raw } = await mermaid.render('mermaid-' + (++seq), code.textContent);
      // Mermaid emits width="100%"; an <img> needs real pixel dimensions.
      const svgEl = new DOMParser().parseFromString(raw, 'image/svg+xml').documentElement;
      const [, , w, h] = (svgEl.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      if (w && h) { svgEl.setAttribute('width', w); svgEl.setAttribute('height', h); svgEl.removeAttribute('style'); }
      const svg = new XMLSerializer().serializeToString(svgEl);
      const p = document.createElement('p');
      p.style.textAlign = 'center';
      if (block.hasAttribute('data-b')) p.setAttribute('data-b', block.getAttribute('data-b'));
      const img = document.createElement('img');
      img.alt = 'Mermaid diagram';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      p.appendChild(img);
      block.replaceWith(p);
    } catch (e) { /* invalid syntax — leave the code block */ }
  }));
}
