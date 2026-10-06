/* FIX-7(b) — Production first-time 2FA setup guard. Real setup2FA handler
 * through the wired app; Admin model faked; NODE_ENV flipped per test. */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import speakeasy from 'speakeasy';

const require = createRequire(import.meta.url);

process.env.ADMIN_KEY = 'test-admin-key-123456';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret-123456';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge-123456';

const ADMIN_KEY = process.env.ADMIN_KEY;
const h = { admin: null, writes: [] };

function makeAdminFake() {
  return {
    findOne: (filter) => {
      const doc = (h.admin && filter.username === h.admin.username) ? { ...h.admin } : null;
      const thenable = { then: (res, rej) => Promise.resolve(doc).then(res, rej) };
      thenable.select = () => thenable;
      return thenable;
    },
    findOneAndUpdate: async (filter, update, opts) => {
      const userMatches = Boolean(h.admin && filter.username === h.admin.username);
      const notEnabledFilter = filter.totpEnabled && filter.totpEnabled.$ne === true;
      if (userMatches && h.admin.totpEnabled === true && notEnabledFilter) {
        // Emulates the unique username index: an upsert against an enabled
        // account collides instead of resetting its secret.
        if (opts && opts.upsert) {
          const err = new Error('E11000 duplicate key error');
          err.code = 11000;
          throw err;
        }
        return null;
      }
      if (userMatches) {
        Object.assign(h.admin, update);
        h.writes.push(update);
        return { ...h.admin };
      }
      if (opts && opts.upsert) {
        h.admin = { username: filter.username, totpEnabled: false, ...update };
        h.writes.push(update);
        return { ...h.admin };
      }
      return null;
    },
  };
}

const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const fakeAuditEvent = { create: async (d) => d, find: () => { const b = { sort: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; } };

function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

const realRateLimiter = require('../src/middleware/rateLimiter');
injectModule('../src/models/Admin.js', makeAdminFake());
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/middleware/rateLimiter.js', {
  ...realRateLimiter,
  globalLimiter: (req, _res, next) => next(),
  adminLimiter: (req, _res, next) => next(),
});

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });

afterEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.ALLOW_2FA_SETUP;
  h.admin = null;
  h.writes.length = 0;
});

const setup = () => request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', ADMIN_KEY);

describe('FIX-7: admin first-time 2FA setup guard', () => {
  it('production + no enrolled admin + flag unset → 403 and nothing written', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_2FA_SETUP;
    const res = await setup();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: '2FA setup is disabled' });
    expect(h.writes.length).toBe(0);
    expect(h.admin).toBe(null);
  });

  it('production + no enrolled admin + ALLOW_2FA_SETUP=true → first-time flow works', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_2FA_SETUP = 'true';
    const res = await setup();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.qrDataUrl).toMatch(/^data:image/);
    expect(h.writes.length).toBe(1);
    expect(h.admin.totpEnabled).toBe(false);
    expect(typeof h.admin.totpSecret).toBe('string');
  });

  it('non-production → existing key-only flow works unchanged', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_2FA_SETUP;
    const res = await setup();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(h.writes.length).toBe(1);
  });

  it('production + enrolled admin → code-required flow unchanged', async () => {
    process.env.NODE_ENV = 'production';
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    h.admin = { username: 'owner', totpSecret: secret, totpEnabled: true };
    const writesBefore = h.writes.length;

    // no code → 400 (unchanged)
    const noCode = await setup();
    expect(noCode.status).toBe(400);
    expect(noCode.body).toEqual({ success: false, error: 'TOTP code required' });

    // wrong code → 401 (unchanged)
    const wrong = await setup().send({ totpCode: '000000' });
    expect(wrong.status).toBe(401);

    // valid code → existing behavior for an enrolled account (409, no reset)
    const token = speakeasy.totp({ secret, encoding: 'base32' });
    const valid = await request(app).post('/api/admin/setup-2fa')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ totpCode: token });
    expect([200, 409]).toContain(valid.status);
    expect(h.writes.length).toBe(writesBefore); // enrolled secret never reset
    expect(h.admin.totpEnabled).toBe(true);
  });
});
