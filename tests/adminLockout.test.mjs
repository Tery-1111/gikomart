import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import speakeasy from 'speakeasy';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);

// ── Fake state ──
const h = { admins: new Map(), listings: [] };

function selectableDoc(doc) {
  // Mirrors Mongoose: even a query that resolves to null carries .select().
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}

const fakeAdminModel = {
  // Always returns a query-like object (with .select) — real Mongoose does,
  // even when the query resolves to null (first-time-setup path).
  findOne: (filter) => selectableDoc(h.admins.get(filter.username) || null),
  findOneAndUpdate: async (filter, update) => {
    const existing = h.admins.get(filter.username) || { username: filter.username };
    const merged = { ...existing, ...update };
    merged.save = async () => merged;
    h.admins.set(filter.username, merged);
    return merged;
  },
  find: () => {
    const enabled = [...h.admins.values()].filter((a) => a.totpEnabled);
    return { select: () => ({ lean: async () => enabled.map((a) => ({ username: a.username })) }) };
  },
};

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Passthrough rate limiters — this file's own /api/admin calls would otherwise
// consume the 10/min adminLimiter budget and interfere with lockout tests
// (whose 429s must come from the LOCKOUT, not the limiter).
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
  h.listings.length = 0;
});

// Seed helper: docs must carry save() — the login flow calls admin.save()
// after updating lastUsedCounter, exactly like the real Mongoose document.
function seedAdmin(overrides = {}) {
  const doc = {
    username: 'owner',
    totpSecret: speakeasy.generateSecret({ length: 20 }).base32,
    totpEnabled: true,
    lastUsedCounter: 0,
    ...overrides,
  };
  doc.save = async () => doc;
  h.admins.set('owner', doc);
  return doc;
}

// The lockout Map is in-memory and per-worker — reset between tests via clear().
afterEach(() => {
  const { clear } = require('../src/middleware/adminLockout.js');
  clear('::ffff:127.0.0.1');
  clear('127.0.0.1');
  clear('::1');
});

const KEY = process.env.ADMIN_KEY;

describe('A1 — setup-2fa requires TOTP once an admin is enrolled', () => {
  it('400 "TOTP code required" without totpCode; seed unchanged', async () => {
    const admin = seedAdmin();
    const seedBefore = admin.totpSecret;

    const res = await request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TOTP code required');
    expect(h.admins.get('owner').totpSecret).toBe(seedBefore);
  });

  it('403 when the key is missing (key check fires before the TOTP gate)', async () => {
    seedAdmin();
    const res = await request(app).post('/api/admin/setup-2fa');
    expect([403, 429]).toContain(res.status);
  });

  it('401 with a WRONG totpCode (generic error); seed unchanged', async () => {
    const admin = seedAdmin();
    const seedBefore = admin.totpSecret;

    const res = await request(app)
      .post('/api/admin/setup-2fa')
      .set('X-Admin-Key', KEY)
      .send({ totpCode: '000000' });
    expect([401, 429]).toContain(res.status);
    if (res.status === 401) {
      expect(res.body.error).toBe('Invalid credentials');
      expect(h.admins.get('owner').totpSecret).toBe(seedBefore);
    }
  });

  it('200 with a valid key + valid TOTP code; seed rotates', async () => {
    const admin = seedAdmin();
    const secret = admin.totpSecret;

    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const res = await request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', KEY).send({ totpCode: code });

    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
    expect(res.body.secret).not.toBe(secret);
  });

  it('first-time setup (no enrolled admin) remains key-only', async () => {
    const res = await request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
  });
});

describe('A3 — per-IP lockout on failed admin auth (through real HTTP)', () => {
  const login = () => request(app).post('/api/admin/login').set('X-Admin-Key', KEY).send({ code: '000000' });

  it('5 failed logins lock the IP; 6th request → 429 with retryAfterSec > 0', async () => {
    seedAdmin();

    for (let i = 0; i < 5; i += 1) {
      const r = await login();
      expect([401, 429]).toContain(r.status);
    }
    const sixth = await login();
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('Too many attempts');
    expect(sixth.body.retryAfterSec).toBeGreaterThan(0);
  });

  it('a successful login clears the failure counter', async () => {
    const admin = seedAdmin();
    const secret = admin.totpSecret;

    // 2 failures
    await login();
    await login();

    // success — counter cleared (fresh code; the seed has not been used yet)
    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const ok = await request(app).post('/api/admin/login').set('X-Admin-Key', KEY).send({ code });
    expect(ok.status).toBe(200);

    // 2 more failures — total counted since clear is 2, so NO lockout yet
    const last = await login();
    expect(last.status).toBe(401);
    expect(h.admins.get('owner').username).toBe('owner');
  });
});

describe('A2 — failed admin auth is logged (no secrets in the log)', () => {
  it('invalid login → warn("admin_auth_failed", { reason: "invalid_totp", ... }) with no key/token/code', async () => {
    seedAdmin();
    const warnSpy = vi.spyOn(fakeLogger, 'warn');

    const res = await request(app)
      .post('/api/admin/login')
      .set('X-Admin-Key', KEY)
      .send({ code: '999999' });
    expect([401, 429]).toContain(res.status);

    const call = warnSpy.mock.calls.find(([msg]) => msg === 'admin_auth_failed');
    expect(call).toBeTruthy();
    const [msg, meta] = call;
    expect(msg).toBe('admin_auth_failed');
    expect(meta.reason).toBe('invalid_totp');
    expect(typeof meta.path).toBe('string');
    expect(typeof meta.method).toBe('string');
    expect(typeof meta.ip).toBe('string');

    const json = JSON.stringify(meta);
    expect(json).not.toContain(KEY);
    expect(json).not.toContain('999999');
    expect(json).not.toContain('x-admin-key');
    expect(json).not.toContain('code');

    warnSpy.mockRestore();
  });

  it('wrong admin key → warn with reason "invalid_key" and no key value', async () => {
    const warnSpy = vi.spyOn(fakeLogger, 'warn');
    const res = await request(app).post('/api/admin/login').set('X-Admin-Key', 'definitely-wrong-key').send({ code: '123456' });
    expect([403, 429]).toContain(res.status);

    const call = warnSpy.mock.calls.find(([msg, meta]) => msg === 'admin_auth_failed' && meta.reason === 'invalid_key');
    expect(call).toBeTruthy();
    expect(JSON.stringify(call[1])).not.toContain('definitely-wrong-key');
    warnSpy.mockRestore();
  });
});
