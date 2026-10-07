// Env fixtures — set BEFORE any server import (same convention as
// vitals.test.mjs / wiring.test.mjs so the suite is self-contained without .env).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Same seam as wiring.test.mjs: inject in-memory fakes into require.cache
// BEFORE server.js is imported. vi.mock does not reach CJS require() consumers
// in this vitest/Node setup.
const require = createRequire(import.meta.url);

function injectModule(p, exportsObj) {
  const resolved = require.resolve(p);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

// ── Counting listing fake ────────────────────────────────────────────────────
const h = { listings: [] };
const calls = { find: 0, countDocuments: 0, findById: 0, create: 0, deleteOne: 0, findByIdAndUpdate: 0 };

// Generic filter matcher — equality plus the $ne/$lt/$lte/$gte/$regex shapes
// the route and webhook flows use (same approach as wiring.test.mjs).
function matchesListFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$ne !== undefined && doc[k] === v.$ne) return false;
      if (v.$lt !== undefined && !(doc[k] && new Date(doc[k]) < new Date(v.$lt))) return false;
      if (v.$lte !== undefined && !(doc[k] && new Date(doc[k]) <= new Date(v.$lte))) return false;
      if (v.$gte !== undefined && !(doc[k] && new Date(doc[k]) >= new Date(v.$gte))) return false;
      if (v.$regex !== undefined && !new RegExp(v.$regex, v.$options || '').test(String(doc[k] ?? ''))) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}

function selectable(doc) {
  // Mirrors Mongoose: a query that resolves to doc also carries .select().
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}

const fakeListingModel = {
  find(filter) {
    calls.find += 1;
    const found = h.listings.filter((l) => matchesListFilter(l, filter));
    const builder = {
      populate() { return builder; },
      sort() { return builder; },
      skip() { return builder; },
      limit() { return builder; },
      lean: () => Promise.resolve(found.map((l) => ({ ...l }))),
      then: (res, rej) => Promise.resolve(found.map((l) => ({ ...l }))).then(res, rej),
      catch: (rej) => Promise.resolve(found.map((l) => ({ ...l }))).catch(rej),
    };
    return builder;
  },
  countDocuments(filter) {
    calls.countDocuments += 1;
    return Promise.resolve(h.listings.filter((l) => matchesListFilter(l, filter)).length);
  },
  findById(id) {
    calls.findById += 1;
    const doc = h.listings.find((x) => String(x._id) === String(id));
    return doc ? selectable(doc) : null;
  },
  create(data) {
    calls.create += 1;
    // Mirror the real schema default the webhook flow relies on: the create
    // payload omits status, real Mongoose supplies the 'active' default.
    const created = { ...data, status: data.status ?? 'active', _id: data._id || `lst-new-${calls.create}`, toObject() { return { ...created }; }, save: async function () { return this; } };
    h.listings.push(created);
    return Promise.resolve(created);
  },
  findByIdAndUpdate(id, updates) {
    calls.findByIdAndUpdate += 1;
    const doc = h.listings.find((x) => String(x._id) === String(id));
    if (!doc) return Promise.resolve(null);
    Object.assign(doc, updates);
    return Promise.resolve({ ...doc, toObject() { return { ...doc }; } });
  },
  deleteOne(filter) {
    calls.deleteOne += 1;
    const idx = h.listings.findIndex((x) => String(x._id) === String(filter._id));
    const deletedCount = idx === -1 ? 0 : 1;
    if (idx !== -1) h.listings.splice(idx, 1);
    return Promise.resolve({ deletedCount });
  },
  updateMany() { // feature-expiry sweep: counted implicitly through find flows
    return Promise.resolve({ modifiedCount: 0 });
  },
};

// ── Counting ttlCache wrapper (invalidation evidence) ────────────────────────
const fakeTtl = {
  value: {
    createTtlCache: require('../src/utils/ttlCache').createTtlCache,
    listingsCache: require('../src/utils/ttlCache').listingsCache,
    invalidateListingsCache: () => {
      fakeTtl.value.invalidations += 1;
      require('../src/utils/ttlCache').listingsCache.clear();
    },
    invalidations: 0,
  },
};

// ── Minimal fakes for the other models the touched paths reach ───────────────
const fakePaymentDocs = [];
// Payment docs must expose .save() (the webhook back-references listingId and
// persists via payment.save()); non-enumerable so the stored body used in the
// byte-identity assertions stays clean.
function withSave(doc) {
  if (doc !== null && typeof doc === 'object' && typeof doc.save !== 'function') {
    Object.defineProperty(doc, 'save', { value: async function () { return this; }, enumerable: false });
  }
  return doc;
}

const fakePaymentModel = {
  findOne(filter) {
    const doc = fakePaymentDocs.find((p) => p.invoiceId === filter.invoiceId);
    return doc ? Promise.resolve(withSave(doc)) : Promise.resolve(null);
  },
  findOneAndUpdate(filter, updates) {
    const doc = fakePaymentDocs.find((p) => String(p._id) === String(filter._id) && p.invoiceId === filter.invoiceId && p.status !== 'completed');
    if (!doc) return Promise.resolve(null);
    withSave(doc);
    Object.assign(doc, updates);
    return Promise.resolve(doc);
  },
  create(data) {
    const created = { ...data, _id: `pay-${fakePaymentDocs.length + 1}`, save: async function () { return this; } };
    fakePaymentDocs.push(created);
    return Promise.resolve(created);
  },
};

const auditEvents = [];
const fakeAuditModel = { create: async (event) => { auditEvents.push(event); return { _id: 'audit-fake', ...event }; } };

const fakeAdminModel = { find: async () => [] };

const fakeWhatsapp = { broadcastListing: async () => {}, formatMessage: () => '' };

// The webhook flow also touches the logger (capturing fake — surfaced below
// on assertion failure instead of being swallowed), Cloudinary (no-op — the
// fake Listing carries no real image URL, so nothing is destroyed) and
// BlockedContact. Same minimal shapes wiring.test.mjs injects for these.
const logErrors = [];
const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: (msg, meta) => logErrors.push({ msg, meta }),
  http: () => {},
};
const fakeCloudinary = { uploader: { destroy: async () => ({}), upload: async () => ({}) } };
const fakeBlocks = { create: async (data) => ({ _id: 'blk-test', ...data }), findOne: async () => null, find: () => ({ lean: async () => [] }) };

let app;

beforeAll(async () => {
  injectModule('../src/models/Listing.js', fakeListingModel);
  injectModule('../src/models/Payment.js', fakePaymentModel);
  injectModule('../src/models/AuditEvent.js', fakeAuditModel);
  injectModule('../src/models/Admin.js', fakeAdminModel);
  injectModule('../src/services/whatsappService.js', fakeWhatsapp);
  injectModule('../src/config/logger.js', fakeLogger);
  injectModule('../src/config/cloudinary.js', fakeCloudinary);
  injectModule('../src/models/BlockedContact.js', fakeBlocks);
  injectModule('../src/utils/ttlCache.js', fakeTtl.value);
  app = require('../server.js');
});

beforeEach(() => {
  h.listings.length = 0;
  fakePaymentDocs.length = 0;
  auditEvents.length = 0;
  for (const k of Object.keys(calls)) calls[k] = 0;
  fakeTtl.value.invalidations = 0;
  fakeTtl.value.listingsCache.clear();
});

function seedListing(id, overrides = {}) {
  const doc = {
    _id: id,
    title: `Widget ${id}`,
    category: 'Electronics',
    condition: 'Good',
    status: 'active',
    moderationStatus: 'approved',
    ownerTokenHash: require('crypto').createHash('sha256').update(`${id}-owner-token`).digest('hex'),
    priorityBroadcast: false,
    featured: false,
    createdAt: new Date('2026-01-01'),
    toObject() { return { ...this }; },
    save: async function () { return this; },
    ...overrides,
  };
  h.listings.push(doc);
  return doc;
}

describe('GET /api/listings — browse cache integration', () => {
  it('two identical page-1 requests hit the model once (cache hit replays the payload)', async () => {
    seedListing('lst-a');
    const r1 = await request(app).get('/api/listings');
    expect(r1.status).toBe(200);
    expect(r1.body.total).toBe(1);
    expect(r1.body.listings.map((l) => l._id)).toEqual(['lst-a']);
    expect(calls.countDocuments).toBe(1);

    const r2 = await request(app).get('/api/listings');
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body); // byte-identical replay from the cache
    expect(calls.countDocuments).toBe(1); // no second model read
    expect(fakeTtl.value.listingsCache.size()).toBe(1);
  });

  it('create invalidates: a webhook-created listing appears on the next page-1 read', async () => {
    seedListing('lst-a');
    await request(app).get('/api/listings'); // warm the cache

    fakePaymentDocs.push({
      _id: 'pay-1', type: 'listing', status: 'pending', amount: 30, expectedAmount: 30,
      invoiceId: 'INV-CACHE-1', package: 'quick', ownerTokenHash: 'a'.repeat(64),
      listingData: {
        title: 'Fresh paid widget', category: 'Electronics', condition: 'New', price: 10,
        description: 'plain', sellerName: 'S', sellerWhatsapp: '0712345678',
        location: 'Egerton', images: [],
      },
    });
    const res = await request(app).post('/api/payments/webhook').send({ challenge: 'test-challenge', invoice_id: 'INV-CACHE-1', state: 'COMPLETE' });
    if (logErrors.length > 0) console.error('captured logger.error:', logErrors);
    expect(res.status).toBe(200);
    expect(fakeTtl.value.invalidations).toBeGreaterThan(0);

    const r2 = await request(app).get('/api/listings');
    expect(r2.status).toBe(200);
    expect(r2.body.listings.map((l) => l._id)).toContain('lst-new-1');
    expect(calls.countDocuments).toBe(2); // fresh read after invalidation
  });

  it('update invalidates: the flagged edition disappears from the next page-1 read', async () => {
    seedListing('lst-a');
    seedListing('lst-b', { condition: 'New' });
    await request(app).get('/api/listings'); // warm

    // A prohibited description flips moderation to flagged (route-level PUT).
    const res = await request(app).put('/api/listings/lst-a').set('X-Owner-Token', 'lst-a-owner-token').send({ description: 'M-Pesa PIN here, pay first then deliver' });
    expect(res.status).toBe(200);
    expect(fakeTtl.value.invalidations).toBeGreaterThan(0);

    const r2 = await request(app).get('/api/listings');
    expect(r2.status).toBe(200);
    expect(r2.body.listings.map((l) => l._id)).toEqual(['lst-b']); // lst-a flagged out
  });

  it('delete invalidates: the deleted listing disappears from the next page-1 read', async () => {
    seedListing('lst-a');
    await request(app).get('/api/listings'); // warm

    const res = await request(app).delete('/api/listings/lst-a').set('X-Owner-Token', 'lst-a-owner-token');
    expect(res.status).toBe(200);
    expect(fakeTtl.value.invalidations).toBeGreaterThan(0);

    const r2 = await request(app).get('/api/listings');
    expect(r2.status).toBe(200);
    expect(r2.body.total).toBe(0);
  });

  it('page 2 is never cached: two page-2 requests hit the model twice', async () => {
    seedListing('lst-a');
    seedListing('lst-b', { condition: 'New' });
    await request(app).get('/api/listings?page=2');
    const r1 = await request(app).get('/api/listings?page=2');
    expect(r1.status).toBe(200);
    expect(calls.countDocuments).toBe(2); // both requests read the model
    expect(fakeTtl.value.listingsCache.size()).toBe(0); // page 2 set nothing
  });
});
