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
  blocks: [],
  reports: [],
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
      if (v.$gte !== undefined && !(doc[k] && new Date(doc[k]) >= new Date(v.$gte))) return false;
      if (v.$regex !== undefined && !new RegExp(v.$regex, v.$options || '').test(String(doc[k] ?? ''))) return false;
    } else if (String(doc[k] ?? '') !== String(v ?? '')) {
      return false;
    }
  }
  return true;
}

// Bounded matcher for the Store findOne `_id` key: plain equality, $ne, $nin,
// $in. For $ne/$nin a MISSING stored id passes, mirroring MongoDB.
function matchesStoreId(storedId, expected) {
  if (expected === undefined) return true;
  if (expected !== null && typeof expected === 'object') {
    if (expected.$ne !== undefined && String(storedId) === String(expected.$ne)) return false;
    if (expected.$nin !== undefined && expected.$nin.some((v) => String(v) === String(storedId))) return false;
    if (expected.$in !== undefined && !expected.$in.some((v) => String(v) === String(storedId))) return false;
    return true;
  }
  return String(storedId) === String(expected);
}

// Bounded matcher for the Store moderationStatus filter. The public store route
// uses plain equality or $nin; $in/$ne are supported for parity. For $nin and
// $ne a MISSING field passes, mirroring MongoDB.
function matchesModFilter(doc, expected) {
  if (expected === undefined) return true;
  if (expected !== null && typeof expected === 'object') {
    if (expected.$nin !== undefined && expected.$nin.includes(doc.moderationStatus)) return false;
    if (expected.$in !== undefined && !expected.$in.includes(doc.moderationStatus)) return false;
    if (expected.$ne !== undefined && doc.moderationStatus === expected.$ne) return false;
    return true;
  }
  return doc.moderationStatus === expected;
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
    // Emulate the unique sparse index on paymentId (Item 4): a second create for
    // the same payment collides, exactly as MongoDB reports it.
    if (data && data.paymentId != null && h.listings.some(l => String(l.paymentId) === String(data.paymentId))) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { paymentId: 1 };
      throw dup;
    }
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, views: 0, status: 'active', store_id: null, broadcastSent: false, priorityBroadcast: false, featured: false, boostType: null, featuredUntil: null, moderationStatus: 'approved', ...data });
    h.listings.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    if (filter.paymentId != null) {
      return h.listings.find(l => String(l.paymentId) === String(filter.paymentId)) || null;
    }
    // Visibility-filter lookup (no paymentId): match the seeded listing by _id,
    // then apply every remaining key. Supports plain equality plus $in / $nin /
    // $ne only — the real visibility filter uses plain equality for all keys.
    if (filter._id !== undefined) {
      const doc = h.listings.find(l => String(l._id) === String(filter._id));
      if (!doc) return null;
      for (const [key, expected] of Object.entries(filter)) {
        if (key === '_id') continue;
        const actual = doc[key];
        if (expected !== null && typeof expected === 'object') {
          if (expected.$in !== undefined && !expected.$in.includes(actual)) return null;
          if (expected.$nin !== undefined && expected.$nin.includes(actual)) return null;
          if (expected.$ne !== undefined && actual === expected.$ne) return null;
        } else if (actual !== expected) {
          return null;
        }
      }
      return doc;
    }
    return null;
  },
  findById: (id) => selectableDoc(h.listings.find(l => String(l._id) === String(id)) || null),
  findOneAndUpdate: (filter, update) => {
    const doc = h.listings.find((l) => matchesFilter(l, filter)) || null;
    if (doc && update && update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
    } else if (doc && update) {
      Object.assign(doc, update);
    }
    // Thenable with .select() so the controller's findOneAndUpdate(...).select()
    // chain works exactly as it does against a real Mongoose query.
    return selectableDoc(doc);
  },
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
    // Emulate the unique sparse index on paymentId (Item 4).
    if (data && data.paymentId != null && [...h.stores.values()].some(s => String(s.paymentId) === String(data.paymentId))) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { paymentId: 1 };
      throw dup;
    }
    const doc = makeDoc({ _id: `sto-${h.stores.size + 1}`, status: 'active', subcategories: [], ...data });
    h.stores.set(String(doc._id), doc);
    return doc;
  },
  // .select('+ownerTokenHash') → same doc incl. hash (fakes don't project)
  findById: (id) => selectableDoc(h.stores.get(String(id)) || null),
  findOne: (filter = {}) => {
    // Emulates select:false on ownerTokenHash: the hash is present only when the
    // caller opts in with .select('+ownerTokenHash'). Returns a thenable so both
    // `await Store.findOne(...)` and `Store.findOne(...).select('+ownerTokenHash')`
    // work as they do against a real Mongoose query.
    let includeHash = false;
    const compute = () => {
      if (filter.paymentId != null) {
        for (const s of h.stores.values()) {
          if (String(s.paymentId) === String(filter.paymentId)) {
            const view = { ...s }; if (!includeHash) delete view.ownerTokenHash; return view;
          }
        }
        return null;
      }
      for (const s of h.stores.values()) {
        const idOk = matchesStoreId(s._id, filter._id);
        const slugOk = filter.slug === undefined || s.slug === filter.slug;
        const statusOk = !(filter.status && filter.status.$ne) || s.status !== filter.status.$ne;
        const modOk = matchesModFilter(s, filter.moderationStatus);
        if (idOk && slugOk && statusOk && modOk) { const view = { ...s }; if (!includeHash) delete view.ownerTokenHash; return view; }
      }
      return null;
    };
    const thenable = {
      select: (proj) => { if (String(proj).includes('+ownerTokenHash')) includeHash = true; return thenable; },
      then: (res, rej) => Promise.resolve(compute()).then(res, rej),
      catch: (rej) => Promise.resolve(compute()).catch(rej),
    };
    return thenable;
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
  countDocuments: async () => 0,
};

// ── Payment fake (findOneAndUpdate emulates the webhook's atomic claim) ──
const fakePaymentModel = {
  create: async (data) => {
    const doc = makeDoc({ _id: `pay-${h.payments.length + 1}`, status: 'pending', ...data });
    h.payments.push(doc);
    return doc;
  },
  findOne: async (filter) => makeDoc(h.payments.find(p => p.invoiceId === filter.invoiceId) || null),
  findById: async (id) => makeDoc(h.payments.find(p => String(p._id) === String(id)) || null),
  // Supports GET /api/admin/payments: find(filter).sort({createdAt:-1}).limit(n).lean()
  find: (filter = {}) => {
    const state = { filter };
    const builder = {
      sort: (s) => { state.sort = s; return builder; },
      limit: (n) => { state.limit = n; return builder; },
      lean: async () => {
        let out = h.payments.filter(p => matchesFilter(p, filter));
        if (state.sort && state.sort.createdAt === -1) {
          out = [...out].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        }
        if (state.limit) out = out.slice(0, state.limit);
        return out.map(p => ({ ...p }));
      },
      then: (res, rej) => Promise.resolve(builder.lean()).then(res, rej),
      catch: (rej) => Promise.resolve(builder.lean()).catch(rej),
    };
    return builder;
  },
  findOneAndUpdate: async (filter, update) => {
    const p = h.payments.find(x => x.invoiceId === filter.invoiceId && x.status !== 'completed');
    if (!p) return null;
    Object.assign(p, update);
    return p;
  },
  countDocuments: async () => 0,
  aggregate: async () => [],
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

// Audit events are fire-and-forget side effects of privileged/payment actions.
// The app under test writes them through the DISCONNECTED real model unless a
// fake is injected, which would leave buffering promises pending for the whole
// suite. Record them instead.
const auditEvents = [];
const fakeAuditEvent = {
  create: vi.fn(async (data) => { auditEvents.push(data); return data; }),
  // Supports the admin audit-log endpoint: find(filter).sort({timestamp:-1}).limit(n).lean()
  find: (filter = {}) => {
    const state = { filter };
    const builder = {
      sort: (s) => { state.sort = s; return builder; },
      limit: (n) => { state.limit = n; return builder; },
      lean: async () => {
        let out = auditEvents.filter(e => matchesFilter(e, filter));
        if (state.sort && state.sort.timestamp === -1) {
          out = [...out].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
        }
        if (state.limit) out = out.slice(0, state.limit);
        return out.map(e => ({ ...e }));
      },
      then: (res, rej) => Promise.resolve(builder.lean()).then(res, rej),
      catch: (rej) => Promise.resolve(builder.lean()).catch(rej),
    };
    return builder;
  },
};

// ── Blocked contacts (Phase 5A) — create / findOne / find / findByIdAndDelete ──
const fakeBlockedContactModel = {
  create: async (data) => {
    if (h.blocks.some((b) => b.contactHash === data.contactHash)) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { contactHash: 1 };
      throw dup;
    }
    const doc = makeDoc({ _id: `6500000000000000000000${String(h.blocks.length + 1).padStart(2, '0')}`, sourceId: null, ...data });
    h.blocks.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    if (filter.contactHash === undefined) return null;
    const expected = filter.contactHash;
    const match = h.blocks.find((b) => {
      if (expected !== null && typeof expected === 'object') {
        if (expected.$in !== undefined) return expected.$in.includes(b.contactHash);
        return false;
      }
      return b.contactHash === expected;
    });
    return match ? { ...match } : null;
  },
  find: (filter = {}) => {
    const state = { filter };
    const builder = {
      sort: (s) => { state.sort = s; return builder; },
      limit: (n) => { state.limit = n; return builder; },
      lean: async () => {
        let out = h.blocks.filter((b) => matchesFilter(b, filter));
        if (state.sort && state.sort.createdAt === -1) {
          out = [...out].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        }
        if (state.limit) out = out.slice(0, state.limit);
        return out.map((b) => ({ ...b }));
      },
      then: (res, rej) => Promise.resolve(builder.lean()).then(res, rej),
      catch: (rej) => Promise.resolve(builder.lean()).catch(rej),
    };
    return builder;
  },
  findByIdAndDelete: async (id) => {
    const i = h.blocks.findIndex((b) => String(b._id) === String(id));
    if (i === -1) return null;
    return h.blocks.splice(i, 1)[0];
  },
  countDocuments: async () => 0,
};

// ── Reports (Phase 5B) — create / findOne / find / findById / findByIdAndUpdate ──
// Matches on plain equality plus $gte/$lte on createdAt (the 24h dedupe window).
const fakeReportModel = {
  create: async (data) => {
    const doc = makeDoc({
      _id: `6500000000000000000000${String(h.reports.length + 1).padStart(2, '0')}`,
      details: '',
      reporterIp: null,
      status: 'open',
      moderationAction: null,
      resolvedAt: null,
      resolvedBy: null,
      note: '',
      createdAt: new Date(),
      ...data,
    });
    h.reports.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    const match = h.reports.find((r) => matchesFilter(r, filter));
    return match ? { ...match } : null;
  },
  find: (filter = {}) => {
    const state = { filter };
    const builder = {
      sort: (s) => { state.sort = s; return builder; },
      limit: (n) => { state.limit = n; return builder; },
      lean: async () => {
        let out = h.reports.filter((r) => matchesFilter(r, filter));
        if (state.sort && state.sort.createdAt === -1) {
          out = [...out].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        }
        if (state.limit) out = out.slice(0, state.limit);
        return out.map((r) => ({ ...r }));
      },
      then: (res, rej) => Promise.resolve(builder.lean()).then(res, rej),
      catch: (rej) => Promise.resolve(builder.lean()).catch(rej),
    };
    return builder;
  },
  findById: (id) => selectableDoc(h.reports.find((r) => String(r._id) === String(id)) || null),
  findByIdAndUpdate: async (id, update) => {
    const doc = h.reports.find((r) => String(r._id) === String(id));
    if (!doc) return null;
    Object.assign(doc, update);
    return doc;
  },
  countDocuments: async () => 0,
};

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
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/models/BlockedContact.js', fakeBlockedContactModel);
injectModule('../src/models/Report.js', fakeReportModel);

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

// This integration suite issues well over 100 requests per run and reuses the
// payment/upload buckets across many endpoints, so the low production windows
// (global 100/min, payment 5/min, listing-create 5/min, upload 10/min) would
// mask unrelated assertions behind 429s. None of these limiter behaviors is
// asserted here, so they pass straight through — every limiter implementation
// and every other limiter (contact, admin) keeps its real configuration.
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

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

beforeEach(() => {
  h.payments.length = 0;
  h.stores.clear();
  h.listings.length = 0;
  h.admins.clear();
  h.blocks.length = 0;
  h.reports.length = 0;
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
    expect(res.status).toBe(404);
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
    amount: 50,
    expectedAmount: 50,
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

// ─── Webhook: server-side amount validation ─────────────────────────────────
describe('Webhook amount validation', () => {
  it('rejects a COMPLETE whose stored amount does not match the price table (400) and creates nothing', async () => {
    h.payments.push(makeDoc(listingPayment({ amount: 999, invoiceId: 'INV-AMT-1' })));
    const res = await webhook({ invoice_id: 'INV-AMT-1', state: 'COMPLETE' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Payment amount validation failed' });
    expect(h.listings).toHaveLength(0);
    // The mismatch is computed from the amount captured at initiation, which is
    // stored on the Payment document.
    expect(h.payments[0].expectedAmount).toBe(50);

    await new Promise((r) => setImmediate(r));
    const ev = auditEvents.find(e => e.action === 'payment.amount_mismatch');
    expect(ev).toBeTruthy();
    expect(ev.result).toBe('failure');
    expect(ev.resource).toBe('payment');
  });

  it('accepts a legacy payment with no expectedAmount by falling back to the live price table', async () => {
    // Payment document created before expectedAmount existed: the field is
    // absent, so validation must fall back to the current price table rather
    // than rejecting the amount as !== undefined.
    h.payments.push(makeDoc(listingPayment({ expectedAmount: undefined, invoiceId: 'INV-LEGACY' })));
    const res = await webhook({ invoice_id: 'INV-LEGACY', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
  });

  it('accepts a COMPLETE whose amount matches the initiation-time price even if the live table has changed', async () => {
    // Initiated when a 'standard' listing cost 30; the live table now says 50.
    // Validation uses expectedAmount, so the genuinely paid record still succeeds.
    h.payments.push(makeDoc(listingPayment({ amount: 30, expectedAmount: 30, invoiceId: 'INV-OLD-PRICE' })));
    const res = await webhook({ invoice_id: 'INV-OLD-PRICE', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
  });

  it('accepts a COMPLETE whose stored amount matches the price table (200)', async () => {
    h.payments.push(makeDoc(listingPayment({ amount: 50, invoiceId: 'INV-AMT-2' })));
    const res = await webhook({ invoice_id: 'INV-AMT-2', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
  });
});

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

  it('fails closed with 401 when INTASEND_WEBHOOK_CHALLENGE is unset (no forged completion)', async () => {
    const saved = process.env.INTASEND_WEBHOOK_CHALLENGE;
    delete process.env.INTASEND_WEBHOOK_CHALLENGE;
    try {
      // The exact forgery the old `undefined !== undefined` check accepted: a
      // body with no `challenge` field at all.
      h.payments.push(makeDoc(listingPayment()));
      const res = await request(app).post('/api/payments/webhook').send({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
      expect(res.status).toBe(401);
      expect(h.payments[0].status).toBe('pending');
      expect(h.listings).toHaveLength(0);
      expect(h.stores.size).toBe(0);
    } finally {
      process.env.INTASEND_WEBHOOK_CHALLENGE = saved;
    }
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
    h.payments.push(makeDoc({ type: 'boost', status: 'pending', amount: 50, expectedAmount: 50, invoiceId: 'INV-BOOST-1', listingId: 'lst-boost-1', boostType: 'featured' }));

    const res = await webhook({ invoice_id: 'INV-BOOST-1', state: 'COMPLETE' });
    expect(res.status).toBe(200);
    expect(h.listings[0].featured).toBe(true);
    expect(h.listings[0].boostType).toBe('standard');
    expect(h.listings[0].featuredUntil).toBeTruthy();
  });

  it('priority_broadcast boost marks priorityBroadcast AND re-broadcasts the listing (Fix 1)', async () => {
    h.listings.push(makeDoc({ _id: 'lst-boost-2', priorityBroadcast: false }));
    h.payments.push(makeDoc({ type: 'boost', status: 'pending', amount: 30, expectedAmount: 30, invoiceId: 'INV-BOOST-2', listingId: 'lst-boost-2', boostType: 'priority_broadcast' }));

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
      type: 'store', status: 'pending', amount: 150, expectedAmount: 150, invoiceId: 'INV-STORE-1', storePlan: 'starter_weekly',
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

// ─── Input validation: condition allowlist + media URL scheme ───────────────
// ─── Contact privacy on public read routes ──────────────────────────────
describe('Contact privacy on public read routes', () => {
  const OWNER_TOKEN = 'raw-owner-token';

  function seedListingWithContact() {
    h.listings.push(makeDoc({
      _id: 'lst-pii', title: 'Widget', status: 'active', moderationStatus: 'approved',
      sellerWhatsapp: '0712345678', ownerTokenHash: sha256hex(OWNER_TOKEN),
    }));
  }
  function seedStoreWithContact() {
    return fakeStoreModel.create({
      name: 'PII Shop', slug: 'pii-shop', category: 'Books',
      phone: '0700000000', whatsapp: '0711111111', email: 'shop@example.com',
      ownerTokenHash: sha256hex(OWNER_TOKEN),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    });
  }

  it('GET /api/listings/:id without an owner token hides sellerWhatsapp', async () => {
    seedListingWithContact();
    const res = await request(app).get('/api/listings/lst-pii');
    expect(res.status).toBe(200);
    expect(res.body.listing.title).toBe('Widget');
    expect(res.body.listing.sellerWhatsapp).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('0712345678');
  });

  it('GET /api/listings/:id with a valid owner token returns sellerWhatsapp', async () => {
    seedListingWithContact();
    const res = await request(app).get('/api/listings/lst-pii').set('X-Owner-Token', OWNER_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.listing.sellerWhatsapp).toBe('0712345678');
  });

  it('GET /api/stores/slug/:slug without an owner token hides phone/whatsapp/email', async () => {
    await seedStoreWithContact();
    const res = await request(app).get('/api/stores/slug/pii-shop');
    expect(res.status).toBe(200);
    expect(res.body.store.slug).toBe('pii-shop');
    expect(res.body.store.phone).toBeUndefined();
    expect(res.body.store.whatsapp).toBeUndefined();
    expect(res.body.store.email).toBeUndefined();
  });

  it('GET /api/stores/slug/:slug with a valid owner token returns phone/whatsapp/email', async () => {
    await seedStoreWithContact();
    const res = await request(app).get('/api/stores/slug/pii-shop').set('X-Store-Owner-Token', OWNER_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.store.phone).toBe('0700000000');
    expect(res.body.store.whatsapp).toBe('0711111111');
    expect(res.body.store.email).toBe('shop@example.com');
  });
});

// ─── Ownership failures are normalized ──────────────────────────────
describe('Ownership failures are normalized', () => {
  it('PUT /api/listings/:id with an invalid owner token → 403 Not authorized', async () => {
    h.listings.push(makeDoc({
      _id: 'lst-403', status: 'active', moderationStatus: 'approved', ownerTokenHash: sha256hex('real-owner'),
    }));
    const res = await request(app).put('/api/listings/lst-403').set('X-Owner-Token', 'wrong-token').send({ title: 'x' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Not authorized' });
  });

  it('DELETE /api/stores/:id with an invalid owner token → 403 Not authorized', async () => {
    await fakeStoreModel.create({
      name: 'Norm Shop', slug: 'norm-shop', category: 'Books',
      ownerTokenHash: sha256hex('real-owner'),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    });
    const res = await request(app).delete('/api/stores/sto-1').set('X-Store-Owner-Token', 'wrong-token');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Not authorized' });
  });
});

describe('Owner update validation — condition allowlist and media URL schemes', () => {
  const OWNER_TOKEN = 'raw-owner-token';
  function seedOwnedListing() {
    h.listings.push(makeDoc({
      _id: 'lst-val', title: 'Widget', condition: 'Good', images: [],
      ownerTokenHash: sha256hex(OWNER_TOKEN), status: 'active', moderationStatus: 'approved',
    }));
  }
  function seedOwnedStore() {
    return fakeStoreModel.create({
      name: 'Val Shop', slug: 'val-shop', category: 'Books',
      ownerTokenHash: sha256hex(OWNER_TOKEN),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    });
  }

  it('PUT /listings/:id rejects a condition outside the allowlist (400) and does not mutate', async () => {
    seedOwnedListing();
    const res = await request(app).put('/api/listings/lst-val')
      .set('X-Owner-Token', OWNER_TOKEN)
      .send({ condition: '<img src=x onerror=alert(1)>' });
    expect(res.status).toBe(400);
    expect(h.listings[0].condition).toBe('Good');
  });

  it('PUT /listings/:id rejects a non-http(s) image URL (400)', async () => {
    seedOwnedListing();
    const res = await request(app).put('/api/listings/lst-val')
      .set('X-Owner-Token', OWNER_TOKEN)
      .send({ images: ['javascript:alert(1)'] });
    expect(res.status).toBe(400);
    expect(h.listings[0].images).toEqual([]);
  });

  it('PUT /listings/:id still accepts a legitimate condition and https images (200)', async () => {
    seedOwnedListing();
    const res = await request(app).put('/api/listings/lst-val')
      .set('X-Owner-Token', OWNER_TOKEN)
      .send({ condition: 'Like New', images: ['https://res.cloudinary.com/demo/image/upload/v1/gikomart/a.jpg'] });
    expect(res.status).toBe(200);
    expect(res.body.listing.condition).toBe('Like New');
    expect(h.listings[0].images[0]).toMatch(/^https:\/\//);
  });

  it('PUT /stores/:id rejects a dangerous logo_url scheme (400) and does not mutate', async () => {
    const store = await seedOwnedStore();
    const res = await request(app).put(`/api/stores/${store._id}`)
      .set('X-Store-Owner-Token', OWNER_TOKEN)
      .send({ logo_url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(h.stores.get(String(store._id)).logo_url).toBeUndefined();
  });

  it('PUT /stores/:id still accepts a legitimate https cover_url (200)', async () => {
    const store = await seedOwnedStore();
    const res = await request(app).put(`/api/stores/${store._id}`)
      .set('X-Store-Owner-Token', OWNER_TOKEN)
      .send({ cover_url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/c.jpg' });
    expect(res.status).toBe(200);
    expect(res.body.store.cover_url).toMatch(/^https:\/\//);
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

// ─── Admin health route ─────────────────────────────────────────────────────
describe('Admin health route', () => {
  it('GET /api/admin/health without a session → 401 Admin 2FA required', async () => {
    const res = await request(app).get('/api/admin/health');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Admin 2FA required' });
  });
});

// ─── Admin metrics route ────────────────────────────────────────────────────
describe('Admin metrics route', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });

  it('GET /api/admin/metrics without a session → 401 Admin 2FA required', async () => {
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: 'Admin 2FA required' });
  });

  it('GET /api/admin/metrics with a session → 200 with the metric groups', async () => {
    const res = await request(app).get('/api/admin/metrics').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const key of ['generatedAt', 'listings', 'stores', 'payments', 'revenue', 'reports', 'blocks']) {
      expect(res.body).toHaveProperty(key);
    }
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
  it('skips hard-delete when the listing payment has not settled', async () => {
    const { deleteExpiredListings } = await import('../src/services/cleanupService.js');
    h.payments.push(makeDoc({ _id: 'pay-stuck', invoiceId: 'INV-STUCK', status: 'pending' }));
    h.payments.push(makeDoc({ _id: 'pay-done', invoiceId: 'INV-DONE', status: 'completed' }));
    // Both are expired; one points at an unsettled payment, one at a settled one.
    h.listings.push(makeDoc({ _id: 'lst-stuck', expiresAt: new Date(Date.now() - 1000), images: [], paymentId: 'pay-stuck' }));
    h.listings.push(makeDoc({ _id: 'lst-settled', expiresAt: new Date(Date.now() - 1000), images: [], paymentId: 'pay-done' }));

    await deleteExpiredListings();

    const ids = h.listings.map(l => l._id);
    expect(ids).toContain('lst-stuck');        // unsettled payment → kept
    expect(ids).not.toContain('lst-settled');  // settled payment → deleted
  });

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
  const FIXED_ERROR = 'Payment could not be started — check your M-Pesa balance and phone number, then try again.';

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
    h.listings.push(makeDoc({ _id: 'lst-plain', title: 'Regular item', boostType: null, featured: false, ownerTokenHash: sha256hex('boost-owner-token') }));
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
    const res = await request(app).post('/api/payments/boost')
      .set('X-Owner-Token', 'boost-owner-token')
      .send({
        listingId: 'lst-plain',
        phoneNumber: '0700000000',
        boostType: 'featured',
      });

    expect(res.status).toBe(503);
    expectFixedErrorBody(res.body);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

// ─── Phase 2, Step 3: owner-only boost ──────────────────────────────────────
describe('Payment boost — owner-only', () => {
  const BOOST_OWNER_TOKEN = 'boost-owner-token';
  const boostBody = (overrides = {}) => ({
    listingId: 'lst-owned',
    phoneNumber: '0700000000',
    boostType: 'featured',
    ...overrides,
  });

  beforeEach(() => {
    h.listings.push(makeDoc({
      _id: 'lst-owned', title: 'Owned item', boostType: null, featured: false,
      ownerTokenHash: sha256hex(BOOST_OWNER_TOKEN),
    }));
  });

  it('403 without an X-Owner-Token', async () => {
    const res = await request(app).post('/api/payments/boost').send(boostBody());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Not authorized' });
  });

  it('403 with a wrong X-Owner-Token', async () => {
    const res = await request(app).post('/api/payments/boost')
      .set('X-Owner-Token', 'wrong-token')
      .send(boostBody());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Not authorized' });
  });

  it('reaches the provider (503 shape) with the correct X-Owner-Token', async () => {
    const res = await request(app).post('/api/payments/boost')
      .set('X-Owner-Token', BOOST_OWNER_TOKEN)
      .send(boostBody());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Payment could not be started — check your M-Pesa balance and phone number, then try again.',
      requestId: expect.any(String),
    });
  });

  it('404 for a nonexistent listing even with a token', async () => {
    const res = await request(app).post('/api/payments/boost')
      .set('X-Owner-Token', BOOST_OWNER_TOKEN)
      .send(boostBody({ listingId: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('unit: isOwnerOrAdmin is true for a matching token hash and false for a mismatch', async () => {
    const { isOwnerOrAdmin } = require('../src/middleware/listingAuth');
    const listing = { ownerTokenHash: sha256hex('raw-token') };
    const fakeReq = (token) => ({ get: (h) => (h === 'X-Owner-Token' ? token : undefined), headers: {} });

    const ok = await isOwnerOrAdmin(fakeReq('raw-token'), listing);
    expect(ok.authorized).toBe(true);
    expect(ok.credential).toBe('owner');

    const bad = await isOwnerOrAdmin(fakeReq('not-the-token'), listing);
    expect(bad.authorized).toBe(false);
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
// ─── Item 2: logger meta redaction ───────────────────────────────────────────
// The app under test uses the injected bare mock logger (fakeLogger, above), so
// the real transport pipeline never runs for the routes exercised in this file.
// For this test we load the REAL logger module directly, spy on its real File
// transport, then restore the injected mock so the app keeps using the fake.
// That proves redaction on the real format + real transport, not on a mock.
describe('Logger meta redaction (Item 2)', () => {
  it('redacts sensitive meta before the real transport receives it', async () => {
    const loggerPath = require.resolve('../src/config/logger.js');
    const injectedLogger = require.cache[loggerPath];
    delete require.cache[loggerPath];
    const realLogger = require('../src/config/logger.js');
    require.cache[loggerPath] = injectedLogger;

    const fileTransport = realLogger.transports.find((t) => t.name === 'file');
    expect(fileTransport).toBeTruthy();

    const spy = vi.spyOn(fileTransport, 'log');
    const rawToken = 'raw-secret-token-abc';
    const rawPhone = '0712345678';

    realLogger.error('redaction-integration', {
      token: rawToken,
      phoneNumber: rawPhone,
      nested: { email: 'user@example.com' },
      safe: 'visible',
    });
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalled();
    const info = spy.mock.calls[spy.mock.calls.length - 1][0];
    expect(info.token).toBe('[REDACTED]');
    expect(info.phoneNumber).toBe('[REDACTED]');
    expect(info.nested.email).toBe('[REDACTED]');
    expect(info.safe).toBe('visible');
    expect(JSON.stringify(info)).not.toContain(rawToken);
    expect(JSON.stringify(info)).not.toContain(rawPhone);
    spy.mockRestore();
  });
});

// ─── Item 4: side-effect idempotency via paymentId ──────────────────────────
describe('Webhook idempotency — side effect via paymentId (Item 4)', () => {
  function storePaymentHere(overrides = {}) {
    return {
      type: 'store',
      status: 'pending',
      storePlan: 'standard_monthly',
      amount: 200,
      expectedAmount: 200,
      invoiceId: 'INV-STORE-1',
      ownerTokenHash: 'b'.repeat(64),
      storeData: {
        name: 'Campus Store',
        slug: 'campus-store',
        category: 'Food',
        phone: '0700000000',
        whatsapp: '0700000000',
      },
      ...overrides,
    };
  }

  it('T1: one COMPLETE delivery creates one listing carrying the payment id', async () => {
    h.payments.push(makeDoc(listingPayment({ _id: 'pay-1' })));
    const res = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });

    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].paymentId).toBeTruthy();
    expect(String(h.listings[0].paymentId)).toBe(String(h.payments[0]._id));
  });

  it('T2: duplicate delivery short-circuits and creates no second listing', async () => {
    h.payments.push(makeDoc(listingPayment()));
    await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
    const res2 = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });

    expect(res2.status).toBe(200);
    expect(res2.body.message).toBe('Payment already processed');
    expect(h.listings).toHaveLength(1);
  });

  it('T3 (listing): bypassing the claim still yields exactly one listing', async () => {
    const payment = makeDoc(listingPayment({ _id: 'pay-1' }));
    h.payments.push(payment);
    // Force BOTH deliveries past the atomic claim and into the creation branch.
    const spy = vi.spyOn(fakePaymentModel, 'findOneAndUpdate').mockResolvedValue(payment);
    try {
      await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
      await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
    } finally {
      spy.mockRestore();
    }

    expect(h.listings).toHaveLength(1);
  });

  it('T3 (store): bypassing the claim still yields exactly one store', async () => {
    const payment = makeDoc(storePaymentHere({ _id: 'pay-2' }));
    h.payments.push(payment);
    const spy = vi.spyOn(fakePaymentModel, 'findOneAndUpdate').mockResolvedValue(payment);
    try {
      await webhook({ invoice_id: 'INV-STORE-1', state: 'COMPLETE' });
      await webhook({ invoice_id: 'INV-STORE-1', state: 'COMPLETE' });
    } finally {
      spy.mockRestore();
    }

    expect(h.stores.size).toBe(1);
  });

  it('T4 (regression): an unrelated duplicate key (slug) fails loudly instead of being treated as a payment replay', async () => {
    const payment = makeDoc(storePaymentHere({ _id: 'pay-3' }));
    h.payments.push(payment);
    const claimSpy = vi.spyOn(fakePaymentModel, 'findOneAndUpdate').mockResolvedValue(payment);
    // Store.create raises a NON-paymentId duplicate (slug unique index), as when
    // a slug collides with a different payment's store. Before the fix this was
    // swallowed as "an idempotent replay"; findOne({ paymentId })
    // then returned null and the code crashed on store._id.
    const origCreate = fakeStoreModel.create;
    fakeStoreModel.create = async () => {
      const dup = new Error('E11000 duplicate key error collection: stores index: slug_1');
      dup.code = 11000;
      dup.keyPattern = { slug: 1 };
      throw dup;
    };
    try {
      const res = await webhook({ invoice_id: 'INV-STORE-1', state: 'COMPLETE' });
      // Surfaced as a server error (retryable) — never misread as idempotent.
      expect(res.status).toBe(500);
      expect(h.stores.size).toBe(0);
    } finally {
      fakeStoreModel.create = origCreate;
      claimSpy.mockRestore();
    }
  });
});

// ─── Admin payment replay (recreates what a lost webhook should have made) ──
describe('POST /api/admin/payments/:ref/replay', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });

  it('returns already_processed and creates nothing for a completed payment whose listing exists', async () => {
    h.payments.push(makeDoc(listingPayment({ _id: 'pay-replay', invoiceId: 'INV-REPLAY', status: 'completed' })));
    h.listings.push(makeDoc({ _id: 'lst-existing', paymentId: 'pay-replay', status: 'active', moderationStatus: 'approved' }));

    const res = await request(app)
      .post('/api/admin/payments/INV-REPLAY/replay')
      .set('X-Admin-Session', session());

    expect(res.status).toBe(200);
    expect(res.body.already_processed).toBe(true);
    expect(String(res.body.paymentId)).toBe('pay-replay');
    expect(res.body.resource).toEqual({ type: 'listing', id: 'lst-existing' });
    expect(h.listings).toHaveLength(1); // nothing created
  });

  it('recreates the listing for a stuck pending payment and returns the new resource', async () => {
    const stored = makeDoc(listingPayment({ _id: 'pay-stuck', invoiceId: 'INV-STUCK-REPLAY', status: 'pending' }));
    h.payments.push(stored);
    // The shared fake's findOne returns a COPY, so field mutations would not be
    // observable. Real Mongoose findOne returns the live document; return the
    // stored object here so the pending→completed transition is assertable.
    const spy = vi.spyOn(fakePaymentModel, 'findOne')
      .mockImplementation(async (filter) => h.payments.find(p => p.invoiceId === filter.invoiceId) || null);

    try {
      const res = await request(app)
        .post('/api/admin/payments/INV-STUCK-REPLAY/replay')
        .set('X-Admin-Session', session());

      expect(res.status).toBe(200);
      expect(res.body.resource.type).toBe('listing');
      expect(res.body.resource.id).toBeTruthy();
      expect(h.listings).toHaveLength(1);
      expect(h.listings[0].paymentId).toBe('pay-stuck');
      expect(stored.status).toBe('completed');
      expect(stored.listingId).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a replay whose stored amount does not match the price table (400) and creates nothing', async () => {
    h.payments.push(makeDoc(listingPayment({ _id: 'pay-amt', invoiceId: 'INV-AMT-REPLAY', status: 'pending', amount: 999 })));

    const res = await request(app)
      .post('/api/admin/payments/INV-AMT-REPLAY/replay')
      .set('X-Admin-Session', session());

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Payment amount validation failed' });
    expect(h.listings).toHaveLength(0);
    // The mismatched payment must not be advanced to completed.
    expect(h.payments[0].status).toBe('pending');
  });

  it('rejects a request with no admin session and creates nothing (401)', async () => {
    h.payments.push(makeDoc(listingPayment({ _id: 'pay-nosess', invoiceId: 'INV-NOSESS', status: 'pending' })));

    const res = await request(app).post('/api/admin/payments/INV-NOSESS/replay');

    expect([401, 403]).toContain(res.status);
    expect(h.listings).toHaveLength(0);
    expect(h.payments[0].status).toBe('pending');
  });
});

// ─── Admin store moderation / suspension (Priority 2, Domain 2) ─────────────
describe('Admin store moderation and suspension', () => {
  const OWNER = 'raw-owner-token';
  function seedStore(overrides = {}) {
    return fakeStoreModel.create({
      name: 'Mod Shop', slug: 'mod-shop', category: 'Books',
      ownerTokenHash: sha256hex(OWNER),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
      moderationStatus: 'approved',
      ...overrides,
    });
  }

  beforeEach(() => { auditEvents.length = 0; });

  it('PUT /api/admin/stores/:id/moderate removed → suspends the store, audits, hides the hash', async () => {
    await seedStore();
    const res = await request(app).put('/api/admin/stores/sto-1/moderate')
      .set('X-Admin-Key', TEST_ADMIN_KEY).send({ action: 'removed' });
    expect(res.status).toBe(200);
    expect(res.body.store.moderationStatus).toBe('removed');
    expect(h.stores.get('sto-1').status).toBe('suspended');
    expect(res.body.store.ownerTokenHash).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(auditEvents.some(e => e.action === 'store.moderate')).toBe(true);
  });

  it('PUT /api/admin/stores/:id/moderate requires admin auth (403) and mutates nothing', async () => {
    await seedStore();
    const res = await request(app).put('/api/admin/stores/sto-1/moderate').send({ action: 'removed' });
    expect(res.status).toBe(403);
    expect(h.stores.get('sto-1').status).toBe('active');
  });

  it('PUT /api/admin/stores/:id/suspend → status suspended and audits store.suspended', async () => {
    await seedStore();
    const res = await request(app).put('/api/admin/stores/sto-1/suspend').set('X-Admin-Key', TEST_ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(h.stores.get('sto-1').status).toBe('suspended');
    await new Promise((r) => setImmediate(r));
    expect(auditEvents.some(e => e.action === 'store.suspended')).toBe(true);
  });

  it('owner mutation on a suspended store → 403 with the suspension message', async () => {
    await seedStore({ status: 'suspended' });
    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', OWNER).send({ description: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Resource is suspended or removed');
  });

  it('public slug read of a suspended store → 404', async () => {
    await seedStore({ status: 'suspended' });
    const res = await request(app).get('/api/stores/slug/mod-shop');
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/admin/audit-logs (Priority 2, Domain 3) ───────────────────────
describe('GET /api/admin/audit-logs', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });

  beforeEach(() => { auditEvents.length = 0; });

  it('401 without an admin session', async () => {
    const res = await request(app).get('/api/admin/audit-logs');
    expect(res.status).toBe(401);
  });

  it('returns events newest-first and redacts sensitive metadata keys', async () => {
    auditEvents.push(
      { actor: 'system', action: 'payment.completed', resource: 'payment', result: 'success', metadata: { type: 'listing' }, timestamp: new Date('2026-01-01') },
      { actor: 'admin:owner', action: 'store.moderate', resource: 'store', result: 'success', metadata: { moderationStatus: 'removed', phoneNumber: '0700000000' }, timestamp: new Date('2026-02-01') },
    );
    const res = await request(app).get('/api/admin/audit-logs').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.logs[0].action).toBe('store.moderate'); // newest first
    expect(res.body.logs[0].metadata.phoneNumber).toBe('[REDACTED]');
    expect(res.body.logs[0].metadata.moderationStatus).toBe('removed');
  });

  it('supports ?action filter and caps ?limit at 50', async () => {
    for (let i = 0; i < 3; i++) {
      auditEvents.push({
        actor: 'system', action: i === 0 ? 'payment.completed' : 'store.update', resource: 'x',
        result: 'success', metadata: {}, timestamp: new Date(Date.now() + i),
      });
    }
    const filtered = await request(app).get('/api/admin/audit-logs?action=store.update').set('X-Admin-Session', session());
    expect(filtered.status).toBe(200);
    expect(filtered.body.logs).toHaveLength(2);
    expect(filtered.body.logs.every(l => l.action === 'store.update')).toBe(true);

    const capped = await request(app).get('/api/admin/audit-logs?limit=999').set('X-Admin-Session', session());
    expect(capped.body.logs.length).toBeLessThanOrEqual(50);
  });
});

// ─── GET /api/admin/payments (Priority 2, Domain 4) ─────────────────────────
describe('GET /api/admin/payments', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });

  it('401 without an admin session', async () => {
    const res = await request(app).get('/api/admin/payments');
    expect(res.status).toBe(401);
  });

  it('strips ownerTokenHash from every payment but keeps phoneNumber', async () => {
    h.payments.push(makeDoc({ _id: 'pay-a', type: 'listing', status: 'completed', amount: 50, phoneNumber: '0700000000', ownerTokenHash: 'a'.repeat(64), invoiceId: 'INV-A', createdAt: new Date('2026-02-01') }));
    h.payments.push(makeDoc({ _id: 'pay-b', type: 'store', status: 'pending', amount: 200, phoneNumber: '0711111111', ownerTokenHash: 'b'.repeat(64), invoiceId: 'INV-B', createdAt: new Date('2026-01-01') }));

    const res = await request(app).get('/api/admin/payments').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.payments[0]._id).toBe('pay-a'); // newest first
    expect(JSON.stringify(res.body)).not.toContain('ownerTokenHash');
    expect(JSON.stringify(res.body)).not.toContain('a'.repeat(64));
    expect(res.body.payments[0].phoneNumber).toBe('0700000000');
  });

  it('filters by ?status', async () => {
    h.payments.push(makeDoc({ _id: 'pay-c', type: 'listing', status: 'completed', amount: 50, phoneNumber: '0700000000', invoiceId: 'INV-C' }));
    h.payments.push(makeDoc({ _id: 'pay-d', type: 'listing', status: 'pending', amount: 50, phoneNumber: '0700000000', invoiceId: 'INV-D' }));
    const res = await request(app).get('/api/admin/payments?status=pending').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]._id).toBe('pay-d');
  });
});

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

// ─── Client IP: bounded trust proxy (a spoofed leftmost XFF is ignored) ──────
describe('Client IP — bounded trust proxy', () => {
  it('sets a numeric trust proxy bound (1), never the boolean true', () => {
    expect(app.get('trust proxy')).toBe(1);
    expect(app.get('trust proxy')).not.toBe(true);
  });

  it('records the trusted client IP and ignores a spoofed leftmost X-Forwarded-For', async () => {
    const { TERMS_VERSIONS } = require('../src/config/termsVersions.js');
    // The contact-release path now looks the listing up by its visibility
    // filter, so seed the listing whose id this request sends.
    h.listings.push(makeDoc({
      _id: '650000000000000000000042',
      title: 'Vintage Calculator',
      status: 'active',
      moderationStatus: 'approved',
      sellerWhatsapp: '0712222222',
    }));
    const captured = [];
    const original = fakeTermsModel.create;
    fakeTermsModel.create = async (data) => {
      captured.push(data);
      return makeDoc({ _id: 'ta-ip', ...data });
    };
    try {
      const res = await request(app)
        .post('/api/terms/contact-acceptance')
        .set('X-Forwarded-For', '198.51.100.1, 203.0.113.7')
        .send({
          acceptance: {
            accepted: true,
            gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
            buyerTermsVersion: TERMS_VERSIONS.BUYER_TERMS,
            action: 'CONTINUE_AND_CONTACT_SELLER',
          },
          listingId: '650000000000000000000042',
          sellerWhatsapp: '0712222222',
          listingTitle: 'Vintage Calculator',
        });

      expect(res.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].actor.ip).toBe('203.0.113.7');
      expect(captured[0].actor.ip).not.toBe('198.51.100.1');
    } finally {
      fakeTermsModel.create = original;
    }
  });
});

// ─── Input length caps (Step 3) ─────────────────────────────────────────────
describe('Input length caps — server-side enforcement', () => {
  const { TERMS_VERSIONS } = require('../src/config/termsVersions.js');
  const listingAcceptance = () => ({
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
  });
  const listingBody = (overrides = {}) => ({
    phoneNumber: '0700000000',
    package: 'quick',
    acceptance: listingAcceptance(),
    website: '',
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
      ...overrides,
    },
  });

  it('initiate-listing with a 5000-character title returns 400 naming title', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({ title: 'x'.repeat(5000) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
  });

  it('initiate-listing with a title of exactly 120 characters is not rejected for length', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({ title: 'x'.repeat(120) }));
    expect(res.status).not.toBe(400);
    expect(res.body.error || '').not.toMatch(/title/);
  });

  it('initiate-listing with 7 images returns 400 naming images', async () => {
    const images = Array.from({ length: 7 }, (_, i) => `https://res.cloudinary.com/demo/image/upload/v1/gikomart/${i}.jpg`);
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({ images }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/images/);
  });

  it('PUT /api/listings/:id with an over-cap description (valid owner token) returns 400', async () => {
    const OWNER_TOKEN = 'limit-owner-token';
    h.listings.push(makeDoc({
      _id: 'lst-limit', title: 'Widget', condition: 'Good', images: [],
      ownerTokenHash: sha256hex(OWNER_TOKEN), status: 'active', moderationStatus: 'approved',
    }));
    const res = await request(app)
      .put('/api/listings/lst-limit')
      .set('X-Owner-Token', OWNER_TOKEN)
      .send({ description: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/);
  });

  it('PUT /api/stores/:id with an over-cap name (valid store token) returns 400', async () => {
    const OWNER_TOKEN = 'limit-store-token';
    const store = await fakeStoreModel.create({
      name: 'Limit Shop', slug: 'limit-shop', category: 'Books',
      ownerTokenHash: sha256hex(OWNER_TOKEN),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    });
    const res = await request(app)
      .put(`/api/stores/${store._id}`)
      .set('X-Store-Owner-Token', OWNER_TOKEN)
      .send({ name: 'n'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });
});

// ─── Phase 2, Step 1: reject store_id at listing creation ────────────────────
describe('initiate-listing rejects store_id (attach after publish)', () => {
  const { TERMS_VERSIONS } = require('../src/config/termsVersions.js');
  const listingBody = (listingData) => ({
    phoneNumber: '0700000000',
    package: 'quick',
    website: '',
    acceptance: {
      accepted: true,
      gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
      sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
    },
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
      ...listingData,
    },
  });

  it('rejects a valid-looking ObjectId store_id with 400 naming store_id and creates no Payment', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({ store_id: '650000000000000000000042' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/store_id/);
    expect(h.payments).toHaveLength(0);
  });

  it('rejects a numeric store_id with 400', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({ store_id: 42 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/store_id/);
  });

  it('accepts a listing with no store_id (proceeds past validation)', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({}));
    expect(res.status).not.toBe(400);
  });

  it('accepts store_id "" (treated as standalone)', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBody({ store_id: '' }));
    expect(res.status).not.toBe(400);
  });
});

// ─── Phase 2, Step 2: store_id forced null at payment completion ─────────────
describe('webhook creation forces store_id null', () => {
  it('ignores a stored store_id and creates the listing standalone', async () => {
    const p = listingPayment();
    p.listingData = { ...p.listingData, store_id: '650000000000000000000042' };
    h.payments.push(makeDoc(p));
    const res = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].store_id).toBeNull();
  });

  it('creates a listing as before when no store_id is stored', async () => {
    h.payments.push(makeDoc(listingPayment()));
    const res = await webhook({ invoice_id: 'INV-LISTING-1', state: 'COMPLETE' });
    expect(res.status).toBe(200);
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].store_id).toBeNull();
  });
});

// ─── Phase 3, Step 2: contact release after a recorded acceptance ────────────
describe('POST /api/terms/contact-acceptance — releases the stored seller contact', () => {
  const { TERMS_VERSIONS } = require('../src/config/termsVersions.js');
  const CONTACT_LISTING_ID = '650000000000000000000042';
  const SELLER_WA = '0712222222';

  const acceptance = () => ({
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    buyerTermsVersion: TERMS_VERSIONS.BUYER_TERMS,
    action: 'CONTINUE_AND_CONTACT_SELLER',
  });

  const seedListing = (overrides = {}) => {
    h.listings.push(makeDoc({
      _id: CONTACT_LISTING_ID,
      title: 'Vintage Calculator',
      status: 'active',
      moderationStatus: 'approved',
      sellerWhatsapp: SELLER_WA,
      ...overrides,
    }));
  };

  // Capture every TermsAcceptance.create payload so the recorded target can be
  // asserted without the fake projecting fields.
  function captureAcceptance() {
    const captured = [];
    const original = fakeTermsModel.create;
    fakeTermsModel.create = async (data) => {
      captured.push(data);
      return makeDoc({ _id: 'ta-contact', ...data });
    };
    return { captured, restore: () => { fakeTermsModel.create = original; } };
  }

  it('returns the stored sellerWhatsapp with no-store and records the target hash', async () => {
    seedListing();
    const cap = captureAcceptance();
    try {
      const res = await request(app)
        .post('/api/terms/contact-acceptance')
        .send({ acceptance: acceptance(), listingId: CONTACT_LISTING_ID, listingTitle: 'Vintage Calculator' });

      expect(res.status).toBe(200);
      expect(res.body.sellerWhatsapp).toBe(SELLER_WA);
      expect(res.headers['cache-control']).toContain('no-store');

      expect(cap.captured).toHaveLength(1);
      expect(cap.captured[0].sellerContactTarget.sellerWhatsappHash).toBe(sha256hex(SELLER_WA));
    } finally {
      cap.restore();
    }
  });

  it('ignores a sellerWhatsapp supplied in the request body', async () => {
    seedListing();
    const cap = captureAcceptance();
    try {
      const res = await request(app)
        .post('/api/terms/contact-acceptance')
        .send({ acceptance: acceptance(), listingId: CONTACT_LISTING_ID, sellerWhatsapp: '0799999999' });

      expect(res.status).toBe(200);
      expect(res.body.sellerWhatsapp).toBe(SELLER_WA);
      expect(cap.captured[0].sellerContactTarget.sellerWhatsappHash).toBe(sha256hex(SELLER_WA));
    } finally {
      cap.restore();
    }
  });

  it('404 for a flagged listing, with no sellerWhatsapp in the body', async () => {
    seedListing({ moderationStatus: 'flagged' });
    const res = await request(app)
      .post('/api/terms/contact-acceptance')
      .send({ acceptance: acceptance(), listingId: CONTACT_LISTING_ID });
    expect(res.status).toBe(404);
    expect(res.body.sellerWhatsapp).toBeUndefined();
  });

  it('404 for a nonexistent (valid ObjectId) listing', async () => {
    const res = await request(app)
      .post('/api/terms/contact-acceptance')
      .send({ acceptance: acceptance(), listingId: '650000000000000000000099' });
    expect(res.status).toBe(404);
    expect(res.body.sellerWhatsapp).toBeUndefined();
  });

  it('404 for a malformed listingId', async () => {
    const res = await request(app)
      .post('/api/terms/contact-acceptance')
      .send({ acceptance: acceptance(), listingId: 'not-an-object-id' });
    expect(res.status).toBe(404);
    expect(res.body.sellerWhatsapp).toBeUndefined();
  });

  it('400 when acceptance is missing, even with a valid listingId, and no sellerWhatsapp', async () => {
    seedListing();
    const res = await request(app)
      .post('/api/terms/contact-acceptance')
      .send({ listingId: CONTACT_LISTING_ID });
    expect(res.status).toBe(400);
    expect(res.body.sellerWhatsapp).toBeUndefined();
  });

  it('400 Seller contact unavailable when the listing has an empty sellerWhatsapp', async () => {
    seedListing({ sellerWhatsapp: '' });
    const res = await request(app)
      .post('/api/terms/contact-acceptance')
      .send({ acceptance: acceptance(), listingId: CONTACT_LISTING_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Seller contact unavailable');
    expect(res.body.sellerWhatsapp).toBeUndefined();
  });
});

// ─── Phase 4, Step 2: moderation on listing edits ───────────────────────────
describe('Content moderation on listing edits (Phase 4, Step 2)', () => {
  const OWNER = 'edit-owner-token';
  const seed = (overrides = {}) => {
    h.listings.push(makeDoc({
      _id: 'lst-edit', title: 'Widget', description: 'A plain widget',
      sellerName: 'Ted', category: 'Electronics', location: 'Njoro',
      status: 'active', moderationStatus: 'approved',
      ownerTokenHash: sha256hex(OWNER),
      ...overrides,
    }));
  };

  it('flags a clean listing when the owner adds prohibited text, and hides it publicly', async () => {
    seed();
    const res = await request(app).put('/api/listings/lst-edit').set('X-Owner-Token', OWNER).send({ description: 'Cheap casino tokens' });
    expect(res.status).toBe(200);
    expect(h.listings[0].moderationStatus).toBe('flagged');
    const pub = await request(app).get('/api/listings');
    expect(pub.body.listings.find((l) => l._id === 'lst-edit')).toBeUndefined();
  });

  it('keeps moderationStatus approved for a clean edit of a clean listing', async () => {
    seed();
    const res = await request(app).put('/api/listings/lst-edit').set('X-Owner-Token', OWNER).send({ title: 'Better Widget' });
    expect(res.status).toBe(200);
    expect(h.listings[0].moderationStatus).toBe('approved');
  });

  it('leaves a flagged listing flagged on a clean edit', async () => {
    seed({ moderationStatus: 'flagged' });
    const res = await request(app).put('/api/listings/lst-edit').set('X-Owner-Token', OWNER).send({ title: 'Cleaner Widget' });
    expect(res.status).toBe(200);
    expect(h.listings[0].moderationStatus).toBe('flagged');
  });

  it('409 when an owner edits a removed listing, and nothing changes', async () => {
    seed({ moderationStatus: 'removed', title: 'Original' });
    const res = await request(app).put('/api/listings/lst-edit').set('X-Owner-Token', OWNER).send({ title: 'New title' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Listing has been removed and can no longer be edited' });
    expect(h.listings[0].title).toBe('Original');
  });

  it('403 (not 409) when a non-owner edits a removed listing', async () => {
    seed({ moderationStatus: 'removed' });
    const res = await request(app).put('/api/listings/lst-edit').set('X-Owner-Token', 'wrong').send({ title: 'New' });
    expect(res.status).toBe(403);
  });

  it('flags on a title-only edit when the stored description is prohibited', async () => {
    seed({ description: 'Totally stolen goods' });
    const res = await request(app).put('/api/listings/lst-edit').set('X-Owner-Token', OWNER).send({ title: 'Brand New' });
    expect(res.status).toBe(200);
    expect(h.listings[0].moderationStatus).toBe('flagged');
  });
});

// ─── Phase 4, Step 3: moderated store creation + public-read gate ───────────
describe('Store moderation on creation and public reads (Phase 4, Step 3)', () => {
  const { createResourceForPayment } = require('../src/controllers/paymentController.js');
  const storePayment = (storeData) => makeDoc({
    _id: 'pay-store-1', type: 'store', storePlan: 'starter_weekly',
    storeData, ownerTokenHash: 'c'.repeat(64),
  });
  const seedStore = (overrides) => fakeStoreModel.create({
    name: 'Shop', slug: 'shop', category: 'Books', ownerTokenHash: sha256hex('t'),
    plan: 'starter_weekly', plan_price: 150, plan_duration: 1, listing_limit: 5,
    started_at: new Date(), expires_at: new Date(), status: 'active',
    ...overrides,
  });

  it('flags a store payment whose storeData name matches the blocklist', async () => {
    const { doc } = await createResourceForPayment(storePayment({ name: 'Casino Supplies', slug: 'casino-supplies', category: 'Books' }));
    expect(doc.moderationStatus).toBe('flagged');
  });

  it('approves a clean store payment', async () => {
    const { doc } = await createResourceForPayment(storePayment({ name: 'Clean Shop', slug: 'clean-shop', category: 'Books' }));
    expect(doc.moderationStatus).toBe('approved');
  });

  it('GET /stores/slug/:slug → 404 for a flagged store', async () => {
    await seedStore({ slug: 'flagged-shop', moderationStatus: 'flagged' });
    const res = await request(app).get('/api/stores/slug/flagged-shop');
    expect(res.status).toBe(404);
  });

  it('GET /stores/slug/:slug → 200 for an approved store', async () => {
    await seedStore({ slug: 'approved-shop', moderationStatus: 'approved' });
    const res = await request(app).get('/api/stores/slug/approved-shop');
    expect(res.status).toBe(200);
  });

  it('GET /stores/slug/:slug → 200 for a store with no moderationStatus field', async () => {
    await seedStore({ slug: 'no-mod-shop' });
    const res = await request(app).get('/api/stores/slug/no-mod-shop');
    expect(res.status).toBe(200);
  });

  it('a flagged store is still readable by its owner but hidden publicly', async () => {
    await fakeStoreModel.create({
      _id: 'sto-flag-owner', name: 'F', slug: 'owner-flag', category: 'Books',
      moderationStatus: 'flagged', ownerTokenHash: sha256hex('owner-flag-token'),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 1, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(), status: 'active',
    });
    const pub = await request(app).get('/api/stores/slug/owner-flag');
    expect(pub.status).toBe(404);

    const byId = await request(app).get('/api/stores/sto-flag-owner').set('X-Store-Owner-Token', 'owner-flag-token');
    expect(byId.status).toBe(200);

    const mine = await request(app).get('/api/stores/me/all').set('X-Store-Owner-Token', 'owner-flag-token');
    expect(mine.status).toBe(200);
    expect(mine.body.stores.map((s) => s.slug)).toContain('owner-flag');
  });
});

// ─── Phase 4, Step 4: store edits + attach guard ────────────────────────────
describe('Store edits and attach guard (Phase 4, Step 4)', () => {
  const OWNER = 'raw-owner-token';
  const seedStore = (overrides = {}) => fakeStoreModel.create({
    name: 'My Shop', slug: 'my-shop', category: 'Books',
    ownerTokenHash: sha256hex(OWNER),
    plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
    started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    ...overrides,
  });

  it('flags a store when the owner adds prohibited text, and hides it publicly', async () => {
    await seedStore();
    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', OWNER)
      .send({ description: 'Cheap casino tokens available' });
    expect(res.status).toBe(200);
    expect(h.stores.get('sto-1').moderationStatus).toBe('flagged');

    const pub = await request(app).get('/api/stores/slug/my-shop');
    expect(pub.status).toBe(404);
  });

  it('leaves a flagged store flagged on a clean edit', async () => {
    await seedStore({ moderationStatus: 'flagged' });
    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', OWNER)
      .send({ description: 'A perfectly clean description' });
    expect(res.status).toBe(200);
    expect(h.stores.get('sto-1').moderationStatus).toBe('flagged');
  });

  it('still rejects a suspended store PUT via storeAuth with 403 (regression)', async () => {
    await seedStore({ status: 'suspended' });
    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', OWNER)
      .send({ description: 'Anything' });
    expect(res.status).toBe(403);
  });

  it('409 when the owner edits a removed (but active) store, and nothing changes', async () => {
    await seedStore({ moderationStatus: 'removed', name: 'Original Name' });
    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', OWNER)
      .send({ name: 'New Name' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Store has been removed and can no longer be edited' });
    expect(h.stores.get('sto-1').name).toBe('Original Name');
  });

  it('attach-listing rejects a removed listing with 409 and leaves store_id unchanged', async () => {
    await seedStore();
    h.listings.push(makeDoc({
      _id: 'lst-removed', store_id: null, moderationStatus: 'removed',
      ownerTokenHash: sha256hex('listing-owner-token'), expiresAt: new Date(Date.now() + 86400000),
    }));
    const res = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', OWNER).set('X-Owner-Token', 'listing-owner-token')
      .send({ listingId: 'lst-removed' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Removed listings cannot be attached to a store');
    expect(h.listings[0].store_id).toBeNull();
  });

  it('attach-listing still succeeds for an active listing with no moderationStatus field', async () => {
    await seedStore();
    h.listings.push(makeDoc({
      _id: 'lst-ok', store_id: null,
      ownerTokenHash: sha256hex('listing-owner-token'), expiresAt: new Date(Date.now() + 86400000),
    }));
    const res = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', OWNER).set('X-Owner-Token', 'listing-owner-token')
      .send({ listingId: 'lst-ok' });
    expect(res.status).toBe(200);
    expect(String(h.listings[0].store_id)).toBe('sto-1');
  });

  it('detach-listing still succeeds for a removed listing', async () => {
    await seedStore();
    h.listings.push(makeDoc({
      _id: 'lst-det-removed', store_id: 'sto-1', moderationStatus: 'removed',
      ownerTokenHash: sha256hex('listing-owner-token'), expiresAt: new Date(Date.now() + 86400000), status: 'active',
    }));
    const res = await request(app).put('/api/stores/sto-1/detach-listing')
      .set('X-Store-Owner-Token', OWNER).set('X-Owner-Token', 'listing-owner-token')
      .send({ listingId: 'lst-det-removed' });
    expect(res.status).toBe(200);
    expect(h.listings[0].store_id).toBeNull();
  });
});

// ─── Phase 5A, Step 1: hidden-store inventory gate ─────────────────────────
describe('GET /api/listings?store_id — hidden-store inventory gate (Phase 5A, Step 1)', () => {
  const STORE_ID = '6500000000000000000000aa';
  const seedStoreAndListings = async (storeFields = {}) => {
    const store = await fakeStoreModel.create({
      _id: STORE_ID,
      name: 'Inv Shop', slug: 'inv-shop', category: 'Books',
      ownerTokenHash: sha256hex('inv-owner-token'),
      plan: 'starter_weekly', plan_price: 150, plan_duration: 1, listing_limit: 5,
      started_at: new Date(), expires_at: new Date(), status: 'active',
      ...storeFields,
    });
    h.listings.push(makeDoc({
      _id: 'lst-inv-1', store_id: String(store._id), title: 'In store',
      status: 'active', moderationStatus: 'approved',
    }));
    return store;
  };

  it('returns the store listings for an active approved store', async () => {
    await seedStoreAndListings({ moderationStatus: 'approved' });
    const res = await request(app).get(`/api/listings?store_id=${STORE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.listings.map((l) => l._id)).toEqual(['lst-inv-1']);
  });

  it('returns an empty list and count 0 for a flagged store, status 200', async () => {
    await seedStoreAndListings({ moderationStatus: 'flagged' });
    const res = await request(app).get(`/api/listings?store_id=${STORE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.listings).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('returns an empty list for a removed store', async () => {
    await seedStoreAndListings({ moderationStatus: 'removed' });
    const res = await request(app).get(`/api/listings?store_id=${STORE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.listings).toEqual([]);
  });

  it('returns an empty list for a suspended store', async () => {
    await seedStoreAndListings({ status: 'suspended' });
    const res = await request(app).get(`/api/listings?store_id=${STORE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.listings).toEqual([]);
  });

  it('returns an empty list for a nonexistent valid ObjectId, status 200', async () => {
    const res = await request(app).get('/api/listings?store_id=650000000000000000000099');
    expect(res.status).toBe(200);
    expect(res.body.listings).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('returns an empty list for a malformed store id, status 200, no error', async () => {
    const res = await request(app).get('/api/listings?store_id=not-an-id');
    expect(res.status).toBe(200);
    expect(res.body.listings).toEqual([]);
    expect(res.body).not.toHaveProperty('error');
  });

  it('returns listings for a store with no moderationStatus field', async () => {
    await seedStoreAndListings();
    const res = await request(app).get(`/api/listings?store_id=${STORE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.listings.map((l) => l._id)).toEqual(['lst-inv-1']);
  });

  it('never calls Store.findOne when no store_id is given', async () => {
    const spy = vi.spyOn(fakeStoreModel, 'findOne');
    try {
      const res = await request(app).get('/api/listings');
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Phase 5A, Step 2: admin seller block list ──────────────────────────────
describe('Admin blocked contacts (Phase 5A, Step 2)', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
  const auth = (r) => r.set('X-Admin-Session', session());
  const HEX64 = /[0-9a-f]{64}/;

  const blockPhone = (phone, reason = 'spam') => auth(request(app).post('/api/admin/blocks'))
    .send({ sourceType: 'phone', phone, reason });

  it('POST /api/admin/blocks without an admin session is rejected as GET /audit-logs is', async () => {
    const blocked = await request(app).post('/api/admin/blocks')
      .send({ sourceType: 'phone', phone: '0712222222', reason: 'spam' });
    expect(blocked.status).toBe(401);
    const logs = await request(app).get('/api/admin/audit-logs');
    expect(logs.status).toBe(401);
  });

  it('blocks a phone number: 201, created 1, no digits or hash in the response', async () => {
    const res = await blockPhone('0712222222');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, created: 1, alreadyBlocked: 0 });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('712222222');
    expect(body).not.toMatch(HEX64);
  });

  it('is idempotent across formats: same number again returns created 0, alreadyBlocked 1', async () => {
    await blockPhone('0712222222');
    const res = await blockPhone('+254712222222');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, created: 0, alreadyBlocked: 1 });
  });

  it('blocks a listing seller by listing id', async () => {
    h.listings.push(makeDoc({ _id: '6500000000000000000000bb', sellerWhatsapp: '0712222222' }));
    const res = await auth(request(app).post('/api/admin/blocks'))
      .send({ sourceType: 'listing', sourceId: '6500000000000000000000bb', reason: 'fraud' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(h.blocks).toHaveLength(1);
  });

  it('blocks a store phone and whatsapp (two numbers -> created 2)', async () => {
    await fakeStoreModel.create({
      _id: '6500000000000000000000cc', name: 'S', slug: 's', category: 'Books',
      phone: '0700000000', whatsapp: '0711111111',
    });
    const res = await auth(request(app).post('/api/admin/blocks'))
      .send({ sourceType: 'store', sourceId: '6500000000000000000000cc', reason: 'fraud' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(h.blocks).toHaveLength(2);
  });

  it('404 for an unknown listing id; 400 for a malformed id', async () => {
    const missing = await auth(request(app).post('/api/admin/blocks'))
      .send({ sourceType: 'listing', sourceId: '650000000000000000000099', reason: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Listing not found');

    const malformed = await auth(request(app).post('/api/admin/blocks'))
      .send({ sourceType: 'listing', sourceId: 'not-an-id', reason: 'x' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('Invalid block request');
  });

  it('400 for a reason longer than 200 characters', async () => {
    const res = await blockPhone('0712222222', 'x'.repeat(201));
    expect(res.status).toBe(400);
  });

  it('GET /api/admin/blocks returns entries without any contactHash field', async () => {
    await blockPhone('0712222222');
    const res = await auth(request(app).get('/api/admin/blocks'));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.blocks[0]).toMatchObject({ sourceType: 'phone', reason: 'spam' });
    expect(res.body.blocks[0]).not.toHaveProperty('contactHash');
    expect(JSON.stringify(res.body)).not.toMatch(HEX64);
  });

  it('DELETE /api/admin/blocks/:id removes it; a second DELETE returns 404', async () => {
    await blockPhone('0712222222');
    const id = h.blocks[0]._id;
    const del = await auth(request(app).delete(`/api/admin/blocks/${id}`));
    expect(del.status).toBe(200);
    expect(h.blocks).toHaveLength(0);

    const again = await auth(request(app).delete(`/api/admin/blocks/${id}`));
    expect(again.status).toBe(404);
  });

  it('emits admin.block_added and admin.block_removed with no phone digits in metadata', async () => {
    await blockPhone('0712222222');
    const id = h.blocks[0]._id;
    await auth(request(app).delete(`/api/admin/blocks/${id}`));
    await new Promise((r) => setTimeout(r, 10));

    const added = auditEvents.find((e) => e.action === 'admin.block_added');
    const removed = auditEvents.find((e) => e.action === 'admin.block_removed');
    expect(added).toBeTruthy();
    expect(removed).toBeTruthy();
    expect(JSON.stringify(added.metadata)).not.toContain('712222222');
    expect(JSON.stringify(removed.metadata)).not.toContain('712222222');
  });
});

// ─── Phase 5A, Step 3: refuse payment initiation for blocked contacts ───────
describe('Payment initiation refuses blocked contacts (Phase 5A, Step 3)', () => {
  const TV = require('../src/config/termsVersions.js').TERMS_VERSIONS;
  const { contactHash: hashContact } = require('../src/utils/phone.js');

  const listingAcceptance = () => ({
    accepted: true,
    gikomartTermsVersion: TV.GIKOMART_TERMS_OF_SERVICE,
    sellerTermsVersion: TV.SELLER_TERMS,
  });
  const storeAcceptance = () => ({
    accepted: true,
    gikomartTermsVersion: TV.GIKOMART_TERMS_OF_SERVICE,
    storeOwnerTermsVersion: TV.STORE_OWNER_TERMS,
  });

  const listingBody = (overrides = {}) => ({
    phoneNumber: '0700000000',
    package: 'quick',
    acceptance: listingAcceptance(),
    website: '',
    listingData: {
      title: 'Test Book', category: 'Books', condition: 'Good', price: 500,
      description: 'Used calc textbook', sellerName: 'Jane',
      sellerWhatsapp: '0711111111', location: 'Egerton', images: [],
      ...overrides,
    },
  });

  const storeBody = (overrides = {}) => ({
    phoneNumber: '0700000000',
    storePlan: 'starter_weekly',
    acceptance: storeAcceptance(),
    website: '',
    storeData: {
      name: 'Shop1', category: 'Books', description: '', phone: '0700000000',
      whatsapp: '0711111111', email: '', location: 'Egerton',
      ...overrides,
    },
  });

  const blockNumber = (raw) => {
    h.blocks.push(makeDoc({
      contactHash: hashContact(raw), sourceType: 'phone', sourceId: null,
      reason: 'x', createdBy: 'admin:owner',
    }));
  };

  it('403 with the exact error and no Payment when the seller number is blocked', async () => {
    blockNumber('0712222222');
    const res = await request(app).post('/api/payments/initiate-listing')
      .send(listingBody({ sellerWhatsapp: '+254 712 222 222' }));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'This number cannot be used on GikoMart' });
    expect(h.payments).toHaveLength(0);
  });

  it('403 when only the payer phoneNumber is blocked', async () => {
    blockNumber('0700000000');
    const res = await request(app).post('/api/payments/initiate-listing').send(listingBody());
    expect(res.status).toBe(403);
  });

  it('initiate-store-plan: 403 when only storeData.whatsapp is blocked', async () => {
    blockNumber('0711111111');
    const res = await request(app).post('/api/payments/initiate-store-plan').send(storeBody());
    expect(res.status).toBe(403);
    expect(h.payments).toHaveLength(0);
  });

  it('initiate-store-plan: 403 when only storeData.phone is blocked', async () => {
    blockNumber('0700000000'); // the storeData.phone value
    const body = storeBody({ whatsapp: '0722222222' });
    body.phoneNumber = '0733333333';
    const res = await request(app).post('/api/payments/initiate-store-plan').send(body);
    expect(res.status).toBe(403);
  });

  it('initiate-listing with no blocked number is not rejected with 403', async () => {
    const res = await request(app).post('/api/payments/initiate-listing').send(listingBody());
    expect(res.status).not.toBe(403);
    expect(res.body.error || '').not.toMatch(/cannot be used/i);
  });

  it('initiate-listing with an unparseable sellerWhatsapp is not 403 on that basis', async () => {
    const res = await request(app).post('/api/payments/initiate-listing')
      .send(listingBody({ sellerWhatsapp: 'abc' }));
    expect(res.status).not.toBe(403);
    expect(res.body.error || '').not.toMatch(/cannot be used/i);
  });

  it('emits payment.blocked_contact with only the route key and no phone digits', async () => {
    blockNumber('0712222222');
    await request(app).post('/api/payments/initiate-listing')
      .send(listingBody({ sellerWhatsapp: '0712222222' }));
    await new Promise((r) => setTimeout(r, 10));

    const ev = auditEvents.find((e) => e.action === 'payment.blocked_contact');
    expect(ev).toBeTruthy();
    expect(ev.metadata).toEqual({ route: 'initiate-listing' });
    expect(JSON.stringify(ev.metadata)).not.toMatch(/712222222|0700000000/);
  });
});

// ─── Phase 5B, Step 2: user reports + admin queue ───────────────────────────
describe('User reports and admin queue (Phase 5B, Step 2)', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
  const auth = (r) => r.set('X-Admin-Session', session());

  const LISTING_ID = '6500000000000000000000aa';
  const OTHER_ID = '6500000000000000000000ab';
  const STORE_ID = '6500000000000000000000ac';
  const REMOVED_ID = '6500000000000000000000ad';

  const seedListing = (id, overrides = {}) => h.listings.push(makeDoc({
    _id: id, title: 'T', category: 'Books', condition: 'Good', price: 10,
    description: 'd', sellerName: 's', sellerWhatsapp: '0700000000',
    moderationStatus: 'approved', ...overrides,
  }));

  beforeEach(() => { auditEvents.length = 0; });

  const postReport = (body) => request(app).post('/api/reports').send(body);
  const validReport = (overrides = {}) => ({
    targetType: 'listing', targetId: LISTING_ID, reason: 'scam', details: 'looks fake', ...overrides,
  });

  it('accepts a listing report: 201, one Report, no id or IP in the body', async () => {
    seedListing(LISTING_ID);
    const res = await postReport(validReport());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true });
    expect(h.reports).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{24}/);
  });

  it('deduplicates a second report from the same IP on the same open target within 24h', async () => {
    seedListing(LISTING_ID);
    await postReport(validReport());
    const res = await postReport(validReport());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(h.reports).toHaveLength(1);
  });

  it('allows a new report when the existing one is older than 24 hours', async () => {
    seedListing(LISTING_ID);
    await postReport(validReport());
    h.reports[0].createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const res = await postReport(validReport());
    expect(res.status).toBe(201);
    expect(h.reports).toHaveLength(2);
  });

  it('creates a new report for a different target from the same IP', async () => {
    seedListing(LISTING_ID);
    seedListing(OTHER_ID);
    await postReport(validReport());
    const res = await postReport(validReport({ targetId: OTHER_ID }));
    expect(res.status).toBe(201);
    expect(h.reports).toHaveLength(2);
  });

  it('accepts a store report', async () => {
    await fakeStoreModel.create({
      _id: STORE_ID, name: 'S', slug: 's', category: 'Books', moderationStatus: 'approved',
    });
    const res = await postReport(validReport({ targetType: 'store', targetId: STORE_ID }));
    expect(res.status).toBe(201);
    expect(h.reports).toHaveLength(1);
  });

  it('404 for an unknown valid ObjectId, a malformed id, and a removed target', async () => {
    seedListing(REMOVED_ID, { moderationStatus: 'removed' });
    expect((await postReport(validReport({ targetId: '6500000000000000000000ef' }))).status).toBe(404);
    expect((await postReport(validReport({ targetId: 'not-an-id' }))).status).toBe(404);
    expect((await postReport(validReport({ targetId: REMOVED_ID }))).status).toBe(404);
    expect(h.reports).toHaveLength(0);
  });

  it('400 for an invalid reason, an invalid targetType and details over 500 characters', async () => {
    seedListing(LISTING_ID);
    expect((await postReport(validReport({ reason: 'bogus' }))).status).toBe(400);
    expect((await postReport(validReport({ targetType: 'user' }))).status).toBe(400);
    expect((await postReport(validReport({ details: 'x'.repeat(501) }))).status).toBe(400);
    expect(h.reports).toHaveLength(0);
  });

  it('the honeypot drops a filled website field: 200 and no Report', async () => {
    seedListing(LISTING_ID);
    const res = await postReport(validReport({ website: 'http://spam.example' }));
    expect(res.status).toBe(200);
    expect(h.reports).toHaveLength(0);
  });

  it('GET /api/admin/reports without a session is rejected as GET /audit-logs is', async () => {
    expect((await request(app).get('/api/admin/reports')).status).toBe(401);
    expect((await request(app).get('/api/admin/audit-logs')).status).toBe(401);
  });

  it('GET /api/admin/reports returns open reports, never reporterIp, and honors status/targetType', async () => {
    const ip = '198.51.100.7';
    h.reports.push(makeDoc({
      _id: '6500000000000000000000c1', targetType: 'listing', targetId: LISTING_ID, reason: 'scam',
      details: 'd', reporterIp: ip, status: 'open', moderationAction: null, resolvedAt: null,
      resolvedBy: null, note: '', createdAt: new Date(),
    }));
    h.reports.push(makeDoc({
      _id: '6500000000000000000000c2', targetType: 'store', targetId: STORE_ID, reason: 'other',
      details: '', reporterIp: ip, status: 'actioned', moderationAction: 'removed', resolvedAt: new Date(),
      resolvedBy: 'admin:owner', note: '', createdAt: new Date(),
    }));

    const open = await auth(request(app).get('/api/admin/reports'));
    expect(open.status).toBe(200);
    expect(open.body.count).toBe(1);
    expect(JSON.stringify(open.body)).not.toContain(ip);

    const all = await auth(request(app).get('/api/admin/reports?status=all'));
    expect(all.body.count).toBe(2);

    const stores = await auth(request(app).get('/api/admin/reports?status=all&targetType=store'));
    expect(stores.body.count).toBe(1);

    const bogus = await auth(request(app).get('/api/admin/reports?status=bogus'));
    expect(bogus.status).toBe(400);
  });

  const seedReport = (overrides = {}) => h.reports.push(makeDoc({
    _id: '6500000000000000000000d1', targetType: 'listing', targetId: LISTING_ID,
    reason: 'scam', details: '', reporterIp: '198.51.100.9', status: 'open',
    moderationAction: null, resolvedAt: null, resolvedBy: null, note: '',
    createdAt: new Date(), ...overrides,
  }));

  const resolve = (body, id = '6500000000000000000000d1') => auth(request(app).put(`/api/admin/reports/${id}/resolve`)).send(body);

  it('PUT resolve actioned updates the report and emits admin.report_resolved with ids and no IP', async () => {
    seedReport();
    const res = await resolve({ resolution: 'actioned', moderationAction: 'removed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(h.reports[0].status).toBe('actioned');
    expect(h.reports[0].moderationAction).toBe('removed');
    expect(h.reports[0].resolvedBy).toBe('admin:owner');

    await new Promise((r) => setTimeout(r, 10));
    const ev = auditEvents.find((e) => e.action === 'admin.report_resolved');
    expect(ev).toBeTruthy();
    expect(ev.metadata).toMatchObject({
      targetType: 'listing', targetId: LISTING_ID, resolution: 'actioned', moderationAction: 'removed',
    });
    expect(JSON.stringify(ev.metadata)).not.toContain('198.51.100.9');
  });

  it('PUT resolve on an already resolved report returns 409; unknown id returns 404', async () => {
    seedReport({ status: 'dismissed' });
    expect((await resolve({ resolution: 'actioned', moderationAction: 'none' })).status).toBe(409);
    expect((await resolve({ resolution: 'actioned', moderationAction: 'none' }, '6500000000000000000000ef')).status).toBe(404);
  });

  it('rejects invalid resolutions', async () => {
    seedReport();
    expect((await resolve({ resolution: 'actioned', moderationAction: 'suspended' })).status).toBe(400);
    expect((await resolve({ resolution: 'actioned' })).status).toBe(400);
    expect((await resolve({ resolution: 'dismissed', moderationAction: 'removed' })).status).toBe(400);
    expect((await resolve({ resolution: 'dismissed', note: 'x'.repeat(201) })).status).toBe(400);
  });
});

// ─── Phase 5B, Step 3: missing audit events ─────────────────────────────────
describe('Audit events for edits, auto-flags, attach/detach and payment views (Phase 5B, Step 3)', () => {
  const { signSession } = require('../src/middleware/adminAuth');
  const session = () => signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  const OWNER = 'audit-owner-token';
  const LISTING_OWNER = 'audit-listing-owner-token';

  const seedListing = (overrides = {}) => h.listings.push(makeDoc({
    _id: 'lst-audit', title: 'Widget', description: 'A plain widget',
    sellerName: 'Ted', category: 'Electronics', condition: 'Good', price: 10,
    sellerWhatsapp: '0700000000', location: 'Njoro',
    status: 'active', moderationStatus: 'approved',
    ownerTokenHash: sha256hex(OWNER),
    ...overrides,
  }));

  const seedStore = (overrides = {}) => fakeStoreModel.create({
    name: 'Audit Shop', slug: 'audit-shop', category: 'Books',
    ownerTokenHash: sha256hex(OWNER),
    plan: 'starter_weekly', plan_price: 150, plan_duration: 604800000, listing_limit: 5,
    started_at: new Date(), expires_at: new Date(Date.now() + 86400000), status: 'active',
    ...overrides,
  });

  beforeEach(() => { auditEvents.length = 0; });

  it('a clean owner edit emits listing.update with field names only and no auto-flag', async () => {
    seedListing();
    const res = await request(app).put('/api/listings/lst-audit')
      .set('X-Owner-Token', OWNER)
      .send({ title: 'New Title', description: 'Clean description' });
    expect(res.status).toBe(200);
    await settle();

    const ev = auditEvents.find((e) => e.action === 'listing.update');
    expect(ev).toBeTruthy();
    expect(ev.resource).toBe('listing');
    expect(ev.resourceId).toBe('lst-audit');
    expect(ev.metadata.autoFlagged).toBe(false);
    expect([...ev.metadata.fields].sort()).toEqual(['description', 'title']);
    expect(JSON.stringify(ev.metadata)).not.toContain('New Title');
    expect(JSON.stringify(ev.metadata)).not.toContain('Clean description');
    expect(auditEvents.some((e) => e.action === 'listing.auto_flagged')).toBe(false);
  });

  it('an owner edit adding prohibited text emits listing.update autoFlagged true and listing.auto_flagged', async () => {
    seedListing();
    const res = await request(app).put('/api/listings/lst-audit')
      .set('X-Owner-Token', OWNER)
      .send({ description: 'Cheap casino tokens' });
    expect(res.status).toBe(200);
    await settle();

    const update = auditEvents.find((e) => e.action === 'listing.update');
    expect(update).toBeTruthy();
    expect(update.metadata.autoFlagged).toBe(true);
    expect(update.metadata.fields).toContain('description');
    expect(update.metadata.fields).not.toContain('moderationStatus');
    const flagged = auditEvents.find((e) => e.action === 'listing.auto_flagged');
    expect(flagged).toBeTruthy();
    expect(flagged.resource).toBe('listing');
    expect(flagged.resourceId).toBe('lst-audit');
    expect(flagged.metadata).toEqual({ source: 'update' });
  });

  it('an owner store edit adding prohibited text emits store.auto_flagged and still store.update', async () => {
    await seedStore();
    const res = await request(app).put('/api/stores/sto-1')
      .set('X-Store-Owner-Token', OWNER)
      .send({ description: 'Cheap casino tokens available' });
    expect(res.status).toBe(200);
    await settle();

    expect(auditEvents.find((e) => e.action === 'store.update')).toBeTruthy();
    const flagged = auditEvents.find((e) => e.action === 'store.auto_flagged');
    expect(flagged).toBeTruthy();
    expect(flagged.resource).toBe('store');
    expect(flagged.resourceId).toBe('sto-1');
    expect(flagged.metadata).toEqual({ source: 'update' });
  });

  it('attach/detach emit store.attach_listing / store.detach_listing; a rejected attach emits none', async () => {
    await seedStore();
    h.listings.push(makeDoc({
      _id: 'lst-rem', store_id: null, ownerTokenHash: sha256hex(LISTING_OWNER),
      expiresAt: new Date(Date.now() + 86400000), status: 'active', moderationStatus: 'removed',
    }));
    const rejected = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', OWNER)
      .set('X-Owner-Token', LISTING_OWNER)
      .send({ listingId: 'lst-rem' });
    expect(rejected.status).toBe(409);
    await settle();
    expect(auditEvents.some((e) => e.action === 'store.attach_listing')).toBe(false);

    h.listings.push(makeDoc({
      _id: 'lst-ok', store_id: null, ownerTokenHash: sha256hex(LISTING_OWNER),
      expiresAt: new Date(Date.now() + 86400000), status: 'active', moderationStatus: 'approved',
    }));
    const attached = await request(app).put('/api/stores/sto-1/attach-listing')
      .set('X-Store-Owner-Token', OWNER)
      .set('X-Owner-Token', LISTING_OWNER)
      .send({ listingId: 'lst-ok' });
    expect(attached.status).toBe(200);
    await settle();
    const attachEvent = auditEvents.find((e) => e.action === 'store.attach_listing');
    expect(attachEvent).toBeTruthy();
    expect(attachEvent.resource).toBe('store');
    expect(attachEvent.resourceId).toBe('sto-1');
    expect(attachEvent.metadata).toEqual({ listingId: 'lst-ok' });

    const detached = await request(app).put('/api/stores/sto-1/detach-listing')
      .set('X-Store-Owner-Token', OWNER)
      .set('X-Owner-Token', LISTING_OWNER)
      .send({ listingId: 'lst-ok' });
    expect(detached.status).toBe(200);
    await settle();
    const detachEvent = auditEvents.find((e) => e.action === 'store.detach_listing');
    expect(detachEvent).toBeTruthy();
    expect(detachEvent.resource).toBe('store');
    expect(detachEvent.metadata).toEqual({ listingId: 'lst-ok' });
  });

  it('GET /api/admin/payments emits admin.payments_viewed with a correct count; a bogus status is null', async () => {
    h.payments.push(makeDoc({
      _id: 'pay-1', type: 'listing', phoneNumber: '0700000000', amount: 500,
      status: 'completed', createdAt: new Date(),
    }));
    const res = await request(app).get('/api/admin/payments').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    await settle();

    const view = auditEvents.find((e) => e.action === 'admin.payments_viewed');
    expect(view).toBeTruthy();
    expect(view.resource).toBe('admin');
    expect(view.metadata).toEqual({ count: 1, status: null, type: null });

    auditEvents.length = 0;
    const bogus = await request(app).get('/api/admin/payments?status=zzz').set('X-Admin-Session', session());
    expect(bogus.status).toBe(200);
    await settle();
    const bogusView = auditEvents.find((e) => e.action === 'admin.payments_viewed');
    expect(bogusView).toBeTruthy();
    expect(bogusView.metadata.status).toBeNull();
  });
});
