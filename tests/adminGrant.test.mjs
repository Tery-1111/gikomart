import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import speakeasy from 'speakeasy';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

export const TEST_ADMIN_KEY = process.env.ADMIN_KEY;

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

// Bounded matcher: plain equality plus the $in operator used by the grant query.
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

// ── Payment fake — supports the atomic claim ──
// findOneAndUpdate(filter, update, options) must return the LIVE stored document
// (so the status transition and the listingId back-fill are observable), honour
// the sort, and only claim a still-matching row.
const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({
      _id: `pay-${h.payments.length + 1}`,
      status: 'pending',
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
  find: () => {
    const builder = {
      sort: () => builder,
      limit: () => builder,
      lean: async () => h.payments.map((p) => ({ ...p })),
    };
    return builder;
  },
  countDocuments: async () => 0,
  aggregate: async () => [],
};

// ── Listing fake — unique sparse paymentId index emulated ──
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
};

// ── Store fake ──
const fakeStoreModel = {
  create: async (data) => {
    if (data && data.paymentId != null && h.stores.some((s) => String(s.paymentId) === String(data.paymentId))) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { paymentId: 1 };
      throw dup;
    }
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

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Passthrough limiters — this file issues many /api/admin requests and would
// otherwise exhaust the 10/min adminLimiter budget.
const pass = () => (req, res, next) => next();
const fakeRateLimiterModule = {
  globalLimiter: pass(),
  uploadLimiter: pass(),
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
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;
let createResourceSpy;

beforeAll(async () => {
  // Install the spy BEFORE server.js is imported: adminGrant.js destructures
  // createResourceForPayment at require time, so the spy must already be on the
  // module's exports object when the router captures the reference.
  const paymentController = require('../src/controllers/paymentController');
  createResourceSpy = vi.spyOn(paymentController, 'createResourceForPayment');
  app = (await import('../server.js')).default;
});

beforeEach(() => {
  h.payments.length = 0;
  h.listings.length = 0;
  h.stores.length = 0;
  h.auditEvents.length = 0;
  h.admins.clear();
  createResourceSpy.mockClear();
});

afterAll(() => { vi.restoreAllMocks(); });

function listingPayment(overrides = {}) {
  return {
    type: 'listing',
    status: 'pending',
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

function storePayment(overrides = {}) {
  return {
    type: 'store',
    status: 'pending',
    storePlan: 'starter_weekly',
    phoneNumber: '254700000002',
    amount: 150,
    storeData: { name: 'Grant Shop', slug: 'grant-shop', category: 'Books' },
    ownerTokenHash: sha256hex('raw-token'),
    invoiceId: 'INV-GRANT-STORE',
    ...overrides,
  };
}

const URL = '/api/admin/grant-free-access';

// Flush fire-and-forget audit writes (emit is not awaited by the route).
const flush = () => new Promise((r) => setImmediate(r));

// Mint a valid X-Admin-Session token. The route is session-only, so every
// non-auth test must present one (same helper the wiring suite uses for its
// session-gated admin routes).
function session() {
  const { signSession } = require('../src/middleware/adminAuth');
  return signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
}

describe('POST /api/admin/grant-free-access — auth (session-only)', () => {
  it('rejects X-Admin-Key alone and mutates nothing', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app).post(URL).set('X-Admin-Key', TEST_ADMIN_KEY).send({ invoiceId: 'INV-GRANT-1' });

    expect([401, 403]).toContain(res.status);
    expect(h.payments[0].status).toBe('pending');
    expect(h.listings).toHaveLength(0);
    expect(createResourceSpy).not.toHaveBeenCalled();
  });

  it('rejects a request with no credentials and mutates nothing', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app).post(URL).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(401);
    expect(h.payments[0].status).toBe('pending');
    expect(h.listings).toHaveLength(0);
    expect(createResourceSpy).not.toHaveBeenCalled();
  });

  it('accepts a session minted by the real setup→verify→login flow', async () => {
    const setup = await request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', TEST_ADMIN_KEY);
    expect(setup.status).toBe(200);
    const secret = setup.body.secret;

    const verifyCode = speakeasy.totp({ secret, encoding: 'base32' });
    const verify = await request(app).post('/api/admin/verify-2fa').set('X-Admin-Key', TEST_ADMIN_KEY).send({ code: verifyCode });
    expect(verify.status).toBe(200);

    const loginCode = speakeasy.totp({ secret, encoding: 'base32' });
    const login = await request(app).post('/api/admin/login').set('X-Admin-Key', TEST_ADMIN_KEY).send({ code: loginCode });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const stored = makeDoc(listingPayment());
    h.payments.push(stored);
    const res = await request(app).post(URL)
      .set('X-Admin-Session', login.body.token)
      .send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(res.body.resource.type).toBe('listing');
    expect(stored.status).toBe('completed');
    await flush();
    const grants = h.auditEvents.filter((e) => e.action === 'admin.grant_free_access');
    expect(grants).toHaveLength(1);
    expect(grants[0].actor).toBe('admin:owner');
  });
});

describe('POST /api/admin/grant-free-access — selector validation', () => {
  it('400 when no selector is provided', async () => {
    const res = await request(app).post(URL).set('X-Admin-Session', session()).send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Provide one of: paymentId, invoiceId, phoneNumber' });
    expect(createResourceSpy).not.toHaveBeenCalled();
  });

  it('400 when more than one selector is provided, with no mutation', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const res = await request(app)
      .post(URL)
      .set('X-Admin-Session', session())
      .send({ paymentId: 'pay-1', phoneNumber: '254700000001' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Provide exactly one of: paymentId, invoiceId, phoneNumber' });
    expect(h.payments[0].status).toBe('pending');
    expect(h.listings).toHaveLength(0);
    expect(createResourceSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/grant-free-access — zero amount is not validated', () => {
  it('grants a pending payment whose amount is 0 (locks the no-amount-check behavior)', async () => {
    const stored = makeDoc(listingPayment({ amount: 0, expectedAmount: 0 }));
    h.payments.push(stored);

    const res = await request(app)
      .post(URL)
      .set('X-Admin-Session', session())
      .send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resource.type).toBe('listing');
    expect(stored.status).toBe('completed');
    expect(String(stored.listingId)).toBe(String(res.body.resource.id));
    expect(h.listings).toHaveLength(1);
  });
});

describe('POST /api/admin/grant-free-access — type restriction', () => {
  it('404 for a pending boost payment and never calls createResourceForPayment', async () => {
    h.payments.push(makeDoc({ type: 'boost', status: 'pending', boostType: 'featured', phoneNumber: '254700000003', amount: 50, invoiceId: 'INV-BOOST' }));

    const res = await request(app).post(URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-BOOST' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'No matching pending payment found' });
    expect(h.payments[0].status).toBe('pending');
    expect(createResourceSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/grant-free-access — listing happy path', () => {
  it('completes the payment, creates the listing, and audits success', async () => {
    const stored = makeDoc(listingPayment());
    h.payments.push(stored);

    const before = Date.now();
    const res = await request(app).post(URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Free access granted');
    expect(String(res.body.paymentId)).toBe(String(stored._id));
    expect(res.body.resource.type).toBe('listing');
    expect(res.body.resource.id).toBeTruthy();

    expect(stored.status).toBe('completed');
    expect(String(stored.listingId)).toBe(String(res.body.resource.id));
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].paymentId).toBe(stored._id);

    const expires = new Date(h.listings[0].expiresAt).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(expires).toBeGreaterThanOrEqual(before + sevenDays - 5000);
    expect(expires).toBeLessThanOrEqual(Date.now() + sevenDays + 5000);

    await flush();
    const grants = h.auditEvents.filter((e) => e.action === 'admin.grant_free_access');
    expect(grants).toHaveLength(1);
    expect(grants[0].result).toBe('success');
    expect(grants[0].actor).toBe('admin:owner');
    expect(grants[0].resource).toBe('Listing');
  });
});

describe('POST /api/admin/grant-free-access — store happy path', () => {
  it('completes the payment, creates the store with the plan limits, and audits', async () => {
    const stored = makeDoc(storePayment());
    h.payments.push(stored);

    const res = await request(app).post(URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-STORE' });

    expect(res.status).toBe(200);
    expect(res.body.resource.type).toBe('store');
    expect(stored.status).toBe('completed');
    expect(String(stored.storeId)).toBe(String(res.body.resource.id));
    expect(h.stores).toHaveLength(1);

    const store = h.stores[0];
    expect(store.listing_limit).toBe(5);
    expect(store.plan).toBe('starter_weekly');
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const expires = new Date(store.expires_at).getTime();
    expect(expires).toBeGreaterThan(Date.now() + sevenDays - 5000);
    expect(expires).toBeLessThan(Date.now() + sevenDays + 5000);

    await flush();
    const grants = h.auditEvents.filter((e) => e.action === 'admin.grant_free_access');
    expect(grants).toHaveLength(1);
    expect(grants[0].resource).toBe('Store');
  });
});

describe('POST /api/admin/grant-free-access — idempotency', () => {
  it('grants once; the second call 404s and creates no second resource or audit event', async () => {
    h.payments.push(makeDoc(listingPayment()));

    const first = await request(app).post(URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });
    expect(first.status).toBe(200);
    expect(first.body.resource.type).toBe('listing');

    const second = await request(app).post(URL).set('X-Admin-Session', session()).send({ invoiceId: 'INV-GRANT-1' });
    expect(second.status).toBe(404);
    expect(second.body).toEqual({ success: false, error: 'No matching pending payment found' });

    expect(h.listings).toHaveLength(1);
    await flush();
    expect(h.auditEvents.filter((e) => e.action === 'admin.grant_free_access')).toHaveLength(1);
  });
});

describe('POST /api/admin/grant-free-access — phone lookup ordering', () => {
  it('claims the most recent pending payment for the phone number', async () => {
    const older = makeDoc(listingPayment({ _id: 'pay-old', invoiceId: 'INV-OLD', createdAt: new Date(Date.now() - 60_000) }));
    const newer = makeDoc(listingPayment({ _id: 'pay-new', invoiceId: 'INV-NEW', createdAt: new Date() }));
    h.payments.push(older, newer);

    const res = await request(app).post(URL).set('X-Admin-Session', session()).send({ phoneNumber: '254700000001' });

    expect(res.status).toBe(200);
    expect(String(res.body.paymentId)).toBe('pay-new');
    expect(newer.status).toBe('completed');
    expect(older.status).toBe('pending');
  });
});

describe('POST /api/admin/grant-free-access — admin UI (JSDOM)', () => {
  it('builds the Grant view with textContent and posts the identifier via api()', async () => {
    const { JSDOM, VirtualConsole } = await import('jsdom');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');

    const html = readFileSync(path.join(process.cwd(), 'public', 'admin', 'index.html'), 'utf8');
    const virtualConsole = new VirtualConsole();
    virtualConsole.forwardTo(console);
    const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

    const g = globalThis;
    const saved = {
      document: g.document, window: g.window, Event: g.Event, localStorage: g.localStorage, sessionStorage: g.sessionStorage,
    };
    g.document = dom.window.document;
    g.window = dom.window;
    g.Event = dom.window.Event;
    g.localStorage = dom.window.localStorage;
    g.sessionStorage = dom.window.sessionStorage;

    const calls = [];
    const fetchStub = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/api/admin/login')) {
        return { ok: true, status: 200, json: async () => ({ success: true, token: 'tok-ui' }) };
      }
      if (String(url).includes('/api/admin/metrics')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (String(url).includes('/api/admin/grant-preview')) {
        return { ok: true, status: 200, json: async () => ({ success: true, payment: { id: 'pay-ui', type: 'listing', package: 'standard', storePlan: null, amount: 50, createdAt: '2026-10-02T12:00:00.000Z', title: 'Textbook for sale', storeName: null, phoneMasked: '2547***01' } }) };
      }
      if (String(url).includes('/api/admin/grant-free-access')) {
        return { ok: true, status: 200, json: async () => ({ success: true, message: 'Free access granted', paymentId: 'pay-ui', resource: { type: 'listing', id: 'lst-ui' } }) };
      }
      return { ok: false, status: 404, json: async () => ({ success: false }) };
    });
    vi.stubGlobal('fetch', fetchStub);

    try {
      await import('../public/assets/js/admin.js');

      // Sign in so the app section (and tabs) become active.
      dom.window.document.getElementById('adminKey').value = TEST_ADMIN_KEY;
      dom.window.document.getElementById('totpCode').value = '123456';
      dom.window.document.getElementById('loginForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      // Drive the tab through the DOM (the views object is IIFE-private).
      const grantTab = dom.window.document.querySelector('.tab[data-view="grant"]');
      expect(grantTab).toBeTruthy();
      expect(grantTab.textContent).toBe('Grant');
      grantTab.click();
      await new Promise((r) => setTimeout(r, 40));

      const form = dom.window.document.getElementById('grantForm');
      expect(form).toBeTruthy();
      const invoiceInput = dom.window.document.getElementById('grantInvoiceId');
      expect(invoiceInput).toBeTruthy();
      invoiceInput.value = 'INV-GRANT-1';
      // Step 3: preview first; the grant button stays disabled until the
      // preview succeeds for the current inputs.
      dom.window.document.getElementById('grantPreviewBtn').click();
      await new Promise((r) => setTimeout(r, 40));
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      const grantCall = calls.find((c) => c.url.includes('/api/admin/grant-free-access'));
      expect(grantCall).toBeTruthy();
      expect(JSON.parse(grantCall.options.body)).toEqual({ paymentId: 'pay-ui' });
      expect(Object.keys(JSON.parse(grantCall.options.body))).toEqual(['paymentId']);

      const msg = dom.window.document.getElementById('grantMsg');
      expect(msg.textContent).toContain('Free access granted');
      // No storage APIs were touched by the grant view.
      expect(dom.window.localStorage.length).toBe(0);
      expect(dom.window.sessionStorage.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      if (saved.document) g.document = saved.document; else delete g.document;
      if (saved.window) g.window = saved.window; else delete g.window;
      if (saved.Event) g.Event = saved.Event; else delete g.Event;
      if (saved.localStorage) g.localStorage = saved.localStorage; else delete g.localStorage;
      if (saved.sessionStorage) g.sessionStorage = saved.sessionStorage; else delete g.sessionStorage;
    }
  });
});
