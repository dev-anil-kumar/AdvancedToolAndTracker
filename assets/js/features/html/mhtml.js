/**
 * A dependency-free MHTML reader.
 *
 * Chrome's "Webpage, Single File" (.mhtml / .mht) is a MIME multipart archive:
 * one text/html part plus every image, stylesheet and font the page referenced,
 * each announced by a Content-Location (its original URL) or a Content-ID. This
 * module flattens that archive back into a single self-contained HTML string,
 * with every resource rewritten to an inline `data:` URI, so the reader can show
 * the page exactly as it was saved without reaching back out to the network.
 *
 * The approach is deliberately pragmatic rather than a full RFC 2045 parser: we
 * decode each part's bytes, build a map from every known location to a data URI,
 * and do a longest-first string replace across the root HTML. It is robust to a
 * malformed part (that part is skipped, not fatal) but makes no attempt to be a
 * general-purpose email library.
 */

/** Does this text look like a MIME multipart archive rather than plain HTML? */
export function isMhtml(text) {
  const head = String(text == null ? '' : text).slice(0, 2000);
  // Plain HTML begins with a doctype or a tag; an archive never does.
  if (/^\s*<(?:!doctype|html|\?xml)/i.test(head)) return false;
  // The tell-tale opening headers of what Chrome and friends save.
  if (/^(From:|MIME-Version:|Content-Type:\s*multipart\/related)/im.test(head)) return true;
  // Or a related multipart with an explicit boundary, wherever it sits.
  return /content-type:\s*multipart\/related[^]*?boundary=/i.test(head);
}

/** Turn an MHTML archive into a single self-contained HTML string. */
export function mhtmlToHtml(text) {
  const raw = String(text == null ? '' : text).replace(/^﻿/, '');

  // 1. Top-level headers: everything up to the first blank line.
  const topSplit = splitHeaders(raw);
  const topHeaders = parseHeaders(topSplit.headers);
  const boundary = readBoundary(topHeaders['content-type'] || '');
  if (!boundary) throw new Error('This does not look like a valid MHTML archive.');

  // The archive may name its root part explicitly, either through a top-level
  // Content-Location or via the multipart's `start` parameter (a Content-ID).
  const rootLocation = (topHeaders['content-location'] || '').trim();
  const startId = stripAngle(readParam(topHeaders['content-type'] || '', 'start'));

  // 2. Carve the body into parts on the `--<boundary>` delimiters, dropping the
  //    preamble before the first delimiter and the `--<boundary>--` terminator.
  const parts = splitParts(topSplit.body, boundary);

  // 3–4. Decode each part and note its content type and identifiers.
  const decoded = [];
  for (const chunk of parts) {
    try {
      const { headers: rawHead, body } = splitHeaders(chunk);
      const headers = parseHeaders(rawHead);
      const type = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const location = (headers['content-location'] || '').trim();
      const cid = stripAngle(headers['content-id'] || '');
      const encoding = (headers['content-transfer-encoding'] || '').trim().toLowerCase();
      const bytes = decodeBody(body, encoding); // a binary string (one char per byte)
      decoded.push({ type, location, cid, bytes });
    } catch (err) {
      // A single malformed part should never sink the whole archive.
      console.warn('Folio: skipping an unreadable MHTML part', err);
    }
  }

  // 5. Find the root HTML part: the one the archive points at, else the first
  //    text/html part we decoded.
  const root =
    (startId && decoded.find(p => p.cid && p.cid === startId)) ||
    (rootLocation && decoded.find(p => p.location && p.location === rootLocation)) ||
    decoded.find(p => p.type === 'text/html');
  if (!root) throw new Error('This does not look like a valid MHTML archive.');

  // The root's bytes are UTF-8 text; everything else stays as raw bytes.
  let html = binaryToUtf8(root.bytes);

  // 6. Map every other part's location and cid to a data: URI.
  const replacements = [];
  for (const part of decoded) {
    if (part === root) continue;
    const type = part.type || 'application/octet-stream';
    const dataUri = 'data:' + type + ';base64,' + btoaBinary(part.bytes);
    if (part.location) replacements.push([part.location, dataUri]);
    if (part.cid) replacements.push(['cid:' + part.cid, dataUri]);
  }

  // 7. Replace longest keys first so a location is never clobbered by a shorter
  //    substring of itself. We swap the full absolute location, and — best
  //    effort — a relative trailing form the HTML might use instead.
  replacements.sort((a, b) => b[0].length - a[0].length);
  for (const [needle, dataUri] of replacements) {
    html = replaceAll(html, needle, dataUri);
    const relative = relativeForm(needle);
    if (relative && relative !== needle) html = replaceAll(html, relative, dataUri);
  }

  // 8. Done.
  return html;
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
    if (/^\s/.test(line) && current) {
      out[current] += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    current = line.slice(0, idx).trim().toLowerCase();
    if (!(current in out)) out[current] = line.slice(idx + 1).trim();
  }
  return out;
}

/** Read the boundary from a Content-Type value; handles quotes and no quotes. */
function readBoundary(contentType) {
  return readParam(contentType, 'boundary');
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
  const pieces = body.split(delimiter);
  // pieces[0] is the preamble; the last piece begins with "--" (the terminator).
  for (let i = 1; i < pieces.length; i++) {
    let piece = pieces[i];
    if (/^--/.test(piece)) break; // reached the terminator
    // Each real delimiter is followed by a newline; drop that leading break.
    piece = piece.replace(/^\r?\n/, '');
    out.push(piece);
  }
  return out;
}

/* ---------- transfer-encoding decoders ---------- */

/** Decode a part body to a binary string (each character is one byte). */
function decodeBody(body, encoding) {
  if (encoding === 'base64') return decodeBase64(body);
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  // 7bit, 8bit, binary or unspecified: the body is already the bytes.
  return body;
}

/** Base64 → binary string, ignoring the whitespace archives sprinkle in. */
function decodeBase64(body) {
  const clean = String(body).replace(/[^A-Za-z0-9+/=]/g, '');
  try { return atob(clean); }
  catch (err) { return ''; }
}

/** Quoted-printable → binary string: soft line breaks vanish, =XX becomes a byte. */
function decodeQuotedPrintable(body) {
  return String(body)
    .replace(/=\r?\n/g, '')                       // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/* ---------- byte and text helpers ---------- */

/**
 * Base64-encode a binary string. btoa only accepts characters in 0–255, which a
 * binary string already satisfies, so we can hand it straight over — but we mask
 * to a byte just in case a stray wide character slipped through.
 */
function btoaBinary(binary) {
  const s = String(binary);
  try {
    return btoa(s);
  } catch (err) {
    // Rebuild a strictly-byte string, then encode.
    let clean = '';
    for (let i = 0; i < s.length; i++) clean += String.fromCharCode(s.charCodeAt(i) & 0xff);
    try { return btoa(clean); } catch (e) { return ''; }
  }
}

/** Interpret a binary string as UTF-8 and return proper JS text. */
function binaryToUtf8(binary) {
  const s = String(binary);
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return new TextDecoder('utf-8').decode(bytes);
  } catch (err) {
    return s; // best effort: hand back what we have
  }
}

/** Replace every literal occurrence of `needle` with `value` (no regex magic). */
function replaceAll(haystack, needle, value) {
  if (!needle) return haystack;
  return haystack.split(needle).join(value);
}

/**
 * A best-effort relative form of an absolute URL: the path (and query) with the
 * scheme and host removed, so `https://site/img/a.png` can also match a bare
 * `/img/a.png` reference in the saved markup.
 */
function relativeForm(location) {
  try {
    const u = new URL(location);
    return u.pathname + u.search;
  } catch (err) {
    return '';
  }
}
