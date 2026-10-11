import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Test-safe checks of the Sentry integration — the SDK is always mocked here,
// so nothing is ever initialized or sent to any real Sentry project.

const require = createRequire(import.meta.url);

// ── Fake @sentry/node injected the same way every other suite mocks modules ──
const sentryCalls = { init: 0, setupHandlers: 0, initOptions: null, handlerApp: null };

// Recreated fresh for each test so require-cache injection takes hold.
const freshInstrument = () => {
  // Reset per-test bookkeeping so try/catch failures can't carry stale counts.
  sentryCalls.init = 0; sentryCalls.setupHandlers = 0; sentryCalls.initOptions = null; sentryCalls.handlerApp = null;
  const resolved = require.resolve('@sentry/node');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, path: resolved,
    exports: {
      init: (opts) => { sentryCalls.init += 1; sentryCalls.initOptions = opts; },
      // The fake registers a REAL error-handling middleware (arity-4) that
      // forwards via next(err) — exactly the documented contract.
      setupExpressErrorHandler: (app) => {
        sentryCalls.setupHandlers += 1; sentryCalls.handlerApp = app;
        app.use(function sentryErrorHandler(err, req, res, next) { next(err); });
      },
    },
  };
  const instPath = require.resolve('../instrument.js');
  delete require.cache[instPath];
  return require('../instrument.js');
};

describe('instrument.js (Sentry integration)', () => {
  const ORIGINAL = { env: { ...process.env } };
  const restore = () => {
    process.env = { ...ORIGINAL.env };
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_RELEASE;
    process.env.NODE_ENV = 'test';
  };
  restore();

  it('1. SDK init is SKIPPED in test mode even when a DSN is present', () => {
    process.env.NODE_ENV = 'test';
    process.env.SENTRY_DSN = 'https://mock-key@mock.ingest.sentry.io/000';
    const instrument = freshInstrument();
    expect(instrument.setupSentry()).toBe(false);
    expect(sentryCalls.init).toBe(0);
    expect(instrument.setupSentryErrorHandler({})).toBe(false);
    expect(sentryCalls.setupHandlers).toBe(0);
  });

  it('2. missing DSN does not break startup and skips everything', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SENTRY_DSN;
    const instrument = freshInstrument();
    expect(instrument.setupSentry()).toBe(false);
    expect(instrument.setupSentryErrorHandler({})).toBe(false);
    expect(sentryCalls.init).toBe(0);
    expect(sentryCalls.setupHandlers).toBe(0);
  });

  it('3. server.js registers the Sentry error handler AFTER all routes and BEFORE the final errorHandler', async () => {
    // Structural wiring: parse server.js's app.use/get sequence and confirm the
    // SETUP_CALL position relative to route mounts and the final errorHandler.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const lastRouteIdx = src.lastIndexOf("require('./src/routes/');") >= 0
      ? src.lastIndexOf("require('./src/routes/')")
      : Math.max(
        src.lastIndexOf("require('./src/routes/listings')"),
        src.lastIndexOf("require('./src/routes/health')"),
      );
    const setupIdx = src.indexOf('setupSentryErrorHandler(app);');
    const errorIdx = src.indexOf("require('./src/middleware/errorHandler')");
    const initIdx = src.indexOf('setupSentry();');

    expect(initIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(src.indexOf("require('express')")); // init before express loads
    expect(setupIdx).toBeGreaterThan(lastRouteIdx); // after every route registration
    expect(errorIdx).toBeGreaterThan(setupIdx); // before the final error handler
  });

  it('4. a route-originated error reaches the app errorHandler AFTER passing the Sentry handler position (live Express stack)', async () => {
    // Full behavioral check with a REAL Express app: mount a throwing route,
    // then the Sentry handler position (mocked SDK returns the real registered
    // middleware via the fake captured call), then the app's errorHandler. This
    // proves route errors flow through the registered Sentry middleware and
    // onward to the existing response contract — not merely a text assertion.
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_DSN = 'https://mock-key@mock.ingest.sentry.io/000';
    const express = require('express');
    const instrument = freshInstrument();
    const app = express();

    app.get('/api/boom', () => { throw new Error('route-explosion'); });
    // Register Sentry handler the same way server.js does (after routes):
    instrument.setupSentryErrorHandler(app);
    // Mount the real app errorHandler last, same as server.js:
    const errorHandler = require('../src/middleware/errorHandler');
    app.use(errorHandler);

    const stack = (app._router || app.router).stack;
    expect(stack).toBeTruthy();

    // Prove positional order in the REAL Express stack: route layer first,
    // then the Sentry error handler (arity-4, non-route layer), then the app's
    // own error handler — so a route error necessarily visits Sentry first.
    const routeLayerIdx = stack.findIndex((l) => l.route && l.route.path === '/api/boom');
    expect(routeLayerIdx).toBeGreaterThan(-1);
    const sentryLayerIdx = stack.findIndex((l) => !l.route && l.handle.name === 'sentryErrorHandler');
    expect(sentryLayerIdx).toBeGreaterThan(routeLayerIdx);
    // Identify the app's real errorHandler by strict module identity (it is
    // exported anonymously, so name matching is unreliable).
    const appErrorIdx = stack.findIndex((l) => !l.route && l.handle === errorHandler);
    expect(appErrorIdx).toBeGreaterThan(sentryLayerIdx);

    // Now drive an actual request end-to-end through supertest: the route
    // throws, the registered Sentry middleware observes + forwards, and the
    // final errorHandler responds with the preserved prod-safe contract.
    const res = await request(app).get('/api/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal Server Error' });
  });

  it('5. beforeSend strips request body and cookies (no sensitive payloads captured)', () => {
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_DSN = 'https://mock-key@mock.ingest.sentry.io/000';
    const instrument = freshInstrument();
    instrument.setupSentry();
    const options = sentryCalls.initOptions;
    expect(typeof options.beforeSend).toBe('function');

    const event = {
      request: {
        data: { listingData: { sellerWhatsapp: '0712345678' }, phoneNumber: '0712345678' },
        cookies: 'session=abc; admin=1',
        url: '/api/payments/initiate-listing',
      },
    };
    const out = options.beforeSend(event);
    expect(out).toBe(event); // not dropped, just sanitized
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.url).toBe('/api/payments/initiate-listing');
  });

  it('5b. beforeSend removes query_string and strips the query component from request.url (path preserved)', () => {
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_DSN = 'https://mock-key@mock.ingest.sentry.io/000';
    const instrument = freshInstrument();
    instrument.setupSentry();
    const options = sentryCalls.initOptions;

    // v11 SDK captures query strings by default; token-bearing params (payment
    // callbacks, grant claims) must never leave the process.
    const event = {
      request: {
        url: 'https://staging.example.com/api/payments/status/INV-123?challenge=secret-webhook-challenge&token=claim-token',
        query_string: 'challenge=secret-webhook-challenge&token=claim-token',
      },
    };
    const out = options.beforeSend(event);
    expect(out).toBe(event);
    expect(out.request.query_string).toBeUndefined();
    expect(out.request.url).toBe('https://staging.example.com/api/payments/status/INV-123');

    // A query-less URL must be passed through untouched.
    const clean = { request: { url: '/api/listings' } };
    expect(options.beforeSend(clean).request.url).toBe('/api/listings');
  });

  it('6. SENTRY_ENVIRONMENT / SENTRY_RELEASE are passed through when configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_DSN = 'https://mock-key@mock.ingest.sentry.io/000';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    process.env.SENTRY_RELEASE = 'abc123';
    const instrument = freshInstrument();
    instrument.setupSentry();
    expect(sentryCalls.initOptions.environment).toBe('staging');
    expect(sentryCalls.initOptions.release).toBe('abc123');
    // Never hardcoded: options carry no literal DSN when env is the source.
    expect(sentryCalls.initOptions.dsn).toBe(process.env.SENTRY_DSN);
  });

  it('7. no-op DSN present but later removed does not leave a half-initialized SDK state', () => {
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_DSN = 'https://mock-key@mock.ingest.sentry.io/000';
    const instrument = freshInstrument();
    expect(instrument.setupSentry()).toBe(true); // initialized once
    delete process.env.SENTRY_DSN;
    // Second attempt with no DSN must not re-init and must be a clean no-op:
    expect(instrument.setupSentryErrorHandler({})).toBe(false);
    expect(sentryCalls.setupHandlers).toBe(0);
  });
});
