// ============================================
//    GikoMart RUM beacon — vitals sampling
// ============================================
//
// Samples ~15% of tab sessions (one coin flip per session, remembered in
// sessionStorage) and sends ONE POST to /api/vitals when the page is hidden
// or closed. Loaded with `defer` from <head>: it never blocks parsing, runs
// after the document is parsed and before DOMContentLoaded, and its buffered
// PerformanceObservers still see every LCP/CLS/interaction entry recorded
// before it ran.
//
// Metrics are hand-rolled (no dependency — the official web-vitals package is
// deliberately avoided for a ~2 KB unminified need; the server allowlists
// every field anyway). Two known approximations, both acceptable for trend
// monitoring:
//   - INP = the longest observed interaction event duration, not the
//     full interaction-to-next-paint distribution the spec defines.
//   - CLS sums all shifts without session windows, which can only
//     overestimate.
// Browsers without PerformanceObserver, or users with saveData on, send
// nothing at all.

(function () {
  'use strict';

  const ENDPOINT = '/api/vitals';
  const SAMPLE_RATE = 0.15; // 15% of sessions
  const SESSION_KEY = 'gikomart_vitals_sampled';

  // One decision per tab session so reloads of the same session do not
  // double-count. sessionStorage can throw in some privacy modes — fall back
  // to a fresh per-page-load coin flip.
  function inSample() {
    try {
      const stored = sessionStorage.getItem(SESSION_KEY);
      if (stored === '1') return true;
      if (stored === '0') return false;
      const sampled = Math.random() < SAMPLE_RATE;
      sessionStorage.setItem(SESSION_KEY, sampled ? '1' : '0');
      return sampled;
    } catch (err) {
      return Math.random() < SAMPLE_RATE;
    }
  }

  // Data-saver users opted out of background transfers; respect that.
  const conn = navigator.connection || {};
  if (conn.saveData) return;

  if (!inSample()) return;
  if (!window.PerformanceObserver || !window.performance) return;

  let lcp;
  let cls = 0;
  let inp = 0;

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) lcp = entries[entries.length - 1].startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) { /* observer type unsupported — field stays absent */ }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.recentInput) cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (err) { /* observer type unsupported — field stays absent */ }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.interactionId && entry.duration > inp) inp = entry.duration;
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (err) { /* observer type unsupported — field stays absent */ }

  const round = (n) => (n === undefined ? undefined : Math.round(n * 100) / 100);

  function ttfb() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.responseStart > 0) return Math.round(nav.responseStart);
    } catch (err) { /* navigation timing unavailable */ }
    return undefined;
  }

  let sent = false;
  function send() {
    if (sent) return;
    sent = true;
    const payload = {
      path: window.location.pathname,
      lcp: round(lcp),
      inp: round(inp),
      cls: round(cls),
      ttfb: ttfb(),
      conn: conn.effectiveType || undefined,
      dpr: window.devicePixelRatio || undefined,
    };
    // keepalive lets the request outlive the page — required for a
    // send-on-hide beacon. Fire-and-forget: a failed report is never retried
    // (the next page view samples again on its own).
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch (err) { /* fetch unavailable — nothing to report */ }
  }

  // Standard flush points: hidden covers tab switch / minimize / mobile
  // backgrounding; pagehide covers close + navigation (Safari does not always
  // fire visibilitychange). The `sent` guard makes this idempotent.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
  });
  window.addEventListener('pagehide', send);
})();
