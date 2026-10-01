import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import speakeasy from 'speakeasy';
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

// Env fixtures — set BEFORE any server import so the suite is self-contained
// (CI has no .env; server code reads ADMIN_KEY / INTASEND_WEBHOOK_CHALLENGE at
// request time and ADMIN_SESSION_SECRET at module load for session tokens).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

export const TEST_ADMIN_KEY = process.env.ADMIN_KEY;
export const TEST_WEBHOOK_CHALLENGE = process.env.INTASEND_WEBHOOK_CHALLENGE;

// ─────────────────────────────────────────────────────────────────────────────
// Architecture note: this suite tests the REAL controllers/services by injecting
// in-memory model fakes into Node's require.cache BEFORE server.js is imported.
// (vi.mock does not reach CJS require() consumers in this vitest/Node setup —
// verified by probe — so require.cache injection is the reliable seam.)
// ─────────────────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);

const h = {
  payments: [],
  stores: new Map(),
  listings: [],
  admins: new Map(),
};

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

// ── Fake helpers ─────────────────────────────────────────────────────────────
// findById results are sometimes awaited directly and sometimes carry
// .select() — return a thenable that resolves to the SAME stored object, with
// a select() that resolves to it too (fake models don't project fields).
function selectableDoc(doc) {
  // Mirrors Mongoose: even a query that resolves to null carries .select().
  return {
    select: () => Promise.resolve(doc),
    then: (res, rej) => Promise.resolve(doc).then(res, rej),
    catch: (rej) => Promise.resolve(doc).catch(rej),
  };
}

// Write results that can also be chained with .session(session) (transactions).
function chainableResult(result) {
  return {
    ...result,
    session: () => Promise.resolve(result),
    then: (res, rej) => Promise.resolve(result).then(res, rej),
    catch: (rej) => Promise.resolve(result).catch(rej),
  };
}

// Generic in-memory matcher: equality plus the $ne/$lt/$lte/$regex operators
// actually used by the code under test.
function matchesFilter(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if (v.$ne !== undefined && doc[k] === v.$ne) return false;
      if (v.$lte !== undefined && !(doc[k] && new Date(doc[k]) <= new Date(v.$lte))) return false;
      if (v.$lt !== undefined && !(doc[k] && new Date(doc[k]) < new Date(v.$lt))) return false;
      if (v.$regex !== undefined && !new RegExp(v.$regex, v.$options || '').test(String(doc[k] ?? ''))) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}

// ── Listing fake (chainable query builder covering every call shape used) ──
function applyFind(state) {
  let out = h.listings.filter((l) => matchesFilter(l, state.filter));
  if (state.sort) {
    const keys = Object.entries(state.sort);
    out = [...out].sort((a, b) => {
      for (const [k, dir] of keys) {
        const av = a[k];
        const bv = b[k];
        const na = typeof av === 'boolean' ? (av ? 1 : 0) : av;
        const nb = typeof bv === 'boolean' ? (bv ? 1 : 0) : bv;
        const c = na < nb ? -1 : na > nb ? 1 : 0;
        if (c !== 0) return c * dir;
      }
      return 0;
    });
  }
  if (state.skip) out = out.slice(state.skip);
  if (state.limit) out = out.slice(0, state.limit);
  return out;
}

const fakeListingModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', store_id: null, broadcastSent: false, priorityBroadcast: false, featured: false, boostType: null, featuredUntil: null, moderationStatus: 'approved', ...data });
    h.listings.push(doc);
    return doc;
  },
  findById: (id) => selectableDoc(h.listings.find(l => String(l._id) === String(id)) || null),
  find: (filter = {}) => {
    const state = { filter };
    const builder = {
      populate: () => builder,
      sort: (s) => { state.sort = s; return builder; },
      skip: (n) => { state.skip = n; return builder; },
      limit: (n) => { state.limit = n; return builder; },
      session: () => builder,
      lean: async () => applyFind(state).map(l => ({ ...l })),
      then: (res, rej) => Promise.resolve(applyFind(state)).then(res, rej),
      catch: (rej) => Promise.resolve(applyFind(state)).catch(rej),
    };
    return builder;
  },
  countDocuments: async (filter = {}) => h.listings.filter(l => matchesFilter(l, filter)).length,
  updateMany: async (filter, update) => {
    let modifiedCount = 0;
    for (const l of h.listings) {
      if (matchesFilter(l, filter)) {
        Object.assign(l, update.$set || update);
        modifiedCount++;
      }
    }
    return { modifiedCount };
  },
  findByIdAndUpdate: async (id, update) => {
    const doc = h.listings.find(l => String(l._id) === String(id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  // NOT async: the controller calls .session() on the IMMEDIATE return value,
  // so these must return the thenable synchronously (await still works via then).
  deleteOne: (filter) => {
    const i = h.listings.findIndex(l => String(l._id) === String(filter._id));
    let deletedCount = 0;
    if (i !== -1) { h.listings.splice(i, 1); deletedCount = 1; }
    return chainableResult({ deletedCount });
  },
  deleteMany: (filter) => {
    const before = h.listings.length;
    h.listings = h.listings.filter(l => !matchesFilter(l, filter));
    return chainableResult({ deletedCount: before - h.listings.length });
  },
};

// ── Store fake (select:false emulated on read paths, hash passthrough on findById) ──
const fakeStoreModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `sto-${h.stores.size + 1}`, status: 'active', subcategories: [], ...data });
    h.stores.set(String(doc._id), doc);
    return doc;
  },
  // .select('+ownerTokenHash') → same doc incl. hash (fakes don't project)
  findById: (id) => selectableDoc(h.stores.get(String(id)) || null),
  findOne: async (filter = {}) => {
    for (const s of h.stores.values()) {
      const slugOk = filter.slug === undefined || s.slug === filter.slug;
      const statusOk = !(filter.status && filter.status.$ne) || s.status !== filter.status.$ne;
      if (slugOk && statusOk) { const view = { ...s }; delete view.ownerTokenHash; return view; }
    }
    return null;
  },
  find: async (filter = {}) => {
    const out = [...h.stores.values()].filter(s => !filter.ownerTokenHash || s.ownerTokenHash === filter.ownerTokenHash);
    return out.map((s) => { const view = { ...s }; delete view.ownerTokenHash; return view; });
  },
  findOneAndUpdate: async (filter, update) => {
    for (const s of h.stores.values()) {
      if (filter.slug && s.slug === filter.slug) { Object.assign(s, update); return s; }
    }
    return null;
  },
  findByIdAndUpdate: async (id, update) => {
    const doc = h.stores.get(String(id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  deleteOne: (filter) => chainableResult({ deletedCount: h.stores.delete(String(filter._id)) ? 1 : 0 }),
};

// ── Payment fake (findOneAndUpdate emulates the webhook's atomic claim) ──
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
};

// ── Remaining fakes ──
const fakeTermsModel = {
  create: async (data) => makeDoc({ _id: `ta-${Math.random().toString(36).slice(2, 8)}`, ...data }),
  findByIdAndUpdate: async () => makeDoc({}),
};

const fakeAdminModel = {
  // Must resolve to the STORED object (not a copy) so totpEnabled flips on the
  // record that authenticateAdmin's Admin.find() later reads.
  findOne: (filter) => selectableDoc(h.admins.get(filter.username) || null),
  findOneAndUpdate: async (filter, update) => {
    const existing = h.admins.get(filter.username) || { username: filter.username };
    const merged = { ...existing, ...update };
    merged.save = async () => merged;
    h.admins.set(filter.username, merged);
    return merged;
  },
  find: () => {
    const enabled = [...h.admins.values()].filter(a => a.totpEnabled);
    return { select: () => ({ lean: async () => enabled.map(a => ({ username: a.username })) }) };
  },
};

const broadcastListing = vi.fn(async () => [{ groupId: 'group-a', success: true }]);
const fakeWhatsappService = { broadcastListing, formatMessage: () => 'msg' };

const cloudinaryUpload = vi.fn(async () => ({ secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/test.jpg' }));
const cloudinaryDestroy = vi.fn(async () => ({ result: 'ok' }));
const fakeCloudinary = {
  api: { ping: async () => ({ status: 'ok' }) },
  uploader: { upload: cloudinaryUpload, destroy: cloudinaryDestroy },
};

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
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);

// ── Transparent sharp wrapper for the decode-concurrency test. While tracking
// is off it is the real sharp, so every other test is unaffected.
const realSharp = require('sharp');
const sharpState = { tracking: false, concurrent: 0, max: 0, delayMs: 0 };
function sharpSpy(...args) {
  const pipeline = realSharp(...args);
  if (!sharpState.tracking) return pipeline;
  const runToBuffer = pipeline.toBuffer.bind(pipeline);
  pipeline.toBuffer = async (...tbArgs) => {
    sharpState.concurrent += 1;
    sharpState.max = Math.max(sharpState.max, sharpState.concurrent);
    try {
      if (sharpState.delayMs) await new Promise((r) => setTimeout(r, sharpState.delayMs));
      return await runToBuffer(...tbArgs);
    } finally {
      sharpState.concurrent -= 1;
    }
  };
  return pipeline;
}
injectModule('sharp', sharpSpy);

// Uploads in this suite (5 in test 6, 15 in test 7) blow past uploadLimiter's
// 10/min per-IP production limit, which would otherwise mask the decode bound
// behind 429s. The upload limiter is not what these tests exercise, so uploads
// pass straight through; every other limiter keeps its real configuration.
const realRateLimiter = require('../src/middleware/rateLimiter');
injectModule('../src/middleware/rateLimiter.js', {
  ...realRateLimiter,
  uploadLimiter: (req, _res, next) => next(),
});

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

beforeEach(() => {
  h.payments.length = 0;
  h.stores.clear();
  h.listings.length = 0;
  h.admins.clear();
  broadcastListing.mockClear();
  cloudinaryUpload.mockClear();
  cloudinaryDestroy.mockClear();
  // deleteStore opens a Mongo transaction on the real (unconnected) mongoose
  // singleton — stub the session API in place.
  vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue({
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(async () => {}),
    abortTransaction: vi.fn(async () => {}),
    endSession: vi.fn(),
  });
});

afterAll(() => { vi.restoreAllMocks(); });

// Task 1 request ID test block
describe('Request-ID middleware (X-Request-ID)', () => {
  it('attaches a UUID-formatted X-Request-ID to responses', async () => {
    const res = await request(app).get('/health');
    // /health checks mongodb + cloudinary; without a live Mongoose connection the
    // suite reports 503, but the request-ID header is independent of that path.
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns a valid UUID v4 in X-Request-ID', async () => {
    const res = await request(app).get('/health');
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('gives every request a unique ID', async () => {
    const r1 = await request(app).get('/health');
    const r2 = await request(app).get('/health');
    expect(r1.headers['x-request-id']).not.toBe(r2.headers['x-request-id']);
  });

  it('includes X-Request-ID on 4xx responses', async () => {
    const res = await request(app).get('/api/listings/nonexistent-xyz');
    expect(res.status).toBe(500);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('includes the request ID in the 500 error log', async () => {
    const logger = require('../src/config/logger');
    const errorHandler = require('../src/middleware/errorHandler');
    let captured;
    const spy = vi.spyOn(logger, 'error').mockImplementation((msg, meta) => { captured = meta; });
    try {
      const res = {
        headersSent: false,
        statusCode: 0,
        status: vi.fn(function (code) { this.statusCode = code; return this; }),
        json: vi.fn(function (payload) { this.body = payload; return this; }),
      };
      const next = vi.fn();
      const err = new Error('SECRET_STRING');
      err.status = 500;
      errorHandler(err, { method: 'GET', originalUrl: '/api/listings', id: '11111111-2222-4333-8444-555555555555' }, res, next);
      expect(captured).toBeDefined();
      expect(captured).toHaveProperty('requestId');
      expect(captured.requestId).toBe('11111111-2222-4333-8444-555555555555');
      expect(captured.method).toBe('GET');
      expect(captured.url).toBe('/api/listings');
      expect(captured.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

function listingPayment(overrides = {}) {
  return {
    type: 'listing',
    status: 'pending',
    package: 'standard',
    invoiceId: 'INV-LISTING-1',
    ownerTokenHash: 'a'.repeat(64),
    listingData: {
      title: 'Vintage Lens Camera',
      category: 'Electronics',
      condition: 'Good',
      price: 500,
      description: 'Lightly used camera body',
      sellerName: 'Jane',
      sellerWhatsapp: '0711111111',
      location: 'Egerton',
      images: [],
    },
    ...overrides,
  };
}

const webhook = (body) => request(app).post('/api/payments/webhook').send({ challenge: TEST_WEBHOOK_CHALLENGE, ...body });

// ─── Webhook: required-field validation ─────────────────────────────────────
describe('Webhook COMPLETE — missing invoice_id fails closed', () => {
  it('rejects with 400 and cannot claim an arbitrary pending payment', async () => {
    // Mongoose 9 drops `undefined` from filter objects, so without the guard the
    // claim filter { invoiceId: undefined, status: { $ne: 'completed' } } collapses
    // to { status: { $ne: 'completed' } } and claims whichever payment is pending.
    h.payments.push(makeDoc(listingPayment()));
    const res = await webhook({ state: 'COMPLETE' }); // no invoice_id

    expect(res.status).toBe(400);
    expect(h.payments[0].status).toBe('pending');
    expect(h.listings).toHaveLength(0);
  });
});

// ─── Webhook: listing payments ──────────────────────────────────────────────
describe('Webhook COMPLETE (listing) → Listing created, broadcast, broadcastSent', () => {
  it('creates the listing, copies ownerTokenHash, calls broadcastListing, sets broadcastSent=true', async () => {
    h.payments.push(makeDoc(listingPayment()));
    const res = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].ownerTokenHash).toBe('a'.repeat(64));
    expect(h.listings[0].moderationStatus).toBe('approved');
    // Fix 2: broadcast sent AND reflected on the listing record.
    expect(broadcastListing).toHaveBeenCalledTimes(1);
    expect(h.listings[0].broadcastSent).toBe(true);
  });

  it('duplicate COMPLETE delivery is idempotent: no second listing, no double broadcast', async () => {
    h.payments.push(makeDoc(listingPayment()));
    await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
    const res2 = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });

    expect(res2.status).toBe(200);
    expect(h.listings).toHaveLength(1);
    expect(broadcastListing).toHaveBeenCalledTimes(1);
  });

  it('flagged listing is created but NOT broadcast and NOT marked broadcastSent', async () => {
    h.payments.push(makeDoc(listingPayment({
      listingData: { title: 'M-Pesa PIN here, pay first then deliver', category: 'Electronics', condition: 'Good', price: 10, description: 'x', sellerName: 'S', sellerWhatsapp: '07', location: 'E', images: [] },
    })));
    const res = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].moderationStatus).toBe('flagged');
    expect(broadcastListing).not.toHaveBeenCalled();
    expect(h.listings[0].broadcastSent).toBe(false);
  });

  it('rejects a bad webhook challenge with 401 and touches nothing', async () => {
    // A real pending payment waits behind the challenge gate: rejection must
    // happen BEFORE any lookup, mutation, or side effect.
    h.payments.push(makeDoc(listingPayment()));
    const res = await request(app).post('/api/payments/webhook').send({ challenge: 'wrong-challenge', invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
    expect(res.status).toBe(401);
    expect(h.payments[0].status).toBe('pending');
    expect(h.listings).toHaveLength(0);
    expect(h.stores.size).toBe(0);
  });

  it('challenge-mismatch log is whitelisted: no challenge or phone_number is logged', async () => {
    const errorSpy = vi.spyOn(fakeLogger, 'error');
    h.payments.push(makeDoc(listingPayment()));
    const res = await request(app).post('/api/payments/webhook').send({
      challenge: 'wrong-challenge',
      invoice_id: 'INV-LISTING-1',
      state: 'COMPLETE',
      api_ref: 'listing_123',
      phone_number: '+254711000111',
    });
    expect(res.status).toBe(401);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, logged] = errorSpy.mock.calls[0];
    expect(message).toBe('Webhook challenge mismatch');
    // Whitelisted debug fields ARE present.
    expect(logged.invoice_id).toBe('INV-LISTING-1');
    expect(logged.state).toBe('COMPLETE');
    expect(logged.api_ref).toBe('listing_123');
    // Secret + PII are NOT: neither the key nor the value may appear.
    expect(logged.challenge).toBeUndefined();
    expect(logged.phone_number).toBeUndefined();
    expect(logged.body).toBeUndefined();
    const loggedJson = JSON.stringify(logged);
    expect(loggedJson).not.toContain('wrong-challenge');
    expect(loggedJson).not.toContain('+254711000111');
    errorSpy.mockRestore();
  });
});

// ─── Webhook: boost payments ────────────────────────────────────────────────
describe('Webhook COMPLETE (boost) → listing mutation', () => {
  it('featured boost sets featured + featuredUntil (+24h)', async () => {
    h.listings.push(makeDoc({ _id: 'lst-boost-1', featured: false, boostType: null, featuredUntil: null }));
    h.payments.push(makeDoc({ type: 'boost', status: 'pending', invoiceId: 'INV-BOOST-1', listingId: 'lst-boost-1', boostType: 'featured' }));

    const res = await webhook({ invoice_id: 'INV-BOOST-1', state: 'COMPLETE' });
    expect(res.status).toBe(200);
    expect(h.listings[0].featured).toBe(true);
    expect(h.listings[0].boostType).toBe('standard');
    expect(h.listings[0].featuredUntil).toBeTruthy();
  });

  it('priority_broadcast boost marks priorityBroadcast AND re-broadcasts the listing (Fix 1)', async () => {
    h.listings.push(makeDoc({ _id: 'lst-boost-2', priorityBroadcast: false }));
    h.payments.push(makeDoc({ type: 'boost', status: 'pending', invoiceId: 'INV-BOOST-2', listingId: 'lst-boost-2', boostType: 'priority_broadcast' }));

    const res = await webhook({ invoice_id: 'INV-BOOST-2', state: 'COMPLETE' });
    expect(res.status).toBe(200);
    expect(h.listings[0].priorityBroadcast).toBe(true);
    // The paid-for extra broadcast must actually happen and be recorded.
    expect(broadcastListing).toHaveBeenCalledTimes(1);
    expect(h.listings[0].broadcastSent).toBe(true);
  });
});

// ─── Listing sort honors priorityBroadcast (Fix 1) ──────────────────────────
describe('GET /api/listings — priorityBroadcast ranks above non-priority (Fix 1)', () => {
  it('returns priority-broadcast listings before regular ones', async () => {
    fakeListingModel.create({ _id: 'lst-plain', title: 'Regular item', priorityBroadcast: false, featured: false, createdAt: new Date('2026-01-03') });
    fakeListingModel.create({ _id: 'lst-prio', title: 'Priority item', priorityBroadcast: true, featured: false, createdAt: new Date('2026-01-01') });

    const res = await request(app).get('/api/listings');
    expect(res.status).toBe(200);
    const ids = res.body.listings.map(l => l._id);
    expect(ids.indexOf('lst-prio')).toBeLessThan(ids.indexOf('lst-plain'));
  });
});

// ─── Webhook: store payments ────────────────────────────────────────────────
describe('Webhook COMPLETE (store) → Store created', () => {
  it('creates the store from payment.storeData with plan pricing', async () => {
    h.payments.push(makeDoc({
      type: 'store', status: 'pending', invoiceId: 'INV-STORE-1', storePlan: 'starter_weekly',
      storeData: { name: 'Test Shop', slug: 'test-shop', category: 'Books', phone: '07', whatsapp: '07', email: '', location: 'Egerton' },
      ownerTokenHash: 'b'.repeat(64),
    }));

    const res = await webhook({ invoice_id: 'INV-STORE-1', state: 'COMPLETE' });
    expect(res.status).toBe(200);
    const store = h.stores.get('sto-1');
    expect(store).toBeTruthy();
    expect(store.ownerTokenHash).toBe('b'.repeat(64));
    expect(store.listing_limit).toBe(5);
    expect(store.status).toBe('active');
  });
});

// ─── Store routes: auth, hash leak, CRUD ────────────────────────────────────
describe('Store routes — auth, secret hygiene, CRUD', () => {
  async function seedStore() {
    return Store_create({
      name: 'My Shop', slug: 'my-shop', category: 'Books',
      ownerTokenHash: sha256hex('raw-owner-token'),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    });
  }
  const Store_create = (data) => fakeStoreModel.create(data);

  it('GET /stores/:id → 403 without token; 200 with token; body must NOT leak ownerTokenHash (Fix 3)', async () => {
    await seedStore();

    const denied = await request(app).get('/api/stores/sto-1');
    expect(denied.status).toBe(403);

    const ok = await request(app).get('/api/stores/sto-1').set('X-Store-Owner-Token', 'raw-owner-token');
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(JSON.stringify(ok.body)).not.toContain('ownerTokenHash');
  });

  it('GET /stores/:id → 403 when token does not match this store (tenant isolation)', async () => {
    await seedStore();
    const res = await request(app).get('/api/stores/sto-1').set('X-Store-Owner-Token', 'attacker-token');
    expect(res.status).toBe(403);
  });

  it('GET /stores/slug/:slug → 200 public route without token', async () => {
    await seedStore();
    const res = await request(app).get('/api/stores/slug/my-shop');
    expect(res.status).toBe(200);
    expect(res.body.store.slug).toBe('my-shop');
  });

  it('GET /stores/me/all → only stores matching the presented token', async () => {
    await fakeStoreModel.create({ name: 'A', slug: 'a', category: 'Books', ownerTokenHash: sha256hex('token-a'), plan: 'starter_weekly', plan_price: 150, plan_duration: 1, listing_limit: 5, started_at: new Date(), expires_at: new Date(), status: 'active' });
    await fakeStoreModel.create({ name: 'B', slug: 'b', category: 'Books', ownerTokenHash: sha256hex('token-b'), plan: 'starter_weekly', plan_price: 150, plan_duration: 1, listing_limit: 5, started_at: new Date(), expires_at: new Date(), status: 'active' });

    const res = await request(app).get('/api/stores/me/all').set('X-Store-Owner-Token', 'token-a');
    expect(res.status).toBe(200);
    expect(res.body.stores).toHaveLength(1);
    expect(res.body.stores[0].slug).toBe('a');
  });

  it('PUT /stores/:id (edit) → 403 cross-owner, 200 owner', async () => {
    await seedStore();
    const denied = await request(app).put('/api/stores/sto-1').set('X-Store-Owner-Token', 'wrong').send({ description: 'hack' });
    expect(denied.status).toBe(403);

    const ok = await request(app).put('/api/stores/sto-1').set('X-Store-Owner-Token', 'raw-owner-token').send({ description: 'updated' });
    expect(ok.status).toBe(200);
    expect(ok.body.store.description).toBe('updated');
  });

  it('PUT /stores/:id rename onto an existing slug → 409 "That slug is already taken"; nothing mutated', async () => {
    await seedStore(); // sto-1, slug 'my-shop'
    await fakeStoreModel.create({ name: 'Other Shop', slug: 'other-shop', category: 'Books', ownerTokenHash: sha256hex('token-b'), plan: 'starter_weekly', plan_price: 150, plan_duration: 1, listing_limit: 5, started_at: new Date(), expires_at: new Date(), status: 'active' });

    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', 'raw-owner-token')
      .send({ name: 'Other Shop' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('That slug is already taken');
    // The renamed store is untouched...
    expect(h.stores.get('sto-1').slug).toBe('my-shop');
    expect(h.stores.get('sto-1').name).toBe('My Shop');
    // ...and so is the store that owns the slug.
    expect(h.stores.get('sto-2').slug).toBe('other-shop');
  });

  it('DELETE /stores/:id cascades: store + its listings removed', async () => {
    const store = await seedStore();
    h.listings.push(makeDoc({ _id: 'lst-in-store', store_id: store._id, title: 'x' }));

    const res = await request(app).delete(`/api/stores/${store._id}`).set('X-Store-Owner-Token', 'raw-owner-token');
    expect(res.status).toBe(200);
    expect(h.stores.has('sto-1')).toBe(false);
    expect(h.listings).toHaveLength(0);
  });

  it('attach-listing requires BOTH store ownership and listing ownership', async () => {
    await seedStore();
    h.listings.push(makeDoc({ _id: 'lst-att', store_id: null, ownerTokenHash: sha256hex('listing-owner-token'), expiresAt: new Date(Date.now() + 86400000) }));

    // Store owner but no listing token → 403
    const noListingTok = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', 'raw-owner-token').send({ listingId: 'lst-att' });
    expect(noListingTok.status).toBe(403);

    // Both tokens → 200, listing attached
    const ok = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', 'raw-owner-token').set('X-Owner-Token', 'listing-owner-token')
      .send({ listingId: 'lst-att' });
    expect(ok.status).toBe(200);
    expect(String(h.listings[0].store_id)).toBe('sto-1');
  });

  it('detach-listing clears store_id, keeps the listing, and drops the store listing count', async () => {
    const store = await seedStore();
    h.listings.push(makeDoc({ _id: 'lst-det', store_id: null, ownerTokenHash: sha256hex('listing-owner-token'), expiresAt: new Date(Date.now() + 86400000), status: 'active' }));

    // Attach through the real endpoint (PUT /api/stores/:id/attach-listing)
    const attached = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', 'raw-owner-token').set('X-Owner-Token', 'listing-owner-token')
      .send({ listingId: 'lst-det' });
    expect(attached.status).toBe(200);
    expect(String(h.listings[0].store_id)).toBe('sto-1');
    const countAfterAttach = await fakeListingModel.countDocuments({ store_id: store._id, status: 'active' });
    expect(countAfterAttach).toBe(1);

    // Detach through the real endpoint (PUT /api/stores/:id/detach-listing)
    const res = await request(app).put('/api/stores/sto-1/detach-listing')
      .set('X-Store-Owner-Token', 'raw-owner-token').set('X-Owner-Token', 'listing-owner-token')
      .send({ listingId: 'lst-det' });
    expect(res.status).toBe(200);
    // storeId cleared...
    expect(h.listings[0].store_id).toBeNull();
    // ...the listing SURVIVES (not deleted)...
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0]._id).toBe('lst-det');
    // ...and the store's listing count decreased (1 after attach → 0 now).
    const countAfterDetach = await fakeListingModel.countDocuments({ store_id: store._id, status: 'active' });
    expect(countAfterDetach).toBe(0);
  });

  it('detach-listing → 403 when the listing belongs to someone else; listing untouched', async () => {
    await seedStore();
    h.listings.push(makeDoc({ _id: 'lst-det2', store_id: 'sto-1', ownerTokenHash: sha256hex('real-listing-owner'), expiresAt: new Date(Date.now() + 86400000), status: 'active' }));

    const res = await request(app).put('/api/stores/sto-1/detach-listing')
      .set('X-Store-Owner-Token', 'raw-owner-token').set('X-Owner-Token', 'attacker-token')
      .send({ listingId: 'lst-det2' });
    expect(res.status).toBe(403);
    // Nothing changed by the rejected attempt.
    expect(String(h.listings[0].store_id)).toBe('sto-1');
    expect(h.listings[0].ownerTokenHash).toBe(sha256hex('real-listing-owner'));
  });
});

// ─── Admin 2FA flow + moderation gate ───────────────────────────────────────
describe('Admin 2FA (real speakeasy) and moderation auth', () => {
  it('moderate endpoint: 403 without credentials, 200 with admin key (pre-2FA)', async () => {
    h.listings.push(makeDoc({ _id: 'lst-mod', moderationStatus: 'flagged' }));

    const denied = await request(app).put('/api/listings/lst-mod/moderate').send({ action: 'approved' });
    expect(denied.status).toBe(403);

    const ok = await request(app).put('/api/listings/lst-mod/moderate')
      .set('X-Admin-Key', TEST_ADMIN_KEY).send({ action: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body.listing.moderationStatus).toBe('approved');
  });

  it('setup → verify → login yields a session token; legacy key alone is rejected once 2FA is on', async () => {
    const setup = await request(app).post('/api/admin/setup-2fa').set('X-Admin-Key', TEST_ADMIN_KEY);
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toBeTruthy();

    const secret = setup.body.secret;
    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const verify = await request(app).post('/api/admin/verify-2fa').set('X-Admin-Key', TEST_ADMIN_KEY).send({ code });
    expect(verify.status).toBe(200);

    // Generate a FRESH code for login rather than reusing the verify code.
    // With a reused code this test fails whenever the 30s TOTP window rolls
    // between the two requests: the token then belongs to the previous window
    // and login's replay protection (verifyDelta, delta < 0) rejects it with 401.
    const loginCode = speakeasy.totp({ secret, encoding: 'base32' });
    const login = await request(app).post('/api/admin/login').set('X-Admin-Key', TEST_ADMIN_KEY).send({ code: loginCode });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    // Legacy key alone must NOT authorize now that 2FA is enabled...
    h.listings.push(makeDoc({ _id: 'lst-mod2', moderationStatus: 'flagged' }));
    const keyOnly = await request(app).put('/api/listings/lst-mod2/moderate').set('X-Admin-Key', TEST_ADMIN_KEY).send({ action: 'approved' });
    expect(keyOnly.status).toBe(401);

    // ...but the TOTP-minted session must.
    const session = await request(app).put('/api/listings/lst-mod2/moderate')
      .set('X-Admin-Session', login.body.token).send({ action: 'approved' });
    expect(session.status).toBe(200);
  });
});

// ─── Upload validation ──────────────────────────────────────────────────────
describe('POST /api/upload — magic-byte and processing validation', () => {
  it('400 when the bytes are not a real image (Content-Type lie rejected)', async () => {
    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', Buffer.from('this is not an image at all'), { filename: 'evil.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(cloudinaryUpload).not.toHaveBeenCalled();
  });

  it('400 when a real-format image fails sharp processing (Fix 7 — was 500)', async () => {
    // Synthetic PNG: valid signature + IHDR declaring 200000×200000 pixels
    // (above sharp's default pixel ceiling) and no more data. file-type
    // sniffs image/png from the header, then sharp throws while loading —
    // a genuine processing failure, not a format-detection rejection.
    const zlib = await import('node:zlib');
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(200000, 0); // width
    ihdr.writeUInt32BE(200000, 4); // height
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type RGB
    const chunk = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(chunk.subarray(4)) >>> 0, 0);
    const oversizedHeaderPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk, crc,
    ]);
    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', oversizedHeaderPng, { filename: 'bomb.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(cloudinaryUpload).not.toHaveBeenCalled();
  });

  it('rejects a file above the 5 MB limit with 4xx and never uploads (oversize)', async () => {
    // One byte over the multer limit (upload.js: fileSize: 5 * 1024 * 1024).
    // A valid PNG header keeps this a pure size rejection, not a format one.
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
    const oversized = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', oversized, { filename: 'big.png', contentType: 'image/png' });
    // Client error (400/413), not a 5xx — the file size is the caller's fault.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(cloudinaryUpload).not.toHaveBeenCalled();
  });

  it('200 happy path uploads and returns a URL', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', png, { filename: 'ok.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
  });

  it('rejects an image above the input pixel cap before decoding it (pixel bomb)', async () => {
    // 6000x5000 = 30 megapixels: a fully decodable PNG that clears sharp's
    // ~268 MP library default but exceeds the route's explicit 25 MP cap.
    // A solid-colour image of this size deflates well under the 5 MB multer
    // limit, so file size alone is no defence — the header declares the cost.
    const bomb = await sharp({ create: { width: 6000, height: 5000, channels: 3, background: 'blue' } }).png().toBuffer();
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);

    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', bomb, { filename: 'bomb.png', contentType: 'image/png' });

    // Rejected at 400 — a client fault, not a 5xx from an exhausted process.
    expect(res.status).toBe(400);
    expect(cloudinaryUpload).not.toHaveBeenCalled();
  });

  it('still accepts a legitimate under-cap photo after the pixel cap is applied', async () => {
    // 2000x1500 = 3 MP — comfortably below the cap, so a normal listing photo
    // must still pass end-to-end. Guards against over-tightening the ceiling.
    const photo = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: 'green' } }).png().toBuffer();

    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', photo, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
  });

  it('does not ask Cloudinary to resize again — the buffer is already within 1600px', async () => {
    // 2400x1800 = 4.3 MP, so sharp's resize must produce a 1600x1200 buffer.
    // Cloudinary therefore receives an already-capped image and the no-op
    // `transformation` would only cost a second resize pass per upload.
    const png = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: 'purple' } }).png().toBuffer();

    const res = await request(app).post('/api/upload')
      .set('Content-Type', 'multipart/form-data')
      .attach('image', png, { filename: 'wide.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);

    expect(cloudinaryUpload).toHaveBeenCalledTimes(1);
    const [dataURI, uploadOptions] = cloudinaryUpload.mock.calls[0];
    // No resize instruction is handed to Cloudinary at all.
    expect(uploadOptions).not.toHaveProperty('transformation');
    // The every-other-option contract is intact.
    expect(uploadOptions.folder).toBe('gikomart');
    expect(uploadOptions.resource_type).toBe('image');
    expect(uploadOptions.quality).toBe('auto');
    expect(uploadOptions.fetch_format).toBe('auto');
    expect(uploadOptions.allowed_formats).toEqual(['jpg', 'jpeg', 'png', 'webp', 'gif']);

    // The data URI handed over is the sharp output, i.e. already inside the box.
    const capped = await sharp(Buffer.from(dataURI.split(',')[1], 'base64')).metadata();
    expect(Math.max(capped.width, capped.height)).toBeLessThanOrEqual(1600);
  });

  it('bounds concurrent sharp decoding to 3 under 5 parallel uploads (Rule D)', async () => {
    const png = await sharp({ create: { width: 900, height: 900, channels: 3, background: 'blue' } }).png().toBuffer();

    sharpState.tracking = true;
    sharpState.concurrent = 0;
    sharpState.max = 0;
    sharpState.delayMs = 60;
    let responses;
    try {
      responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          request(app)
            .post('/api/upload')
            .set('Content-Type', 'multipart/form-data')
            .attach('image', png, { filename: `c${i}.png`, contentType: 'image/png' })
        )
      );
    } finally {
      sharpState.tracking = false;
      sharpState.delayMs = 0;
    }

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(sharpState.max).toBe(3);
  });

  it('answers 503 with the busy message once uploads exceed the queue (Rule D)', async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: 'red' } }).png().toBuffer();

    sharpState.tracking = true;
    sharpState.delayMs = 200;
    let responses;
    try {
      responses = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          request(app)
            .post('/api/upload')
            .set('Content-Type', 'multipart/form-data')
            .attach('image', png, { filename: `p${i}.png`, contentType: 'image/png' })
        )
      );
    } finally {
      sharpState.tracking = false;
      sharpState.delayMs = 0;
    }

    const busy = responses.filter((r) => r.status === 503);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(busy[0].body.success).toBe(false);
    expect(busy[0].body.error).toBe('Server busy — please try again in a moment');
    expect(busy[0].body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ─── Cleanup service unit (real service, fake Listing model via cache) ──────
describe('cleanupService.deleteExpiredListings', () => {
  it('deletes expired listings and destroys their Cloudinary images', async () => {
    const { deleteExpiredListings } = await import('../src/services/cleanupService.js');
    h.listings.push(makeDoc({ _id: 'lst-exp', expiresAt: new Date(Date.now() - 1000), images: ['https://res.cloudinary.com/demo/image/upload/v1/gikomart/old.webp'] }));
    h.listings.push(makeDoc({ _id: 'lst-live', expiresAt: new Date(Date.now() + 86400000), images: [] }));

    await deleteExpiredListings();

    const ids = h.listings.map(l => l._id);
    expect(ids).toContain('lst-live');
    expect(ids).not.toContain('lst-exp');
    expect(cloudinaryDestroy).toHaveBeenCalledWith('gikomart/old');
  });
});

// ─── Payment error UX (Task 2) ──────────────────────────────────────────────
// The IntaSend SDK rejects with a raw unparsed buffer/string on HTTP errors —
// no stable type/code field — so a payment-start failure cannot be classified.
// It must therefore surface as a FIXED, actionable 503 carrying only the
// request ID, never the raw SDK error text.
//
// The stub keeps the REAL pricing maps (the controller validates package/plan
// before calling the service) and only replaces the three initiate* calls.
// It is injected HERE — after the other fakes but before server.js is imported
// by the module-level beforeAll below — so paymentController's destructured
// require() bindings pick up the rejecting versions.
const { TERMS_VERSIONS } = require('../src/config/termsVersions');
const rawIntasendError = 'intasend-raw-error-xyz';
const rejectWithRawIntasendError = async () => { throw new Error(rawIntasendError); };
injectModule('../src/services/paymentService.js', {
  ...require('../src/services/paymentService.js'),
  initiateBoostPayment: rejectWithRawIntasendError,
  initiateListingPayment: rejectWithRawIntasendError,
  initiateStorePlanPayment: rejectWithRawIntasendError,
});

describe('Payment error UX (Task 2)', () => {
  const FIXED_ERROR = 'Payment could not be started — please try again in a moment';

  // Valid acceptance payloads — the controller validates terms acceptance
  // before it ever reaches the payment call.
  const listingAcceptance = {
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
  };
  const storeAcceptance = {
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    storeOwnerTermsVersion: TERMS_VERSIONS.STORE_OWNER_TERMS,
  };

  beforeEach(() => {
    // initiateBoost looks the listing up through the injected Listing model.
    h.listings.push(makeDoc({ _id: 'lst-plain', title: 'Regular item', boostType: null, featured: false }));
  });

  // The 503 body must be exactly the fixed message plus the request ID, with
  // no trace of the underlying SDK error.
  function expectFixedErrorBody(body) {
    expect(body).toEqual({ error: FIXED_ERROR, requestId: expect.any(String) });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain(rawIntasendError);
    expect(Object.keys(body)).toHaveLength(2);
  }

  it('initiate-listing 503 on IntaSend failure', async () => {
    const res = await request(app).post('/api/payments/initiate-listing').send({
      phoneNumber: '0700000000',
      package: 'quick',
      listingData: {
        title: 'Test Book',
        category: 'Books',
        condition: 'Good',
        price: 500,
        description: 'Used calc textbook',
        sellerName: 'Jane',
        sellerWhatsapp: '0711111111',
        location: 'Egerton',
        images: [],
      },
      acceptance: listingAcceptance,
    });

    expect(res.status).toBe(503);
    expectFixedErrorBody(res.body);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('initiate-store-plan 503 on IntaSend failure', async () => {
    const res = await request(app).post('/api/payments/initiate-store-plan').send({
      phoneNumber: '0700000000',
      storePlan: 'starter_weekly',
      storeData: {
        name: 'Shop1',
        category: 'Books',
        description: '',
        phone: '0700000000',
        whatsapp: '0711111111',
        email: '',
        location: 'Egerton',
      },
      acceptance: storeAcceptance,
    });

    expect(res.status).toBe(503);
    expectFixedErrorBody(res.body);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('initiate-boost 503 on IntaSend failure', async () => {
    const res = await request(app).post('/api/payments/boost').send({
      listingId: 'lst-plain',
      phoneNumber: '0700000000',
      boostType: 'featured',
    });

    expect(res.status).toBe(503);
    expectFixedErrorBody(res.body);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

// ─── Pricing config: standard_weekly removed (Fix 6) ────────────────────────
describe('STORE_PLANS — unsellable plan removed (Fix 6)', () => {
  it('standard_weekly no longer exists backend-side', async () => {
    const paymentService = await import('../src/services/paymentService.js');
    expect(paymentService.STORE_PLANS.standard_weekly).toBeUndefined();
  });
});

// ─── CSP: analytics origins ─────────────────────────────────────────────────
describe('CSP analytics origins', () => {
  function directive(header, name) {
    const found = header.split(';').map(d => d.trim()).find(d => d.startsWith(name + ' '));
    return found ? found.slice(name.length).trim().split(/\s+/) : [];
  }

  it('allows the GoatCounter image beacon host in img-src (sendBeacon fallback)', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();

    // The legacy <img> beacon used when navigator.sendBeacon is unavailable is
    // governed by img-src, not connect-src — so the host must appear there too.
    expect(directive(csp, 'img-src')).toContain('https://gikomart.goatcounter.com');

    // Primary path: the script itself, and the POST beacon it sends.
    expect(directive(csp, 'script-src')).toContain('gc.zgo.at');
    expect(directive(csp, 'connect-src')).toContain('https://gikomart.goatcounter.com');
  });
});
