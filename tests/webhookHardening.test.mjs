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
  create: vi.fn(async (data) => {
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', store_id: null, broadcastSent: false, priorityBroadcast: false, featured: false, boostType: null, featuredUntil: null, moderationStatus: 'approved', ...data });
    h.listings.push(doc);
    return doc;
  }),
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
  // Honors the status condition of real atomic-claim filters (exact match or
  // { $ne }) so the pending-only FAILED/COMPLETE claims are exercised truly.
  findOneAndUpdate: async (filter, update) => {
    const statusOk = (x) => {
      if (filter.status === undefined) return true;
      if (filter.status !== null && typeof filter.status === 'object') {
        return filter.status.$ne === undefined || x.status !== filter.status.$ne;
      }
      return x.status === filter.status;
    };
    const p = h.payments.find(x => x.invoiceId === filter.invoiceId
      && (filter._id === undefined || String(x._id) === String(filter._id))
      && statusOk(x));
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
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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

// Seed a pending listing payment directly (same shape the initiate endpoint
// writes) — used by webhook-only tests so they stay inside the real
// paymentLimiter/listingCreateLimiter budget (5/min/IP) that this wired-app
// harness keeps active. The initiate path itself is covered by the tests above.
function seedListingPayment(invoiceId) {
  const doc = makeDoc({
    _id: `pay-${invoiceId}`,
    type: 'listing',
    status: 'pending',
    package: 'standard',
    invoiceId,
    amount: 50,
    expectedAmount: 50,
    ownerTokenHash: 'c'.repeat(64),
    listingData: { ...LEGIT },
  });
  h.payments.push(doc);
  return doc;
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

describe('payment-state ordering safety', () => {
  it('pending → FAILED: payment becomes failed with provider failure detail retained, nothing provisioned', async () => {
    const invoiceId = 'INV-ORD-FAILED-1';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    const res = await request(app).post('/api/payments/webhook')
      .send({
        challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED',
        failed_code: '1032', failed_reason: 'Request cancelled by user',
      });
    expect(res.status).toBe(200);
    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('failed');
    expect(payment.failedCode).toBe('1032');
    expect(payment.failedReason).toBe('Request cancelled by user');
    expect(h.listings.length).toBe(listingsBefore);
  });

  it('generic FAILED without failure detail does not crash and stores no detail', async () => {
    const invoiceId = 'INV-ORD-FAILED-2';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    const res = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED' });
    expect(res.status).toBe(200);
    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('failed');
    expect(payment.failedCode).toBeUndefined();
    expect(payment.failedReason).toBeUndefined();
    expect(h.listings.length).toBe(listingsBefore);
  });

  it('duplicate FAILED events retain the latest failure detail and stay failed', async () => {
    const invoiceId = 'INV-ORD-FAILED-3';
    seedListingPayment(invoiceId);
    const first = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED', failed_code: '1', failed_reason: 'first' });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED', failed_code: '1032', failed_reason: 'Request cancelled by user' });
    expect(second.status).toBe(200);
    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('failed');
    expect(payment.failedCode).toBe('1032');
    expect(payment.failedReason).toBe('Request cancelled by user');
  });

  it('pending → COMPLETE → FAILED: completed payment is never downgraded, resource intact, no duplicate', async () => {
    const invoiceId = 'INV-ORD-MIXED-1';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    const complete = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(complete.status).toBe(200);
    expect(h.listings.length - listingsBefore).toBe(1);
    const created = h.listings[h.listings.length - 1];

    const failed = await request(app).post('/api/payments/webhook')
      .send({
        challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED',
        failed_code: '999', failed_reason: 'out-of-order event',
      });
    expect(failed.status).toBe(200);

    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('completed');
    expect(payment.failedCode).toBeUndefined();
    expect(h.listings.length - listingsBefore).toBe(1);
    expect(created.title).toBe(LEGIT.title);
    // The ignored late-FAILED event is observable, not silently absorbed.
    expect(fakeLogger.warn).toHaveBeenCalledWith(
      'FAILED webhook ignored for completed payment',
      expect.objectContaining({ invoice_id: invoiceId }),
    );
  });

  it('pending → FAILED → COMPLETE: recovery flow still completes and provisions exactly once', async () => {
    const invoiceId = 'INV-ORD-MIXED-2';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    const failed = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED', failed_code: '1032', failed_reason: 'Request cancelled by user' });
    expect(failed.status).toBe(200);
    expect(h.payments.find(p => p.invoiceId === invoiceId).status).toBe('failed');

    const complete = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(complete.status).toBe(200);
    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('completed');
    expect(h.listings.length - listingsBefore).toBe(1);
  });

  it('pending → COMPLETE → COMPLETE → FAILED: still completed, exactly one resource, FAILED is inert', async () => {
    const invoiceId = 'INV-ORD-MIXED-3';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    const first = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(second.status).toBe(200);
    expect(second.body.message).toBe('Payment already processed');
    const failed = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'FAILED', failed_code: '999', failed_reason: 'late event' });
    expect(failed.status).toBe(200);

    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('completed');
    expect(h.listings.length - listingsBefore).toBe(1);
  });

  it('unsupported provider states (PENDING/PROCESSING/RETRY/PARTIAL/CANCELED) change nothing, grant nothing, and are logged', async () => {
    const invoiceId = 'INV-ORD-STATES-1';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    for (const state of ['PENDING', 'PROCESSING', 'RETRY', 'PARTIAL', 'CANCELED']) {
      const res = await request(app).post('/api/payments/webhook')
        .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state, api_ref: 'listing_1' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      const payment = h.payments.find(p => p.invoiceId === invoiceId);
      expect(payment.status).toBe('pending');
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        'Webhook received unhandled provider state',
        expect.objectContaining({ invoice_id: invoiceId, state }),
      );
    }
    expect(h.listings.length).toBe(listingsBefore);
  });

  it('initiation response without a usable invoice id creates no Payment and fails safely', async () => {
    const paymentsBefore = h.payments.length;
    mpesaStkPush.mockResolvedValueOnce({ invoice: {} }); // no invoice_id, no id
    const res = await request(app).post('/api/payments/initiate-listing').send({
      phoneNumber: '0712345678', package: 'standard', listingData: { ...LEGIT }, acceptance,
    });
    expect(res.status).toBe(503);
    expect(res.body.invoiceId).toBeUndefined();
    expect(h.payments.length).toBe(paymentsBefore);
    expect(h.acceptance.length).toBe(0);
  });

  it('resource creation failure after completion: payment stays completed, no resource, high-severity diagnostic logged, 500 response', async () => {
    const invoiceId = 'INV-ORD-RESFAIL-1';
    seedListingPayment(invoiceId);
    const listingsBefore = h.listings.length;
    fakeListingModel.create.mockRejectedValueOnce(new Error('listing create failed'));

    const res = await request(app).post('/api/payments/webhook')
      .send({ challenge: 'whsec-correct-challenge-value', invoice_id: invoiceId, state: 'COMPLETE' });
    expect(res.status).toBe(500);

    const payment = h.payments.find(p => p.invoiceId === invoiceId);
    expect(payment.status).toBe('completed');
    expect(h.listings.length).toBe(listingsBefore);
    expect(fakeLogger.error).toHaveBeenCalledWith(
      'Payment completed but resource fulfilment failed — manual repair required',
      expect.objectContaining({
        invoiceId,
        paymentType: 'listing',
        error: 'listing create failed',
      }),
    );
  });
});
