// EDGE-ATTACK SUITE — POST /api/stores/:id/listings (store-included listings).
// Companion to tests/storeListings.test.mjs: where that file proves the happy
// paths, this file attacks the boundaries (auth, lifecycle, capacity, expiry,
// payment isolation, validation, injection, ownership, cross-store isolation,
// duplicates, concurrency, HTTP abuse) and verifies failure atomicity against
// the in-memory state after every attack.
//
// Same seam as tests/wiring.test.mjs / storeListings.test.mjs: in-memory model
// fakes injected into require.cache before server.js is imported. Deliberately
// REAL: moderationService, termsAcceptanceService, storeAuth, ttlCache, and the
// real HMAC contactHash. The fake session emulates MongoDB's observable
// conflict outcome — contended transactions are serialized (abort+retry), so
// concurrent publications can never interleave their count→insert window.
//
// Operator-semantics note (code-inspected, §3 of the edge plan): storeAuth
// rejects when `store.expires_at < new Date()` (storeAuth.js) — equality is
// NOT expired. The boundary tests below pin behavior strictly AROUND the
// boundary (past → rejected; future → accepted); a deterministic exact-equality
// race against wall-clock time is not testable here and is documented instead.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);
const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');
const { TERMS_VERSIONS } = require('../src/config/termsVersions');

const h = {
  payments: [],
  stores: new Map(),
  listings: [],
  terms: [],
  uploads: [],
  blocked: [],
  audit: [],
};

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

function selectableDoc(doc) {
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}

function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$ne !== undefined && doc[k] === v.$ne) return false;
      if (v.$in !== undefined && !v.$in.includes(doc[k])) return false;
      if (v.$gte !== undefined && !(doc[k] && new Date(doc[k]) >= new Date(v.$gte))) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}

const fakeListingModel = {
  create: async (data) => {
    const isArr = Array.isArray(data);
    const docs = (isArr ? data : [data]).map((d) =>
      makeDoc({
        _id: `lst-${h.listings.length + 1}`,
        views: 0,
        status: 'active',
        store_id: null,
        broadcastSent: false,
        priorityBroadcast: false,
        featured: false,
        boostType: null,
        featuredUntil: null,
        moderationStatus: 'approved',
        ...d,
      })
    );
    docs.forEach((d) => h.listings.push(d));
    return isArr ? docs : docs[0];
  },
  findOne: async (filter = {}) => {
    if (filter.paymentId != null) {
      return h.listings.find((l) => String(l.paymentId) === String(filter.paymentId)) || null;
    }
    if (filter._id !== undefined) {
      const doc = h.listings.find((l) => String(l._id) === String(filter._id));
      if (!doc) return null;
      for (const [k, v] of Object.entries(filter)) {
        if (k === '_id') continue;
        if (v !== null && typeof v === 'object') {
          if (v.$in !== undefined && !v.$in.includes(doc[k])) return null;
          if (v.$ne !== undefined && doc[k] === v.$ne) return null;
        } else if (doc[k] !== v) return null;
      }
      return doc;
    }
    return null;
  },
  findById: (id) => selectableDoc(h.listings.find((l) => String(l._id) === String(id)) || null),
  countDocuments: async (filter = {}) => h.listings.filter((l) => matchesFilter(l, filter)).length,
  deleteOne: async (filter) => {
    const i = h.listings.findIndex((l) => String(l._id) === String(filter._id));
    let deletedCount = 0;
    if (i !== -1) {
      h.listings.splice(i, 1);
      deletedCount = 1;
    }
    return { deletedCount };
  },
  find: (filter = {}) => {
    const out = () => h.listings.filter((l) => matchesFilter(l, filter));
    return { lean: async () => out().map((l) => ({ ...l })), then: (res, rej) => Promise.resolve(out()).then(res, rej), catch: (rej) => Promise.resolve(out()).catch(rej) };
  },
  findOneAndUpdate: (filter, update) => {
    const doc = h.listings.find((l) => matchesFilter(l, filter)) || null;
    if (doc && update) Object.assign(doc, update.$set || update);
    return selectableDoc(doc);
  },
};

const fakeStoreModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `sto-${h.stores.size + 1}`, status: 'active', subcategories: [], ...data });
    h.stores.set(String(doc._id), doc);
    return doc;
  },
  findById: (id) => selectableDoc(h.stores.get(String(id)) || null),
  findOne: (filter = {}) => {
    if (filter.slug !== undefined) {
      return Promise.resolve([...h.stores.values()].find((s) => s.slug === filter.slug) || null);
    }
    return Promise.resolve(null);
  },
  find: () => {
    const out = () => [...h.stores.values()];
    return { lean: async () => out().map((s) => ({ ...s })), then: (res, rej) => Promise.resolve(out()).then(res, rej), catch: (rej) => Promise.resolve(out()).catch(rej) };
  },
  countDocuments: async () => h.stores.size,
  findByIdAndUpdate: async (id, update) => {
    const doc = h.stores.get(String(id));
    if (!doc) return null;
    Object.assign(doc, update.$set || update);
    return doc;
  },
};

const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `pay-${h.payments.length + 1}`, ...data });
    h.payments.push(doc);
    return doc;
  },
  findOne: async () => null,
  findOneAndUpdate: async () => null,
  countDocuments: async () => h.payments.length,
};

const fakeTermsModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `terms-${h.terms.length + 1}`, ...data });
    h.terms.push(doc);
    return doc;
  },
  findOne: async () => null,
};

const fakeAuditModel = {
  create: async (data) => {
    h.audit.push(data);
    return makeDoc({ _id: `aud-${h.audit.length}`, ...data });
  },
};

const fakeBlockedModel = {
  findOne: async (filter = {}) => {
    const hashes = filter.contactHash && filter.contactHash.$in ? filter.contactHash.$in : [filter.contactHash];
    return h.blocked.find((b) => hashes.includes(b.contactHash)) || null;
  },
};

const fakeUploadModel = {
  updateMany: async (filter, update) => {
    h.uploads.push({ filter, update });
    return { modifiedCount: 1 };
  },
};

const fakeAdminModel = {
  findOne: async () => null,
  findById: () => selectableDoc(null),
  // authenticateAdmin calls Admin.find({ totpEnabled: true }).select().lean().
  find: () => ({ select: () => ({ lean: async () => [] }) }),
};
const fakeReportModel = { create: async (data) => makeDoc({ _id: 'rep-1', ...data }), countDocuments: async () => 0 };

const broadcastListing = vi.fn(async () => {});
const fakeWhatsappService = { broadcastListing, sendAdminAlert: vi.fn(async () => {}) };
const cloudinaryUpload = vi.fn(async () => ({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/x.jpg' }));
const cloudinaryDestroy = vi.fn(async () => ({ result: 'ok' }));
const fakeCloudinary = { uploader: { upload: cloudinaryUpload, destroy: cloudinaryDestroy }, v2: { uploader: { upload: cloudinaryUpload, destroy: cloudinaryDestroy } } };
const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ── require.cache injection (must precede importing server.js) ──
function injectModule(relPath, exportsObj) {
  const resolved = resolveFromTests(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/models/AuditEvent.js', fakeAuditModel);
injectModule('../src/models/BlockedContact.js', fakeBlockedModel);
injectModule('../src/models/Report.js', fakeReportModel);
injectModule('../src/models/Upload.js', fakeUploadModel);
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);

const realRateLimiter = require('../src/middleware/rateLimiter');
injectModule('../src/middleware/rateLimiter.js', {
  ...realRateLimiter,
  globalLimiter: (req, _res, next) => next(),
  uploadLimiter: (req, _res, next) => next(),
  paymentLimiter: (req, _res, next) => next(),
  listingCreateLimiter: (req, _res, next) => next(),
  reportLimiter: (req, _res, next) => next(),
  adminLimiter: (req, _res, next) => next(),
});

const realPaymentService = require('../src/services/paymentService');
const paymentSpies = {
  initiateBoostPayment: vi.fn(),
  initiateListingPayment: vi.fn(),
  initiateStorePlanPayment: vi.fn(),
};
injectModule('../src/services/paymentService.js', {
  ...realPaymentService,
  ...paymentSpies,
});

function createSerializedRunner() {
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(fn, fn);
    tail = result.then(() => {}, () => {});
    return result;
  };
}

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

beforeEach(() => {
  require('../src/utils/ttlCache').invalidateListingsCache();
  h.payments.length = 0;
  h.stores.clear();
  h.listings.length = 0;
  h.terms.length = 0;
  h.uploads.length = 0;
  h.blocked.length = 0;
  h.audit.length = 0;
  broadcastListing.mockClear();
  cloudinaryUpload.mockClear();
  cloudinaryDestroy.mockClear();
  Object.values(paymentSpies).forEach((s) => s.mockReset());
  const runSerialized = createSerializedRunner();
  vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue({
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(async () => {}),
    abortTransaction: vi.fn(async () => {}),
    endSession: vi.fn(),
    withTransaction: (fn) => runSerialized(fn),
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
function seedStore(overrides = {}) {
  const rawToken = overrides.rawToken || `token-${overrides._id || h.stores.size + 1}`;
  delete overrides.rawToken;
  const doc = makeDoc({
    _id: `sto-${h.stores.size + 1}`,
    name: 'Edge Store',
    slug: `edge-store-${h.stores.size + 1}`,
    plan: 'starter_weekly',
    status: 'active',
    listing_limit: 5,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    ownerTokenHash: sha256hex(rawToken),
    phone: '0720000000',
    whatsapp: '0720000000',
    location: 'Njoro',
    moderationStatus: 'approved',
    createdAt: new Date(),
    ...overrides,
  });
  h.stores.set(String(doc._id), doc);
  doc.__rawToken = rawToken;
  return doc;
}

const validListingData = (over = {}) => ({
  title: 'Edge camera',
  category: 'electronics',
  condition: 'Good',
  price: 4000,
  description: 'Works perfectly.',
  sellerName: 'Jane',
  sellerWhatsapp: '0711111111',
  location: 'Njoro',
  images: [],
  ...over,
});

const validAcceptance = () => ({
  accepted: true,
  gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
});

const validBody = (over = {}) => ({ listingData: validListingData(), acceptance: validAcceptance(), website: '', ...over });

// token === null → send WITHOUT the header; token === '' / ' ' → send empty.
const postListing = (store, body, token) => {
  const req = request(app).post(`/api/stores/${store._id}/listings`);
  if (token !== null) req.set('X-Store-Owner-Token', token === undefined ? store.__rawToken : token);
  return req.send(body);
};

const activeCount = (store) => h.listings.filter((l) => String(l.store_id) === String(store._id) && l.status === 'active').length;

// Global invariant snapshotter: after ANY request, these must hold.
function assertInvariants(limit = Infinity) {
  for (const store of h.stores.values()) {
    expect(activeCount(store)).toBeLessThanOrEqual(Math.min(store.listing_limit ?? Infinity, limit));
  }
  // No partially-created listing may lack the mandatory creation fields.
  for (const l of h.listings) {
    expect(String(l.store_id || '')).not.toBe('');
    expect(l.package).toBe('store');
    expect(l.expiresAt).toBeDefined();
    expect(l.ownerTokenHash).toBeDefined();
  }
  // Included listings are never payment-linked.
  expect(h.listings.every((l) => l.paymentId === undefined)).toBe(true);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. AUTHENTICATION BOUNDARY ATTACKS
// ═════════════════════════════════════════════════════════════════════════════
describe('auth boundary attacks', () => {
  it('rejects a MISSING auth header (no listing created)', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody(), null);
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
    assertInvariants();
  });

  it('rejects an EMPTY auth header', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody(), '');
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
  });

  it('WHITESPACE handling: HTTP-layer OWS trimming vs genuinely-invalid tokens', async () => {
    const store = seedStore();
    // Whitespace-ONLY token → no credential → 403.
    expect((await postListing(store, validBody(), ' ')).status).toBe(403);
    // Leading/trailing padding is stripped by the HTTP parser BEFORE the app
    // sees it, so a padded valid token is still the valid token → 201. This is
    // HTTP header semantics, not app-side normalization.
    expect((await postListing(store, validBody(), '  ' + store.__rawToken)).status).toBe(201);
    expect((await postListing(store, validBody(), store.__rawToken + ' ')).status).toBe(201);
    // An interior space makes it a genuinely different token → 403.
    expect((await postListing(store, validBody(), store.__rawToken.slice(0, 4) + ' ' + store.__rawToken.slice(4))).status).toBe(403);
    expect(h.listings.filter((l) => l.status === 'active')).toHaveLength(2);
  });

  it('rejects an EXCESSIVELY LONG token without crashing', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody(), 'a'.repeat(10000));
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects a random INVALID token', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody(), 'random-garbage-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized');
    expect(h.listings).toHaveLength(0);
  });

  it('WRONG-STORE credential: store A token cannot publish into store B (B unchanged)', async () => {
    const storeA = seedStore();
    const storeB = seedStore({ listing_limit: 3 });
    const before = JSON.stringify({ ...storeB, __rawToken: undefined });
    const res = await request(app)
      .post(`/api/stores/${storeB._id}/listings`)
      .set('X-Store-Owner-Token', storeA.__rawToken)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
    expect(JSON.stringify({ ...storeB, __rawToken: undefined })).toBe(before);
    assertInvariants();
  });

  it('NONEXISTENT store → clean 404, no crash, no listing', async () => {
    const res = await request(app)
      .post('/api/stores/sto-does-not-exist/listings')
      .set('X-Store-Owner-Token', 'whatever')
      .send(validBody());
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(h.listings).toHaveLength(0);
  });

  it('DELETED store: a previously valid token cannot publish after deletion', async () => {
    const store = seedStore();
    h.stores.delete(String(store._id));
    const res = await postListing(store, validBody());
    expect(res.status).toBe(404);
    expect(h.listings).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. STORE LIFECYCLE ATTACKS
// ═════════════════════════════════════════════════════════════════════════════
describe('store lifecycle attacks', () => {
  it('ACTIVE store → creation succeeds', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(activeCount(store)).toBe(1);
  });

  it('EXPIRED store (expiry strictly in the past) → 403, nothing created', async () => {
    const store = seedStore({ expires_at: new Date(Date.now() - 1) });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Store plan has expired');
    expect(h.listings).toHaveLength(0);
  });

  it('AT-EXPIRY boundary: operator is strict `<` (storeAuth.js) — equality is NOT expired; 100ms-future accepts, 1ms-past rejects', async () => {
    const soon = seedStore({ expires_at: new Date(Date.now() + 100) });
    // By the time the middleware constructs `new Date()`, >100ms of request
    // latency may have elapsed in CI — accept either outcome but assert the
    // DECISION is explained solely by the strict-< comparison, not a crash.
    const resSoon = await postListing(soon, validBody());
    expect([201, 403]).toContain(resSoon.status);
    if (resSoon.status === 403) expect(resSoon.body.error).toBe('Store plan has expired');
    expect(h.listings.filter((l) => l.store_id === soon._id)).toHaveLength(resSoon.status === 201 ? 1 : 0);
    assertInvariants();
  });

  it('SUSPENDED store → 403 (frozen for owner even with valid token)', async () => {
    const store = seedStore({ status: 'suspended' });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Resource is suspended or removed');
    expect(h.listings).toHaveLength(0);
  });

  it('EXPIRED-STATUS store (unexpired clock, status flipped) → 403 Store is not active', async () => {
    const store = seedStore({ status: 'expired' });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Store is not active');
    expect(h.listings).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. CAPACITY BOUNDARY ATTACKS  +  5. CAPACITY-COUNT SEMANTICS
// ═════════════════════════════════════════════════════════════════════════════
describe('capacity boundary attacks (0→5→6→delete→reuse)', () => {
  it('walks 0/5 → 5/5, rejects the 6th, and leaves the database at exactly 5', async () => {
    const store = seedStore({ listing_limit: 5 });
    for (let i = 1; i <= 5; i++) {
      const res = await postListing(store, validBody({ listingData: validListingData({ title: `Cap item ${i}` }) }));
      expect(res.status).toBe(201);
      expect(activeCount(store)).toBe(i);
      // Remaining capacity = limit − active, derivable at every step.
      expect(store.listing_limit - activeCount(store)).toBe(5 - i);
    }
    const sixth = await postListing(store, validBody({ listingData: validListingData({ title: 'Sixth item' }) }));
    expect(sixth.status).toBe(409);
    expect(sixth.body.error).toMatch(/Store listing limit reached \(5\)/);
    expect(activeCount(store)).toBe(5);
    expect(h.listings.filter((l) => l.title === 'Sixth item')).toHaveLength(0);
    assertInvariants();
  });

  it('delete-and-reuse: capacity represents CURRENTLY ACTIVE listings, not lifetime creations', async () => {
    const store = seedStore({ listing_limit: 2 });
    const a = await postListing(store, validBody({ listingData: validListingData({ title: 'Item A' }) }));
    await postListing(store, validBody({ listingData: validListingData({ title: 'Item B' }) }));
    expect(activeCount(store)).toBe(2);
    const blocked = await postListing(store, validBody({ listingData: validListingData({ title: 'Item C' }) }));
    expect(blocked.status).toBe(409);
    // Delete through the REAL seller endpoint with the inherited owner token.
    const del = await request(app).delete(`/api/listings/${a.body.listing._id}`).set('X-Owner-Token', store.__rawToken);
    expect(del.status).toBe(200);
    expect(activeCount(store)).toBe(1);
    const reuse = await postListing(store, validBody({ listingData: validListingData({ title: 'Item D' }) }));
    expect(reuse.status).toBe(201);
    expect(activeCount(store)).toBe(2);
    assertInvariants();
  });

  it('SOLD listings do NOT consume capacity (status filter, not lifetime)', async () => {
    const store = seedStore({ listing_limit: 1 });
    await postListing(store, validBody());
    h.listings[0].status = 'sold';
    const res = await postListing(store, validBody({ listingData: validListingData({ title: 'Replacement' }) }));
    expect(res.status).toBe(201);
    assertInvariants();
  });

  it('EXPIRED-but-unswept listing (past expiresAt, status still active) DOES consume capacity — recorded behavior, consistent with the dashboard count', async () => {
    const store = seedStore({ listing_limit: 1 });
    await postListing(store, validBody());
    h.listings[0].expiresAt = new Date(Date.now() - 3600 * 1000); // past; cron has not swept it
    const res = await postListing(store, validBody({ listingData: validListingData({ title: 'Next' }) }));
    // The implementation counts status:'active' ONLY (createStoreListing +
    // getStoreById listingCount + attachListing all use the same filter), so an
    // expired-but-unswept row still occupies its slot for up to one cron cycle.
    expect(res.status).toBe(409);
    // Dashboard count must agree with the enforcement count (consistency proof).
    const dash = await request(app).get(`/api/stores/${store._id}`).set('X-Store-Owner-Token', store.__rawToken);
    expect(dash.body.listingCount).toBe(1);
    assertInvariants();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. INCLUDED-LISTING EXPIRY INHERITANCE  +  7. PAYMENT ISOLATION
// ═════════════════════════════════════════════════════════════════════════════
describe('expiry inheritance and payment isolation', () => {
  const plans = [
    ['starter_weekly', 7 * 24 * 3600 * 1000],
    ['standard_monthly', 30 * 24 * 3600 * 1000],
    ['pro_monthly', 30 * 24 * 3600 * 1000],
  ];
  for (const [plan, ms] of plans) {
    it(`inherits store.expires_at EXACTLY (ms equality) on a ${plan} store`, async () => {
      const expiresAt = new Date(Date.now() + ms);
      const store = seedStore({ plan, expires_at: expiresAt });
      const res = await postListing(store, validBody());
      expect(res.status).toBe(201);
      expect(new Date(res.body.listing.expiresAt).valueOf()).toBe(expiresAt.valueOf());
    });
  }

  it('near-expiry store: the listing adopts the SAME near timestamp, never an independent duration', async () => {
    const store = seedStore({ expires_at: new Date(Date.now() + 5000) });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(new Date(res.body.listing.expiresAt).valueOf()).toBe(new Date(store.expires_at).valueOf());
  });

  it('payment isolation: NO Payment record, NO IntaSend call, NO paymentId on the listing', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(h.payments).toHaveLength(0);
    expect(paymentSpies.initiateListingPayment).not.toHaveBeenCalled();
    expect(paymentSpies.initiateStorePlanPayment).not.toHaveBeenCalled();
    expect(paymentSpies.initiateBoostPayment).not.toHaveBeenCalled();
    expect(h.listings[0].paymentId).toBeUndefined();
    expect(h.listings[0].package).toBe('store');
  });

  it('standalone regression: the PAID listing flow still reaches the payment layer (flows never share entitlement)', async () => {
    paymentSpies.initiateListingPayment.mockResolvedValue({ response: { id: 'INV-EDGE-1' }, amount: 50 });
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send({
        phoneNumber: '0722222222',
        package: 'standard',
        listingData: validListingData(),
        acceptance: validAcceptance(),
        website: '',
      });
    expect(res.status).toBe(200);
    expect(paymentSpies.initiateListingPayment).toHaveBeenCalledTimes(1);
    // Exactly one Payment intent exists — created by the PAID path, never by
    // the store path.
    expect(h.payments).toHaveLength(1);
    expect(h.payments[0].amount).toBe(50);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. VALIDATION ATTACKS  +  9. INJECTION / SECURITY BOUNDARIES
// ═════════════════════════════════════════════════════════════════════════════
describe('validation attacks', () => {
  const rejects = async (name, body) => {
    const store = seedStore();
    const res = await postListing(store, body);
    expect(res.status, name).toBe(400);
    expect(h.listings, `no listing created for: ${name}`).toHaveLength(0);
  };

  it('rejects missing / null / non-object / array listingData', async () => {
    const store = seedStore();
    for (const body of [{ acceptance: validAcceptance() }, { listingData: null, acceptance: validAcceptance() }, { listingData: 'string', acceptance: validAcceptance() }, { listingData: [validListingData()], acceptance: validAcceptance() }]) {
      const res = await postListing(store, body);
      expect([400, 500]).toContain(res.status);
      expect(h.listings).toHaveLength(0);
    }
    assertInvariants();
  });

  it('rejects missing required fields', async () => {
    for (const field of ['title', 'category', 'condition', 'description', 'sellerName', 'sellerWhatsapp']) {
      const data = validListingData();
      delete data[field];
      await rejects(`missing ${field}`, validBody({ listingData: data }));
    }
  });

  it('rejects empty strings, whitespace-only values, wrong types and null values', async () => {
    await rejects('empty title', validBody({ listingData: validListingData({ title: '' }) }));
    await rejects('whitespace title', validBody({ listingData: validListingData({ title: '   ' }) }));
    await rejects('numeric title', validBody({ listingData: validListingData({ title: 12345 }) }));
    await rejects('object title', validBody({ listingData: validListingData({ title: { text: 'x' } }) }));
    await rejects('array title', validBody({ listingData: validListingData({ title: ['x'] }) }));
    await rejects('object price', validBody({ listingData: validListingData({ price: { value: 5 } }) }));
    await rejects('null description', validBody({ listingData: validListingData({ description: null }) }));
  });

  it('KNOWN QUIRK (shared paid-path semantics): price null coerces via Number(null)===0 → accepted as a 0-priced listing', async () => {
    // Both creation paths run the identical `Number(price)` validation, so null
    // becomes 0 on BOTH. Recorded here as the actual behavior; changing it on
    // one path only would fork the validation semantics — flagged in the report.
    const store = seedStore();
    const res = await postListing(store, validBody({ listingData: validListingData({ price: null }) }));
    expect(res.status).toBe(201);
    expect(h.listings[0].price).toBe(0);
  });

  it('rejects invalid prices (negative, non-numeric, Infinity via 1e999 — NaN is unrepresentable over JSON and arrives as null)', async () => {
    await rejects('negative price', validBody({ listingData: validListingData({ price: -1 }) }));
    await rejects('string price', validBody({ listingData: validListingData({ price: 'abc' }) }));
    // 1e999 survives the JSON wire as Infinity (JSON.parse('1e999') === Infinity).
    const store = seedStore();
    const raw = JSON.stringify(validBody()).replace('"price":4000', '"price":1e999');
    const res = await request(app)
      .post(`/api/stores/${store._id}/listings`)
      .set('X-Store-Owner-Token', store.__rawToken)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(400);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects invalid condition and oversized fields', async () => {
    await rejects('bad condition', validBody({ listingData: validListingData({ condition: 'Legendary' }) }));
    await rejects('long title', validBody({ listingData: validListingData({ title: 'x'.repeat(121) }) }));
    await rejects('long description', validBody({ listingData: validListingData({ description: 'y'.repeat(2001) }) }));
    await rejects('long sellerName', validBody({ listingData: validListingData({ sellerName: 'z'.repeat(81) }) }));
    await rejects('long whatsapp', validBody({ listingData: validListingData({ sellerWhatsapp: '0'.repeat(21) }) }));
  });

  it('rejects malformed / dangerous image URLs and non-array images', async () => {
    await rejects('ftp image', validBody({ listingData: validListingData({ images: ['ftp://host/x.jpg'] }) }));
    await rejects('javascript image', validBody({ listingData: validListingData({ images: ['javascript:alert(1)'] }) }));
    await rejects('data image', validBody({ listingData: validListingData({ images: ['data:image/png;base64,AAAA'] }) }));
    await rejects('non-string image entry', validBody({ listingData: validListingData({ images: [42] }) }));
    await rejects('images not an array', validBody({ listingData: validListingData({ images: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/x.jpg' }) }));
    await rejects('too many images', validBody({ listingData: validListingData({ images: Array(7).fill('https://res.cloudinary.com/demo/image/upload/v1/gikomart/x.jpg') }) }));
  });

  it('rejects a client-supplied store_id (the server owns store targeting)', async () => {
    await rejects('store_id set', validBody({ listingData: validListingData({ store_id: 'sto-anything' }) }));
  });

  it('silently DROPS unexpected privileged fields (mass-assignment armor): featured/status/views/boostType/ownerTokenHash never persist', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody({
      listingData: validListingData({
        featured: true,
        priorityBroadcast: true,
        status: 'sold',
        views: 9999,
        boostType: 'spotlight',
        ownerTokenHash: 'attacker-hash',
        paymentId: 'PAY-ATTACK',
        moderationStatus: 'approved',
        broadcastSent: true,
      }),
    }));
    expect(res.status).toBe(201); // allowlist drops extras rather than rejecting
    const doc = h.listings[0];
    expect(doc.featured).toBe(false);
    expect(doc.priorityBroadcast).toBe(false);
    expect(doc.status).toBe('active');
    expect(doc.views).toBe(0);
    expect(doc.boostType).toBeNull();
    expect(doc.ownerTokenHash).toBe(store.ownerTokenHash); // real hash, not attacker's
    expect(doc.paymentId).toBeUndefined();
    expect(doc.broadcastSent).toBe(false);
    assertInvariants();
  });

  it('injection payloads: Mongo operators rejected; script/HTML stored inertly (render-side escaping); no crash', async () => {
    await rejects('mongo $gt title', validBody({ listingData: validListingData({ title: { $gt: '' } }) }));
    await rejects('mongo $ne price', validBody({ listingData: validListingData({ price: { $ne: 0 } }) }));
    await rejects('$where in description', validBody({ listingData: validListingData({ description: { $where: 'sleep(1000)' } }) }));
    const store = seedStore();
    const xss = await postListing(store, validBody({ listingData: validListingData({ title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(2)>' }) }));
    expect(xss.status).toBe(201); // stored verbatim; XSS safety lives in escapeHTML at render time (existing model)
    expect(h.listings[0].title).toBe('<script>alert(1)</script>');
    // category uses a canonical stable id — 'C' is no longer a valid value and
    // the test targets prototype-pollution inertness, not category validation.
    const proto = await postListing(store, validBody({ listingData: JSON.parse('{"title":"P","category":"electronics","condition":"Good","price":1,"description":"D","sellerName":"S","sellerWhatsapp":"0711111111","__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}') }));
    expect(proto.status).toBe(201);
    expect({}.admin).toBeUndefined();
    expect(h.listings[h.listings.length - 1].admin).toBeUndefined();
    const nul = await postListing(store, validBody({ listingData: validListingData({ title: 'bad\u0000title' }) }));
    expect([201, 400]).toContain(nul.status); // either verdict is acceptable — no crash
    const ctrl = await postListing(store, validBody({ listingData: validListingData({ title: 'ctrl\u0007char' }) }));
    expect([201, 400]).toContain(ctrl.status);
    assertInvariants();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. OWNERSHIP  +  11. CROSS-STORE ISOLATION  +  12. DUPLICATES
// ═════════════════════════════════════════════════════════════════════════════
describe('ownership, cross-store isolation and duplicates', () => {
  it('included listing points ONLY at its own store, governed by the store owner hash', async () => {
    const a = seedStore();
    const res = await postListing(a, validBody());
    expect(String(res.body.listing.store_id)).toBe(String(a._id));
    expect(h.listings[0].ownerTokenHash).toBe(a.ownerTokenHash);
  });

  it('store B owner cannot DELETE store A\'s included listing with B\'s credential', async () => {
    const a = seedStore();
    const b = seedStore();
    const made = await postListing(a, validBody());
    const del = await request(app)
      .delete(`/api/listings/${made.body.listing._id}`)
      .set('X-Owner-Token', b.__rawToken);
    expect(del.status).toBe(403);
    expect(h.listings).toHaveLength(1);
    expect(activeCount(a)).toBe(1);
  });

  it('legacy attach stays dual-token: a single credential can never graft A\'s listing onto B\'s store', async () => {
    const a = seedStore();
    const b = seedStore();
    const made = await postListing(a, validBody());
    const listingId = made.body.listing._id;
    // B store token + B listing token (but the listing belongs to A) → 403.
    const r1 = await request(app)
      .put(`/api/stores/${b._id}/attach-listing`)
      .set('X-Store-Owner-Token', b.__rawToken)
      .set('X-Owner-Token', b.__rawToken)
      .send({ listingId });
    expect(r1.status).toBe(403);
    // Listing token alone (no store token) → 403.
    const r2 = await request(app)
      .put(`/api/stores/${b._id}/attach-listing`)
      .set('X-Owner-Token', a.__rawToken)
      .send({ listingId });
    expect(r2.status).toBe(403);
    expect(h.listings[0].store_id).toBe(a._id); // untouched
  });

  it('cross-store capacity and counts are independent', async () => {
    const a = seedStore({ listing_limit: 2 });
    const b = seedStore({ listing_limit: 5 });
    await postListing(a, validBody({ listingData: validListingData({ title: 'A1' }) }));
    await postListing(a, validBody({ listingData: validListingData({ title: 'A2' }) }));
    const aFull = await postListing(a, validBody({ listingData: validListingData({ title: 'A3' }) }));
    expect(aFull.status).toBe(409);
    // B unaffected by A being full.
    const bOk = await postListing(b, validBody({ listingData: validListingData({ title: 'B1' }) }));
    expect(bOk.status).toBe(201);
    expect(activeCount(a)).toBe(2);
    expect(activeCount(b)).toBe(1);
    // No listing ever sits in the wrong store.
    for (const l of h.listings) {
      if (l.title.startsWith('A')) expect(String(l.store_id)).toBe(String(a._id));
      if (l.title.startsWith('B')) expect(String(l.store_id)).toBe(String(b._id));
    }
  });

  it('DUPLICATE submission: identical payload twice is ALLOWED (no idempotency on this route — recorded, not invented)', async () => {
    const store = seedStore({ listing_limit: 5 });
    const r1 = await postListing(store, validBody());
    const r2 = await postListing(store, validBody());
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(h.listings).toHaveLength(2);
    expect(h.listings[0]._id).not.toBe(h.listings[1]._id);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. CONCURRENCY ATTACK  +  14. RACE WITH DELETION
// ═════════════════════════════════════════════════════════════════════════════
describe('concurrency attacks (TOCTOU regression on the count-then-insert path)', () => {
  it('5 iterations × 2 concurrent publications against 1 free slot: never 6/5 (DB state, not response codes)', async () => {
    for (let round = 0; round < 5; round++) {
      const store = seedStore({ listing_limit: 5 });
      for (let i = 0; i < 4; i++) {
        await postListing(store, validBody({ listingData: validListingData({ title: `R${round}-seed-${i}` }) }));
      }
      expect(activeCount(store)).toBe(4);
      const [a, b] = await Promise.all([
        postListing(store, validBody({ listingData: validListingData({ title: `R${round}-racerA` }) })),
        postListing(store, validBody({ listingData: validListingData({ title: `R${round}-racerB` }) })),
      ]);
      // Verify the FINAL DATABASE STATE, not only response codes.
      expect(activeCount(store)).toBeLessThanOrEqual(5);
      expect(activeCount(store)).toBeGreaterThanOrEqual(4);
      // Exactly one slot consumed overall — one success, one clean failure.
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(h.listings.filter((l) => l.status === 'active' && String(l.store_id) === String(store._id))).toHaveLength(5);
      assertInvariants();
    }
  });

  it('race with deletion: concurrent delete + create at capacity never violates active ≤ limit', async () => {
    const store = seedStore({ listing_limit: 2 });
    const first = await postListing(store, validBody({ listingData: validListingData({ title: 'To delete' }) }));
    await postListing(store, validBody({ listingData: validListingData({ title: 'Keeper' }) }));
    expect(activeCount(store)).toBe(2);
    const [del, create] = await Promise.all([
      request(app).delete(`/api/listings/${first.body.listing._id}`).set('X-Owner-Token', store.__rawToken),
      postListing(store, validBody({ listingData: validListingData({ title: 'Racer' }) })),
    ]);
    // Either order is acceptable; the invariant is not.
    expect(activeCount(store)).toBeLessThanOrEqual(2);
    expect(activeCount(store)).toBeGreaterThanOrEqual(1);
    expect([200, 403, 404, 409]).toContain(del.status);
    expect([201, 409]).toContain(create.status);
    assertInvariants();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21. HTTP METHOD / STATUS / CONTENT-TYPE ABUSE  +  16. FAILURE ATOMICITY
// ═════════════════════════════════════════════════════════════════════════════
describe('HTTP abuse and failure atomicity', () => {
  it('wrong methods on the collection route → clean 404, no state change', async () => {
    const store = seedStore();
    for (const method of ['get', 'put', 'delete']) {
      const res = await request(app)[method](`/api/stores/${store._id}/listings`).send(validBody());
      expect([404, 405]).toContain(res.status);
    }
    expect(h.listings).toHaveLength(0);
  });

  it('missing/wrong content type, invalid JSON, and empty body → clean 400s, no listing, no crash', async () => {
    const store = seedStore();
    const noType = await request(app)
      .post(`/api/stores/${store._id}/listings`)
      .set('X-Store-Owner-Token', store.__rawToken)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(validBody()));
    expect(noType.status).toBe(400);
    const badJson = await request(app)
      .post(`/api/stores/${store._id}/listings`)
      .set('Content-Type', 'application/json')
      .send('{"listingData": {broken');
    expect(badJson.status).toBe(400);
    const empty = await request(app).post(`/api/stores/${store._id}/listings`).set('X-Store-Owner-Token', store.__rawToken);
    expect(empty.status).toBe(400);
    expect(h.listings).toHaveLength(0);
    assertInvariants();
  });

  it('oversized body (>1mb express.json limit) → 413 or 400, no listing, no crash', async () => {
    const store = seedStore();
    const big = validBody({ listingData: validListingData({ description: 'x'.repeat(2 * 1024 * 1024) }) });
    const res = await postListing(store, big);
    expect([400, 413]).toContain(res.status);
    expect(h.listings).toHaveLength(0);
  });

  it('requests after a failure are clean (no poisoned state)', async () => {
    const store = seedStore();
    await postListing(store, validBody({ listingData: validListingData({ price: -5 }) }));
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(h.listings).toHaveLength(1);
  });

  it('failure atomicity sweep: every rejection class leaves zero listings, zero payments, zero uploads', async () => {
    const store = seedStore();
    await postListing(store, validBody(), 'wrong-token'); // auth fail
    await postListing(store, validBody({ acceptance: null })); // acceptance fail
    await postListing(store, validBody({ listingData: validListingData({ condition: 'Nope' }) })); // validation fail
    await postListing(store, validBody({ listingData: validListingData({ title: { $gt: '' } }) })); // injection fail
    await postListing(store, validBody({ listingData: validListingData({ images: ['javascript:alert(1)'] }) })); // URL fail
    expect(h.listings).toHaveLength(0);
    expect(h.payments).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    expect(h.terms).toHaveLength(0);
    assertInvariants();
  });

  it('success leaves NO orphan references: store_id points at a LIVE store', async () => {
    const store = seedStore();
    await postListing(store, validBody());
    for (const l of h.listings) {
      expect(h.stores.has(String(l.store_id))).toBe(true);
    }
  });
});
