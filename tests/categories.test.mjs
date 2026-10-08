// Canonical listing-category contract (src/config/listingOptions.js).
//
// Proves the 12-category taxonomy end to end: the config contract itself, the
// Listing model enum, the public metadata endpoint, canonical-ID validation on
// every listing write path (paid initiation, store listings, grant redemption,
// owner update), server-side browse category filtering + pagination, safe
// rendering of legacy/unknown categories, and the WhatsApp display-name
// rendering. Real server driven through supertest with in-memory model fakes
// injected into require.cache (the wiring.test.mjs seam).
//
// The frontend drift test lives in tests/paymentRecovery.test.mjs: it renders
// the real app.js category UI against metadata built FROM this same backend
// config, so the two layers cannot silently diverge.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);
const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');
const { TERMS_VERSIONS } = require('../src/config/termsVersions');

// ── REAL modules captured BEFORE fakes are injected into require.cache ──
const {
  LISTING_CATEGORIES,
  VALID_CATEGORY_IDS,
  isValidListingCategory,
  normalizeLegacyListingCategory,
  categoryDisplayName,
} = require('../src/config/listingOptions.js');
const RealListingModel = require('../src/models/Listing.js');
const realWhatsappService = require('../src/services/whatsappService.js');

// ─────────────────────────────────────────────────────────────────────────────
// Expected contract (mirrors the authoritative spec; asserted against the real
// config below so any divergence in EITHER direction fails).
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED_IDS = [
  'food-drinks', 'electronics', 'clothing-fashion', 'furniture-home',
  'student-essentials', 'hostel-living', 'jobs-services', 'vehicles',
  'accommodation', 'agriculture', 'beauty-personal-care', 'entertainment-hobbies',
];
const EXPECTED_NAMES = [
  'Food & Drinks', 'Electronics', 'Clothing & Fashion', 'Furniture & Home',
  'Student Essentials', 'Hostel Living', 'Jobs & Services', 'Vehicles',
  'Accommodation', 'Agriculture', 'Beauty & Personal Care', 'Entertainment & Hobbies',
];

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state + fakes
// ─────────────────────────────────────────────────────────────────────────────
const h = { listings: [], payments: [], stores: new Map(), grants: new Map(), terms: [], audit: [] };

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

// Listing find() with the filters getListings builds: status, moderationStatus,
// category (exact), condition, title regex, store_id — plus sort/skip/limit/lean.
function listingMatches(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$ne !== undefined && doc[k] === v.$ne) return false;
      if (v.$in !== undefined && !v.$in.includes(doc[k])) return false;
      if (v.$regex !== undefined && !(new RegExp(v.$regex, v.$options || '')).test(String(doc[k] ?? ''))) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}
function listingQuery(hListings, filter) {
  const matched = () => hListings.filter((l) => listingMatches(l, filter));
  const b = {
    populate: () => b,
    sort: () => b,
    skip: (n) => { b._skip = n; return b; },
    limit: (n) => { b._limit = n; return b; },
    lean: async () => {
      let out = matched();
      if (b._skip) out = out.slice(b._skip);
      if (b._limit !== undefined) out = out.slice(0, b._limit);
      return out;
    },
    then: (res, rej) => b.lean().then(res, rej),
    catch: (rej) => b.lean().catch(rej),
  };
  return b;
}

const fakeListingModel = {
  create: async (data) => {
    // Array input (Listing.create([doc], { session })) must return an ARRAY,
    // mirroring real Mongoose (store-listing creation destructures the array).
    if (Array.isArray(data)) {
      const docs = data.map((d) => makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', moderationStatus: 'approved', images: [], ...d }));
      h.listings.push(...docs);
      return docs;
    }
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', moderationStatus: 'approved', images: [], ...data });
    h.listings.push(doc);
    return doc;
  },
  find: (filter = {}) => listingQuery(h.listings, filter),
  countDocuments: (filter = {}) => Promise.resolve(h.listings.filter((l) => listingMatches(l, filter)).length),
  findById: (id) => selectableDoc(h.listings.find((l) => String(l._id) === String(id)) || null),
  findOneAndUpdate: async (filter, update) => {
    const doc = h.listings.find((l) => String(l._id) === String(filter._id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  findByIdAndUpdate: async (id, update) => {
    const doc = h.listings.find((l) => String(l._id) === String(id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  // Boost-expiry sweep runs on every browse request.
  updateMany: async () => ({ modifiedCount: 0 }),
  deleteOne: async () => ({ deletedCount: 1 }),
};

const fakeStoreModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `sto-${h.stores.size + 1}`, status: 'active', subcategories: [], ...data });
    h.stores.set(String(doc._id), doc);
    return doc;
  },
  findById: (id) => selectableDoc(h.stores.get(String(id)) || null),
  findOne: (filter = {}) => Promise.resolve(
    filter.slug !== undefined ? ([...h.stores.values()].find((s) => s.slug === filter.slug) || null) : null,
  ),
  find: () => {
    const out = () => [...h.stores.values()];
    return { lean: async () => out(), then: (res, rej) => Promise.resolve(out()).then(res, rej), catch: (rej) => Promise.resolve(out()).catch(rej) };
  },
  countDocuments: async () => h.stores.size,
};

const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `pay-${h.payments.length + 1}`, status: 'pending', ...data });
    h.payments.push(doc);
    return doc;
  },
  findOne: async (filter) => makeDoc(h.payments.find((p) => p.invoiceId === filter.invoiceId) || null),
  findOneAndUpdate: async () => null,
  countDocuments: async () => 0,
};

const fakeTermsModel = {
  create: async (data) => { const d = makeDoc({ _id: `terms-${h.terms.length + 1}`, ...data }); h.terms.push(d); return d; },
  findOne: async () => null,
  findByIdAndUpdate: async () => makeDoc({}),
};

const fakeGrantModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `grant-${h.grants.size + 1}`, status: 'pending', provisionedAt: null, ...data });
    h.grants.set(String(doc._id), doc);
    return doc;
  },
  findById: (id) => selectableDoc(h.grants.get(String(id)) || null),
  findOneAndUpdate: async (filter, update) => {
    const doc = h.grants.get(String(filter._id));
    if (!doc || doc.status !== filter.status || doc.provisionedAt !== filter.provisionedAt) return null;
    Object.assign(doc, update.$set || update);
    return doc;
  },
};

const fakeBlockedModel = { findOne: async () => null };
const fakeUploadModel = { updateMany: async () => ({ modifiedCount: 0 }) };
const fakeAdminModel = { findOne: async () => null, findById: () => selectableDoc(null) };
const fakeAuditModel = { create: async (data) => { h.audit.push(data); return makeDoc(data); } };
const fakeReportModel = { create: async (data) => makeDoc({ _id: 'rep-1', ...data }), countDocuments: async () => 0 };
const broadcastListing = vi.fn(async () => {});
const fakeWhatsappService = { broadcastListing, formatMessage: () => 'msg' };
const fakeCloudinary = { uploader: { upload: vi.fn(), destroy: vi.fn() }, v2: { uploader: { upload: vi.fn(), destroy: vi.fn() } } };
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// IntaSend: returns a usable invoice id so initiation succeeds for valid input.
const mpesaStkPush = vi.fn(async () => ({ invoice: { invoice_id: `INV-CAT-${h.payments.length + 1}` } }));
const fakeIntaSend = function IntaSend() {};
fakeIntaSend.prototype.collection = () => ({ mpesaStkPush });

function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/GrantRequest.js', fakeGrantModel);
injectModule('../src/models/BlockedContact.js', fakeBlockedModel);
injectModule('../src/models/Upload.js', fakeUploadModel);
injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/models/AuditEvent.js', fakeAuditModel);
injectModule('../src/models/Report.js', fakeReportModel);
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('intasend-node', fakeIntaSend);

// Pass-through limiters so the all-12-IDs validation loop cannot trip 429s.
const realRateLimiter = require('../src/middleware/rateLimiter');
injectModule('../src/middleware/rateLimiter.js', {
  ...realRateLimiter,
  globalLimiter: (req, _res, next) => next(),
  uploadLimiter: (req, _res, next) => next(),
  uploadDailyLimiter: (req, _res, next) => next(),
  paymentLimiter: (req, _res, next) => next(),
  listingCreateLimiter: (req, _res, next) => next(),
  contactLimiter: (req, _res, next) => next(),
  statusLimiter: (req, _res, next) => next(),
  contactReleaseLimiter: (req, _res, next) => next(),
  reportLimiter: (req, _res, next) => next(),
  adminLimiter: (req, _res, next) => next(),
  vitalsLimiter: (req, _res, next) => next(),
});

let app;
beforeAll(async () => { app = (await import('../server.js')).default; }, 60000);

beforeEach(() => {
  h.listings.length = 0;
  h.payments.length = 0;
  h.stores.clear();
  h.grants.clear();
  h.terms.length = 0;
  h.audit.length = 0;
  mpesaStkPush.mockClear();
  // Store/grant provisioning opens a transaction; the in-memory fakes run it
  // inline (same seam as storeListings.test.mjs).
  vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue({
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(async () => {}),
    abortTransaction: vi.fn(async () => {}),
    endSession: vi.fn(),
    withTransaction: (fn) => fn(),
  });
});

afterAll(() => { vi.restoreAllMocks(); });

const acceptance = {
  accepted: true,
  gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
};

function listingData(overrides = {}) {
  return {
    title: 'Canon category test item',
    category: 'electronics',
    condition: 'Good',
    price: 500,
    description: 'Canonical category validation fixture.',
    sellerName: 'Jane',
    sellerWhatsapp: '0711111111',
    location: 'Njoro',
    images: [],
    ...overrides,
  };
}

// ─── Contract shape ──────────────────────────────────────────────────────────
describe('canonical listing category contract (src/config/listingOptions.js)', () => {
  it('contains exactly 12 categories', () => {
    expect(LISTING_CATEGORIES).toHaveLength(12);
    expect(VALID_CATEGORY_IDS).toHaveLength(12);
  });

  it('uses the exact specified stable IDs in the exact specified order', () => {
    expect(VALID_CATEGORY_IDS).toEqual(EXPECTED_IDS);
  });

  it('uses the exact specified display names in the exact specified order', () => {
    expect(LISTING_CATEGORIES.map((c) => c.name)).toEqual(EXPECTED_NAMES);
  });

  it('gives every category a non-empty icon', () => {
    for (const c of LISTING_CATEGORIES) {
      expect(typeof c.icon).toBe('string');
      expect(c.icon.length).toBeGreaterThan(0);
    }
  });

  it('has no Property and no Free Stuff in the canonical taxonomy', () => {
    expect(VALID_CATEGORY_IDS).not.toContain('property');
    expect(VALID_CATEGORY_IDS).not.toContain('free');
    const names = LISTING_CATEGORIES.map((c) => c.name);
    expect(names).not.toContain('Property');
    expect(names).not.toContain('Free Stuff');
  });

  it('includes the three newly named categories', () => {
    expect(LISTING_CATEGORIES.map((c) => c.name)).toContain('Food & Drinks');
    expect(LISTING_CATEGORIES.map((c) => c.name)).toContain('Beauty & Personal Care');
    expect(LISTING_CATEGORIES.map((c) => c.name)).toContain('Entertainment & Hobbies');
  });
});

describe('legacy category mapping (application-level, no data migration)', () => {
  it('maps every unambiguous pre-contract display name to its canonical ID', () => {
    expect(normalizeLegacyListingCategory('Electronics')).toBe('electronics');
    expect(normalizeLegacyListingCategory('Furniture')).toBe('furniture-home');
    expect(normalizeLegacyListingCategory('Clothing')).toBe('clothing-fashion');
    expect(normalizeLegacyListingCategory('Vehicles')).toBe('vehicles');
    expect(normalizeLegacyListingCategory('Property')).toBe('accommodation');
    expect(normalizeLegacyListingCategory('Jobs & Services')).toBe('jobs-services');
    expect(normalizeLegacyListingCategory('Agriculture')).toBe('agriculture');
    expect(normalizeLegacyListingCategory('Student Essentials')).toBe('student-essentials');
    expect(normalizeLegacyListingCategory('Hostel Living')).toBe('hostel-living');
  });

  it('never reclassifies Free Stuff and never maps unknown values', () => {
    expect(normalizeLegacyListingCategory('Free Stuff')).toBeNull();
    expect(normalizeLegacyListingCategory('not-a-category')).toBeNull();
    expect(normalizeLegacyListingCategory(undefined)).toBeNull();
  });

  it('renders display names for canonical, legacy and unknown values safely', () => {
    expect(categoryDisplayName('food-drinks')).toBe('Food & Drinks');
    expect(categoryDisplayName('electronics')).toBe('Electronics');
    expect(categoryDisplayName('Electronics')).toBe('Electronics'); // legacy → mapped display
    expect(categoryDisplayName('Property')).toBe('Accommodation'); // legacy → mapped display
    expect(categoryDisplayName('Free Stuff')).toBe('Free Stuff'); // unmapped → raw, unclassified
    expect(categoryDisplayName('weird-legacy-value')).toBe('weird-legacy-value');
  });

  it('rejects every legacy display name as new input (isValidListingCategory)', () => {
    for (const legacy of ['Electronics', 'Furniture', 'Clothing', 'Vehicles', 'Property', 'Jobs & Services', 'Agriculture', 'Student Essentials', 'Hostel Living', 'Free Stuff']) {
      expect(isValidListingCategory(legacy)).toBe(false);
    }
  });
});

describe('Listing model enum (model-layer constraint)', () => {
  it('accepts canonical stable IDs', () => {
    for (const id of EXPECTED_IDS) {
      const doc = new RealListingModel({
        title: 't', category: id, condition: 'Good', price: 1, description: 'd',
        sellerName: 's', sellerWhatsapp: '07', package: 'standard', expiresAt: new Date(),
      });
      const err = doc.validateSync();
      expect(err ?? null).toBeNull();
    }
  });

  it('rejects legacy display names and arbitrary strings', () => {
    for (const bad of ['Electronics', 'Free Stuff', 'not-a-category', '']) {
      const doc = new RealListingModel({
        title: 't', category: bad, condition: 'Good', price: 1, description: 'd',
        sellerName: 's', sellerWhatsapp: '07', package: 'standard', expiresAt: new Date(),
      });
      const err = doc.validateSync();
      expect(err).toBeTruthy();
      expect(err.errors.category).toBeTruthy();
    }
  });
});

describe('GET /api/listings/categories — public metadata endpoint', () => {
  it('returns the canonical categories in the exact order with id, name, icon', async () => {
    const res = await request(app).get('/api/listings/categories');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.categories).toHaveLength(12);
    expect(res.body.categories.map((c) => c.id)).toEqual(EXPECTED_IDS);
    expect(res.body.categories.map((c) => c.name)).toEqual(EXPECTED_NAMES);
    for (const c of res.body.categories) {
      expect(c.icon).toBeTruthy();
      expect(Array.isArray(c.legacyNames)).toBe(true);
    }
  });

  it('is not shadowed by the /:id route', async () => {
    // A 404 here would mean '/categories' was captured as an id param.
    const res = await request(app).get('/api/listings/categories');
    expect(res.status).toBe(200);
  });
});

describe('paid listing initiation — canonical category validation', () => {
  it('accepts every one of the 12 canonical IDs and stores the stable ID', async () => {
    for (const id of EXPECTED_IDS) {
      h.payments.length = 0;
      const res = await request(app).post('/api/payments/initiate-listing').send({
        phoneNumber: '0712345678',
        package: 'standard',
        listingData: listingData({ category: id }),
        acceptance,
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const payment = h.payments[0];
      expect(payment.listingData.category).toBe(id);
    }
  });

  it('rejects an invalid category, a legacy display name, and Free Stuff', async () => {
    for (const bad of ['not-a-category', 'Electronics', 'Free Stuff', 'Property', '']) {
      const res = await request(app).post('/api/payments/initiate-listing').send({
        phoneNumber: '0712345678',
        package: 'standard',
        listingData: listingData({ category: bad }),
        acceptance,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('category');
    }
    expect(h.payments.length).toBe(0);
  });
});

describe('listing update — canonical category validation', () => {
  const OWNER_TOKEN = 'owner-token-cat';
  function seedOwnedListing(overrides = {}) {
    const doc = makeDoc({
      _id: 'lst-own-1',
      title: 'Owned item',
      category: 'electronics',
      subcategory: undefined,
      condition: 'Good',
      price: 100,
      description: 'desc',
      sellerName: 'Jane',
      sellerWhatsapp: '07',
      location: 'Njoro',
      status: 'active',
      moderationStatus: 'approved',
      images: [],
      ownerTokenHash: sha256hex(OWNER_TOKEN),
      package: 'standard',
      expiresAt: new Date(Date.now() + 86400000),
      ...overrides,
    });
    h.listings.push(doc);
    return doc;
  }

  it('accepts a canonical stable ID and persists it', async () => {
    seedOwnedListing();
    const res = await request(app).put('/api/listings/lst-own-1')
      .set('X-Owner-Token', OWNER_TOKEN)
      .send({ category: 'furniture-home' });
    expect(res.status).toBe(200);
    expect(h.listings[0].category).toBe('furniture-home');
  });

  it('rejects invalid, legacy, and Free Stuff values without fuzzy matching', async () => {
    for (const bad of ['not-a-category', 'Electronics', 'Free Stuff']) {
      seedOwnedListing();
      const res = await request(app).put('/api/listings/lst-own-1')
        .set('X-Owner-Token', OWNER_TOKEN)
        .send({ category: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid category');
      expect(h.listings[0].category).not.toBe(bad);
      h.listings.length = 0;
    }
  });
});

describe('store listing creation — canonical listing-category validation', () => {
  const STORE_TOKEN = 'store-token-cat';
  function seedStore() {
    const doc = makeDoc({
      _id: 'sto-cat-1',
      name: 'Category Test Store',
      slug: 'category-test-store',
      category: 'Books', // store taxonomy — deliberately NOT a listing category
      plan: 'starter_weekly',
      status: 'active',
      listing_limit: 5,
      expires_at: new Date(Date.now() + 7 * 86400000),
      ownerTokenHash: sha256hex(STORE_TOKEN),
      moderationStatus: 'approved',
    });
    h.stores.set(String(doc._id), doc);
    return doc;
  }
  const postListing = (store, listingDataBody) =>
    request(app).post(`/api/stores/${store._id}/listings`)
      .set('X-Store-Owner-Token', STORE_TOKEN)
      .send({ listingData: listingDataBody, acceptance, website: '' });

  it('accepts a canonical listing-category ID on a store listing', async () => {
    const store = seedStore();
    const res = await postListing(store, listingData({ category: 'accommodation' }));
    expect(res.status).toBe(201);
    expect(h.listings[0].category).toBe('accommodation');
    // Store taxonomy untouched: the store keeps its own category value.
    expect(h.stores.get('sto-cat-1').category).toBe('Books');
  });

  it('rejects invalid and legacy listing-category values on store listings', async () => {
    for (const bad of ['not-a-category', 'Electronics', 'Free Stuff']) {
      const store = seedStore();
      const res = await postListing(store, listingData({ category: bad }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('category');
      h.stores.clear();
    }
    expect(h.listings.length).toBe(0);
  });
});

describe('grant redemption — canonical listing-category validation', () => {
  // Grant ids must be valid ObjectIds (isValidId guards the route).
  const GRANT_ID = 'a'.repeat(24);
  function seedApprovedGrant() {
    const raw = 'grant-claim-token-cat';
    const doc = makeDoc({
      _id: GRANT_ID,
      type: 'listing',
      package: 'standard',
      whatsapp: '0711111111',
      status: 'approved',
      provisionedAt: null,
      claimTokenHash: sha256hex(raw),
    });
    h.grants.set(String(doc._id), doc);
    return { doc, raw };
  }
  const redeem = (claimId, raw, body) =>
    request(app).post(`/api/grants/${claimId}/redeem`)
      .set('X-Grant-Token', raw)
      .send({ listingData: body, acceptance, website: '' });

  it('accepts a canonical category and provisions with the stable ID', async () => {
    const { doc, raw } = seedApprovedGrant();
    const res = await redeem(doc._id, raw, listingData({ category: 'beauty-personal-care' }));
    expect(res.status).toBe(201);
    expect(h.listings[0].category).toBe('beauty-personal-care');
  });

  it('rejects invalid and legacy category values at redemption', async () => {
    for (const bad of ['not-a-category', 'Electronics', 'Free Stuff']) {
      const { doc, raw } = seedApprovedGrant();
      const res = await redeem(doc._id, raw, listingData({ category: bad }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('category');
      expect(h.listings.length).toBe(0);
      h.grants.clear();
    }
  });
});

describe('browse — server-side category filtering and pagination', () => {
  function seedBrowseInventory() {
    // 55 electronics (forces a second page), 3 food-drinks, 1 legacy Free Stuff.
    for (let i = 0; i < 55; i++) {
      h.listings.push(makeDoc({
        _id: `elec-${i}`,
        title: `Electronics widget ${i}`,
        category: 'electronics',
        condition: 'Good',
        price: 100 + i,
        description: 'x',
        sellerName: 's',
        sellerWhatsapp: '07',
        location: 'Njoro',
        status: 'active',
        moderationStatus: 'approved',
        images: [],
        createdAt: new Date(Date.now() - i * 1000),
      }));
    }
    for (let i = 0; i < 3; i++) {
      h.listings.push(makeDoc({
        _id: `food-${i}`,
        title: `Foodie pack ${i}`,
        category: 'food-drinks',
        condition: 'New',
        price: 200,
        description: 'x',
        sellerName: 's',
        sellerWhatsapp: '07',
        location: 'Njoro',
        status: 'active',
        moderationStatus: 'approved',
        images: [],
      }));
    }
    h.listings.push(makeDoc({
      _id: 'legacy-free',
      title: 'Old free shelf',
      category: 'Free Stuff', // pre-contract value; must render, not crash, not match pills
      condition: 'Good',
      price: 0, // zero price remains an ordinary listing
      description: 'x',
      sellerName: 's',
      sellerWhatsapp: '07',
      location: 'Njoro',
      status: 'active',
      moderationStatus: 'approved',
      images: [],
    }));
  }

  it('pages through a large category without losing listings beyond the first 50', async () => {
    seedBrowseInventory();
    const page1 = await request(app).get('/api/listings?category=electronics&page=1&limit=50');
    expect(page1.status).toBe(200);
    expect(page1.body.listings).toHaveLength(50);
    expect(page1.body.total).toBe(55);
    expect(page1.body.totalPages).toBe(2);
    expect(page1.body.listings.every((l) => l.category === 'electronics')).toBe(true);

    const page2 = await request(app).get('/api/listings?category=electronics&page=2&limit=50');
    expect(page2.status).toBe(200);
    expect(page2.body.listings).toHaveLength(5);
    // No overlap between pages — nothing is silently discarded.
    const ids1 = new Set(page1.body.listings.map((l) => l._id));
    expect(page2.body.listings.every((l) => !ids1.has(l._id))).toBe(true);
  });

  it('does not cross-contaminate categories (cache keys cannot collide)', async () => {
    seedBrowseInventory();
    const other = await request(app).get('/api/listings?category=food-drinks&page=1&limit=50');
    expect(other.status).toBe(200);
    expect(other.body.total).toBe(3);
    expect(other.body.listings.every((l) => l.category === 'food-drinks')).toBe(true);
  });

  it('combines category AND search', async () => {
    seedBrowseInventory();
    const res = await request(app).get('/api/listings?category=electronics&search=widget%201&page=1&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.listings.length).toBeLessThanOrEqual(55);
    expect(res.body.listings.every((l) => l.category === 'electronics')).toBe(true);
    expect(res.body.listings.every((l) => /widget 1/.test(l.title))).toBe(true);
  });

  it('returns an empty set (not an error) for an unknown category', async () => {
    seedBrowseInventory();
    const res = await request(app).get('/api/listings?category=not-a-category&page=1&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('renders legacy/unclassified records safely in the unfiltered browse', async () => {
    seedBrowseInventory();
    const res = await request(app).get('/api/listings?page=1&limit=100');
    expect(res.status).toBe(200);
    const legacy = res.body.listings.find((l) => l._id === 'legacy-free');
    expect(legacy).toBeTruthy();
    expect(legacy.category).toBe('Free Stuff'); // passed through unclassified
    expect(legacy.price).toBe(0);
  });
});

describe('WhatsApp message renders the category display name (routing untouched)', () => {
  const baseListing = {
    title: 'T', price: 100, condition: 'Good', description: 'D',
    location: 'Njoro', sellerName: 'S', sellerWhatsapp: '0712345678', images: [],
  };

  it('shows the display name for a canonical ID', () => {
    const msg = realWhatsappService.formatMessage({ ...baseListing, category: 'food-drinks' });
    expect(msg).toContain('Food & Drinks');
    expect(msg).not.toContain('food-drinks');
  });

  it('maps a legacy display name for display', () => {
    const msg = realWhatsappService.formatMessage({ ...baseListing, category: 'Property' });
    expect(msg).toContain('Accommodation');
  });

  it('renders an unmapped legacy value raw without crashing', () => {
    const msg = realWhatsappService.formatMessage({ ...baseListing, category: 'Free Stuff' });
    expect(msg).toContain('Free Stuff');
  });
});
