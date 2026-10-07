/**
 * Bounded in-memory TTL cache for the /api/listings browse endpoint.
 *
 * A plain Map of key → { value, expiresAt }. No dependencies. Failed lookups
 * return undefined; callers must treat any response as a cache only.
 *
 * DELIBERATELY IN-PROCESS (see docs/runbook-keep-warm.md for the contrast):
 * the keep-warm monitor is external because an in-process heartbeat fails
 * exactly when the app fails. This cache is the opposite — an in-process
 * cache INTENTIONALLY evaporates on restart, redeploy or scale-out. Losing
 * it is a non-event: the first request after a restart recomputes and the
 * cache repopulates. Correct-with-cold-cache is the design target, which is
 * why file-based or single-instance survivorship is NOT built here.
 *
 * ONE PROCESS = ONE SOURCE OF TRUTH: with the invalidation contract below,
 * every handler-visible write that can change the browse result set calls
 * invalidateListingsCache() before the response is sent. The only reads
 * served stale are the ≤60s window between a write and the NEXT write that
 * trips invalidation, by design.
 */

/** Factory. Default and per-set() expiry both in ms. */
function createTtlCache(defaultTtlMs = 60000) {
  const entries = new Map();

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      // Lazily drop the entry on read; the write paths above still drive the
      // correctness contract, this only bounds what a miss would cost.
      // (Expired-but-never-read entries deliberately linger until eviction
      // or the next explicit invalidation — bounded memory, no GC pressure.)
      if (Date.now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value, ttlMs = defaultTtlMs) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },

    /** Drops every cached entry — the shape all invalidations route through. */
    clear() {
      entries.clear();
    },

    size() {
      return entries.size;
    },
  };
}

// Process-scoped cache for the browse endpoint. Exported alongside the
// factory so tests can inject their own cache (via createTtlCache) AND so
// the module contract stays explicit rather than hidden inside the imports.
const listingsCache = createTtlCache();

// Invalidation seam every write path calls. Exported as a FUNCTION (not the
// cache object) so require.cache seams in tests can swap the cache cleanly
// without handlers re-reaching into module state — touching one call site is
// all a test needs to break invalidation deterministically.
function invalidateListingsCache() {
  listingsCache.clear();
}

module.exports = { createTtlCache, listingsCache, invalidateListingsCache };
