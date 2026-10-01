/**
 * Minimal counting semaphore.
 *
 * Bounds how many async operations run at once (maxConcurrent) while letting a
 * limited number of further callers wait their turn (maxQueued). Anything past
 * that is rejected immediately with code UPLOAD_BUSY so the caller can answer
 * with a retryable 503 instead of piling up work on a process that is already
 * out of headroom.
 *
 * Node built-ins only — no dependency, no worker/queue infrastructure.
 */

function createSemaphore(maxConcurrent, maxQueued) {
  let active = 0;
  const waiters = [];

  // Free one slot. If someone is waiting, hand the slot straight to them
  // (active stays the same, since one lease ends and another begins).
  function release() {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  }

  // Resolve to a release() function. Blocks (returns a pending promise) when all
  // slots are busy but the wait list still has room; throws UPLOAD_BUSY past that.
  function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(release);
    }
    if (waiters.length >= maxQueued) {
      const err = new Error('Upload capacity exhausted — server busy');
      err.code = 'UPLOAD_BUSY';
      throw err;
    }
    return new Promise((resolve) => {
      waiters.push(() => resolve(release));
    });
  }

  return { acquire };
}

module.exports = { createSemaphore };
