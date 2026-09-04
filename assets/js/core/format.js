/**
 * Display formatting. Pure functions — no DOM, no state.
 */

export function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
export function kindLabel(rec) {
  if (rec.kind === 'pdf') return 'PDF';
  if (rec.kind === 'sheet') return 'Sheet';
  if (rec.kind === 'url') { try { return new URL(rec.source).hostname.replace(/^www\./, ''); } catch (e) { return 'Link'; } }
  if (rec.kind === 'paste') return 'Pasted';
  if (rec.kind === 'sample') return 'Sample';
  return 'File';
}
export const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
