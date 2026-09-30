/**
 * Admin lockout — in-memory, per-process, keyed by IP.
 *
 * NOTE: this state resets on deploy and is not shared between processes.
 * Acceptable at current scale (single Render instance); a distributed store
 * (e.g. Redis) is needed for multi-instance deployments.
 */
const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 min sliding window
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min lockout

const attempts = new Map(); // ip -> { fails, firstFailAt, lockedUntil }

function check(ip) {
  const entry = attempts.get(ip);
  if (!entry) return { locked: false, retryAfterSec: 0 };
  if (entry.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

function recordFailure(ip) {
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || now - entry.firstFailAt > WINDOW_MS) {
    entry = { fails: 0, firstFailAt: now, lockedUntil: 0 };
  }
  entry.fails += 1;
  if (entry.fails >= MAX_FAILS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  attempts.set(ip, entry);
}

function clear(ip) {
  attempts.delete(ip);
}

module.exports = { check, recordFailure, clear };
