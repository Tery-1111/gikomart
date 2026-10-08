// Store-included listing creation (POST /api/stores/:id/listings) — integration
// suite for the bundled-listing entitlement model (INV-1…INV-7).
//
// The REAL server is driven through supertest with in-memory model fakes
// injected into require.cache before server.js is imported — the exact seam
// proven by tests/wiring.test.mjs (vi.mock does not reach CJS require()).
// Deliberately REAL: moderationService (production blocklist), termsAcceptanceService
// (version validation), storeAuth, ttlCache, and the real contactHash HMAC from
// utils/phone — the blocked-contact test seeds a hash produced by the real function.
//
// Concurrency: fakes execute serially, so MongoDB's snapshot isolation cannot be
// timed directly. The fake session emulates its observable outcome instead — a
// transaction that conflicts with a concurrent write on the same document is
// aborted and the driver retries the whole callback on a fresh snapshot, whose
// end result is run-to-completion serialization of contended transactions. The
// fake enforces that with a process-wide promise mutex around withTransaction,
// so two concurrent publications can never interleave their count→insert window.

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
const { contactHash } = require('../src/utils/phone');
const { TERMS_VERSIONS } = require('../src/config/termsVersions');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state
// ─────────────────────────────────────────────────────────────────────────────
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

// ── Fakes ────────────────────────────────────────────────────────────────────
const fakeListingModel = {
  // The controller calls Listing.create([doc], { session }) and destructures
  // the array — the fake must return an ARRAY for array input (real Mongoose).
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
};

const fakeReportModel = {
  create: async (data) => makeDoc({ _id: 'rep-1', ...data }),
  countDocuments: async () => 0,
};

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

// Real limiter module, stubbed limiters (the store route intentionally reuses
// no payment limiter, but the global/upload ones apply to other endpoints).
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

// paymentService: keep the REAL catalogs (controller validates plan/package),
// spy the initiators so "no payment machinery" is provable. The spies are kept
// in a handle object because the injected module's exports are what the server
// binds to — the original module object is never touched.
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

// ── Transaction emulation: serialized withTransaction (see header note) ──
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
  const rawToken = overrides.rawToken || 'store-owner-token-1';
  delete overrides.rawToken;
  const doc = makeDoc({
    _id: 'sto-1',
    name: 'Test Store',
    slug: 'test-store',
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

const validListingData = () => ({
  title: 'Barely used camera',
  category: 'Electronics',
  condition: 'Good',
  price: 4000,
  description: 'Works perfectly, all accessories included.',
  sellerName: 'Jane',
  sellerWhatsapp: '0711111111',
  location: 'Njoro',
  images: [],
});

const validBody = (over = {}) => ({
  listingData: validListingData(),
  acceptance: {
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
  },
  website: '',
  ...over,
});

const postListing = (store, body, token) =>
  request(app)
    .post(`/api/stores/${store._id}/listings`)
    .set('X-Store-Owner-Token', token === undefined ? store.__rawToken : token)
    .send(body);

const storeActiveCount = (store) => h.listings.filter((l) => l.store_id === store._id && l.status === 'active').length;

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/stores/:id/listings — included listing creation', () => {
  it('creates the listing INSIDE the store: store_id set, package "store", no attachment hop (INV-3)', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(String(res.body.listing.store_id)).toBe(String(store._id));
    expect(res.body.listing.package).toBe('store');
    // Born in the store: no separate attach step needed afterwards.
    expect(storeActiveCount(store)).toBe(1);
  });

  it('charges NOTHING: no Payment record, no IntaSend initiate call (INV-2)', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(h.payments).toHaveLength(0);
    expect(paymentSpies.initiateListingPayment).not.toHaveBeenCalled();
    expect(paymentSpies.initiateStorePlanPayment).not.toHaveBeenCalled();
    expect(paymentSpies.initiateBoostPayment).not.toHaveBeenCalled();
  });

  it('sets expiresAt EXACTLY equal to the store expires_at (approved expiry model)', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(new Date(res.body.listing.expiresAt).valueOf()).toBe(new Date(store.expires_at).valueOf());
  });

  it('copies the store owner credential: listing ownerTokenHash equals the store hash (A8 authorization model)', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    const created = h.listings[0];
    expect(created.ownerTokenHash).toBe(store.ownerTokenHash);
    // The stored hash must never leak in the response view.
    expect(res.body.listing.ownerTokenHash).toBeUndefined();
  });

  it('rejects a WRONG store token with 403 and creates no listing', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody(), 'wrong-token');
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects a MISSING store token with 403 and creates no listing', async () => {
    const store = seedStore();
    const res = await request(app).post(`/api/stores/${store._id}/listings`).send(validBody());
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects an EXPIRED store (past expires_at) with 403 — Store plan has expired', async () => {
    const store = seedStore({ expires_at: new Date(Date.now() - 1000) });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Store plan has expired');
    expect(h.listings).toHaveLength(0);
  });

  it('rejects an expired-STATUS store with 403 — Store is not active', async () => {
    const store = seedStore({ status: 'expired' });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Store is not active');
  });

  it('rejects a SUSPENDED store with 403', async () => {
    const store = seedStore({ status: 'suspended' });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects publication when terms acceptance is missing or not explicit', async () => {
    const store = seedStore();
    const missing = await postListing(store, { listingData: validListingData(), website: '' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Terms acceptance required/);
    const notAccepted = await postListing(store, validBody({ acceptance: { accepted: false, gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE, sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS } }));
    expect(notAccepted.status).toBe(400);
    const wrongVersion = await postListing(store, validBody({ acceptance: { accepted: true, gikomartTermsVersion: '9.9.9', sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS } }));
    expect(wrongVersion.status).toBe(400);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects invalid listing content with 400 (condition, price, oversized title, too many images)', async () => {
    const store = seedStore();
    const badCondition = await postListing(store, validBody({ listingData: { ...validListingData(), condition: 'Legendary' } }));
    expect(badCondition.status).toBe(400);
    const negativePrice = await postListing(store, validBody({ listingData: { ...validListingData(), price: -5 } }));
    expect(negativePrice.status).toBe(400);
    const oversizedTitle = await postListing(store, validBody({ listingData: { ...validListingData(), title: 'x'.repeat(121) } }));
    expect(oversizedTitle.status).toBe(400);
    const tooManyImages = await postListing(store, validBody({ listingData: { ...validListingData(), images: Array(7).fill('https://res.cloudinary.com/demo/image/upload/v1/gikomart/x.jpg') } }));
    expect(tooManyImages.status).toBe(400);
    expect(h.listings).toHaveLength(0);
  });

  it('rejects a client-supplied store_id in listingData — the server owns store targeting (INV-6, §19)', async () => {
    const store = seedStore();
    const otherStore = seedStore({ _id: 'sto-other', rawToken: 'other-token' });
    const res = await postListing(store, validBody({ listingData: { ...validListingData(), store_id: otherStore._id } }));
    expect(res.status).toBe(400);
    expect(h.listings).toHaveLength(0);
  });

  it('blocks a BLOCKED contact number with 403 — same rule as payment initiation (real HMAC contactHash)', async () => {
    const store = seedStore();
    h.blocked.push({ contactHash: contactHash('0711111111') });
    const res = await postListing(store, validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot be used/);
    expect(h.listings).toHaveLength(0);
  });

  it('flags a listing that trips the REAL production moderation blocklist (created, but hidden until admin review)', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody({ listingData: { ...validListingData(), title: 'Cheap casino betting account' } }));
    expect(res.status).toBe(201);
    expect(h.listings[0].moderationStatus).toBe('flagged');
  });

  it('marks uploaded images attached BEFORE insert so the orphan sweep spares them', async () => {
    const store = seedStore();
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/kept.jpg';
    const res = await postListing(store, validBody({ listingData: { ...validListingData(), images: [url] } }));
    expect(res.status).toBe(201);
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0].filter.url.$in).toContain(url);
    expect(h.uploads[0].update.attached).toBe(true);
  });

  it('does NOT mutate the store row: listing_limit and expires_at stay intact (INV-4 — no second quota source)', async () => {
    const store = seedStore();
    const expiresAt = new Date(store.expires_at).valueOf();
    await postListing(store, validBody());
    expect(store.listing_limit).toBe(5);
    expect(new Date(store.expires_at).valueOf()).toBe(expiresAt);
    // Capacity stays derivable from listing state, never from a stored counter.
    expect(store.freeListingsUsed).toBeUndefined();
    expect(store.freeListingQuota).toBeUndefined();
  });

  it('capacity is LIVE active count: deleting an active store listing frees the slot (INV-5)', async () => {
    const store = seedStore({ listing_limit: 1 });
    const first = await postListing(store, validBody());
    expect(first.status).toBe(201);
    // 1/1 — the next publication must fail...
    const full = await postListing(store, validBody({ listingData: { ...validListingData(), title: 'Second item' } }));
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/Store listing limit reached \(1\)/);
    // ...unless the active listing is deleted by its owner (the store token,
    // which the listing inherited). Delete through the REAL listing endpoint.
    const del = await request(app).delete(`/api/listings/${first.body.listing._id}`).set('X-Owner-Token', store.__rawToken);
    expect(del.status).toBe(200);
    expect(storeActiveCount(store)).toBe(0);
    // Slot is free again — no counter to decrement, the recount derives it.
    const again = await postListing(store, validBody({ listingData: { ...validListingData(), title: 'Replacement item' } }));
    expect(again.status).toBe(201);
    expect(storeActiveCount(store)).toBe(1);
  });

  it('CONCURRENCY: two simultaneous publications against one free slot yield exactly one success — never 6/5 (INV-7)', async () => {
    const store = seedStore({ listing_limit: 5 });
    for (let i = 0; i < 4; i++) {
      await postListing(store, validBody({ listingData: { ...validListingData(), title: `Item ${i}` } }));
    }
    expect(storeActiveCount(store)).toBe(4);
    const [a, b] = await Promise.all([
      postListing(store, validBody({ listingData: { ...validListingData(), title: 'Racer A' } })),
      postListing(store, validBody({ listingData: { ...validListingData(), title: 'Racer B' } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(storeActiveCount(store)).toBe(5);
  });

  it('records the acceptance with the zero-fee label and emits a store audit event', async () => {
    const store = seedStore();
    const res = await postListing(store, validBody());
    expect(res.status).toBe(201);
    expect(h.terms).toHaveLength(1);
    expect(h.terms[0].fee.amount).toBe(0);
    expect(h.terms[0].fee.label).toMatch(/Included in store plan/);
    expect(h.audit.some((e) => e.action === 'store.create_listing' && e.metadata.package === 'store')).toBe(true);
  });
});

describe('Listing model schema compatibility', () => {
  it('the REAL Listing schema package enum includes "store" (no schema drift allowed)', () => {
    // require.cache holds the injected fake — read the real module source from
    // disk so the schema assertion cannot be satisfied by any test double.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'models', 'Listing.js'), 'utf8');
    const enumLine = src.split('\n').find((l) => l.includes('package:'));
    expect(enumLine).toMatch(/enum:.*'store'/);
    expect(enumLine).toMatch(/required: true/);
  });
});
