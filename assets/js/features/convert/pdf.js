/**
 * PDF → Markdown.
 *
 * A PDF has no paragraphs. It has glyphs at coordinates, and everything a
 * reader takes for granted — that these two lines are one sentence, that this
 * line is a heading, that "Page 4 of 12" is not part of the text — has to be
 * inferred from position and size. That inference is what this file is.
 *
 * Turning the document into Markdown rather than drawing it means every part
 * of the app already works on it: it opens in a pane, sits beside other
 * documents, takes notes with block indices, exports, and reads in focus mode.
 * What it gives up is layout and images. For a document you intend to *read*
 * that is the right trade; for one you need to see exactly, it is not.
 *
 * The two functions worth knowing are pure, and are where the judgement lives:
 * itemsToLines turns glyph runs into lines, and linesToMarkdown turns lines
 * into prose. Neither touches pdf.js, so both can be tested on their own.
 */
import { CHROME_SHARE, HEAD_RATIO, PDF_PAGE_MAX } from '../../core/config.js';
import { pdfLib } from './loader.js';

/* A bullet, or a number that starts a list item. */
const BULLET = /^([•▪◦‣·∙*]|[-–—](?=\s))\s*/;
const NUMBERED = /^(\d{1,3})[.)]\s+/;
const ENDS_SENTENCE = /[.!?:;”’"')\]]$/;

/**
 * Glyph runs → lines.
 *
 * pdf.js hands back text in pieces whose only reliable relationship is where
 * they sit. Pieces on the same baseline belong to one line; a gap wider than a
 * fraction of the type size is a word space that carries no character of its
 * own, which is why "wordbreaks" would otherwise appear all through the text.
 */
export function itemsToLines(items) {
  const glyphs = (items || [])
    .filter(it => it && typeof it.str === 'string')
    .map(it => {
      const m = it.transform || [1, 0, 0, 1, 0, 0];
      return {
        text: it.str,
        x: m[4] || 0,
        y: m[5] || 0,
        width: it.width || 0,
        size: Math.abs(m[3]) || it.height || 10
      };
    })
    .filter(g => g.text.length);

  /* Down the page, then across it. */
  glyphs.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let current = null;
  glyphs.forEach(g => {
    const sameLine = current && Math.abs(current.y - g.y) <= Math.max(1.5, g.size * 0.4);
    if (!sameLine) {
      current = { text: g.text, size: g.size, y: g.y, x: g.x, right: g.x + g.width };
      lines.push(current);
      return;
    }
    const gap = g.x - current.right;
    const needsSpace = gap > g.size * 0.18 && !/\s$/.test(current.text) && !/^\s/.test(g.text);
    current.text += (needsSpace ? ' ' : '') + g.text;
    current.size = Math.max(current.size, g.size);
    current.right = Math.max(current.right, g.x + g.width);
    current.x = Math.min(current.x, g.x);
  });

  return lines
    .map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter(l => l.text.length);
}

/**
 * The running heads and page numbers that repeat on most pages.
 *
 * Digits are blanked before comparing, so "Page 3 of 12" and "Page 4 of 12"
 * count as the same furniture. Only the first and last two lines of a page are
 * candidates, and a line has to appear on at least two of them — which is why
 * a one-page document never loses anything, and a title, appearing once, is
 * never mistaken for a running head.
 */
export function pageFurniture(pages, share = CHROME_SHARE) {
  if (pages.length < 2) return new Set();
  const flat = (text) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const counts = new Map();
  pages.forEach(lines => {
    const edges = lines.slice(0, 2).concat(lines.slice(-2));
    new Set(edges.map(l => flat(l.text))).forEach(key => counts.set(key, (counts.get(key) || 0) + 1));
  });
  const enough = Math.max(2, Math.ceil(pages.length * share));
  const drop = new Set();
  counts.forEach((n, key) => { if (n >= enough && key.length && key.length < 90) drop.add(key); });
  return drop;
}

/** The type size most of the words are set in — the yardstick for headings. */
export function bodySize(pages) {
  const weight = new Map();
  pages.forEach(lines => lines.forEach(l => {
    const bucket = Math.round(l.size * 2) / 2;
    weight.set(bucket, (weight.get(bucket) || 0) + l.text.length);
  }));
  let best = 10, most = -1;
  weight.forEach((w, size) => { if (w > most) { most = w; best = size; } });
  return best;
}

/**
 * The type sizes used for headings, biggest first.
 *
 * Levels come from this ranking rather than from fixed ratios, because what
 * makes a heading a heading is that it is bigger than the ones under it — not
 * that it is some particular multiple of the body. A report set in 22pt and
 * 14pt gets an h1 and an h2, which is what a reader would call them, where a
 * ratio test would have called the 14pt an h3 and skipped a level.
 */
export function headingSizes(pages, body) {
  const sizes = new Set();
  pages.forEach(lines => lines.forEach(line => {
    if (line.size / body >= HEAD_RATIO && line.text.length <= 120) {
      sizes.add(Math.round(line.size * 2) / 2);
    }
  }));
  return [...sizes].sort((a, b) => b - a);
}

/** Half the gap between one line and the next, as this page usually sets it. */
function typicalGap(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/* Text that would be read as Markdown it was never meant to be. */
const escapeBody = (text) => text.replace(/^([#>])/, '\\$1');

/**
 * Lines → Markdown.
 *
 * @param {Array<Array<object>>} pages  lines per page, from itemsToLines
 * @returns {string}
 */
export function linesToMarkdown(pages) {
  const furniture = pageFurniture(pages);
  const flat = (text) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const body = bodySize(pages);
  const ranks = headingSizes(pages, body);
  const levelOf = (size) => {
    const at = ranks.indexOf(Math.round(size * 2) / 2);
    return Math.min(6, (at < 0 ? ranks.length : at) + 1);
  };

  const blocks = [];
  let para = [];                       // lines gathering into one paragraph
  let list = null;                     // { ordered, items: [] }

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(escapeBody(joinLines(para)));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list.items.map((text, i) =>
      (list.ordered ? (i + 1) + '. ' : '- ') + escapeBody(text)).join('\n'));
    list = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  pages.forEach((lines, pageAt) => {
    const kept = lines.filter((l, i) => {
      const edge = i < 2 || i >= lines.length - 2;
      return !(edge && furniture.has(flat(l.text)));
    });
    if (!kept.length) return;

    const gap = typicalGap(kept) || body * 1.2;
    const widest = Math.max.apply(null, kept.map(l => l.right - l.x));
    /* A page break is a paragraph break: the last line of a page is short for
       reasons of layout, not of meaning, but joining across is worse. */
    if (pageAt > 0) flushAll();

    kept.forEach((line, i) => {
      const previous = i > 0 ? kept[i - 1] : null;
      const ratio = line.size / body;
      const bullet = BULLET.test(line.text);
      const numbered = NUMBERED.test(line.text);

      /* A heading is bigger than the body and short enough to be a label. */
      if (ratio >= HEAD_RATIO && line.text.length <= 120 && !bullet && !numbered) {
        flushAll();
        blocks.push('#'.repeat(levelOf(line.size)) + ' ' + line.text.replace(/^#+\s*/, ''));
        return;
      }

      if (bullet || numbered) {
        flushPara();
        const ordered = numbered && !bullet;
        if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
        list.items.push(line.text.replace(bullet ? BULLET : NUMBERED, '').trim());
        return;
      }

      /* A line that continues a list item is indented past the marker. */
      if (list && previous && line.x > previous.x + line.size * 0.5) {
        list.items[list.items.length - 1] = joinLines([
          { text: list.items[list.items.length - 1] }, line
        ]);
        return;
      }
      flushList();

      if (previous && breaksParagraph(previous, line, gap, widest)) flushPara();
      para.push(line);
    });
  });

  flushAll();
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Is this line the start of something new, or the rest of the last thing? */
function breaksParagraph(previous, line, gap, widest) {
  const fell = previous.y - line.y;
  if (fell > gap * 1.55) return true;                       // extra leading
  const short = (previous.right - previous.x) < widest * 0.62;
  if (short && ENDS_SENTENCE.test(previous.text)) return true;   // a finished line
  if (line.x > previous.x + line.size * 1.2) return true;        // a fresh indent
  return false;
}

/** Join lines into prose, mending words the layout broke across a line end. */
function joinLines(lines) {
  return lines.reduce((out, line) => {
    const text = line.text;
    if (!out) return text;
    if (/[‐-―-]$/.test(out) && /^[a-z]/.test(text)) return out.slice(0, -1) + text;
    return out + ' ' + text;
  }, '').replace(/\s+/g, ' ').trim();
}

/* ---------- The part that needs pdf.js ---------- */

/**
 * Read a PDF into Markdown.
 * @returns {{ markdown: string, pages: number, read: number, title: string }}
 */
export async function pdfToMarkdown(buffer) {
  const lib = await pdfLib();
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  } catch (err) {
    throw new Error('That file could not be opened as a PDF' +
      (err && /password/i.test(String(err.message)) ? ' — it is password-protected.' : '.'));
  }

  const read = Math.min(doc.numPages, PDF_PAGE_MAX);
  const pages = [];
  for (let n = 1; n <= read; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items));
    if (typeof page.cleanup === 'function') page.cleanup();
  }

  let title = '';
  try {
    const meta = await doc.getMetadata();
    title = (meta && meta.info && meta.info.Title ? String(meta.info.Title) : '').trim();
  } catch (err) { /* metadata is optional */ }

  const letters = pages.reduce((sum, lines) => sum + lines.reduce((n, l) => n + l.text.length, 0), 0);
  if (letters < Math.max(24, read * 12)) {
    throw new Error('That PDF has no text in it — it is a scan or a set of images, ' +
      'so there is nothing to read or take notes from.');
  }

  let markdown = linesToMarkdown(pages);
  if (read < doc.numPages) {
    markdown += '\n\n---\n\n*Read the first ' + read + ' of ' + doc.numPages + ' pages.*\n';
  }
  return { markdown, pages: doc.numPages, read, title };
}
