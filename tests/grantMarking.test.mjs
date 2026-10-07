import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env). Mirrors the harness
// in tests/adminGrant.test.mjs (which cannot be imported without editing it).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

export const TEST_ADMIN_KEY = process.env.ADMIN_KEY;
const TEST_WEBHOOK_CHALLENGE = process.env.INTASEND_WEBHOOK_CHALLENGE;

const require = createRequire(import.meta.url);

// ── Fake state ──
const h = {
  payments: [],
  listings: [],
  stores: [],
  auditEvents: [],
  admins: new Map(),
};

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

// Payment fake mirrors the schema defaults for the two new fields, so a payment
// created any way other than an admin grant keeps grantedBy/grantedAt null.
const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({
      _id: `pay-${h.payments.length + 1}`,
      status: 'pending',
      grantedBy: null,
      grantedAt: null,
      createdAt: new Date(Date.now() + h.payments.length),
      ...data,
    });
    h.payments.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => makeDoc(h.payments.find((p) => matchesFilter(p, filter)) || null),
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
  findById: async (id) => makeDoc(h.payments.find((p) => String(p._id) === String(id)) || null),
  countDocuments: async () => 0,
  aggregate: async () => [],
};

const fakeListingModel = {
  create: async (data) => {
    if (data && data.paymentId != null && h.listings.some((l) => String(l.paymentId) === String(data.paymentId))) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { paymentId: 1 };
      throw dup;
    }
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, store_id: null, status: 'active', ...data });
    h.listings.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    if (filter.paymentId != null) {
      return h.listings.find((l) => String(l.paymentId) === String(filter.paymentId)) || null;
    }
    return null;
  },
  findById: (id) => {
    const doc = h.listings.find((l) => String(l._id) === String(id)) || null;
    return { select: () => Promise.resolve(doc), then: (res, rej) => Promise.resolve(doc).then(res, rej), catch: (rej) => Promise.resolve(doc).catch(rej) };
  },
};

const fakeStoreModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `sto-${h.stores.length + 1}`, ...data });
    h.stores.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    if (filter.paymentId != null) {
      return h.stores.find((s) => String(s.paymentId) === String(filter.paymentId)) || null;
    }
    return null;
  },
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

const fakeTermsModel = {
  findByIdAndUpdate: async () => makeDoc({}),
};

const fakeWhatsappService = { broadcastListing: vi.fn(async () => [{ groupId: 'group-a', success: true }]), formatMessage: () => 'msg' };

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

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

injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

beforeEach(() => {
  h.payments.length = 0;
  h.listings.length = 0;
  h.stores.length = 0;
  h.auditEvents.length = 0;
  h.admins.clear();
});

afterAll(() => { vi.restoreAllMocks(); });

function listingPayment(overrides = {}) {
  return {
    type: 'listing',
    status: 'pending',
    // Schema defaults — a payment created through the real model carries these.
    grantedBy: null,
    grantedAt: null,
    package: 'standard',
    phoneNumber: '254700000001',
    amount: 50,
    listingData: {
      title: 'Textbook for sale',
      category: 'Books',
      condition: 'Good',
      price: 500,
      description: 'A gently used textbook.',
      sellerName: 'Seller',
      sellerWhatsapp: '254700000001',
    },
    ownerTokenHash: sha256hex('raw-token'),
    invoiceId: 'INV-GRANT-1',
    ...overrides,
  };
}

const GRANT_URL = '/api/admin/grant-free-access';
const flush = () => new Promise((r) => setImmediate(r));

function session() {
  const { signSession } = require('../src/middleware/adminAuth');
  return signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
}

describe('grant marking — admin grant records grantedBy/grantedAt', () => {
  it('marks the payment completed with grantedBy = the admin actor and a grantedAt Date', async () => {
    const stored = makeDoc(listingPayment());
    h.payments.push(stored);

    const res = await request(app).post(GRANT_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(stored.status).toBe('completed');
    expect(stored.grantedBy).toBe('admin:owner');
    expect(stored.grantedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(stored.grantedAt.getTime())).toBe(false);
  });

  it('records grantedAt (ISO string) in the audit metadata', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app).post(GRANT_URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });
    expect(res.status).toBe(200);

    await flush();
    const grant = h.auditEvents.find((e) => e.action === 'admin.grant_free_access');
    expect(grant).toBeTruthy();
    expect(typeof grant.metadata.grantedAt).toBe('string');
    expect(Number.isNaN(new Date(grant.metadata.grantedAt).getTime())).toBe(false);
  });
});

describe('grant marking — a webhook-completed payment is not marked as granted', () => {
  it('leaves grantedBy null when the payment completes through the real webhook', async () => {
    const stored = makeDoc(listingPayment({ invoiceId: 'INV-WEBHOOK-1', expectedAmount: 50 }));
    h.payments.push(stored);

    const res = await request(app)
      .post('/api/payments/webhook')
      .send({ challenge: TEST_WEBHOOK_CHALLENGE, invoice_id: 'INV-WEBHOOK-1', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(stored.status).toBe('completed');
    expect(stored.grantedBy).toBeNull();
    expect(stored.grantedAt).toBeNull();
  });
});
