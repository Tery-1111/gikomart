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
 *
 * Test safety: initialization is skipped entirely when NODE_ENV === 'test'
 * (same gate the winston logger uses, src/config/logger.js).
 *
 * This file must never hold a DSN value or any other secret.
 */
const { init, setupExpressErrorHandler } = require('@sentry/node');

// Exported for server.js wiring and tests.
module.exports = { setupSentry, setupSentryErrorHandler };

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
    // Error monitoring only (no tracing). The SDK's expressIntegration
    // captures errors from routes/middleware automatically; expected
    // validation failures are 4xx and are NOT reported as crashes because
    // they are returned normally, not thrown/next(err)'d as unhandled errors.
    tracesSampleRate: undefined,
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
