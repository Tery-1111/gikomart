import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// Focused tests for the temporary delivery diagnostic in instrument.js. The
// Sentry client and logger are injected fakes, so no event is ever sent.

const require = createRequire(import.meta.url);

const VALID_ID = 'probe-20261012-abc';

function fakeSentry({ flush = async () => true, client = {} } = {}) {
  const calls = { capture: [], tags: [], flushArgs: null, flushCount: 0 };
  return {
    calls,
    withScope: (fn) => fn({ setTag: (k, v) => calls.tags.push([k, v]) }),
    captureMessage: (msg, level) => {
      calls.capture.push([msg, level]);
      return 'evt-123';
    },
    flush: (ms) => {
      calls.flushCount += 1;
      calls.flushArgs = ms;
      return flush();
    },
    getClient: () => client,
  };
}

function fakeLogger() {
  const entries = [];
  return {
    entries,
    info: (msg, payload) => entries.push(['info', msg, payload]),
    warn: (msg, payload) => entries.push(['warn', msg, payload]),
    error: (msg, payload) => entries.push(['error', msg, payload]),
  };
}

// Loads instrument.js with a fake @sentry/node (same require-cache technique as
// tests/sentry.test.mjs) so setupSentry()'s init options can be inspected.
function loadInstrumentWithFakeInit() {
  const initCalls = [];
  const resolved = require.resolve('@sentry/node');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, path: resolved,
    exports: {
      init: (opts) => initCalls.push(opts),
      setupExpressErrorHandler: () => {},
    },
  };
  const instPath = require.resolve('../instrument.js');
  delete require.cache[instPath];
  return { instrument: require('../instrument.js'), initCalls };
}

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe('runDeliveryCheck', () => {
  const { instrument } = loadInstrumentWithFakeInit();
  const { runDeliveryCheck } = instrument;

  it('does nothing and logs nothing when the flag is absent', async () => {
    const sentry = fakeSentry();
    const logger = fakeLogger();
    const out = await runDeliveryCheck({ sentry, logger, initialized: true, env: { NODE_ENV: 'production' } });
    expect(out).toBeNull();
    expect(logger.entries).toHaveLength(0);
    expect(sentry.calls.capture).toHaveLength(0);
    expect(sentry.calls.flushCount).toBe(0);
  });

  it('treats an empty flag as absent (no logs)', async () => {
    const sentry = fakeSentry();
    const logger = fakeLogger();
    await runDeliveryCheck({ sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: '', NODE_ENV: 'production' } });
    expect(logger.entries).toHaveLength(0);
    expect(sentry.calls.capture).toHaveLength(0);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['illegal characters', 'bad value;rm'],
    ['whitespace only', '        '],
  ])('skips a malformed flag (%s) with one reason-only warning and no value echo', async (_name, value) => {
    const sentry = fakeSentry();
    const logger = fakeLogger();
    const out = await runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: value, NODE_ENV: 'production' },
    });
    expect(out).toBeNull();
    expect(sentry.calls.capture).toHaveLength(0);
    expect(logger.entries).toEqual([
      ['warn', 'sentry_delivery_check_skipped', { reason: 'invalid_id' }],
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(value.trim() || value);
  });

  it('skips in test mode with a valid flag and sends nothing', async () => {
    const sentry = fakeSentry();
    const logger = fakeLogger();
    const out = await runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'test' },
    });
    expect(out).toBeNull();
    expect(sentry.calls.capture).toHaveLength(0);
    expect(logger.entries).toEqual([['warn', 'sentry_delivery_check_skipped', { reason: 'test_mode' }]]);
  });

  it('skips when the SDK was not initialised', async () => {
    const sentry = fakeSentry();
    const logger = fakeLogger();
    const out = await runDeliveryCheck({
      sentry, logger, initialized: false, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production' },
    });
    expect(out).toBeNull();
    expect(sentry.calls.capture).toHaveLength(0);
    expect(sentry.calls.flushCount).toBe(0);
    expect(logger.entries).toEqual([['warn', 'sentry_delivery_check_skipped', { reason: 'sdk_not_initialized' }]]);
  });

  it('reports queue_drained (not "delivered") when flush resolves true, with the tagged message', async () => {
    const sentry = fakeSentry({ flush: async () => true });
    const logger = fakeLogger();
    const out = await runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production' },
    });
    expect(out).toBe('queue_drained');
    expect(sentry.calls.capture).toEqual([[`gikomart-delivery-check ${VALID_ID}`, 'info']]);
    expect(sentry.calls.tags).toEqual([['delivery_check', VALID_ID]]);
    expect(sentry.calls.flushArgs).toBe(10000);
    expect(logger.entries).toEqual([[
      'info', 'sentry_delivery_check',
      { probeId: VALID_ID, eventId: 'evt-123', outcome: 'queue_drained', sdkActive: true },
    ]]);
    expect(JSON.stringify(logger.entries)).not.toMatch(/delivered/);
  });

  it('reports queue_not_drained when flush resolves false', async () => {
    const sentry = fakeSentry({ flush: async () => false });
    const logger = fakeLogger();
    const out = await runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production' },
    });
    expect(out).toBe('queue_not_drained');
    expect(logger.entries[0][2].outcome).toBe('queue_not_drained');
  });

  it('reports flush_error and resolves (no unhandled rejection) when flush rejects', async () => {
    const sentry = fakeSentry({ flush: async () => { throw new Error('boom'); } });
    const logger = fakeLogger();
    const out = await runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production' },
    });
    expect(out).toBe('flush_error');
    expect(logger.entries[0][2].outcome).toBe('flush_error');
  });

  it('reports deadline when flush never settles, and clears the timer once it resolves', async () => {
    vi.useFakeTimers();
    const sentry = fakeSentry({ flush: () => new Promise(() => {}) });
    const logger = fakeLogger();
    const pending = runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production' },
    });
    await vi.advanceTimersByTimeAsync(12000);
    expect(await pending).toBe('deadline');
    expect(logger.entries[0][2].outcome).toBe('deadline');
  });

  it('leaves no deadline timer behind when flush settles first', async () => {
    vi.useFakeTimers();
    const sentry = fakeSentry({ flush: async () => true });
    const logger = fakeLogger();
    await runDeliveryCheck({
      sentry, logger, initialized: true, env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs only the expected fields (no DSN, key, token or request data)', async () => {
    const sentry = fakeSentry();
    const logger = fakeLogger();
    await runDeliveryCheck({
      sentry, logger, initialized: true,
      env: { SENTRY_DELIVERY_CHECK: VALID_ID, NODE_ENV: 'production', SENTRY_DSN: 'https://secret@example.invalid/1' },
    });
    const payload = logger.entries[0][2];
    expect(Object.keys(payload).sort()).toEqual(['eventId', 'outcome', 'probeId', 'sdkActive']);
    expect(JSON.stringify(logger.entries)).not.toContain('secret');
  });
});

describe('setupSentry debug gate', () => {
  it('passes debug: false when the flag is absent', () => {
    const { instrument, initCalls } = loadInstrumentWithFakeInit();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production', SENTRY_DSN: 'https://k@example.invalid/1' };
    delete process.env.SENTRY_DELIVERY_CHECK;
    expect(instrument.setupSentry()).toBe(true);
    expect(initCalls[0].debug).toBe(false);
  });

  it('passes debug: false for a malformed flag', () => {
    const { instrument, initCalls } = loadInstrumentWithFakeInit();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production', SENTRY_DSN: 'https://k@example.invalid/1', SENTRY_DELIVERY_CHECK: 'x' };
    instrument.setupSentry();
    expect(initCalls[0].debug).toBe(false);
  });

  it('passes debug: true only for a valid flag', () => {
    const { instrument, initCalls } = loadInstrumentWithFakeInit();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production', SENTRY_DSN: 'https://k@example.invalid/1', SENTRY_DELIVERY_CHECK: VALID_ID };
    instrument.setupSentry();
    expect(initCalls[0].debug).toBe(true);
  });
});
