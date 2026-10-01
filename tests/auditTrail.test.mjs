import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import speakeasy from 'speakeasy';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

// Env fixtures — set BEFORE any controller import.
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

// Same require.cache injection seam as tests/wiring.test.mjs: vitest's vi.mock
// does not reach CJS require() consumers in this setup, so fakes are installed
// into Node's module cache before the controllers are loaded.
const require = createRequire(import.meta.url);
function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

const h = { listings: [], stores: new Map(), payments: [], admins: new Map() };
const auditEvents = [];

function makeDoc(o) {
  if (!o) return null;
  const d = { ...o };
  d.save = async () => d;
  return d;
}
function selectableDoc(doc) {
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}
// Write results that also chain with .session(session) (the store cascade uses
// a MongoDB transaction, even though the fake is in-memory).
function chainableResult(result) {
  return {
    ...result,
    session: () => Promise.resolve(result),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
    catch: (rej) => Promise.resolve(result).catch(rej),
  };
}
function matches(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$ne !== undefined && doc[k] === v.$ne) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}
const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

const fakeAuditEvent = {
  create: vi.fn(async (data) => { auditEvents.push(data); return data; }),
};

const fakeListingModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, images: [], ...data });
    h.listings.push(doc);
    return doc;
  },
  findById: (id) => selectableDoc(h.listings.find(l => String(l._id) === String(id)) || null),
  findByIdAndUpdate: async (id, update) => {
    const doc = h.listings.find(l => String(l._id) === String(id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  find: (filter = {}) => {
    const builder = {
      populate: () => builder, sort: () => builder, skip: () => builder, limit: () => builder,
      session: () => builder,
      then: (res, rej) => Promise.resolve(h.listings.filter(l => matches(l, filter))).then(res, rej),
      catch: (rej) => Promise.resolve(h.listings.filter(l => matches(l, filter))).catch(rej),
    };
    return builder;
  },
  deleteOne: (filter) => {
    const i = h.listings.findIndex(l => String(l._id) === String(filter._id));
    if (i !== -1) h.listings.splice(i, 1);
    return chainableResult({ deletedCount: 1 });
  },
  deleteMany: (filter) => {
    const before = h.listings.length;
    h.listings = h.listings.filter(l => !matches(l, filter));
    return chainableResult({ deletedCount: before - h.listings.length });
  },
};

const fakeStoreModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `sto-${h.stores.size + 1}`, status: 'active', ...data });
    h.stores.set(String(doc._id), doc);
    return doc;
  },
  findById: (id) => selectableDoc(h.stores.get(String(id)) || null),
  findOne: async (filter = {}) => {
    for (const s of h.stores.values()) {
      if (filter.slug === undefined || s.slug === filter.slug) return { ...s };
    }
    return null;
  },
  findByIdAndUpdate: async (id, update) => {
    const doc = h.stores.get(String(id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  deleteOne: (filter) => chainableResult({ deletedCount: h.stores.delete(String(filter._id)) ? 1 : 0 }),
};

const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `pay-${h.payments.length + 1}`, status: 'pending', ...data });
    h.payments.push(doc);
    return doc;
  },
  findOne: async (filter) => makeDoc(h.payments.find(p => p.invoiceId === filter.invoiceId) || null),
  findOneAndUpdate: async (filter, update) => {
    const p = h.payments.find(x => x.invoiceId === filter.invoiceId && x.status !== 'completed');
    if (!p) return null;
    Object.assign(p, update);
    return p;
  },
};

const fakeTermsModel = {
  create: async (data) => makeDoc({ _id: 'ta-1', ...data }),
  findByIdAndUpdate: async () => makeDoc({}),
};

const fakeAdminModel = {
  findOne: (filter) => selectableDoc(h.admins.get(filter.username) || null),
  findOneAndUpdate: async (filter, update) => {
    const merged = { ...(h.admins.get(filter.username) || {}), ...update };
    merged.save = async () => merged;
    h.admins.set(filter.username, merged);
    return merged;
  },
  find: () => {
    const enabled = [...h.admins.values()].filter(a => a.totpEnabled);
    return { select: () => ({ lean: async () => enabled.map(a => ({ username: a.username })) }) };
  },
};

const fakeCloudinary = { uploader: { destroy: async () => ({ result: 'ok' }) } };
const broadcastListing = vi.fn(async () => [{ success: true }]);
const fakeWhatsapp = { broadcastListing, formatMessage: () => 'msg' };
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/services/whatsappService.js', fakeWhatsapp);
injectModule('../src/config/logger.js', fakeLogger);

let paymentController;
let storeController;
let listingController;
let adminAuthController;
let adminAuth;
let auditService;
let OWNER_ACTOR_FALLBACK;
let SYSTEM_ACTOR;
let storeAuth;

beforeEach(async () => {
  h.listings.length = 0;
  h.stores.clear();
  h.payments.length = 0;
  h.admins.clear();
  auditEvents.length = 0;
  broadcastListing.mockReset().mockResolvedValue([{ success: true }]);
  fakeAuditEvent.create.mockClear();
  fakeLogger.warn.mockClear();
  vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue({
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(async () => {}),
    abortTransaction: vi.fn(async () => {}),
    endSession: vi.fn(),
  });
  // Controllers resolve their requires at first load; load them lazily so the
  // injected fakes above are definitely in the cache.
  paymentController = require('../src/controllers/paymentController.js');
  storeController = require('../src/controllers/storeController.js');
  listingController = require('../src/controllers/listingController.js');
  adminAuthController = require('../src/controllers/adminAuthController.js');
  adminAuth = require('../src/middleware/adminAuth.js');
  storeAuth = require('../src/middleware/storeAuth.js');
  auditService = require('../src/services/auditService.js');
  ({ OWNER_ACTOR_FALLBACK, SYSTEM_ACTOR } = auditService);
});

afterAll(() => { vi.restoreAllMocks(); });

const flush = async () => { await new Promise((r) => setImmediate(r)); };

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = vi.fn(function (code) { res.statusCode = code; return res; });
  res.json = vi.fn(function (payload) { res.body = payload; return res; });
  return res;
}
function getHeader(headers) {
  return (name) => headers[name] ?? headers[name.toLowerCase()];
}

function listingPayment(overrides = {}) {
  return {
    type: 'listing',
    status: 'pending',
    package: 'standard',
    invoiceId: 'INV-LISTING-1',
    amount: 50,
    expectedAmount: 50,
    ownerTokenHash: 'a'.repeat(64),
    listingData: {
      title: 'Vintage Lens Camera', category: 'Electronics', condition: 'Good', price: 500,
      description: 'Lightly used camera body', sellerName: 'Jane', sellerWhatsapp: '0711111111',
      location: 'Egerton', images: [],
    },
    ...overrides,
  };
}
function storePayment(overrides = {}) {
  return {
    type: 'store',
    status: 'pending',
    storePlan: 'standard_monthly',
    invoiceId: 'INV-STORE-1',
    amount: 200,
    expectedAmount: 200,
    ownerTokenHash: 'b'.repeat(64),
    storeData: {
      name: 'Campus Store', slug: 'campus-store', category: 'Food',
      phone: '0700000000', whatsapp: '0700000000',
    },
    ...overrides,
  };
}
const findEvent = (action, extra) =>
  auditEvents.find(e => e.action === action && (!extra || extra(e)));

// ─── Payment / webhook sites ────────────────────────────────────────────────
describe('Audit trail — payment and webhook sites', () => {
  it('records webhook.missing_invoice_id as a failure', async () => {
    const req = { body: { challenge: 'test-challenge', state: 'COMPLETE' }, id: 'r1' };
    const res = fakeRes();
    await paymentController.handleWebhook(req, res, vi.fn());
    await flush();

    expect(res.statusCode).toBe(400);
    const ev = findEvent('webhook.missing_invoice_id');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe(SYSTEM_ACTOR);
    expect(ev.resource).toBe('payment');
    expect(ev.result).toBe('failure');
  });

  it('records payment.completed (listing) as a success', async () => {
    h.payments.push(makeDoc(listingPayment()));
    const req = { body: { challenge: 'test-challenge', invoice_id: 'INV-LISTING-1', state: 'COMPLETE' }, id: 'r2' };
    const res = fakeRes();
    await paymentController.handleWebhook(req, res, vi.fn());
    await flush();

    const ev = findEvent('payment.completed', e => e.metadata.type === 'listing');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('success');
    expect(ev.resource).toBe('payment');
    expect(ev.resourceId).toBeTruthy();
  });

  it('records payment.completed (store) as a success', async () => {
    h.payments.push(makeDoc(storePayment()));
    const req = { body: { challenge: 'test-challenge', invoice_id: 'INV-STORE-1', state: 'COMPLETE' }, id: 'r3' };
    const res = fakeRes();
    await paymentController.handleWebhook(req, res, vi.fn());
    await flush();

    const ev = findEvent('payment.completed', e => e.metadata.type === 'store');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('success');
  });

  it('records webhook.broadcast_skipped as a failure when the broadcast rejects', async () => {
    broadcastListing.mockRejectedValueOnce(new Error('Whapi down'));
    h.payments.push(makeDoc(listingPayment()));
    const req = { body: { challenge: 'test-challenge', invoice_id: 'INV-LISTING-1', state: 'COMPLETE' }, id: 'r4' };
    const res = fakeRes();
    await paymentController.handleWebhook(req, res, vi.fn());
    await flush();
    await flush();

    const ev = findEvent('webhook.broadcast_skipped');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
    expect(ev.resource).toBe('listing');
    expect(ev.resourceId).toBeTruthy();
  });
});

// ─── Store sites ────────────────────────────────────────────────────────────
describe('Audit trail — store sites', () => {
  it('records store.update success', async () => {
    // The route's storeAuth middleware attaches req.ownerTokenHash from the
    // store document; run it so this proves the full attribution path.
    const ownerHash = sha256hex('sto-1-owner-token');
    const store = makeDoc({ _id: 'sto-1', name: 'Old', slug: 'old', status: 'active', expires_at: new Date(Date.now() + 1e9), ownerTokenHash: ownerHash });
    h.stores.set('sto-1', store);
    const headers = { 'X-Store-Owner-Token': 'sto-1-owner-token' };
    const req = { params: { id: 'sto-1' }, body: { name: 'New' }, headers, get: getHeader(headers) };
    const res = fakeRes();
    const next = vi.fn();
    await storeAuth({ requireActive: true })(req, res, next);
    expect(next).toHaveBeenCalled();
    await storeController.updateStore(req, res, vi.fn());
    await flush();

    const ev = findEvent('store.update');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe(ownerHash);
    expect(ev.resource).toBe('store');
    expect(ev.resourceId).toBe('sto-1');
    expect(ev.result).toBe('success');
  });

  it('records store.delete success', async () => {
    const ownerHash = sha256hex('sto-2-owner-token');
    const store = makeDoc({ _id: 'sto-2', name: 'Shop', status: 'active', ownerTokenHash: ownerHash });
    h.stores.set('sto-2', store);
    h.listings.push(makeDoc({ _id: 'lst-x', store_id: 'sto-2', images: [] }));
    const headers = { 'X-Store-Owner-Token': 'sto-2-owner-token' };
    const req = { params: { id: 'sto-2' }, headers, get: getHeader(headers) };
    const res = fakeRes();
    const next = vi.fn();
    // Route uses storeAuth({ allowAdmin: true }); a valid owner token authorizes.
    await storeAuth({ allowAdmin: true })(req, res, next);
    expect(next).toHaveBeenCalled();
    await storeController.deleteStore(req, res, vi.fn());
    await flush();

    const ev = findEvent('store.delete');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe(ownerHash);
    expect(ev.resourceId).toBe('sto-2');
    expect(ev.result).toBe('success');
  });

  it('falls back to owner:unknown when no owner hash is available', async () => {
    // Unexpected flow: credential is 'owner' but nothing attached a hash to req
    // and the document carries none. The stable fallback must still be recorded.
    const store = makeDoc({ _id: 'sto-3', name: 'Old', slug: 'old', status: 'active', expires_at: new Date(Date.now() + 1e9) });
    h.stores.set('sto-3', store);
    const req = { params: { id: 'sto-3' }, body: { name: 'New' }, store, headers: {} };
    const res = fakeRes();
    await storeController.updateStore(req, res, vi.fn());
    await flush();

    const ev = findEvent('store.update');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe(OWNER_ACTOR_FALLBACK);
    expect(ev.actor).toBe('owner:unknown');
  });
});

// ─── Listing sites ──────────────────────────────────────────────────────────
describe('Audit trail — listing sites', () => {
  it('records listing.delete success (owner credential)', async () => {
    const ownerHash = sha256hex('tok');
    h.listings.push(makeDoc({ _id: 'lst-1', ownerTokenHash: ownerHash, images: [] }));
    const req = { params: { id: 'lst-1' }, headers: { 'X-Owner-Token': 'tok' }, get: getHeader({ 'X-Owner-Token': 'tok' }) };
    const res = fakeRes();
    await listingController.deleteListing(req, res, vi.fn());
    await flush();

    const ev = findEvent('listing.delete');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe(ownerHash);
    expect(ev.resourceId).toBe('lst-1');
  });

  it('records listing.moderate success', async () => {
    h.listings.push(makeDoc({ _id: 'lst-2', moderationStatus: 'approved' }));
    const req = { params: { id: 'lst-2' }, body: { action: 'flagged' }, admin: { username: 'owner' }, headers: {} };
    const res = fakeRes();
    await listingController.moderateListing(req, res, vi.fn());
    await flush();

    const ev = findEvent('listing.moderate');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('admin:owner');
    expect(ev.metadata.moderationStatus).toBe('flagged');
  });
});

// ─── Admin sites ────────────────────────────────────────────────────────────
describe('Audit trail — admin sites', () => {
  it('records admin.setup_2fa success', async () => {
    const req = { headers: { 'x-admin-key': 'test-admin-key' }, ip: '10.0.0.1', body: {} };
    const res = fakeRes();
    await adminAuthController.setup2FA(req, res);
    await flush();

    const ev = findEvent('admin.setup_2fa');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('success');
    expect(ev.actor).toBe('admin:owner');
  });

  it('records admin.setup_2fa failure on a bad key', async () => {
    const req = { headers: {}, ip: '10.0.0.2', body: {} };
    const res = fakeRes();
    await adminAuthController.setup2FA(req, res);
    await flush();

    const ev = findEvent('admin.setup_2fa');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
  });

  it('records admin.verify_2fa success', async () => {
    const secret = speakeasy.generateSecret({ name: 'GikoMart' });
    h.admins.set('owner', makeDoc({ username: 'owner', totpSecret: secret.base32, totpEnabled: false }));
    const code = speakeasy.totp({ secret: secret.base32, encoding: 'base32' });
    const req = { headers: { 'x-admin-key': 'test-admin-key' }, ip: '10.0.0.3', body: { code } };
    const res = fakeRes();
    await adminAuthController.verify2FA(req, res);
    await flush();

    const ev = findEvent('admin.verify_2fa');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('success');
  });

  it('records admin.verify_2fa failure on an invalid code', async () => {
    const secret = speakeasy.generateSecret({ name: 'GikoMart' });
    h.admins.set('owner', makeDoc({ username: 'owner', totpSecret: secret.base32, totpEnabled: false }));
    const req = { headers: { 'x-admin-key': 'test-admin-key' }, ip: '10.0.0.4', body: { code: '000000' } };
    const res = fakeRes();
    await adminAuthController.verify2FA(req, res);
    await flush();

    const ev = findEvent('admin.verify_2fa');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
  });

  it('records admin.login success', async () => {
    const secret = speakeasy.generateSecret({ name: 'GikoMart' });
    h.admins.set('owner', makeDoc({ username: 'owner', totpSecret: secret.base32, totpEnabled: true, lastUsedCounter: 0 }));
    const code = speakeasy.totp({ secret: secret.base32, encoding: 'base32' });
    const req = { headers: { 'x-admin-key': 'test-admin-key' }, ip: '10.0.0.5', body: { code } };
    const res = fakeRes();
    await adminAuthController.login(req, res);
    await flush();

    const ev = findEvent('admin.login');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('success');
  });

  it('records admin.login failure on an invalid code', async () => {
    const secret = speakeasy.generateSecret({ name: 'GikoMart' });
    h.admins.set('owner', makeDoc({ username: 'owner', totpSecret: secret.base32, totpEnabled: true, lastUsedCounter: 0 }));
    const req = { headers: { 'x-admin-key': 'test-admin-key' }, ip: '10.0.0.6', body: { code: '000000' } };
    const res = fakeRes();
    await adminAuthController.login(req, res);
    await flush();

    const ev = findEvent('admin.login');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
  });

  it('records admin.lockout_triggered after 5 failures from one IP', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      await adminAuth({ headers: {}, ip, get: () => undefined }, res, vi.fn());
    }
    const res6 = fakeRes();
    await adminAuth({ headers: {}, ip, get: () => undefined }, res6, vi.fn());
    await flush();

    expect(res6.statusCode).toBe(429);
    const ev = findEvent('admin.lockout_triggered');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
  });

  it('records admin.session_invalid when 2FA is active but no session is supplied', async () => {
    h.admins.set('owner', makeDoc({ username: 'owner', totpEnabled: true }));
    const res = fakeRes();
    await adminAuth({ headers: {}, ip: '10.8.8.8', get: () => undefined }, res, vi.fn());
    await flush();

    expect(res.statusCode).toBe(401);
    const ev = findEvent('admin.session_invalid');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
  });
});

// ─── emit resilience + PII discipline ───────────────────────────────────────
describe('Audit trail — emit resilience and metadata hygiene', () => {
  it('emit() never throws when the underlying write rejects', async () => {
    fakeAuditEvent.create.mockRejectedValueOnce(new Error('db down'));
    expect(() => auditService.emit({
      actor: 'system', action: 'audit.test', resource: 'x', result: 'success',
    })).not.toThrow();
    await flush();
    await flush();

    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('never writes PII keys into emitted metadata', async () => {
    h.payments.push(makeDoc(listingPayment()));
    const req = { body: { challenge: 'test-challenge', invoice_id: 'INV-LISTING-1', state: 'COMPLETE' }, id: 'r5' };
    await paymentController.handleWebhook(req, fakeRes(), vi.fn());
    const store = makeDoc({ _id: 'sto-3', name: 'Old', slug: 'old', status: 'active', expires_at: new Date(Date.now() + 1e9) });
    h.stores.set('sto-3', store);
    await storeController.updateStore(
      { params: { id: 'sto-3' }, body: { name: 'New' }, store, headers: {} },
      fakeRes(), vi.fn(),
    );
    await flush();

    expect(auditEvents.length).toBeGreaterThan(0);
    for (const ev of auditEvents) {
      const serialized = JSON.stringify(ev.metadata || {});
      expect(serialized).not.toMatch(/(email|phone|phoneNumber|token|authorization|password|msisdn|secret)/i);
    }
  });
});
