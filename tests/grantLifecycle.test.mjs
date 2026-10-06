import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Free Grant lifecycle additions: atomic redemption claim (race), failure
// rollback, broadcast parity, full-number admin response, history filtering.
// Harness mirrors tests/grantRequest.test.mjs (require.cache fake models, env
// fixtures BEFORE any server import) — one fake differs: fakeGrantModel's
// findOneAndUpdate honours the provisionedAt:null claim filter, which the race
// depends on.
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);
const sha256hex = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

const h = {
  grants: [], listings: [], stores: [], payments: [], blocks: [], acceptances: [], auditEvents: [],
};

function makeDoc(obj) {
  if (!obj) return null;
  const doc = { ...obj };
  doc.save = async () => doc;
  return doc;
}

function oid(n) {
  return '6500000000000000000000' + String(n).padStart(2, '0');
}

// Slowable create hook so a second concurrent redeem can be interlaced.
let listingCreateDelay = null;
let listingCreateThrow = null;

const fakeGrantModel = {
  create: async (data) => {
    const doc = makeDoc({
      _id: oid(h.grants.length + 1), status: 'pending', decidedBy: null, decidedAt: null,
      provisionedAt: null, listingId: null, storeId: null,
      createdAt: new Date(Date.now() + h.grants.length), ...data,
    });
    h.grants.push(doc);
    return doc;
  },
  findById: async (id) => h.grants.find((g) => String(g._id) === String(id)) || null,
  // Atomic-claim semantics: matches on _id AND status (when the caller filters
  // by it) AND the provisionedAt filter (null means "unclaimed"). Mirrors what
  // MongoDB guarantees. The QA flag update carries no status filter on purpose
  // (it works for any status), so status matching is conditional here.
  findOneAndUpdate: async (filter, update) => {
    const g = h.grants.find((x) => String(x._id) === String(filter._id)
      && (filter.status === undefined || x.status === filter.status));
    if (!g) return null;
    if (Object.prototype.hasOwnProperty.call(filter, 'provisionedAt') && filter.provisionedAt === null && g.provisionedAt !== null) {
      return null; // claim already held
    }
    Object.assign(g, update.$set || update);
    return g;
  },
  find: (filter = {}) => {
    const builder = {
      sort: () => builder,
      limit: () => builder,
      lean: async () => h.grants
        .filter((g) => g.status === filter.status)
        .filter((g) => filter.isTest === undefined || Boolean(g.isTest) === filter.isTest)
        .map((g) => ({ ...g })),
      then: (res, rej) => Promise.resolve(builder.lean()).then(res, rej),
      catch: (rej) => Promise.resolve(builder.lean()).catch(rej),
    };
    return builder;
  },
};

const fakeListingModel = {
  create: async (data) => {
    if (listingCreateDelay) await listingCreateDelay();
    if (listingCreateThrow) throw listingCreateThrow;
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

const fakeBlockedContactModel = { findOne: async () => null };
const fakePaymentModel = {
  create: async (data) => { h.payments.push(data); return makeDoc(data); },
  findOne: async () => null, findOneAndUpdate: async () => null,
  countDocuments: async () => 0, aggregate: async () => [],
};
const fakeTermsModel = {
  create: async (data) => { h.acceptances.push(data); return makeDoc({ _id: `ta-${h.acceptances.length}`, ...data }); },
  findByIdAndUpdate: async () => makeDoc({}),
};
const fakeAuditEvent = {
  create: vi.fn(async (data) => { h.auditEvents.push(data); return data; }),
  find: () => ({ sort: () => ({ limit: () => ({ lean: async () => h.auditEvents.map((e) => ({ ...e })) }) }) }),
  countDocuments: vi.fn(async () => 0),
};
const fakeAdminModel = {
  findOne: () => ({ select: () => Promise.resolve(null), then: (res) => Promise.resolve(null).then(res, res) }),
  findOneAndUpdate: async () => null,
  find: () => ({ select: () => ({ lean: async () => [] }) }),
};
const fakeReportModel = {
  create: async (data) => makeDoc(data),
  find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
  countDocuments: async () => 0,
};
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const pass = () => (req, res, next) => next();
const fakeRateLimiterModule = {
  globalLimiter: pass(), uploadLimiter: pass(), uploadDailyLimiter: pass(), paymentLimiter: pass(), listingCreateLimiter: pass(),
  contactLimiter: pass(), adminLimiter: pass(), statusLimiter: pass(), contactReleaseLimiter: pass(), reportLimiter: pass(),
};
const broadcastListing = vi.fn(async () => []);
const fakeWhatsappService = { broadcastListing, formatMessage: () => 'msg' };
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
  h.blocks.length = 0; h.acceptances.length = 0; h.auditEvents.length = 0;
  broadcastListing.mockClear();
  fakeAuditEvent.countDocuments.mockClear();
  fakeAuditEvent.countDocuments.mockResolvedValue(0);
  delete process.env.GRANT_MINT_ALERT_THRESHOLD;
  listingCreateDelay = null;
  listingCreateThrow = null;
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
  return request(app).post('/api/grants').send({ type: 'listing', package: 'standard', whatsapp: '0712345678', ...overrides });
}
async function approve(id) {
  return request(app).post(`/api/admin/grants/${id}/approve`).set('X-Admin-Session', session()).send({});
}
async function redeemListing(claimId, claimToken, overrides = {}) {
  return request(app).post(`/api/grants/${claimId}/redeem`).set('X-Grant-Token', claimToken)
    .send({ listingData: LISTING_DATA, acceptance: LISTING_ACCEPTANCE, ...overrides });
}

describe('Admin grant queue — full WhatsApp number and history', () => {
  it('returns the full normalized number ONLY in the authenticated admin response (with the masked form kept)', async () => {
    const { body: submitted } = await submitListingGrant();
    const res = await request(app).get('/api/admin/grants').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.requests[0].whatsapp).toBe('254712345678');
    expect(res.body.requests[0].whatsappMasked).toBe('2547***78');
    // The admin response must never carry the raw claim token or its stored hash.
    expect(JSON.stringify(res.body)).not.toContain(submitted.claimToken);
    expect(JSON.stringify(res.body)).not.toContain(sha256hex(submitted.claimToken));
    expect(JSON.stringify(res.body)).not.toContain('claimTokenHash');
  });

  it('a session-less request to the grant queue leaks nothing', async () => {
    await submitListingGrant();
    const res = await request(app).get('/api/admin/grants');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('254712345678');
  });

  it('filters by status: pending / approved / rejected, with provisioned derived on approved rows', async () => {
    const a = await submitListingGrant({ whatsapp: '0712000001' });
    const b = await submitListingGrant({ whatsapp: '0712000002' });
    const c = await submitListingGrant({ whatsapp: '0712000003' });
    await approve(a.body.claimId);
    await request(app).post(`/api/admin/grants/${b.body.claimId}/reject`).set('X-Admin-Session', session()).send({});
    await redeemListing(a.body.claimId, a.body.claimToken);

    const pending = await request(app).get('/api/admin/grants?status=pending').set('X-Admin-Session', session());
    const approved = await request(app).get('/api/admin/grants?status=approved').set('X-Admin-Session', session());
    const rejected = await request(app).get('/api/admin/grants?status=rejected').set('X-Admin-Session', session());
    expect(pending.body.requests.map((g) => g.id)).toEqual([c.body.claimId]);
    expect(approved.body.requests.map((g) => g.id)).toEqual([a.body.claimId]);
    expect(approved.body.requests[0].provisioned).toBe(true); // derived, not a status
    expect(rejected.body.requests.map((g) => g.id)).toEqual([b.body.claimId]);
  });

  it('an unknown status value falls back to the pending default', async () => {
    await submitListingGrant();
    const res = await request(app).get('/api/admin/grants?status=bogus').set('X-Admin-Session', session());
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
  });
});

describe('QA/test flag — marking agent-submitted requests', () => {
  it('marks a request and exposes isTest in the queue', async () => {
    const { body: submitted } = await submitListingGrant({ whatsapp: '0712000011' });
    const markRes = await request(app).post(`/api/admin/grants/${submitted.claimId}/qa-flag`)
      .set('X-Admin-Session', session()).send({ isTest: true });
    expect(markRes.status).toBe(200);
    expect(markRes.body).toMatchObject({ success: true, grantId: submitted.claimId, isTest: true });

    const queue = await request(app).get('/api/admin/grants?status=pending').set('X-Admin-Session', session());
    expect(queue.body.requests[0].isTest).toBe(true);
  });

  it('unmarks again and real-seller rows stay untouched (flag defaults to false)', async () => {
    const a = await submitListingGrant({ whatsapp: '0712000012' });
    const b = await submitListingGrant({ whatsapp: '0712000013' });
    await request(app).post(`/api/admin/grants/${a.body.claimId}/qa-flag`).set('X-Admin-Session', session()).send({ isTest: true });
    await request(app).post(`/api/admin/grants/${a.body.claimId}/qa-flag`).set('X-Admin-Session', session()).send({ isTest: false });

    const queue = await request(app).get('/api/admin/grants?status=pending').set('X-Admin-Session', session());
    const rows = Object.fromEntries(queue.body.requests.map((g) => [g.id, g.isTest]));
    expect(rows[a.body.claimId]).toBe(false);
    expect(rows[b.body.claimId]).toBe(false);
  });

  it('unknown grant → 404, malformed id → 400, unauthenticated → 401 (leaks nothing)', async () => {
    const missing = await request(app).post('/api/admin/grants/650000000000000000000099/qa-flag')
      .set('X-Admin-Session', session()).send({ isTest: true });
    expect(missing.status).toBe(404);

    const malformed = await request(app).post('/api/admin/grants/not-an-id/qa-flag')
      .set('X-Admin-Session', session()).send({ isTest: true });
    expect(malformed.status).toBe(400);

    const unauth = await request(app).post('/api/admin/grants/650000000000000000000099/qa-flag').send({ isTest: true });
    expect(unauth.status).toBe(401);
    expect(JSON.stringify(unauth.body)).not.toContain('isTest');
  });

  it('the flag is cosmetic: approve and redeem work unchanged on a marked grant', async () => {
    const { body: submitted } = await submitListingGrant({ whatsapp: '0712000014' });
    await request(app).post(`/api/admin/grants/${submitted.claimId}/qa-flag`)
      .set('X-Admin-Session', session()).send({ isTest: true });

    const approveRes = await approve(submitted.claimId);
    expect(approveRes.status).toBe(200);
    const redeemRes = await redeemListing(submitted.claimId, submitted.claimToken);
    expect(redeemRes.status).toBe(201);
  });

  it('every flag change writes an admin.grant_test_flag_set audit event without token material', async () => {
    const { body: submitted } = await submitListingGrant({ whatsapp: '0712000015' });
    await request(app).post(`/api/admin/grants/${submitted.claimId}/qa-flag`)
      .set('X-Admin-Session', session()).send({ isTest: true });
    await request(app).post(`/api/admin/grants/${submitted.claimId}/qa-flag`)
      .set('X-Admin-Session', session()).send({ isTest: false });

    const events = h.auditEvents.filter((e) => e.action === 'admin.grant_test_flag_set');
    expect(events).toHaveLength(2);
    expect(events[0].metadata).toMatchObject({ isTest: true });
    expect(events[1].metadata).toMatchObject({ isTest: false });
    expect(JSON.stringify(events)).not.toContain(submitted.claimToken);
    expect(JSON.stringify(events)).not.toContain(sha256hex(submitted.claimToken));
  });

  it('supports a queue view filtered to test requests only (isTest query param)', async () => {
    const real = await submitListingGrant({ whatsapp: '0712000016' });
    const test = await submitListingGrant({ whatsapp: '0712000017' });
    await request(app).post(`/api/admin/grants/${test.body.claimId}/qa-flag`).set('X-Admin-Session', session()).send({ isTest: true });

    const onlyReal = await request(app).get('/api/admin/grants?status=pending&isTest=false').set('X-Admin-Session', session());
    expect(onlyReal.body.requests.map((g) => g.id)).toEqual([real.body.claimId]);
    const onlyTest = await request(app).get('/api/admin/grants?status=pending&isTest=true').set('X-Admin-Session', session());
    expect(onlyTest.body.requests.map((g) => g.id)).toEqual([test.body.claimId]);
  });
});

describe('Concurrent redemption — atomic single-winner claim', () => {
  it('two simultaneous redeems: exactly one resource, one valid owner token, the loser never mints one', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);

    // Hold the winner inside provisioning so the loser interlaces while the
    // claim is held — both pass the earlier reads, then contend on the claim.
    // The barrier is released once the loser has resolved (it never enters
    // create), so nothing awaits a request that cannot finish by itself.
    let releaseWinner = () => {};
    listingCreateDelay = () => new Promise((resolve) => { releaseWinner = resolve; });

    const firstPromise = redeemListing(body.claimId, body.claimToken);
    // Supertest is in-process; 150ms is ample for the first request to pass
    // the reads and take the claim before the second one starts.
    await new Promise((r) => setTimeout(r, 150));
    const secondPromise = redeemListing(body.claimId, body.claimToken);
    const second = await Promise.race([
      secondPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('loser request hung')), 4000)),
    ]);
    releaseWinner();
    const first = await firstPromise;

    const responses = [first, second];
    const winner = responses.find((r) => r.status === 201);
    const loser = responses.find((r) => r.status !== 201);
    expect(winner).toBeDefined();
    expect(winner.body.ownerToken).toBeTruthy();
    expect(loser).toBeDefined();
    expect([200, 409]).toContain(loser.status);       // resolves to the winner's outcome or a retryable 409
    expect(loser.body.ownerToken).toBeUndefined();    // never mints a (dead) owner credential
    expect(h.listings).toHaveLength(1);               // exactly one resource exists
    expect(h.listings[0].ownerTokenHash).toBe(sha256hex(winner.body.ownerToken)); // hash matches the returned token
    expect(h.grants[0].provisionedAt).toBeInstanceOf(Date);
  });

  it('a provisioning failure releases the claim so the seller can safely retry', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);

    listingCreateThrow = new Error('provisioning exploded');
    const failed = await redeemListing(body.claimId, body.claimToken);
    expect(failed.status).toBe(500);
    expect(h.listings).toHaveLength(0);
    expect(h.grants[0].provisionedAt).toBeNull(); // claim released — safe retry

    listingCreateThrow = null; // the failure condition itself is cleared for the retry
    const retried = await redeemListing(body.claimId, body.claimToken);
    expect(retried.status).toBe(201);
    expect(h.listings).toHaveLength(1);
    expect(h.listings[0].ownerTokenHash).toBe(sha256hex(retried.body.ownerToken));
  });
});

describe('Free Grant broadcast parity with the paid listing path', () => {
  it('an approved listing grant broadcasts through the EXISTING mechanism', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    await redeemListing(body.claimId, body.claimToken);
    expect(broadcastListing).toHaveBeenCalledTimes(1);
    expect(broadcastListing.mock.calls[0][0]._id).toBe(h.listings[0]._id);
  });

  it('a FLAGGED listing grant is not broadcast (moderation parity with the paid path)', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    const res = await redeemListing(body.claimId, body.claimToken, { listingData: { ...LISTING_DATA, title: 'Casino chips' } });
    expect(res.status).toBe(201);
    expect(h.listings[0].moderationStatus).toBe('flagged');
    expect(broadcastListing).not.toHaveBeenCalled();
  });

  it('a broadcast failure never undoes successful provisioning', async () => {
    broadcastListing.mockRejectedValueOnce(new Error('whapi down'));
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    const res = await redeemListing(body.claimId, body.claimToken);
    expect(res.status).toBe(201);
    expect(h.listings).toHaveLength(1);
    expect(h.grants[0].provisionedAt).toBeInstanceOf(Date);
  });

  it('a store grant never triggers the listing broadcast', async () => {
    const submit = await request(app).post('/api/grants').send({ type: 'store', storePlan: 'standard_monthly', whatsapp: '0712345678' });
    await approve(submit.body.claimId);
    const res = await request(app).post(`/api/grants/${submit.body.claimId}/redeem`).set('X-Grant-Token', submit.body.claimToken)
      .send({ storeData: { name: 'Free Shop', category: 'Books', phone: '0712000000', whatsapp: '0712000000' }, acceptance: STORE_ACCEPTANCE });
    expect(res.status).toBe(201);
    expect(h.stores).toHaveLength(1);
    expect(broadcastListing).not.toHaveBeenCalled();
  });

  it('a Payment row is still never created anywhere in the extended lifecycle', async () => {
    const { body } = await submitListingGrant();
    await approve(body.claimId);
    await redeemListing(body.claimId, body.claimToken);
    expect(h.payments).toHaveLength(0);
  });
});

describe('Admin continuation-token mint — deliberate credential rotation', () => {
  it('replaces the stored hash, revokes the old token, and returns the new raw token ONLY in this response', async () => {
    const { body } = await submitListingGrant();
    const claimId = body.claimId;
    const originalToken = body.claimToken;
    await approve(claimId);

    const mint = await request(app)
      .post(`/api/admin/grants/${claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200);
    expect(mint.body.success).toBe(true);
    expect(mint.body.claimId).toBe(claimId);
    expect(typeof mint.body.claimToken).toBe('string');
    expect(mint.body.claimToken).toMatch(/^[0-9a-f]{48}$/);
    // A genuinely NEW credential — never the one the seller already holds.
    expect(mint.body.claimToken).not.toBe(originalToken);

    // The stored hash now matches ONLY the new token; the old one is dead.
    expect(h.grants[0].claimTokenHash).toBe(sha256hex(mint.body.claimToken));
    const oldStatus = await request(app).get(`/api/grants/status/${claimId}`).set('X-Grant-Token', originalToken);
    expect(oldStatus.status).toBe(401);
    const newStatus = await request(app).get(`/api/grants/status/${claimId}`).set('X-Grant-Token', mint.body.claimToken);
    expect(newStatus.status).toBe(200);
    expect(newStatus.body.status).toBe('approved');

    // The raw token appears nowhere except this action's response.
    expect(JSON.stringify(mint.body)).not.toContain(sha256hex(mint.body.claimToken));
    const list = await request(app).get('/api/admin/grants?status=approved').set('X-Admin-Session', session());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(mint.body.claimToken);
    expect(JSON.stringify(list.body)).not.toContain(sha256hex(mint.body.claimToken));
    expect(JSON.stringify(list.body)).not.toContain('claimTokenHash');
    // The audit event records the rotation without any token material.
    const auditAction = h.auditEvents.find((e) => e.action === 'admin.grant_continuation_minted');
    expect(auditAction).toBeTruthy();
    expect(JSON.stringify(auditAction)).not.toContain(mint.body.claimToken);
  });

  it('a redeemed grant with the OLD token can no longer redeem — rotation blocks stale credentials', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000044' });
    const claimId = body.claimId;
    await approve(claimId);
    const mint = await request(app)
      .post(`/api/admin/grants/${claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200);

    const staleRedeem = await redeemListing(claimId, body.claimToken);
    expect(staleRedeem.status).toBe(401); // old token rejected before any state check
    const freshRedeem = await redeemListing(claimId, mint.body.claimToken);
    expect(freshRedeem.status).toBe(201);
    expect(h.listings).toHaveLength(1);
  });

  it('pending, rejected, and provisioned grants are all refused with 409 (not 404)', async () => {
    const pending = await submitListingGrant({ whatsapp: '0712000051' });
    const rejected = await submitListingGrant({ whatsapp: '0712000052' });
    const redeemable = await submitListingGrant({ whatsapp: '0712000053' });
    await request(app).post(`/api/admin/grants/${rejected.body.claimId}/reject`).set('X-Admin-Session', session()).send({});
    await approve(redeemable.body.claimId);
    await redeemListing(redeemable.body.claimId, redeemable.body.claimToken);

    for (const claimId of [pending.body.claimId, rejected.body.claimId, redeemable.body.claimId]) {
      const res = await request(app)
        .post(`/api/admin/grants/${claimId}/continuation-token`)
        .set('X-Admin-Session', session())
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/approved/i);
    }
  });

  it('an unknown grant id is 404, a malformed id is 400', async () => {
    const missing = await request(app)
      .post('/api/admin/grants/650000000000000000000099/continuation-token')
      .set('X-Admin-Session', session())
      .send({});
    expect(missing.status).toBe(404);

    const malformed = await request(app)
      .post('/api/admin/grants/not-an-id/continuation-token')
      .set('X-Admin-Session', session())
      .send({});
    expect(malformed.status).toBe(400);
  });

  it('an unauthenticated mint attempt is 401 and leaks nothing', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000061' });
    await approve(body.claimId);
    const res = await request(app).post(`/api/admin/grants/${body.claimId}/continuation-token`).send({});
    expect(res.status).toBe(401);
    expect(res.body.claimToken).toBeUndefined();
    // The stored credential is untouched — no rotation happened.
    expect(h.grants[0].claimTokenHash).toBe(sha256hex(body.claimToken));
    const stillWorks = await request(app).get(`/api/grants/status/${body.claimId}`).set('X-Grant-Token', body.claimToken);
    expect(stillWorks.status).toBe(200);
  });
});

describe('Continuation-token mint volume alerting', () => {
  // Drain the fire-and-forget alert evaluation the mint triggered. The alert
  // path itself waits on countDocuments/create, so yielding a few microtask
  // ticks settles it deterministically without sleeping.
  const drainAlert = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  it('stays silent while the window count is below the threshold', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000071' });
    await approve(body.claimId);
    fakeAuditEvent.countDocuments.mockResolvedValue(1);
    process.env.GRANT_MINT_ALERT_THRESHOLD = '5';

    const mint = await request(app)
      .post(`/api/admin/grants/${body.claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200);
    await drainAlert();

    expect(h.auditEvents.some((e) => e.action === 'admin.grant_mint_volume_alert')).toBe(false);
  });

  it('raises an admin.grant_mint_volume_alert at the threshold, carrying counts but no token material', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000072' });
    await approve(body.claimId);
    process.env.GRANT_MINT_ALERT_THRESHOLD = '3';
    fakeAuditEvent.countDocuments.mockResolvedValue(3);

    const mint = await request(app)
      .post(`/api/admin/grants/${body.claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200); // the alert NEVER blocks or alters the mint
    await drainAlert();

    const alert = h.auditEvents.find((e) => e.action === 'admin.grant_mint_volume_alert');
    expect(alert).toBeTruthy();
    expect(alert.actor).toBe('system');
    expect(alert.resource).toBe('grant');
    expect(alert.metadata).toMatchObject({ count: 3, threshold: 3, windowMinutes: 60 });
    expect(JSON.stringify(alert)).not.toContain(mint.body.claimToken);
    expect(JSON.stringify(alert)).not.toContain('claimToken');
  });

  it('ignores an invalid or non-positive threshold and uses the default of 5', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000073' });
    await approve(body.claimId);
    process.env.GRANT_MINT_ALERT_THRESHOLD = '-2';
    fakeAuditEvent.countDocuments.mockResolvedValue(4);

    const mint = await request(app)
      .post(`/api/admin/grants/${body.claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200);
    await drainAlert();

    // count 4 < default 5 → no alert; the check evaluated with the default.
    expect(h.auditEvents.some((e) => e.action === 'admin.grant_mint_volume_alert')).toBe(false);
    fakeAuditEvent.countDocuments.mockResolvedValue(5);
    const second = await request(app)
      .post(`/api/admin/grants/${body.claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(second.status).toBe(200);
    await drainAlert();
    expect(h.auditEvents.some((e) => e.action === 'admin.grant_mint_volume_alert')).toBe(true);
  });

  it('the mint still succeeds when the alert evaluation fails', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000074' });
    await approve(body.claimId);
    fakeAuditEvent.countDocuments.mockRejectedValue(new Error('count exploded'));

    const mint = await request(app)
      .post(`/api/admin/grants/${body.claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200);
    expect(mint.body.claimToken).toMatch(/^[0-9a-f]{48}$/);
    expect(h.grants[0].claimTokenHash).toBe(sha256hex(mint.body.claimToken));
    await drainAlert();
    expect(h.auditEvents.some((e) => e.action === 'admin.grant_mint_volume_alert')).toBe(false);
  });

  it('queries the audit trail for the minted action within a one-hour window', async () => {
    const { body } = await submitListingGrant({ whatsapp: '0712000075' });
    await approve(body.claimId);

    const mint = await request(app)
      .post(`/api/admin/grants/${body.claimId}/continuation-token`)
      .set('X-Admin-Session', session())
      .send({});
    expect(mint.status).toBe(200);
    await drainAlert();

    expect(fakeAuditEvent.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.grant_continuation_minted',
        timestamp: expect.objectContaining({ $gte: expect.any(Date) }),
      }),
    );
    const filter = fakeAuditEvent.countDocuments.mock.calls.at(-1)[0];
    expect(filter.timestamp.$gte.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - filter.timestamp.$gte.getTime()).toBeLessThan(61 * 60 * 1000);
  });
});
