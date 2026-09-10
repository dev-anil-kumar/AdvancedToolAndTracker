/**
 * The line matching, off the main thread.
 *
 * Matching two large files is the one part of a comparison that can take long
 * enough to be felt, and a frozen tab is not a slow tab — it is a broken one.
 * So the work goes to a worker and the page stays live: the reader can still
 * scroll what is already there, switch panes, or start again with another file.
 *
 * Only the *matching* runs here, and only the edits come back. Rows are built
 * on the main thread from those edits, because a comparison of a large file has
 * far fewer edits than rows and shipping a few thousand small objects back
 * across the boundary costs nothing, where shipping half a million would cost
 * more than the matching did.
 *
 * This file is loaded as a module worker, so it imports the very same engine
 * the main thread uses. There is one implementation of the algorithm, and no
 * build step to keep two copies in step.
 */
import { diffLines, splitLines } from './text.js';

/* A worker that was constructed is not a worker that runs: a module that fails
   to import gets this far and no further. So it says hello, and the main thread
   waits for that before trusting it with any work — otherwise a job posted to a
   dead worker would be waited on forever. */
self.postMessage({ ready: true });

self.onmessage = (event) => {
  const job = event.data || {};
  try {
    const a = splitLines(job.aText).lines;
    const b = splitLines(job.bText).lines;
    const found = diffLines(a, b, job.opts || {});
    self.postMessage({ id: job.id, ok: true, ops: found.ops, exact: found.exact, moves: found.moves });
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String((err && err.message) || err) });
  }
};
