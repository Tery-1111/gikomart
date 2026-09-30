import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const errorHandler = require('../src/middleware/errorHandler');

// Env fixtures (server.js's dotenv also sets these when the suite imports it;
// the unit tests below force the NODE_ENV they need explicitly).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

function fakeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    body: undefined,
    status: vi.fn(function (code) { this.statusCode = code; return this; }),
    json: vi.fn(function (payload) { this.body = payload; return this; }),
  };
}

describe('errorHandler (unit)', () => {
  const ORIGINAL = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = ORIGINAL; });

  it('production: 5xx sends exactly { error: "Internal Server Error" }, no leak', () => {
    process.env.NODE_ENV = 'production';
    const res = fakeRes();
    const next = vi.fn();
    const err = new Error('SECRET_STRING');
    err.status = 500;

    errorHandler(err, { method: 'GET', originalUrl: '/x' }, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
    expect(JSON.stringify(res.body)).not.toContain('SECRET_STRING');
  });

  it('development: body includes err.message and err.stack', () => {
    process.env.NODE_ENV = 'development';
    const res = fakeRes();
    const next = vi.fn();
    const err = new Error('SECRET_STRING');
    err.status = 500;

    errorHandler(err, { method: 'GET', originalUrl: '/x' }, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.error).toBe('SECRET_STRING');
    expect(res.body.stack).toBe(err.stack);
  });

  it('headersSent: delegates to next and never writes a response', () => {
    const res = fakeRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = new Error('SECRET_STRING');

    errorHandler(err, { method: 'GET', originalUrl: '/x' }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('errorHandler (integration — GET /api/listings, listingController.getListings)', () => {
  let app;

  beforeAll(async () => {
    // Same require.cache injection architecture as tests/wiring.test.mjs:
    // the fake's updateMany rejects BEFORE any query executes, so the first
    // awaited call in getListings throws and the controller must next(err).
    const resolve = (p) => require.resolve(p);
    const inject = (rel, exportsObj) => {
      const r = resolve(rel);
      require.cache[r] = { id: r, filename: r, loaded: true, path: r, exports: exportsObj };
    };
    inject('../src/models/Listing.js', {
      updateMany: vi.fn().mockRejectedValue(new Error('SECRET_STRING')),
    });
    app = (await import('../server.js')).default;
  });

  it('forwards the thrown error to the central handler; prod-style body, no leak', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app).get('/api/listings');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal Server Error' });
      expect(JSON.stringify(res.body)).not.toContain('SECRET_STRING');
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
