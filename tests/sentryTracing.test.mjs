import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// Focused tests for the opt-in performance-tracing configuration in
// instrument.js. The SDK is always a fake here — nothing is initialized for
// real and no network traffic occurs.

const require = createRequire(import.meta.url);

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// Loads instrument.js with a fake @sentry/node in the require cache (same
// technique as tests/sentry.test.mjs), capturing init options.
function loadInstrumentWithFakeInit() {
  const captured = { calls: [] };
  const resolved = require.resolve('@sentry/node');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, path: resolved,
    exports: {
      init: (opts) => captured.calls.push(opts),
      setupExpressErrorHandler: () => {},
    },
  };
  const instPath = require.resolve('../instrument.js');
  delete require.cache[instPath];
  return { instrument: require('../instrument.js'), captured };
}

function initOptionsWith(env) {
  process.env = { ...ORIGINAL_ENV, ...env, NODE_ENV: 'production' };
  const { instrument, captured } = loadInstrumentWithFakeInit();
  instrument.setupSentry();
  return captured.calls[0];
}

describe('tracing configuration (SENTRY_TRACES_SAMPLE_RATE)', () => {
  it('variable absent: init options carry no tracing keys (tracing disabled, options unchanged)', () => {
    const opts = initOptionsWith({ SENTRY_DSN: 'https://k@example.invalid/1' });
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    expect('tracesSampleRate' in opts).toBe(false);
    expect('tracesSampler' in opts).toBe(false);
  });

  it.each([
    'not-a-number',
    '-0.5',
    '1.5',
    '',
    '; rm -rf /',
  ])('invalid value %j: tracing stays disabled (no tracesSampleRate key)', (bad) => {
    const opts = initOptionsWith({
      SENTRY_DSN: 'https://k@example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: bad,
    });
    expect('tracesSampleRate' in opts).toBe(false);
    expect('tracesSampler' in opts).toBe(false);
  });

  it('valid rate: tracesSampleRate is set and tracesSampler is a function', () => {
    const opts = initOptionsWith({
      SENTRY_DSN: 'https://k@example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: '0.1',
    });
    expect(opts.tracesSampleRate).toBe(0.1);
    expect(typeof opts.tracesSampler).toBe('function');
  });

  it('rate of 0 is honored as a valid, explicit setting', () => {
    const opts = initOptionsWith({
      SENTRY_DSN: 'https://k@example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: '0',
    });
    expect(opts.tracesSampleRate).toBe(0);
  });

  it('health-check exclusion: sampler returns 0 for any method on /health', () => {
    const opts = initOptionsWith({
      SENTRY_DSN: 'https://k@example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: '0.1',
    });
    const sampler = opts.tracesSampler;
    // Stream-mode spans start named after the method; url.path is the reliable
    // matching key (verified in @sentry/core v11.6.0).
    expect(sampler({ attributes: { 'url.path': '/health' } })).toBe(0);
    expect(sampler({ attributes: { 'url.path': '/health/deep' } })).toBe(0);
    expect(sampler({ attributes: { 'url.path': '/health' }, name: 'GET' })).toBe(0);
  });

  it('sampler returns the configured rate for everything else, and handles a missing attributes object', () => {
    const opts = initOptionsWith({
      SENTRY_DSN: 'https://k@example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: '0.1',
    });
    const sampler = opts.tracesSampler;
    expect(sampler({ attributes: { 'url.path': '/api/listings' } })).toBe(0.1);
    expect(sampler({ attributes: { 'url.path': '/healthcare' } })).toBe(0.1); // not a prefix match
    expect(sampler({})).toBe(0.1);
    expect(sampler(undefined)).toBe(0.1);
  });

  it('privacy: dataCollection disables URL query params and database query data whenever the SDK initializes', () => {
    // Even with tracing off, span-adjacent collection settings are safe to
    // pass; they scope only span/transaction payloads.
    const off = initOptionsWith({ SENTRY_DSN: 'https://k@example.invalid/1' });
    expect(off.dataCollection).toEqual({ urlQueryParams: false, databaseQueryData: false });

    const on = initOptionsWith({
      SENTRY_DSN: 'https://k@example.invalid/1',
      SENTRY_TRACES_SAMPLE_RATE: '0.1',
    });
    expect(on.dataCollection).toEqual({ urlQueryParams: false, databaseQueryData: false });
  });

  it('existing behavior untouched: beforeSend still strips body/cookies/query from error events', () => {
    const opts = initOptionsWith({ SENTRY_DSN: 'https://k@example.invalid/1' });
    const event = {
      request: {
        data: { sellerWhatsapp: '0712345678' },
        cookies: 'session=abc',
        url: '/api/payments/status/INV-1?challenge=secret&token=claim',
        query_string: 'challenge=secret&token=claim',
      },
    };
    const out = opts.beforeSend(event);
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.query_string).toBeUndefined();
    expect(out.request.url).toBe('/api/payments/status/INV-1');
  });
});
