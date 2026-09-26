/**
 * A dependency-free MHTML reader.
 *
 * Chrome's "Webpage, Single File" (.mhtml / .mht) is a MIME multipart archive:
 * one text/html part plus every image, stylesheet, font and script the page
 * referenced, each announced by a Content-Location (its original URL) or a
 * Content-ID. This module flattens that archive back into a single
 * self-contained HTML string, with every resource rewritten to an inline value,
 * so the reader can show the page exactly as it was saved without ever reaching
 * back out to the network.
 *
 * The hard part is not decoding the parts — it is matching each reference in the
 * markup to the part that satisfies it. A saved page keeps its *original* URLs,
 * which come in every shape: absolute, root-relative, protocol-relative and
 * page-relative. A blind string replace only catches the absolute ones, which is
 * why an earlier version rendered pages unstyled. So instead we parse the HTML
 * into a real document, resolve every reference against the page's own address
 * the way a browser would, and look the result up in a map of the archive's
 * parts. Stylesheets are inlined as <style> (and their own url()s resolved),
 * images and scripts as data URIs or inline code. It is pragmatic rather than a
 * full RFC 2045 parser, and robust to a malformed part (that part is skipped,
 * not fatal), but makes no attempt to be a general-purpose email library.
 */

/** Does this text look like a MIME multipart archive rather than plain HTML? */
export function isMhtml(text) {
  const head = String(text == null ? '' : text).slice(0, 4000);
  // Plain HTML begins with a doctype or a tag; an archive never does.
  if (/^\s*<(?:!doctype|html|\?xml|body|div|head)/i.test(head)) return false;
  // The tell-tale opening headers of what Chrome and friends save.
  if (/^(From:|MIME-Version:|Snapshot-Content-Location:|Content-Type:\s*multipart\/related)/im.test(head)) return true;
  // Or a related multipart with an explicit boundary, wherever it sits.
  return /content-type:\s*multipart\/related[\s\S]*?boundary=/i.test(head);
}

/** Turn an MHTML archive into a single self-contained HTML string. */
export function mhtmlToHtml(text) {
  const raw = String(text == null ? '' : text).replace(/^﻿/, '');

  // 1. Top-level headers: everything up to the first blank line.
  const top = splitHeaders(raw);
  const topHeaders = parseHeaders(top.headers);
  const boundary = readParam(topHeaders['content-type'] || '', 'boundary');
  if (!boundary) throw new Error('This does not look like a valid MHTML archive.');

  // 2. Carve the body into parts on the `--<boundary>` delimiters.
  const parts = splitParts(top.body, boundary);

  // 3–4. Decode each part and note its type, address(es) and charset.
  const decoded = [];
  for (const chunk of parts) {
    try {
      const { headers: rawHead, body } = splitHeaders(chunk);
      const headers = parseHeaders(rawHead);
      const ctype = headers['content-type'] || '';
      decoded.push({
        type: ctype.split(';')[0].trim().toLowerCase(),
        charset: readParam(ctype, 'charset'),
        location: (headers['content-location'] || '').trim(),
        cid: stripAngle(headers['content-id'] || ''),
        bytes: decodeBody(body, (headers['content-transfer-encoding'] || '').trim().toLowerCase())
      });
    } catch (err) {
      // A single malformed part should never sink the whole archive.
      console.warn('Folio: skipping an unreadable MHTML part', err);
    }
  }

  // 5. Find the root HTML part: the one the archive points at, else the first
  //    text/html part we decoded.
  const startId = stripAngle(readParam(topHeaders['content-type'] || '', 'start'));
  const rootLoc = (topHeaders['content-location'] || '').trim();
  const root =
    (startId && decoded.find(p => p.cid && p.cid === startId)) ||
    (rootLoc && decoded.find(p => p.location && p.location === rootLoc)) ||
    decoded.find(p => p.type === 'text/html');
  if (!root) throw new Error('This does not look like a valid MHTML archive.');

  // The page's own address — everything relative resolves against it.
  const baseUrl = root.location || (topHeaders['snapshot-content-location'] || '').trim() || '';

  // 6. Index every other part by its absolute location and by its Content-ID.
  const byUrl = new Map();
  const byCid = new Map();
  for (const part of decoded) {
    if (part === root) continue;
    if (part.location) byUrl.set(part.location, part);
    if (part.cid) byCid.set(part.cid, part);
  }

  /** The part that satisfies a reference, resolved the way a browser would. */
  const lookup = (ref, base) => {
    if (!ref) return null;
    const t = ref.trim();
    if (!t || /^(data:|about:|blank|javascript:|#)/i.test(t)) return null;
    if (/^cid:/i.test(t)) return byCid.get(stripAngle(t.slice(4))) || null;
    const abs = resolveUrl(t, base || baseUrl);
    return byUrl.get(abs) || byUrl.get(t) || byUrl.get(stripHash(abs)) || null;
  };

  const asDataUri = (part) =>
    'data:' + (part.type || 'application/octet-stream') + ';base64,' + btoaBinary(part.bytes);

  /* Rewrite every url() and @import inside a stylesheet, resolved against that
     stylesheet's own address — a CSS file's background image is relative to the
     CSS, not to the page. Guarded against a cycle by a small depth budget. */
  const rewriteCss = (css, cssBase, depth) => {
    const budget = depth == null ? 3 : depth;
    let out = String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
      const part = lookup(ref, cssBase);
      return part ? 'url("' + asDataUri(part) + '")' : m;
    });
    out = out.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?/gi, (m, q, ref) => {
      const part = lookup(ref, cssBase);
      if (!part) return m;
      if (budget > 0 && (part.type === 'text/css' || /\.css($|\?)/i.test(ref))) {
        // Inline the imported sheet outright, so its own url()s resolve too.
        return '\n' + rewriteCss(decodeTextBytes(part.bytes, part.charset), part.location || cssBase, budget - 1) + '\n';
      }
      return '@import url("' + asDataUri(part) + '")';
    });
    return out;
  };

  // 7. Parse the root HTML and rewrite it through the DOM.
  const htmlText = decodeTextBytes(root.bytes, root.charset);
  let doc;
  try { doc = new DOMParser().parseFromString(htmlText, 'text/html'); }
  catch (err) { return htmlText; } // no DOM to lean on: hand back the markup

  // Stylesheets → inline <style>, with their own references resolved.
  qsa(doc, 'link[rel~="stylesheet" i][href], link[href$=".css" i]').forEach(link => {
    const part = lookup(link.getAttribute('href'), baseUrl);
    if (!part) return;
    const style = doc.createElement('style');
    const media = link.getAttribute('media');
    if (media) style.setAttribute('media', media);
    style.textContent = rewriteCss(decodeTextBytes(part.bytes, part.charset), part.location || baseUrl);
    link.replaceWith(style);
  });

  // Inline <style> blocks and style="" attributes.
  qsa(doc, 'style').forEach(s => { s.textContent = rewriteCss(s.textContent, baseUrl); });
  qsa(doc, '[style]').forEach(elm => elm.setAttribute('style', rewriteCss(elm.getAttribute('style'), baseUrl)));

  // External scripts → inline the code we hold; drop the ones we do not, since a
  // sandboxed offline frame cannot fetch them and a 404 helps no one.
  qsa(doc, 'script[src]').forEach(sc => {
    const part = lookup(sc.getAttribute('src'), baseUrl);
    if (!part) { sc.remove(); return; }
    const ns = doc.createElement('script');
    if (sc.type) ns.type = sc.type;
    ns.textContent = decodeTextBytes(part.bytes, part.charset);
    sc.replaceWith(ns);
  });

  // Images, media and their kin → data URIs.
  qsa(doc, 'img[src], input[type="image" i][src], embed[src], source[src], audio[src], video[src], track[src], iframe[src]').forEach(elm => {
    const part = lookup(elm.getAttribute('src'), baseUrl);
    if (part) elm.setAttribute('src', asDataUri(part));
  });
  qsa(doc, 'video[poster]').forEach(elm => {
    const part = lookup(elm.getAttribute('poster'), baseUrl);
    if (part) elm.setAttribute('poster', asDataUri(part));
  });

  // srcset on <img>/<source>: a comma-separated list of "url descriptor".
  qsa(doc, 'img[srcset], source[srcset]').forEach(elm => {
    const rewritten = elm.getAttribute('srcset').split(',').map(cand => {
      const bits = cand.trim().split(/\s+/);
      const part = lookup(bits[0], baseUrl);
      if (part) bits[0] = asDataUri(part);
      return bits.join(' ');
    }).join(', ');
    elm.setAttribute('srcset', rewritten);
  });

  // SVG <image>/<use> reference resources through href (or the legacy xlink:href).
  qsa(doc, 'image, use').forEach(elm => {
    const ref = elm.getAttribute('href') || elm.getAttribute('xlink:href');
    const part = lookup(ref, baseUrl);
    if (part) {
      if (elm.hasAttribute('href')) elm.setAttribute('href', asDataUri(part));
      if (elm.hasAttribute('xlink:href')) elm.setAttribute('xlink:href', asDataUri(part));
    }
  });

  // <link rel=icon / preload / etc.> → data URI so the tab icon still shows.
  qsa(doc, 'link[href]:not([rel~="stylesheet" i])').forEach(link => {
    const part = lookup(link.getAttribute('href'), baseUrl);
    if (part) link.setAttribute('href', asDataUri(part));
  });

  // A <base> keeps any leftover relative link resolving against the real site,
  // so clicking through a saved page goes somewhere sensible rather than nowhere.
  if (baseUrl && !doc.querySelector('base') && doc.head) {
    const base = doc.createElement('base');
    base.setAttribute('href', baseUrl);
    doc.head.insertBefore(base, doc.head.firstChild);
  }

  const doctype = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>\n' : '<!DOCTYPE html>\n';
  return doctype + doc.documentElement.outerHTML;
}

/* ---------- header and body carving ---------- */

/** Split a block at its first blank line into { headers, body }. */
function splitHeaders(block) {
  const m = /\r?\n\r?\n/.exec(block);
  if (!m) return { headers: block, body: '' };
  return { headers: block.slice(0, m.index), body: block.slice(m.index + m[0].length) };
}

/**
 * Parse header lines into a lower-cased map, honouring RFC 822 folding where a
 * continuation line begins with whitespace. Later duplicates lose to the first.
 */
function parseHeaders(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^\s/.test(line) && current) { out[current] += ' ' + line.trim(); continue; }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    if (!(current in out)) out[current] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Read a named parameter from a header value, quoted or bare. */
function readParam(value, name) {
  const re = new RegExp(name + '\\s*=\\s*("([^"]*)"|([^;\\s]+))', 'i');
  const m = re.exec(value || '');
  if (!m) return '';
  return (m[2] != null ? m[2] : m[3] || '').trim();
}

/** Strip the surrounding angle brackets from a Content-ID / start value. */
function stripAngle(value) {
  return String(value || '').trim().replace(/^<|>$/g, '');
}

/**
 * Split the multipart body into its parts on `--<boundary>` lines, discarding
 * the preamble before the first delimiter and the closing `--<boundary>--`.
 */
function splitParts(body, boundary) {
  const delimiter = '--' + boundary;
  const out = [];
  const pieces = String(body).split(delimiter);
  // pieces[0] is the preamble; the last piece begins with "--" (the terminator).
  for (let i = 1; i < pieces.length; i++) {
    let piece = pieces[i];
    if (/^--/.test(piece)) break;            // reached the terminator
    piece = piece.replace(/^\r?\n/, '');     // drop the break after the delimiter
    out.push(piece);
  }
  return out;
}

/* ---------- transfer-encoding decoders ---------- */

/** Decode a part body to a binary string (each character is one byte). */
function decodeBody(body, encoding) {
  if (encoding === 'base64') return decodeBase64(body);
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body; // 7bit, 8bit, binary or unspecified: already the bytes
}

/** Base64 → binary string, ignoring the whitespace archives sprinkle in. */
function decodeBase64(body) {
  const clean = String(body).replace(/[^A-Za-z0-9+/=]/g, '');
  try { return atob(clean); } catch (err) { return ''; }
}

/** Quoted-printable → binary string: soft line breaks vanish, =XX becomes a byte. */
function decodeQuotedPrintable(body) {
  return String(body)
    .replace(/=\r?\n/g, '')                    // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/* ---------- byte and text helpers ---------- */

/** Base64-encode a binary string, masking to bytes just in case. */
function btoaBinary(binary) {
  const s = String(binary);
  try { return btoa(s); }
  catch (err) {
    let clean = '';
    for (let i = 0; i < s.length; i++) clean += String.fromCharCode(s.charCodeAt(i) & 0xff);
    try { return btoa(clean); } catch (e) { return ''; }
  }
}

/** Interpret a binary string as text in the given charset (UTF-8 by default). */
function decodeTextBytes(binary, charset) {
  const s = String(binary);
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return new TextDecoder(charset && charset.trim() ? charset.trim() : 'utf-8').decode(bytes);
  } catch (err) {
    try { return new TextDecoder('utf-8').decode(Uint8Array.from(s, c => c.charCodeAt(0) & 0xff)); }
    catch (e) { return s; }
  }
}

/* ---------- URL helpers ---------- */

/** Resolve a reference against a base, the way the browser's own loader would. */
function resolveUrl(ref, base) {
  try { return new URL(ref, base || undefined).href; }
  catch (err) {
    try { return new URL(ref).href; } catch (e) { return ref; }
  }
}

const stripHash = (url) => String(url).replace(/#.*$/, '');

/** querySelectorAll as a plain array, tolerant of an invalid selector. */
function qsa(root, selector) {
  try { return Array.prototype.slice.call(root.querySelectorAll(selector)); }
  catch (err) { return []; }
}
