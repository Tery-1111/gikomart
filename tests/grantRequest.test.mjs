import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Env fixtures — BEFORE any server import (CI has no .env). Mirrors the harness
// in tests/grantPreview.test.mjs.
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);
const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

const h = {
  grants: [],
  listings: [],
  stores: [],
  payments: [],
  blocks: [],
  acceptances: [],
  auditEvents: [],
  admins: new Map(),
};

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

// 24-hex ids so mongoose.Types.ObjectId.isValid() passes (the controller guards
// on it), and so the created Listing/Store paymentId is a real ObjectId shape.
function oid(n) {
  return '6500000000000000000000' + String(n).padStart(2, '0');
}

const fakeGrantModel = {
  create: async (data) => {
    const doc = makeDoc({
      _id: oid(h.grants.length + 1),
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      provisionedAt: null,
      listingId: null,
      storeId: null,
      createdAt: new Date(Date.now() + h.grants.length),
      ...data,
    });
    h.grants.push(doc);
    return doc;
  },
  // Returns the STORED object (not a copy) so grant.save() persists.
  findById: async (id) => h.grants.find((g) => String(g._id) === String(id)) || null,
  findOneAndUpdate: async (filter, update) => {
    const g = h.grants.find((x) => String(x._id) === String(filter._id) && x.status === filter.status);
    if (!g) return null;
    Object.assign(g, update.$set || update);
    return g;
  },
  find: (filter = {}) => {
    const builder = {
      sort: () => builder,
      limit: () => builder,
      lean: async () => h.grants.filter((g) => g.status === filter.status).map((g) => ({ ...g })),
      then: (res, rej) => Promise.resolve(builder.lean()).then(res, rej),
      catch: (rej) => Promise.resolve(builder.lean()).catch(rej),
    };
    return builder;
  },
};

const fakeListingModel = {
  create: async (data) => {
    if (data && data.paymentId != null && h.listings.some((l) => String(l.paymentId) === String(data.paymentId))) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { paymentId: 1 };
      throw dup;
    }
    const doc = makeDoc({ _id: `lst-${h.listings.length + 1}`, store_id: null, status: 'active', moderationStatus: 'approved', ...data });
    h.listings.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    if (filter.paymentId != null) return h.listings.find((l) => String(l.paymentId) === String(filter.paymentId)) || null;
    return null;
  },
};

const fakeStoreModel = {
  create: async (data) => {
    if (data && data.paymentId != null && h.stores.some((s) => String(s.paymentId) === String(data.paymentId))) {
      const dup = new Error('E11000 duplicate key error');
      dup.code = 11000;
      dup.keyPattern = { paymentId: 1 };
      throw dup;
    }
    const doc = makeDoc({ _id: `sto-${h.stores.length + 1}`, status: 'active', moderationStatus: 'approved', ...data });
    h.stores.push(doc);
    return doc;
  },
  findOne: async (filter = {}) => {
    if (filter.slug !== undefined) return h.stores.find((s) => s.slug === filter.slug) || null;
    if (filter.paymentId != null) return h.stores.find((s) => String(s.paymentId) === String(filter.paymentId)) || null;
    return null;
  },
};

const fakeBlockedContactModel = {
  findOne: async (filter = {}) => {
    const expected = filter.contactHash;
    return h.blocks.find((b) => b.contactHash === expected) || null;
  },
};

const fakePaymentModel = {
  create: async (data) => { h.payments.push(data); return makeDoc(data); },
  findOne: async () => null,
  findOneAndUpdate: async () => null,
  countDocuments: async () => 0,
  aggregate: async () => [],
};

const fakeTermsModel = {
  create: async (data) => { h.acceptances.push(data); return makeDoc({ _id: `ta-${h.acceptances.length}`, ...data }); },
  findByIdAndUpdate: async () => makeDoc({}),
};

const fakeAuditEvent = {
  create: vi.fn(async (data) => { h.auditEvents.push(data); return data; }),
  find: () => {
    const builder = { sort: () => builder, limit: () => builder, lean: async () => h.auditEvents.map((e) => ({ ...e })) };
    return builder;
  },
};

const fakeAdminModel = {
  findOne: () => ({ select: () => Promise.resolve(null), then: (res) => Promise.resolve(null).then(res, res) }),
  findOneAndUpdate: async () => null,
  find: () => ({ select: () => ({ lean: async () => [] }) }),
};

const fakeReportModel = {
  create: async (data) => makeDoc(data),
  find: () => {
    const builder = { sort: () => builder, limit: () => builder, lean: async () => [] };
    return builder;
  },
  countDocuments: async () => 0,
};

const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const pass = () => (req, res, next) => next();
const fakeRateLimiterModule = {
  globalLimiter: pass(), uploadLimiter: pass(), uploadDailyLimiter: pass(), paymentLimiter: pass(), listingCreateLimiter: pass(),
  contactLimiter: pass(), adminLimiter: pass(), statusLimiter: pass(), contactReleaseLimiter: pass(), reportLimiter: pass(),
};

const fakeWhatsappService = { broadcastListing: vi.fn(async () => []), formatMessage: () => 'msg' };
const fakeCloudinary = { api: { ping: async () => ({ status: 'ok' }) }, uploader: { upload: vi.fn(), destroy: vi.fn() } };

function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/GrantRequest.js', fakeGrantModel);
injectModule('../src/models/Payment.js', fakePaymentModel);
injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/Store.js', fakeStoreModel);
injectModule('../src/models/BlockedContact.js', fakeBlockedContactModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
injectModule('../src/models/Admin.js', fakeAdminModel);
injectModule('../src/models/Report.js', fakeReportModel);
injectModule('../src/services/whatsappService.js', fakeWhatsappService);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });
beforeEach(() => {
  h.grants.length = 0; h.listings.length = 0; h.stores.length = 0; h.payments.length = 0;
  h.blocks.length = 0; h.acceptances.length = 0; h.auditEvents.length = 0; h.admins.clear();
});
afterAll(() => { vi.restoreAllMocks(); });

function session() {
  const { signSession } = require('../src/middleware/adminAuth');
  return signSession({ username: 'owner', role: 'admin', exp: Date.now() + 60_000 });
}

const LISTING_ACCEPTANCE = { accepted: true, gikomartTermsVersion: '1.0.0', sellerTermsVersion: '1.0.0' };
const STORE_ACCEPTANCE = { accepted: true, gikomartTermsVersion: '1.0.0', storeOwnerTermsVersion: '1.0.0' };

const LISTING_DATA = {
  title: 'Free textbook', category: 'Books', condition: 'Good', price: 300,
  description: 'A gently used textbook.', sellerName: 'Seller', sellerWhatsapp: '254700000001',
};

async function submitListingGrant(overrides = {}) {
  const res = await request(app).post('/api/grants').send({ type: 'listing', package: 'standard', whatsapp: '0712345678', ...overrides });
  return res;
}

async function approve(id, token = session()) {
  return request(app).post(`/api/admin/grants/${id}/approve`).set('X-Admin-Session', token).send({});
}

async function redeemListing(claimId, claimToken, overrides = {}) {
  return request(app).post(`/api/grants/${claimId}/redeem`).set('X-Grant-Token', claimToken)
    .send({ listingData: LISTING_DATA, acceptance: LISTING_ACCEPTANCE, ...overrides });
}

describe('POST /api/grants — request validation', () => {
  it('creates a pending listing request and returns a one-time claim token', async () => {
    const res = await submitListingGrant();
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('pending');
    expect(typeof res.body.claimToken).toBe('string');
    expect(res.body.claimToken).toHaveLength(48);
    expect(h.grants).toHaveLength(1);
    // Only the hash is stored — the raw token is never persisted.
    expect(h.grants[0].claimTokenHash).toBe(sha256hex(res.body.claimToken));
    expect(JSON.stringify(h.grants[0])).not.toContain(res.body.claimToken);
  });

  it('normalizes the WhatsApp number to 254 form', async () => {
    await submitListingGrant({ whatsapp: '0712 345 678' });
    expect(h.grants[0].whatsapp).toBe('254712345678');
  });

  it('400 on an invalid WhatsApp number', async () => {
    const res = await submitListingGrant({ whatsapp: 'nope' });
    expect(res.status).toBe(400);
    expect(h.grants).toHaveLength(0);
  });

  it('400 on an invalid listing package', async () => {
    const res = await submitListingGrant({ package: 'gold' });
    expect(res.status).toBe(400);
    expect(h.grants).toHaveLength(0);
  });

  it('400 on an invalid store plan', async () => {
    const res = await request(app).post('/api/grants').send({ type: 'store', storePlan: 'mega', whatsapp: '0712345678' });
    expect(res.status).toBe(400);
    expect(h.grants).toHaveLength(0);
  });

  it('400 on an invalid grant type', async () => {
    const res = await request(app).post('/api/grants').send({ type: 'boost', whatsapp: '0712345678' });
    expect(res.status).toBe(400);
  });

  it('403 for a blocked contact', async () => {
    h.blocks.push({ contactHash: require('../src/utils/phone').contactHash('0712345678') });
    const res = await submitListingGrant();
    expect(res.status).toBe(403);
    expect(h.grants).toHaveLength(0);
  });

  it('a filled honeypot field drops the request without creating a record', async () => {
    const res = await submitListingGrant({ website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(h.grants).toHaveLength(0);
  });
});

describe('GET /api/grants/status/:claimId — claim verification', () => {
  it('401 without a grant token', async () => {
    const { body } = await submitListingGrant();
    const res = await request(app).get(`/api/grants/status/${body.claimId}`);
    expect(res.status).toBe(401);
  });

  it('401 with the wrong grant token', async () => {
    const { body } = await submitListingGrant();
    const res = await request(app).get(`/api/grants/status/${body.claimId}`).set('X-Grant-Token', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns pending with the right token', async () => {
    const { body } = await submitListingGrant();
    const res = await request(app).get(`/api/grants/status/${body.claimId}`).set('X-Grant-Token', body.claimToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.type).toBe('listing');
  });
});

describe('Admin grant queue', () => {
  it('401 without a session and mutates nothing', async () => {
    await submitListingGrant();
    const res = await request(app).post(`/api/admin/grants/${h.grants[0]._id}/approve`).send({});
    expect(res.status).toBe(401);
    expect(h.grants[0].status).toBe('pending');
  });

  it('lists a pending request with the full number (session-gated admin only) plus the masked form', async () => {
    await submitListingGrant();
    const res = await request(app).get('/api/admin/grants').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].whatsappMasked).toBe('2547***78');
    // The full normalized number is exposed to the authenticated admin queue
    // (wa.me contact + verification) — but never a claim token or its hash.
    expect(res.body.requests[0].whatsapp).toBe('254712345678');
    expect(JSON.stringify(res.body)).not.toContain('claimTokenHash');
  });

  it('approves a pending request and records the admin actor', async () => {
    await submitListingGrant();
    const res = await approve(h.grants[0]._id);
    expect(res.status).toBe(200);
    expect(h.grants[0].status).toBe('approved');
    expect(h.grants[0].decidedBy).toBe('admin:owner');
    expect(h.grants[0].decidedAt).toBeInstanceOf(Date);
  });

  it('cannot approve twice (atomic pending → approved)', async () => {
    await submitListingGrant();
    const first = await approve(h.grants[0]._id);
    const second = await approve(h.grants[0]._id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });

  it('rejects a pending request', async () => {
    await submitListingGrant();
    const res = await request(app).post(`/api/admin/grants/${h.grants[0]._id}/reject`).set('X-Admin-Session', session()).send({});
    expect(res.status).toBe(200);
    expect(h.grants[0].status).toBe('rejected');
  });

  it('ignores any package/whatsapp supplied in the approval body', async () => {
    await submitListingGrant();
    await request(app).post(`/api/admin/grants/${h.grants[0]._id}/approve`).set('X-Admin-Session', session())
      .send({ package: 'premium', whatsapp: '0799999999' });
    expect(h.grants[0].package).toBe('standard');
    expect(h.grants[0].whatsapp).toBe('254712345678');
  });
});

describe('POST /api/grants/:claimId/redeem — provisioning', () => {
  it('409 before approval', async () => {
    const { body } = await submitListingGrant();
    const res = await redeemListing(body.claimId, body.claimToken);
    expect(res.status).toBe(409);
    expect(h.listings).toHaveLength(0);
  });

  it('a rejected grant cannot be redeemed', async () => {
    const { body } = await submitListingGrant();
    await request(app).post(`/api/admin/grants/${body.claimId}/reject`).set('X-Admin-Session', session()).send({});
    const res = await redeemListing(body.claimId, body.claimToken);
    expect(res.status).toBe(409);
    expect(h.listings).toHaveLength(0);
  });

  it('creates a normal listing, returns the owner token, and stores only its hash', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);

    const res = await redeemListing(body.claimId, body.claimToken);
    expect(res.status).toBe(201);
    expect(res.body.resource.type).toBe('listing');
    expect(typeof res.body.ownerToken).toBe('string');

    expect(h.listings).toHaveLength(1);
    const listing = h.listings[0];
    // The producing record id is the unique-sparse paymentId.
    expect(String(listing.paymentId)).toBe(String(body.claimId));
    // The raw token is never stored — only its sha256.
    expect(listing.ownerTokenHash).toBe(sha256hex(res.body.ownerToken));
    // Expiry is the standard package duration (standard = 7 days).
    const days = Math.round((new Date(listing.expiresAt) - Date.now()) / 86400000);
    expect(days).toBe(7);
    // The grant is marked provisioned with the resource id.
    expect(h.grants[0].provisionedAt).toBeInstanceOf(Date);
    expect(String(h.grants[0].listingId)).toBe(String(listing._id));
  });

  it('applies moderation (a prohibited listing is flagged, not blocked)', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    const res = await redeemListing(body.claimId, body.claimToken, {
      listingData: { ...LISTING_DATA, title: 'Casino chips' },
    });
    expect(res.status).toBe(201);
    expect(h.listings[0].moderationStatus).toBe('flagged');
  });

  it('400 when the acceptance token is missing/invalid', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    const res = await request(app).post(`/api/grants/${body.claimId}/redeem`).set('X-Grant-Token', body.claimToken)
      .send({ listingData: LISTING_DATA, acceptance: { accepted: false } });
    expect(res.status).toBe(400);
    expect(h.listings).toHaveLength(0);
  });

  it('400 on an invalid listing payload', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    const res = await redeemListing(body.claimId, body.claimToken, { listingData: { title: '' } });
    expect(res.status).toBe(400);
    expect(h.listings).toHaveLength(0);
  });

  it('is idempotent: a second redeem returns the existing resource without creating a duplicate', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    const first = await redeemListing(body.claimId, body.claimToken);
    const second = await redeemListing(body.claimId, body.claimToken);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.alreadyProvisioned).toBe(true);
    expect(second.body.resource.id).toBe(first.body.resource.id);
    expect(h.listings).toHaveLength(1);
  });

  it('creates a normal store for a store grant', async () => {
    const submit = await request(app).post('/api/grants').send({ type: 'store', storePlan: 'standard_monthly', whatsapp: '0712345678' });
    const { claimId, claimToken } = submit.body;
    await approve(claimId);

    const res = await request(app).post(`/api/grants/${claimId}/redeem`).set('X-Grant-Token', claimToken)
      .send({ storeData: { name: 'Free Shop', category: 'Books', phone: '0712000000', whatsapp: '0712000000' }, acceptance: STORE_ACCEPTANCE });

    expect(res.status).toBe(201);
    expect(res.body.resource.type).toBe('store');
    expect(h.stores).toHaveLength(1);
    expect(h.stores[0].plan).toBe('standard_monthly');
    expect(h.stores[0].listing_limit).toBe(10);
    expect(h.stores[0].ownerTokenHash).toBe(sha256hex(res.body.ownerToken));
  });
});

describe('Financial integrity — Free Grant creates no payment', () => {
  it('never writes a Payment row during the whole grant lifecycle', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    await redeemListing(body.claimId, body.claimToken);
    expect(h.payments).toHaveLength(0);
  });

  it('records an audit trail for request, approval and redemption', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    await redeemListing(body.claimId, body.claimToken);
    const actions = h.auditEvents.map((e) => e.action);
    expect(actions).toContain('grant.requested');
    expect(actions).toContain('admin.grant_approved');
    expect(actions).toContain('grant.redeemed');
  });
});
