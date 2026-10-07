import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import speakeasy from 'speakeasy';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

// Same require.cache injection seam as the other admin tests: vitest's vi.mock
// does not reach CJS require() consumers in this setup, so in-memory fakes are
// installed into Node's module cache BEFORE server.js is imported.
const require = createRequire(import.meta.url);

// ── Fake state ──
const h = { admins: new Map() };

function selectableDoc(doc) {
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}

const fakeAdminModel = {
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
const fakeAuditEvent = { create: vi.fn(async (data) => data) };

// Passthrough rate limiters — these tests issue several /api/admin requests and
// would otherwise consume the 10/min adminLimiter budget.
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
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;
let adminAuth;

beforeAll(async () => {
  app = (await import('../server.js')).default;
  adminAuth = require('../src/middleware/adminAuth.js');
});

// A fixed, mid-window epoch second (T % 30 === 15) so tests never sit on a
// step boundary. Both the authenticator's code generation (via `time`) and the
// controller's `Date.now()` read this same instant.
const T = 1_800_000_015;

beforeEach(() => {
  h.admins.clear();
  fakeLogger.warn.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(T * 1000);
});

afterEach(() => {
  vi.restoreAllMocks();
  const { clear } = require('../src/middleware/adminLockout.js');
  clear('::ffff:127.0.0.1');
  clear('127.0.0.1');
  clear('::1');
});

const KEY = process.env.ADMIN_KEY;

function seedEnrolledAdmin(secret, lastUsedCounter = 0) {
  const doc = { username: 'owner', totpSecret: secret, totpEnabled: true, lastUsedCounter };
  doc.save = async () => doc;
  h.admins.set('owner', doc);
  return doc;
}

const codeAt = (secret, sec) => speakeasy.totp({ secret, encoding: 'base32', time: sec });

const login = (code, key = KEY) =>
  request(app).post('/api/admin/login').set('X-Admin-Key', key).send({ code });

describe('Admin TOTP login — verification and replay', () => {
  it('accepts a valid current TOTP and issues a verifiable admin session', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);

    const res = await login(codeAt(secret, T));

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token).toBeTruthy();
    const payload = adminAuth.verifySession(res.body.token);
    expect(payload).toBeTruthy();
    expect(payload.username).toBe('owner');
  });

  it('rejects an invalid TOTP (code from a different secret)', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const other = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);

    const res = await login(codeAt(other, T));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid TOTP code');
  });

  it('rejects an expired / out-of-window TOTP', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);

    const past = await login(codeAt(secret, T - 90)); // 3 steps behind
    expect(past.status).toBe(401);
    expect(past.body.error).toBe('Invalid TOTP code');

    const future = await login(codeAt(secret, T + 90)); // 3 steps ahead
    expect(future.status).toBe(401);
    expect(future.body.error).toBe('Invalid TOTP code');
  });

  it('rejects a TOTP that was already used (replay)', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);
    const code = codeAt(secret, T);

    const first = await login(code);
    expect(first.status).toBe(200);

    const replay = await login(code);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('TOTP code already used');
  });

  it('accepts a valid new TOTP in the following window after a used code', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);

    const first = await login(codeAt(secret, T));
    expect(first.status).toBe(200);

    // Roll the server clock one step forward and use the fresh code.
    Date.now.mockReturnValue((T + 30) * 1000);
    const second = await login(codeAt(secret, T + 30));
    expect(second.status).toBe(200);
    expect(second.body.token).toBeTruthy();
  });

  it('rejects a wrong admin key with 403', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);

    const res = await login(codeAt(secret, T), 'definitely-wrong-key');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Invalid admin key');
  });

  it('rejects a missing TOTP when 2FA is enabled', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);

    const res = await request(app).post('/api/admin/login').set('X-Admin-Key', KEY).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TOTP code required');
  });
});

describe('Admin TOTP login — ±1 step drift tolerance (one-sided bug regression)', () => {
  it('accepts a code from the previous step, but only once', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);
    const prevCode = codeAt(secret, T - 30); // delta -1

    const first = await login(prevCode);
    expect(first.status).toBe(200);

    const replay = await login(prevCode);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('TOTP code already used');
  });

  it('accepts a code from the next step, but only once', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret);
    const nextCode = codeAt(secret, T + 30); // delta +1

    const first = await login(nextCode);
    expect(first.status).toBe(200);

    const replay = await login(nextCode);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('TOTP code already used');
  });

  it('a previous-step code is still replay-blocked after a current-step success', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    seedEnrolledAdmin(secret, Math.floor(T / 30));
    // lastUsedCounter already at the current step: the previous-step code must
    // not be accepted just because it is inside the drift window.
    const res = await login(codeAt(secret, T - 30));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOTP code already used');
  });
});
