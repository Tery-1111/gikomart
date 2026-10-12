/**
 * Sentry instrumentation bootstrap — loaded as the FIRST require in server.js,
 * before any application module (express included), so the SDK can instrument
 * everything that follows.
 *
 * Configuration is environment-driven only:
 *   SENTRY_DSN            — required to send anything; without it the SDK is
 *                           not initialized at all (tests, local dev without
 *                           a DSN, and CI run with zero side effects).
 *   SENTRY_ENVIRONMENT    — optional tag (e.g. production / staging).
 *   SENTRY_RELEASE        — optional tag tying events to a deploy.
 *   SENTRY_TRACES_SAMPLE_RATE — optional; number in [0, 1]. Absent/unparsable
 *                               keeps tracing disabled. 0.1 is the intended
 *                               production setting; /health is never sampled.
 *
 * Test safety: initialization is skipped entirely when NODE_ENV === 'test'
 * (same gate the winston logger uses, src/config/logger.js).
 *
 * This file must never hold a DSN value or any other secret.
 */
const { init, setupExpressErrorHandler } = require('@sentry/node');

// Exported for server.js wiring and tests.
module.exports = { setupSentry, setupSentryErrorHandler, runDeliveryCheck };

// ── Temporary delivery diagnostic ─────────────────────────────────────────────
// Runs only when SENTRY_DELIVERY_CHECK is a valid identifier. It sends ONE info
// message tagged with the identifier and reports the flush outcome. flush()
// returning true means the queue drained; it is NOT proof of ingestion.
const DELIVERY_CHECK_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const DELIVERY_FLUSH_MS = 10000;
const DELIVERY_DEADLINE_MS = 12000;

// Returns the valid probe id, or null.
function deliveryCheckId(env) {
  const raw = env.SENTRY_DELIVERY_CHECK;
  return typeof raw === 'string' && DELIVERY_CHECK_ID_RE.test(raw) ? raw : null;
}

// Absent flag: silent, no work. Malformed or unusable flag: one skip line that
// names the reason and never echoes the value.
async function runDeliveryCheck({ sentry, logger, initialized, env = process.env }) {
  if (!env.SENTRY_DELIVERY_CHECK) return null;
  const probeId = deliveryCheckId(env);
  if (!probeId) {
    logger.warn('sentry_delivery_check_skipped', { reason: 'invalid_id' });
    return null;
  }
  if (env.NODE_ENV === 'test') {
    logger.warn('sentry_delivery_check_skipped', { reason: 'test_mode' });
    return null;
  }
  if (!initialized) {
    logger.warn('sentry_delivery_check_skipped', { reason: 'sdk_not_initialized' });
    return null;
  }

  let eventId = null;
  sentry.withScope((scope) => {
    scope.setTag('delivery_check', probeId);
    eventId = sentry.captureMessage(`gikomart-delivery-check ${probeId}`, 'info');
  });

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('deadline'), DELIVERY_DEADLINE_MS);
    if (timer.unref) timer.unref();
  });
  const flush = Promise.resolve()
    .then(() => sentry.flush(DELIVERY_FLUSH_MS))
    .then(
      (drained) => (drained ? 'queue_drained' : 'queue_not_drained'),
      () => 'flush_error',
    );
  let outcome;
  try {
    outcome = await Promise.race([flush, deadline]);
  } finally {
    clearTimeout(timer);
  }
  logger.info('sentry_delivery_check', {
    probeId, eventId, outcome, sdkActive: Boolean(sentry.getClient()),
  });
  return outcome;
}

// ── Performance tracing (opt-in via SENTRY_TRACES_SAMPLE_RATE) ───────────────
// Tracing options are added to init() ONLY when the variable parses as a number
// in [0, 1]; otherwise they are omitted entirely and tracing stays disabled —
// identical init options to the pre-tracing configuration.
function tracesSampleRateFrom(env) {
  const raw = env.SENTRY_TRACES_SAMPLE_RATE;
  if (typeof raw !== 'string' || !/^[0-9]*\.?[0-9]+$/.test(raw.trim())) return null;
  const rate = Number(raw.trim());
  return rate >= 0 && rate <= 1 ? rate : null;
}

// Sampler: 0 for /health (Render probes it constantly; spans there are all
// noise), otherwise the configured rate.
//
// Match on the `url.path` span attribute, NOT the span name: verified in the
// installed SDK (v11.6.0) that in default stream mode an incoming-request span
// starts named just after the HTTP method ("GET") and Express renames it to
// "GET <route>" later — a name-based check would never match. The sampling
// context carries the span's initial attributes, which include url.path
// (node_modules/@sentry/core tracing/trace.js + integrations/http/server-subscription.js).
function tracesSamplerFor(rate) {
  return ({ attributes } = {}) => {
    const path = attributes && attributes['url.path'];
    return typeof path === 'string' && /^\/health(\/|$)/.test(path) ? 0 : rate;
  };
}

function tracingInitOptions(env) {
  const rate = tracesSampleRateFrom(env);
  if (rate === null) return {}; // keep tracing fully disabled
  return { tracesSampleRate: rate, tracesSampler: tracesSamplerFor(rate) };
}

/**
 * SDK initialization only — no Express wiring. Called from server.js before
 * Express is created. Returns true when initialization happened, false when
 * skipped (test mode or missing DSN) — an honest, testable signal instead of a
 * global spy.
 */
function setupSentry() {
  if (process.env.NODE_ENV === 'test') return false;
  if (!process.env.SENTRY_DSN) return false; // Events without a DSN go nowhere.

  init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || undefined,
    release: process.env.SENTRY_RELEASE || undefined,
    // Error capture is automatic (expressIntegration); expected 4xx validation
    // failures are returned normally, not thrown/next(err)'d, so they are NOT
    // reported as crashes. Tracing stays off unless SENTRY_TRACES_SAMPLE_RATE
    // parses (see tracingInitOptions above).
    ...tracingInitOptions(process.env),
    // Privacy for spans, mirroring the beforeSend policy below. Verified in the
    // installed SDK: v11 streams spans by default and beforeSend NEVER runs on
    // them, so query params (which can carry claim tokens / webhook challenge
    // values) must be disabled at the data-collection layer — this also strips
    // the query string from span URLs. databaseQueryData:false drops bound
    // parameters and result data; the parameterized query text itself is not a
    // switchable field in this SDK and contains no user data at collection time.
    dataCollection: { urlQueryParams: false, databaseQueryData: false },
    // SDK debug output only while a valid delivery-check flag is set.
    debug: deliveryCheckId(process.env) !== null,
    // Defense-in-depth against accidentally leaking sensitive payloads through
    // event data: drop any request body, cookies, and URL query parameters.
    // The URL's path component is preserved so the route remains useful for
    // grouping, but ?query=value is removed — SDK v11 captures query strings
    // by default and token-bearing parameters (payment callbacks, grants)
    // must never leave the process.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        if (typeof event.request.url === 'string') {
          // Strip the query component, preserving the path (and hash-free form).
          const qIdx = event.request.url.indexOf('?');
          if (qIdx !== -1) event.request.url = event.request.url.slice(0, qIdx);
        }
      }
      return event;
    },
  });

  return true;
}

/**
 * Registers Sentry's Express error-capture middleware on `app`.
 *
 * MUST be called AFTER all routes are registered and BEFORE the app's final
 * error-handling middleware — per the documented v7→v8 handler semantics:
 * an Express error handler only observes errors raised by handlers mounted
 * earlier in the stack, and the existing final errorHandler must still see the
 * error (Sentry's handler forwardss via next) to log it and send the response.
 *
 * A no-op in test mode / without a DSN so tests and CI are untouched.
 */
function setupSentryErrorHandler(app) {
  if (process.env.NODE_ENV === 'test') return false;
  if (!process.env.SENTRY_DSN) return false;
  setupExpressErrorHandler(app);
  return true;
}
