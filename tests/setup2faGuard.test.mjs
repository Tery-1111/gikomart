import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import speakeasy from 'speakeasy';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

// Same require.cache injection seam as tests/wiring.test.mjs and
// tests/adminLockout.test.mjs: vitest's vi.mock does not reach CJS require()
// consumers in this vitest + Node 24 setup, so in-memory model fakes are
// installed into Node's module cache BEFORE server.js is imported.
const require = createRequire(import.meta.url);

// ── Fake state ──
const h = { admins: new Map() };

function selectableDoc(doc) {
  // Mirrors Mongoose: even a query that resolves to null carries .select().
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}

// Applies the query filter and emulates the unique `username` index: an upsert
// whose filter excludes an existing document (because totpEnabled is true)
// cannot insert a duplicate username, so the real driver raises a duplicate-key
// error with code 11000. The fake reproduces exactly that.
const fakeAdminModel = {
  findOne: (filter) => selectableDoc(h.admins.get(filter.username) || null),
  findOneAndUpdate: async (filter, update) => {
    const existing = h.admins.get(filter.username);
    if (existing) {
      if (filter.totpEnabled && filter.totpEnabled.$ne === true && existing.totpEnabled === true) {
        const err = new Error('E11000 duplicate key error collection: test.admins index: username_1');
        err.code = 11000;
        throw err;
      }
      const merged = { ...existing, ...update };
      merged.save = async () => merged;
      h.admins.set(filter.username, merged);
      return merged;
    }
    const created = { ...update };
    created.save = async () => created;
    h.admins.set(filter.username, created);
    return created;
  },
  find: () => {
    const enabled = [...h.admins.values()].filter((a) => a.totpEnabled);
    return { select: () => ({ lean: async () => enabled.map((a) => ({ username: a.username })) }) };
  },
};

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Passthrough rate limiters — this file's own /api/admin calls would otherwise
// consume the 10/min adminLimiter budget.
const pass = () => (req, res, next) => next();
const fakeRateLimiterModule = {
  globalLimiter: pass(),
  vitalsLimiter: pass(),
  uploadLimiter: pass(),
  uploadDailyLimiter: pass(),
  paymentLimiter: pass(),
  listingCreateLimiter: pass(),
  contactLimiter: pass(),
  adminLimiter: pass(),
  statusLimiter: pass(),
  contactReleaseLimiter: pass(),
  reportLimiter: pass(),
};

function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

beforeEach(() => {
  h.admins.clear();
});

// The lockout Map is in-memory and per-worker — reset between tests via clear().
afterEach(() => {
  const { clear } = require('../src/middleware/adminLockout.js');
  clear('::ffff:127.0.0.1');
  clear('127.0.0.1');
  clear('::1');
});

// Seed helper: docs must carry save() — the login flow calls admin.save().
function seedEnrolledAdmin() {
  const doc = {
    username: 'owner',
    totpSecret: speakeasy.generateSecret({ length: 20 }).base32,
    totpEnabled: true,
    lastUsedCounter: 0,
  };
  doc.save = async () => doc;
  h.admins.set('owner', doc);
  return doc;
}

const KEY = process.env.ADMIN_KEY;

describe('Phase 9 — setup-2fa never replaces an enrolled factor', () => {
  it('setup-2fa for a not-yet-enrolled admin still returns 200 with qrDataUrl and secret and stores it', async () => {
    const res = await request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body.qrDataUrl).toBeTruthy();
    expect(res.body.secret).toBeTruthy();

    const stored = h.admins.get('owner');
    expect(stored).toBeTruthy();
    expect(stored.totpSecret).toBe(res.body.secret);
    expect(stored.totpEnabled).toBe(false);
  });

  it('setup-2fa for an enrolled admin with a valid TOTP code returns 409 and does not change the stored secret', async () => {
    const admin = seedEnrolledAdmin();
    const secretBefore = admin.totpSecret;

    const code = speakeasy.totp({ secret: secretBefore, encoding: 'base32' });
    const res = await request(app)
      .post('/api/admin/setup-2fa')
      .set('X-Admin-Key', KEY)
      .send({ totpCode: code });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: '2FA is already enabled' });
  });

  it('the stored secret for an enrolled admin is byte-identical before and after the attempt', async () => {
    const admin = seedEnrolledAdmin();
    const secretBefore = admin.totpSecret;

    const code = speakeasy.totp({ secret: secretBefore, encoding: 'base32' });
    const res = await request(app)
      .post('/api/admin/setup-2fa')
      .set('X-Admin-Key', KEY)
      .send({ totpCode: code });

    expect(res.status).toBe(409);
    expect(h.admins.get('owner').totpSecret).toBe(secretBefore);
    expect(Buffer.from(h.admins.get('owner').totpSecret)).toEqual(Buffer.from(secretBefore));
  });
});
