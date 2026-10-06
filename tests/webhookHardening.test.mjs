/* FIX-3(d) — Webhook hardening tests. IntaSend fully mocked; exercises the
 * real handleWebhook through the wired app. Confirmation-call cases (FIX-3c)
 * are BLOCKED (SDK shape unknown per STEP 0D) and intentionally absent. */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'whsec-correct-challenge-value';
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

let whSeq = 0;
const mpesaStkPush = vi.fn(async () => {
  whSeq += 1;
  const id = `INV-WH-${whSeq}`;
  return { invoice: { invoice_id: id }, id };
});
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
injectModule('../src/models/Upload.js', { updateMany: async () => ({ modifiedCount: 0 }) });

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });

const LEGIT = {
  title: 'Webhook Test Item', category: 'Electronics', condition: 'Good', price: 500,
  description: 'wh test body', sellerName: 'Jane', sellerWhatsapp: '0711111111', location: 'Njoro',
};
const acceptance = {
  gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
  accepted: true,
};

async function initiatePayment() {
  const res = await request(app).post('/api/payments/initiate-listing').send({
    phoneNumber: '0712345678', package: 'standard', listingData: { ...LEGIT }, acceptance,
  });
  expect(res.status).toBe(200);
  return res.body.invoiceId;
}

describe('FIX-3: webhook hardening', () => {
  it('wrong challenge → 401, fail-closed body unchanged, non-string challenges rejected', async () => {
    const invoiceId = await initiatePayment();
    for (const bad of ['wrong-value', 123, { toString: () => 'whsec-correct-challenge-value' }, undefined]) {
      const res = await request(app).post('/api/payments/webhook')
        .send({ challenge: bad, invoice_id: invoiceId, state: 'COMPLETE' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Invalid webhook challenge' });
    }
    expect(h.listings.length).toBe(0);
  });

  it('amount lower than expected → 400, payment status not completed, nothing provisioned; redelivery provisions nothing', async () => {
    const invoiceId = await initiatePayment();
    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    payment.amount = payment.expectedAmount - 100; // attacker-relevant drift

    const res = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Payment amount validation failed' });
    expect(payment.status).not.toBe('completed');

    // redelivery after the mismatch
    const res2 = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(res2.status).toBe(400);
    expect(h.listings.length).toBe(0);
  });

  it('correct challenge + valid amounts → provisioned exactly once', async () => {
    const invoiceId = await initiatePayment();
    const res = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(res.status).toBe(200);
    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('completed');
    expect(h.listings.length).toBe(1);
    expect(h.listings[0].title).toBe(LEGIT.title);
  });

  it('same webhook delivered twice → provisioned once, duplicate answered 200 already-processed', async () => {
    const before = h.listings.length;
    const invoiceId = await initiatePayment();
    const first = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(second.status).toBe(200);
    expect(second.body.message).toBe('Payment already processed');
    expect(h.listings.length - before).toBe(1);
  });
});
