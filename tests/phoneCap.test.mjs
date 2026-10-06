/* FIX-4(c) — Per-phone STK-push cap tests. IntaSend mocked; drives the real
 * initiate-listing, initiate-store-plan and boost handlers with rate limiters
 * bypassed so only the per-phone cap is under test. */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
process.env.BLOCK_HASH_SECRET = 'test-block-hash-secret-value';

const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);
const { TERMS_VERSIONS } = require('../src/config/termsVersions');

const h = { payments: [], listings: [], stores: [], acceptance: [] };

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$gte instanceof Date && !(doc[k] instanceof Date && doc[k] >= v.$gte)) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) return false;
  }
  return true;
}

const fakeListingModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', store_id: null, broadcastSent: false, moderationStatus: 'approved', ...data });
    h.listings.push(doc);
    return doc;
  },
  findOne: async () => null,
  findById: () => {
    const found = h.listings[0] || null;
    const thenable = { then: (res) => Promise.resolve(found).then(res) };
    thenable.select = () => thenable;
    return thenable;
  },
  find: () => { const b = { populate: () => b, sort: () => b, skip: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; },
  countDocuments: async () => 0,
};

const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `pay-${h.payments.length + 1}`, status: 'pending', createdAt: new Date(), ...data });
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
  // honors the phoneHash + createdAt window filters via matchesFilter
  countDocuments: async (filter = {}) => h.payments.filter(p => matchesFilter(p, filter)).length,
};

const fakeStoreModel = {
  create: async (data) => { const doc = makeDoc({ _id: `sto-${h.stores.length + 1}`, ...data }); h.stores.push(doc); return doc; },
  findOne: async (filter) => (filter && filter.slug ? h.stores.find(s => s.slug === filter.slug) || null : null),
  findById: () => Promise.resolve(null),
  find: () => { const b = { populate: () => b, sort: () => b, skip: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; },
  countDocuments: async () => 0,
};

const fakeTermsModel = {
  create: async (data) => makeDoc({ _id: `ta-${h.acceptance.length + 1}`, ...data }),
  findByIdAndUpdate: async () => makeDoc({}),
  countDocuments: async () => 0,
};

const fakeBlockedContactModel = { findOne: async () => null, countDocuments: async () => 0 };

const broadcastListing = vi.fn(async () => ({ success: true }));
const fakeWhatsappService = { broadcastListing, formatMessage: () => 'msg' };

const fakeCloudinary = { api: { ping: async () => ({ status: 'ok' }) }, uploader: { upload: vi.fn(), destroy: vi.fn() } };
const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const fakeAuditEvent = { create: vi.fn(async (d) => d), find: () => { const b = { sort: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; } };

let mpesaCalls = 0;
const mpesaStkPush = vi.fn(async () => {
  mpesaCalls += 1;
  const id = `INV-PH-${mpesaCalls}`;
  return { invoice: { invoice_id: id }, id };
});
const fakeIntaSend = function IntaSend() {};
fakeIntaSend.prototype.collection = () => ({ mpesaStkPush });

const realRateLimiter = require('../src/middleware/rateLimiter');
function injectModule(relPath, exportsObj) {
  const resolved = resolveFromTests(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/BlockedContact.js', fakeBlockedContactModel);
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('intasend-node', fakeIntaSend);
injectModule('../src/models/Upload.js', { updateMany: async () => ({ modifiedCount: 0 }) });
// Bypass IP-keyed limiters; the per-phone cap lives in the controller under test.
injectModule('../src/middleware/rateLimiter.js', {
  ...realRateLimiter,
  globalLimiter: (req, _res, next) => next(),
  uploadLimiter: (req, _res, next) => next(),
  paymentLimiter: (req, _res, next) => next(),
  listingCreateLimiter: (req, _res, next) => next(),
  reportLimiter: (req, _res, next) => next(),
  adminLimiter: (req, _res, next) => next(),
});

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });

const PHONE_A = '0712345678';   // capped number
const PHONE_B = '0725987632';   // control number
const LEGIT = {
  title: 'Phone Cap Item', category: 'Electronics', condition: 'Good', price: 500,
  description: 'cap test body', sellerName: 'Jane', sellerWhatsapp: '0711111111', location: 'Njoro',
};
const acceptance = {
  gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
  accepted: true,
};
const CAP_429 = { success: false, error: 'Too many payment requests for this number. Please try again later.' };

const listingReq = (phone) => request(app).post('/api/payments/initiate-listing')
  .send({ phoneNumber: phone, package: 'standard', listingData: { ...LEGIT }, acceptance });
const storeReq = (phone) =>
  request(app).post('/api/payments/initiate-store-plan')
  .send({
    phoneNumber: phone, storePlan: 'starter_weekly',
    storeData: { name: 'Cap Store', category: 'Electronics', phone, whatsapp: phone },
    acceptance: {
      gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
      storeOwnerTermsVersion: TERMS_VERSIONS.STORE_OWNER_TERMS,
      accepted: true,
    },
  });
describe('FIX-4: per-phone STK-push cap', () => {
  it('listing: three requests succeed, fourth within the hour is 429 and the SDK is not called', async () => {
    h.payments.length = 0; mpesaCalls = 0; mpesaStkPush.mockClear();
    for (let i = 0; i < 3; i++) {
      const res = await listingReq(PHONE_A);
      expect(res.status).toBe(200);
    }
    const callsBefore = mpesaCalls;
    const fourth = await listingReq(PHONE_A);
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual(CAP_429);
    expect(mpesaCalls).toBe(callsBefore); // SDK not called on the capped request
  });

  it('a different number is unaffected by the cap reached on the first', async () => {
    const res = await listingReq(PHONE_B);
    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toMatch(/^INV-PH-/);
  });

  it('cap applies to initiate-store-plan', async () => {
    h.payments.length = 0; mpesaCalls = 0; mpesaStkPush.mockClear();
    for (let i = 0; i < 3; i++) {
      const res = await storeReq(PHONE_A);
      expect(res.status).toBe(200);
    }
    const callsBefore = mpesaCalls;
    const fourth = await storeReq(PHONE_A);
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual(CAP_429);
    expect(mpesaCalls).toBe(callsBefore);
  });

  it('cap applies to boost (owner-token authorized)', async () => {
    h.payments.length = 0; mpesaCalls = 0; mpesaStkPush.mockClear();
    // a listing with a known ownerTokenHash so boost passes isOwnerOrAdmin
    const ownerToken = 'cap-test-owner-token';
    const { createHash } = await import('node:crypto');
    h.listings.length = 0;
    await fakeListingModel.create({
      title: 'Boost Target', category: 'Electronics', condition: 'Good', price: 1,
      description: 'x', sellerName: 'J', sellerWhatsapp: PHONE_A,
      ownerTokenHash: createHash('sha256').update(ownerToken).digest('hex'),
    });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/payments/boost')
        .set('X-Owner-Token', ownerToken)
        .send({ listingId: 'lst-1', phoneNumber: PHONE_A, boostType: 'featured' });
      expect(res.status).toBe(200);
    }
    const callsBefore = mpesaCalls;
    const fourth = await request(app).post('/api/payments/boost')
      .set('X-Owner-Token', ownerToken)
      .send({ listingId: 'lst-1', phoneNumber: PHONE_A, boostType: 'featured' });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual(CAP_429);
    expect(mpesaCalls).toBe(callsBefore);
  });

  it('stores phoneHash (not the raw number) on every new Payment record', async () => {
    const { contactHash } = require('../src/utils/phone');
    h.payments.length = 0;
    await listingReq(PHONE_B);
    const record = h.payments[h.payments.length - 1];
    expect(record.phoneHash).toBe(contactHash(PHONE_B));
    expect(record.phoneHash).not.toContain('725987632');
    expect(String(record.phoneNumber)).toBe(PHONE_B); // pre-existing field, unchanged behavior
  });
});
