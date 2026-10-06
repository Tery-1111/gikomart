import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env). Mirrors the harness
// in tests/adminGrant.test.mjs (which cannot be imported without editing it).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);

const h = { payments: [], listings: [], stores: [], auditEvents: [], admins: new Map() };

const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$in !== undefined && !v.$in.includes(doc[k])) return false;
      if (v.$ne !== undefined && doc[k] === v.$ne) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}

const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `pay-${h.payments.length + 1}`, status: 'pending', grantedBy: null, grantedAt: null, createdAt: new Date(Date.now() + h.payments.length), ...data });
    h.payments.push(doc);
    return doc;
  },
  // findOne must honour the sort option the preview route passes, exactly as the
  // real query does, so "most recent wins" is observable. Signature mirrors
  // Mongoose: findOne(filter, projection, options).
  findOne: async (filter = {}, ...args) => {
    // Mongoose signature is findOne(filter, projection, options); the route
    // passes null as the projection, so options is the third argument.
    const options = args[1] || {};
    const matching = h.payments.filter((p) => matchesFilter(p, filter));
    if (matching.length === 0) return null;
    if (options.sort && options.sort.createdAt === -1) {
      return makeDoc([...matching].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0]);
    }
    return makeDoc(matching[0]);
  },
  findOneAndUpdate: async (filter, update, options = {}) => {
    const matching = h.payments.filter((p) => matchesFilter(p, filter));
    if (matching.length === 0) return null;
    let chosen = matching[0];
    if (options.sort && options.sort.createdAt === -1) {
      chosen = [...matching].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    }
    Object.assign(chosen, update.$set || update);
    return chosen;
  },
  countDocuments: async () => 0,
  aggregate: async () => [],
};

const fakeListingModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, store_id: null, status: 'active', ...data });
    h.listings.push(doc);
    return doc;
  },
  findOne: async () => null,
};

const fakeStoreModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `sto-${h.stores.length + 1}`, ...data });
    h.stores.push(doc);
    return doc;
  },
  findOne: async () => null,
};

const fakeAuditEvent = {
  create: vi.fn(async (data) => { h.auditEvents.push(data); return data; }),
  find: () => {
    const builder = { sort: () => builder, limit: () => builder, lean: async () => h.auditEvents.map((e) => ({ ...e })) };
    return builder;
  },
};

const fakeAdminModel = {
  findOne: (filter) => {
    const doc = h.admins.get(filter.username) || null;
    return { select: () => Promise.resolve(doc), then: (res, rej) => Promise.resolve(doc).then(res, rej), catch: (rej) => Promise.resolve(doc).catch(rej) };
  },
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

const pass = () => (req, res, next) => next();
const fakeRateLimiterModule = {
  globalLimiter: pass(), uploadLimiter: pass(), uploadDailyLimiter: pass(), paymentLimiter: pass(), listingCreateLimiter: pass(),
  contactLimiter: pass(), adminLimiter: pass(), statusLimiter: pass(), contactReleaseLimiter: pass(), reportLimiter: pass(),
};

function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });
beforeEach(() => {
  h.payments.length = 0; h.listings.length = 0; h.stores.length = 0; h.auditEvents.length = 0; h.admins.clear();
});
afterAll(() => { vi.restoreAllMocks(); });

function listingPayment(overrides = {}) {
  return {
    _id: 'pay-1',
    type: 'listing',
    status: 'pending',
    grantedBy: null,
    grantedAt: null,
    package: 'standard',
    phoneNumber: '254700000001',
    amount: 50,
    listingData: { title: 'Textbook for sale', category: 'Books', condition: 'Good', price: 500, description: 'x', sellerName: 'Seller', sellerWhatsapp: '254700000001' },
    ownerTokenHash: sha256hex('raw-token'),
    invoiceId: 'INV-GRANT-1',
    ...overrides,
  };
}

const PREVIEW_URL = '/api/admin/grant-preview';
const GRANT_URL = '/api/admin/grant-free-access';

function session() {
  const { signSession } = require('../src/middleware/adminAuth');
  return signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
}

describe('POST /api/admin/grant-preview — auth', () => {
  it('401 without a session and mutates nothing', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app).post(PREVIEW_URL).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(401);
    expect(h.payments[0].status).toBe('pending');
  });
});

describe('POST /api/admin/grant-preview — selector validation', () => {
  it('400 with two selectors', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session())
      .send({ paymentId: 'pay-1', phoneNumber: '254700000001' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Provide exactly one of: paymentId, invoiceId, phoneNumber' });
    expect(h.payments[0].status).toBe('pending');
  });

  it('400 over the paymentId cap (24) on both routes', async () => {
    const over = 'p'.repeat(25);
    const preview = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ paymentId: over });
    const grant = await request(app).post(GRANT_URL).set('X-Admin-Session', session()).send({ paymentId: over });

    expect(preview.status).toBe(400);
    expect(preview.body).toEqual({ success: false, error: 'Invalid selector' });
    expect(grant.status).toBe(400);
    expect(grant.body).toEqual({ success: false, error: 'Invalid selector' });
  });

  it('400 over the invoiceId cap (64) on both routes', async () => {
    const over = 'i'.repeat(65);
    const preview = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: over });
    const grant = await request(app).post(GRANT_URL).set('X-Admin-Session', session()).send({ invoiceId: over });

    expect(preview.status).toBe(400);
    expect(grant.status).toBe(400);
  });

  it('400 over the phoneNumber cap (20) on both routes', async () => {
    const over = '9'.repeat(21);
    const preview = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ phoneNumber: over });
    const grant = await request(app).post(GRANT_URL).set('X-Admin-Session', session()).send({ phoneNumber: over });

    expect(preview.status).toBe(400);
    expect(grant.status).toBe(400);
  });

  it('accepts a selector exactly at the cap', async () => {
    h.payments.push(makeDoc(listingPayment({ invoiceId: 'i'.repeat(64) })));
    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'i'.repeat(64) });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/admin/grant-preview — no mutation', () => {
  it('does not change the payment (status stays pending)', async () => {
    const stored = makeDoc(listingPayment());
    h.payments.push(stored);

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(stored.status).toBe('pending');
    expect(stored.grantedBy).toBeNull();
    expect(stored.grantedAt).toBeNull();
  });

  it('404 when nothing matches', async () => {
    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'NOPE' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'No matching pending payment found' });
  });
});

describe('POST /api/admin/grant-preview — response shape and privacy', () => {
  it('returns the payment preview with a masked phone and no unmasked phone', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const p = res.body.payment;
    expect(p.id).toBe('pay-1');
    expect(p.type).toBe('listing');
    expect(p.package).toBe('standard');
    expect(p.storePlan).toBeNull();
    expect(p.amount).toBe(50);
    expect(p.title).toBe('Textbook for sale');
    expect(p.storeName).toBeNull();
    expect(p.phoneMasked).toBe('2547***01');
    // The raw phone number must not appear anywhere in the serialized response.
    expect(JSON.stringify(res.body)).not.toContain('254700000001');
  });

  it('returns a hostile title as a plain string, unmodified', async () => {
    h.payments.push(makeDoc(listingPayment({ listingData: { title: '<b>x</b>' } })));

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(res.body.payment.title).toBe('<b>x</b>');
  });

  it('caps title and storeName at 80 characters and returns the store name for a store payment', async () => {
    h.payments.push(makeDoc({
      type: 'store', status: 'pending', grantedBy: null, grantedAt: null, storePlan: 'starter_weekly',
      phoneNumber: '254700000002', amount: 150, storeData: { name: 'S'.repeat(100), slug: 's' },
      ownerTokenHash: sha256hex('t'), invoiceId: 'INV-STORE-PREVIEW',
    }));

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-STORE-PREVIEW' });

    expect(res.status).toBe(200);
    expect(res.body.payment.storeName).toHaveLength(80);
    expect(res.body.payment.storePlan).toBe('starter_weekly');
    expect(res.body.payment.title).toBeNull();
  });

  it('leaves a non-numeric phone value unchanged when it does not match the mask pattern', async () => {
    h.payments.push(makeDoc(listingPayment({ phoneNumber: 'not-a-number' })));

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(res.body.payment.phoneMasked).toBe('not-a-number');
  });

  it('previews the most recent pending payment for a phone number', async () => {
    const older = makeDoc(listingPayment({ _id: 'pay-old', invoiceId: 'INV-OLD', createdAt: new Date(Date.now() - 60_000) }));
    const newer = makeDoc(listingPayment({ _id: 'pay-new', invoiceId: 'INV-NEW', createdAt: new Date() }));
    h.payments.push(older, newer);

    const res = await request(app).post(PREVIEW_URL).set('X-Admin-Session', session()).send({ phoneNumber: '254700000001' });

    expect(res.status).toBe(200);
    expect(res.body.payment.id).toBe('pay-new');
    expect(older.status).toBe('pending');
    expect(newer.status).toBe('pending');
  });
});
