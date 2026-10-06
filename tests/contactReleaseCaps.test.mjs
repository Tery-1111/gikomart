/* FIX-6(c) — Contact-release caps. Real recordContactAcceptance handler with
 * the Listing and TermsAcceptance models faked; IP limiters bypassed so only
 * the per-listing and global caps are exercised. */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'node:module';

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
process.env.BLOCK_HASH_SECRET = 'test-block-hash-secret-value';

const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);
const { TERMS_VERSIONS } = require('../src/config/termsVersions');

const LISTING_ID = '507f1f77bcf86cd799439011';

const h = { acceptance: [], nextId: 0 };

const LISTING_DOC = {
  _id: LISTING_ID,
  title: 'Contact Cap Camera',
  status: 'active',
  moderationStatus: 'approved',
  sellerWhatsapp: '0712345678',
};

const fakeListingModel = {
  findOne: async (filter) => {
    if (String(filter._id) === LISTING_ID
      && filter.status === 'active'
      && filter.moderationStatus === 'approved') {
      return { ...LISTING_DOC };
    }
    return null;
  },
  find: () => { const b = { populate: () => b, sort: () => b, skip: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; },
  countDocuments: async () => 0,
};

const fakeTermsModel = {
  create: async (data) => {
    const doc = { _id: `ta-${++h.nextId}`, timestamp: new Date(), ...data };
    h.acceptance.push(doc);
    return doc;
  },
  countDocuments: async (filter = {}) => {
    let rows = h.acceptance;
    if (filter.listingId !== undefined) rows = rows.filter(r => String(r.listingId) === String(filter.listingId));
    if (filter.acceptanceType !== undefined) rows = rows.filter(r => r.acceptanceType === filter.acceptanceType);
    if (filter.timestamp && filter.timestamp.$gte instanceof Date) {
      rows = rows.filter(r => r.timestamp instanceof Date && r.timestamp >= filter.timestamp.$gte);
    }
    return rows.length;
  },
  findByIdAndUpdate: async () => ({}),
};

const fakeBlockedContactModel = { findOne: async () => null, countDocuments: async () => 0 };

const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const fakeAuditEvent = { create: async (d) => d, find: () => { const b = { sort: () => b, limit: () => b, lean: async () => [], then: (res) => Promise.resolve([]).then(res) }; return b; } };

function injectModule(relPath, exportsObj) {
  const resolved = resolveFromTests(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

const realRateLimiter = require('../src/middleware/rateLimiter');
const REAL_CONTACT_RELEASE_LIMITER = realRateLimiter.contactReleaseLimiter;
injectModule('../src/models/Listing.js', fakeListingModel);
injectModule('../src/models/TermsAcceptance.js', fakeTermsModel);
injectModule('../src/models/BlockedContact.js', fakeBlockedContactModel);
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/models/AuditEvent.js', fakeAuditEvent);
// Bypass the IP limiters; the caps under test live in the controller.
injectModule('../src/middleware/rateLimiter.js', {
  ...realRateLimiter,
  globalLimiter: (req, _res, next) => next(),
  uploadLimiter: (req, _res, next) => next(),
  uploadDailyLimiter: (req, _res, next) => next(),
  paymentLimiter: (req, _res, next) => next(),
  listingCreateLimiter: (req, _res, next) => next(),
  contactLimiter: (req, _res, next) => next(),
  contactReleaseLimiter: (req, _res, next) => next(),
  reportLimiter: (req, _res, next) => next(),
  adminLimiter: (req, _res, next) => next(),
});

let app;
beforeAll(async () => { app = (await import('../server.js')).default; });

const ACCEPTANCE = {
  gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  buyerTermsVersion: TERMS_VERSIONS.BUYER_TERMS,
  accepted: true,
};
const CAP_429 = { success: false, error: 'This contact is temporarily unavailable. Please try again later.' };

const release = (n) => request(app).post('/api/terms/contact-acceptance')
  .set('X-Forwarded-For', `203.0.113.${n % 250 + 1}`) // distinct "IPs"; IP is not the cap key
  .send({ listingId: LISTING_ID, acceptance: ACCEPTANCE, listingTitle: 'Contact Cap Camera' });

describe('FIX-6: contact-release caps', () => {
  it('releases normally below the caps', async () => {
    h.acceptance.length = 0; h.nextId = 0;
    const res = await release(1);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sellerWhatsapp).toBe(LISTING_DOC.sellerWhatsapp);
    expect(res.get('Cache-Control')).toContain('no-store');
  });

  it('per-listing cap triggers on the 31st release within an hour', async () => {
    h.acceptance.length = 0; h.nextId = 0;
    for (let i = 0; i < 30; i++) {
      const res = await release(i);
      expect(res.status).toBe(200);
    }
    const thirtyFirst = await release(31);
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.body).toEqual(CAP_429);
  });

  it('global cap triggers even for a fresh listing', async () => {
    h.acceptance.length = 0; h.nextId = 0;
    // 1500 BUYER_CONTACT records inside the window (across other listings)
    for (let i = 0; i < 1500; i++) {
      h.acceptance.push({ _id: `g-${i}`, acceptanceType: 'BUYER_CONTACT', listingId: '607f1f77bcf86cd799439099', timestamp: new Date() });
    }
    const res = await release(1);
    expect(res.status).toBe(429);
    expect(res.body).toEqual(CAP_429);
  });

  it('contactReleaseLimiter now defaults to 20 per hour per IP', async () => {
    const mini = express();
    mini.use(REAL_CONTACT_RELEASE_LIMITER);
    mini.post('/x', (_req, res) => res.json({ ok: true }));
    let last;
    for (let i = 1; i <= 21; i++) {
      last = await request(mini).post('/x');
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ success: false, error: 'Too many contact releases — please try again later' });
  });
});
