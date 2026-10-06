/* FIX-1(d) — Listing creation allowlist test. Uses the same require.cache fake
 * wiring as wiring.test.mjs, with the IntaSend SDK mocked (no network). */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);
const { TERMS_VERSIONS } = require('../src/config/termsVersions');

const h = { payments: [], listings: [], acceptance: [] };

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

const fakeListingModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', store_id: null, broadcastSent: false, priorityBroadcast: false, featured: false, boostType: null, featuredUntil: null, moderationStatus: 'approved', ...data });
    h.listings.push(doc);
    return doc;
  },
  findOne: async () => null,
  findById: () => ({ select: () => Promise.resolve(null), then: (res) => Promise.resolve(null).then(res) }),
  find: () => { const b = { populate: () => b, sort: () => b, skip: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; },
  countDocuments: async () => 0,
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

const mpesaStkPush = vi.fn(async () => ({ invoice: { invoice_id: 'INV-FIX1' }, id: 'INV-FIX1' }));
const fakeIntaSend = function IntaSend() {};
fakeIntaSend.prototype.collection = () => ({ mpesaStkPush });

function injectModule(relPath, exportsObj) {
  const resolved = resolveFromTests(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/BlockedContact.js', fakeBlockedContactModel);
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('intasend-node', fakeIntaSend);
// Upload model (FIX-5) is injected by other test files in the same process —
// provide a no-op implementation here so this file is self-contained.
injectModule('../src/models/Upload.js', { updateMany: async () => ({ modifiedCount: 0 }) });

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });

const ATTACK_KEYS = {
  featured: true,
  featuredUntil: '2099-01-01',
  boostType: 'rush',
  priorityBroadcast: true,
  broadcastSent: true,
  status: 'active',
  views: 99999,
  moderationStatus: 'approved',
  expiresAt: '2099-01-01',
  paymentId: '0123456789abcdef01234567',
  ownerTokenHash: 'f'.repeat(64),
};

const LEGIT = {
  title: 'Hasselblad 500C/M', category: 'Electronics', condition: 'Good', price: 45000,
  description: 'Medium format body, light seals replaced.', sellerName: 'Jane Kamau',
  sellerWhatsapp: '0712345678', location: 'Njoro',
};

const acceptance = {
  gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
  accepted: true,
};

const initiate = (listingData) =>
  request(app).post('/api/payments/initiate-listing').send({
    phoneNumber: '0712345678', package: 'standard', listingData, acceptance,
  });

describe('FIX-1: listing creation uses an explicit allowlist', () => {
  beforeAll(async () => {
    const res = await initiate({ ...LEGIT, ...ATTACK_KEYS });
    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe('INV-FIX1');
    const wh = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'test-challenge', invoice_id: 'INV-FIX1', state: 'COMPLETE' });
    expect(wh.status).toBe(200);
  });

  it('drops every attack key from Payment.listingData', () => {
    const stored = h.payments[0].listingData;
    for (const [k, v] of Object.entries(ATTACK_KEYS)) {
      expect(JSON.stringify(stored[k]), `listingData.${k}`).not.toBe(JSON.stringify(v));
    }
    expect(stored.paymentId).toBeUndefined();
    expect(stored.ownerTokenHash).toBeUndefined();
  });

  it('keeps the legitimate validated fields on the created Listing', () => {
    const listing = h.listings[0];
    expect(listing.title).toBe(LEGIT.title);
    expect(listing.category).toBe(LEGIT.category);
    expect(listing.condition).toBe(LEGIT.condition);
    expect(listing.price).toBe(LEGIT.price);
    expect(listing.description).toBe(LEGIT.description);
    expect(listing.sellerName).toBe(LEGIT.sellerName);
    expect(listing.sellerWhatsapp).toBe(LEGIT.sellerWhatsapp);
    expect(listing.location).toBe(LEGIT.location);
    expect(listing.package).toBe('standard');
    expect(listing.paymentId).toBe(h.payments[0]._id);
    expect(listing.store_id).toBe(null);
    expect(listing.expiresAt).toBeInstanceOf(Date);
    expect(listing.moderationStatus).toBe('approved');
    expect(typeof listing.ownerTokenHash).toBe('string');
    expect(listing.ownerTokenHash.length).toBeGreaterThan(0);
  });

  it('carries no attacker value onto the created Listing', () => {
    const listing = h.listings[0];
    // Schema defaults the real code sets (or that Mongoose applies):
    expect(listing.views).toBe(0);
    // broadcastSent is set to true by the app's own webhook broadcast step —
    // assert it is the boolean schema field, not the attacker's payload echo.
    expect(typeof listing.broadcastSent).toBe('boolean');
    expect(listing.priorityBroadcast).toBe(false);
    expect(listing.featured).toBe(false);
    expect(listing.boostType).toBe(null);
    // Explicit overrides defeat these even on old code — they must stay that way:
    expect(listing.moderationStatus).toBe('approved');
    expect(listing.expiresAt).toBeInstanceOf(Date);
    expect(listing.expiresAt.getTime()).toBeLessThan(new Date('2100-01-01').getTime());
    expect(listing.ownerTokenHash).not.toBe('f'.repeat(64));
    expect(String(listing.paymentId)).not.toBe('0123456789abcdef01234567');
  });

  it('rejects store_id at initiate time as before', async () => {
    const res = await initiate({ ...LEGIT, store_id: '0123456789abcdef01234567' });
    expect(res.status).toBe(400);
  });
});
