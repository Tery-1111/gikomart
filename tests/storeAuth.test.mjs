import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';

// storeAuth depends on the Store model, the logger, and adminAuth. Inject all
// three through the require.cache seam (vi.mock does not reach CJS require()).
const require = createRequire(import.meta.url);
function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

const state = { store: null, findByIdError: null, adminPayload: null };
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Mimics the single Mongoose chain storeAuth uses: findById(id).select(fields).
// The promise is created lazily inside select() so the error path rejects
// through the same call the middleware awaits — a bare Promise.reject() here
// would escape as an unhandled rejection and the middleware would instead
// catch a `.select is not a function` TypeError.
const fakeStoreModel = {
  findById: (id) => ({
    select: () => {
      if (state.findByIdError) return Promise.reject(state.findByIdError);
      const doc = state.store && String(state.store._id) === String(id) ? state.store : null;
      return Promise.resolve(doc);
    },
  }),
};

const fakeAdminAuth = {
  authenticateAdmin: vi.fn(async () =>
    (state.adminPayload ? { needs2fa: false, payload: state.adminPayload } : { needs2fa: false, payload: null })),
  verifySession: () => null,
  signSession: () => '',
  SESSION_TTL_MS: 0,
};

injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/adminAuth.js', fakeAdminAuth);

const storeAuth = require('../src/middleware/storeAuth.js');

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = vi.fn(function (code) { res.statusCode = code; return res; });
  res.json = vi.fn(function (payload) { res.body = payload; return res; });
  return res;
}
const getHeader = (headers) => (name) => headers[name] ?? headers[name.toLowerCase()];

const activeStore = (id, ownerToken) => ({
  _id: id,
  name: 'Shop',
  status: 'active',
  expires_at: new Date(Date.now() + 86400000),
  ownerTokenHash: sha256hex(ownerToken),
});

beforeEach(() => {
  state.store = null;
  state.findByIdError = null;
  state.adminPayload = null;
  fakeLogger.error.mockClear();
  fakeAdminAuth.authenticateAdmin.mockClear();
});

afterAll(() => { vi.restoreAllMocks(); });

describe('storeAuth — owner identity and error handling', () => {
  it('attaches req.ownerTokenHash when the owner token authenticates', async () => {
    const hash = sha256hex('owner-token');
    state.store = activeStore('sto-1', 'owner-token');
    const headers = { 'X-Store-Owner-Token': 'owner-token' };
    const req = { params: { id: 'sto-1' }, headers, get: getHeader(headers) };
    const res = fakeRes();
    const next = vi.fn();

    await storeAuth({ requireActive: true })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.storeCredentialType).toBe('owner');
    expect(req.ownerTokenHash).toBe(hash);
  });

  it('does NOT attach owner identity when an admin override authorizes the request', async () => {
    state.store = activeStore('sto-2', 'owner-token');
    state.adminPayload = { username: 'owner' };
    const req = { params: { id: 'sto-2' }, headers: {}, get: getHeader({}) };
    const res = fakeRes();
    const next = vi.fn();

    await storeAuth({ allowAdmin: true })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.storeCredentialType).toBe('admin');
    expect(req.admin).toEqual({ username: 'owner' });
    // The critical assertion: admin identity must not carry the owner hash.
    expect(req.ownerTokenHash).toBeUndefined();
  });

  it('rejects when neither an owner token nor an admin session is valid (403)', async () => {
    state.store = activeStore('sto-3', 'owner-token');
    const req = { params: { id: 'sto-3' }, headers: {}, get: getHeader({}) };
    const res = fakeRes();
    const next = vi.fn();

    await storeAuth({})(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(req.ownerTokenHash).toBeUndefined();
  });

  it('returns a generic 500 (never the raw error text) and logs the detail on internal failure', async () => {
    state.findByIdError = new Error('connect failed: mongodb://user:pass@host/db');
    const req = { params: { id: 'sto-4' }, headers: {}, get: getHeader({}) };
    const res = fakeRes();
    const next = vi.fn();

    await storeAuth({})(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Store authorization failed');
    expect(JSON.stringify(res.body)).not.toContain('mongodb://');
    expect(next).not.toHaveBeenCalled();
    expect(fakeLogger.error).toHaveBeenCalledTimes(1);
    // The real driver error (including its DSN) must reach the server log …
    expect(fakeLogger.error.mock.calls[0][1].error).toContain('mongodb://');
    // … proving the redaction above came from the generic client response, not
    // from the error having been swallowed before it was logged.
  });
});
