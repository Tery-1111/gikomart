import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';

import termsSvc from '../src/services/termsAcceptanceService.js';
import termsCfg from '../src/config/termsVersions.js';

const { buildTermsVersionsForType, validateAcceptanceToken, sha256 } = termsSvc;
const { TERMS_VERSIONS, ACCEPTANCE_TYPES } = termsCfg;

vi.mock('../src/models/TermsAcceptance.js', () => ({
  default: {
    create: vi.fn().mockImplementation(async (data) => ({
      _id: '650000000000000000000001',
      ...data,
    })),
  },
}));

vi.mock('../src/models/Payment.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue({
      _id: '650000000000000000000099',
      invoiceId: 'INV-TEST-001',
      save: vi.fn().mockResolvedValue(true),
    }),
  },
}));

vi.mock('../src/services/paymentService.js', async () => {
  const actual = await vi.importActual('../src/services/paymentService.js');
  return {
    ...actual,
    initiateIntaSendSTK: vi.fn().mockResolvedValue({
      success: true,
      invoiceId: 'INV-TEST-001',
      amount: 50,
      customerMessage: 'OK',
    }),
  };
});

vi.mock('../src/config/cloudinary.js', () => ({
  api: { ping: vi.fn().mockResolvedValue({ status: 'ok' }) },
  uploader: { upload: vi.fn() },
}));
vi.mock('../src/services/whatsappService.js', () => ({
  // Real service exports broadcastListing + formatMessage (audit Fix 5: the old
  // 'broadcastListingApproved' key matched no real export).
  broadcastListing: vi.fn(),
  formatMessage: vi.fn(),
}));
vi.mock('../src/services/cleanupService.js', () => ({
  startCleanupScheduler: vi.fn(),
}));
vi.mock('../src/config/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

process.env.MONGO_URI = 'mongodb://mocked.invalid/test';
process.env.INTASEND_PUBLISHABLE_KEY = 'test-pub-key';
process.env.INTASEND_SECRET_KEY = 'test-sec-key';
process.env.INTASEND_TEST_MODE = 'true';
process.env.PORT = '0';

// Load server synchronously (accepts that mongo won't connect — routes still work)
import serverMod from '../server.js';
const app = serverMod;

// ─────────────────────────────────────────────────────────────────────────────
// UNIT TESTS: termsAcceptanceService
// ─────────────────────────────────────────────────────────────────────────────
describe('termsAcceptanceService — unit', () => {
  describe('sha256 helper', () => {
    it('returns null for null/undefined values', () => {
      expect(sha256(null)).toBeNull();
      expect(sha256(undefined)).toBeNull();
      expect(sha256('')).toBeDefined();
    });
    it('produces a 64-char hex digest', () => {
      expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
    });
    it('is deterministic', () => {
      expect(sha256('abc123')).toEqual(sha256('abc123'));
    });
  });

  describe('buildTermsVersionsForType', () => {
    it('always includes TOS version', () => {
      for (const type of Object.values(ACCEPTANCE_TYPES)) {
        expect(buildTermsVersionsForType(type).gikomartTermsOfService)
          .toBe(TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE);
      }
    });
    it('STORE_CREATION includes storeOwnerTerms only', () => {
      const v = buildTermsVersionsForType(ACCEPTANCE_TYPES.STORE_CREATION);
      expect(v.storeOwnerTerms).toBe(TERMS_VERSIONS.STORE_OWNER_TERMS);
      expect(v).not.toHaveProperty('sellerTerms');
      expect(v).not.toHaveProperty('buyerTerms');
    });
    it('LISTING_PUBLICATION includes sellerTerms only', () => {
      const v = buildTermsVersionsForType(ACCEPTANCE_TYPES.LISTING_PUBLICATION);
      expect(v.sellerTerms).toBe(TERMS_VERSIONS.SELLER_TERMS);
      expect(v).not.toHaveProperty('storeOwnerTerms');
    });
    it('BUYER_CONTACT includes buyerTerms only', () => {
      const v = buildTermsVersionsForType(ACCEPTANCE_TYPES.BUYER_CONTACT);
      expect(v.buyerTerms).toBe(TERMS_VERSIONS.BUYER_TERMS);
      expect(v).not.toHaveProperty('sellerTerms');
    });
  });

  describe('validateAcceptanceToken — not trusted boolean-only policy', () => {
    it('rejects undefined/null/non-object payloads', () => {
      expect(validateAcceptanceToken(undefined, ACCEPTANCE_TYPES.LISTING_PUBLICATION).valid).toBe(false);
      expect(validateAcceptanceToken(null, ACCEPTANCE_TYPES.LISTING_PUBLICATION).valid).toBe(false);
      expect(validateAcceptanceToken('string!', ACCEPTANCE_TYPES.LISTING_PUBLICATION).valid).toBe(false);
      expect(validateAcceptanceToken(42, ACCEPTANCE_TYPES.LISTING_PUBLICATION).valid).toBe(false);
    });

    it('rejects accepted:false even when versions are correct', () => {
      const r = validateAcceptanceToken({
        accepted: false,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
      }, ACCEPTANCE_TYPES.LISTING_PUBLICATION);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/accepted/);
    });

    it('rejects TOS version mismatch (BUYER_CONTACT)', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: '0.0.0-WRONG',
        buyerTermsVersion: TERMS_VERSIONS.BUYER_TERMS,
      }, ACCEPTANCE_TYPES.BUYER_CONTACT);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/GikoMart Terms version mismatch/);
    });

    it('LISTING_PUBLICATION — valid payload → valid + versions returned', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
        action: 'PAY_AND_PUBLISH',
      }, ACCEPTANCE_TYPES.LISTING_PUBLICATION);
      expect(r.valid).toBe(true);
      expect(r.versions.sellerTerms).toBe(TERMS_VERSIONS.SELLER_TERMS);
    });

    it('LISTING_PUBLICATION — wrong sellerTerms (stale frontend) → invalid', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        sellerTermsVersion: '0.0.1-BAD',
      }, ACCEPTANCE_TYPES.LISTING_PUBLICATION);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/Seller Terms version mismatch/);
    });

    it('STORE_CREATION — valid payload → valid', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        storeOwnerTermsVersion: TERMS_VERSIONS.STORE_OWNER_TERMS,
      }, ACCEPTANCE_TYPES.STORE_CREATION);
      expect(r.valid).toBe(true);
    });

    it('STORE_CREATION — wrong doc set (sellerTerms instead of storeOwner) → invalid', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
      }, ACCEPTANCE_TYPES.STORE_CREATION);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/Store Owner Terms version mismatch/);
    });

    it('BUYER_CONTACT — valid payload → valid', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        buyerTermsVersion: TERMS_VERSIONS.BUYER_TERMS,
      }, ACCEPTANCE_TYPES.BUYER_CONTACT);
      expect(r.valid).toBe(true);
    });

    it('BUYER_CONTACT — wrong buyerTerms version → invalid', () => {
      const r = validateAcceptanceToken({
        accepted: true,
        gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
        buyerTermsVersion: '99.99.99',
      }, ACCEPTANCE_TYPES.BUYER_CONTACT);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/Buyer Terms version mismatch/);
    });

    it('Security blocker: accepted:true alone is NEVER sufficient', () => {
      const cheater = { accepted: true };
      expect(validateAcceptanceToken(cheater, ACCEPTANCE_TYPES.STORE_CREATION).valid).toBe(false);
      expect(validateAcceptanceToken(cheater, ACCEPTANCE_TYPES.LISTING_PUBLICATION).valid).toBe(false);
      expect(validateAcceptanceToken(cheater, ACCEPTANCE_TYPES.BUYER_CONTACT).valid).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES: browse works WITHOUT acceptance
// ─────────────────────────────────────────────────────────────────────────────
describe('Public endpoints — browse/open access preserved (no terms gating)', () => {
  beforeAll(() => {
    // /health gates on Mongo readyState 1 + Cloudinary ping; neither exists
    // in the unit-test environment (no DB connection is made), so simulate
    // the connected state the production process would have.
    Object.defineProperty(mongoose.connection, 'readyState', {
      get: () => 1,
      configurable: true,
    });
  });

  it('GET /health → 200', async () => {
    const res = await request(app).get('/health');
    expect(res.ok).toBe(true);
  });

  it('GET /api/terms/versions → 200 with canonical versions, types, and doc URLs', async () => {
    const res = await request(app).get('/api/terms/versions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.versions).toMatchObject({
      GIKOMART_TERMS_OF_SERVICE: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
      STORE_OWNER_TERMS: TERMS_VERSIONS.STORE_OWNER_TERMS,
      SELLER_TERMS: TERMS_VERSIONS.SELLER_TERMS,
      BUYER_TERMS: TERMS_VERSIONS.BUYER_TERMS,
    });
    expect(res.body.acceptanceTypes).toMatchObject({
      STORE_CREATION: 'STORE_CREATION',
      LISTING_PUBLICATION: 'LISTING_PUBLICATION',
      BUYER_CONTACT: 'BUYER_CONTACT',
    });
    // Exposed docs map (legal page URLs, for frontend to render links)
    expect(typeof res.body.docs).toBe('object');
    expect(res.body.docs['GikoMart Terms of Service']).toBe('/legal/terms-of-service.html');
    expect(res.body.docs['Store Owner Terms & Conditions']).toBe('/legal/store-owner-terms.html');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT INITIATION: server-side acceptance gating
// ─────────────────────────────────────────────────────────────────────────────
describe('Payment initiation — server validates acceptance (frontend not trusted)', () => {
  const validListingPackage = 'quick';
  const validStorePlan = 'starter_weekly';

  const listingBodyBase = {
    phoneNumber: '0700000000',
    package: validListingPackage,
    listingData: {
      title: 'Test Book',
      category: 'student-essentials',
      condition: 'Good',
      price: 500,
      description: 'Used calc textbook',
      sellerName: 'Jane',
      sellerWhatsapp: '0711111111',
      location: 'Njoro',
      images: [],
    },
    website: '',
  };

  it('POST initiate-listing → 400 when acceptance absent entirely', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send(listingBodyBase);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Terms acceptance required/);
  });

  it('POST initiate-listing → 400 when accepted:false', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send({
        ...listingBodyBase,
        acceptance: {
          accepted: false,
          gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
          sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Terms acceptance required/);
  });

  it('POST initiate-listing → 400 when sellerTerms version is wrong', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-listing')
      .send({
        ...listingBodyBase,
        acceptance: {
          accepted: true,
          gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
          sellerTermsVersion: '0.0.0-OLD',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Seller Terms version mismatch/);
  });

  it('POST initiate-store-plan → 400 when acceptance absent', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-store-plan')
      .send({
        phoneNumber: '0700000000',
        storePlan: validStorePlan,
        storeData: {
          name: 'Shop1', category: 'Books', description: '',
          phone: '0700000000', whatsapp: '0711111111',
          email: '', location: 'Njoro',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Terms acceptance required/);
  });

  it('POST initiate-store-plan → 400 when storeOwner version mismatch', async () => {
    const res = await request(app)
      .post('/api/payments/initiate-store-plan')
      .send({
        phoneNumber: '0700000000',
        storePlan: validStorePlan,
        storeData: {
          name: 'Shop1', category: 'Books', description: '',
          phone: '0700000000', whatsapp: '0711111111',
          email: '', location: 'Njoro',
        },
        acceptance: {
          accepted: true,
          gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
          storeOwnerTermsVersion: '9.9.9-FAKE',
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Store Owner Terms version mismatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUYER CONTACT ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/terms/contact-acceptance — buyer contact gate', () => {
  const goodPayload = () => ({
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

  it('missing acceptance → 400 "Acceptance payload required"', async () => {
    const p = goodPayload();
    delete p.acceptance;
    const res = await request(app).post('/api/terms/contact-acceptance').send(p);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Acceptance payload/);
  });

  it('wrong buyerTerms version → 400 version mismatch', async () => {
    const p = goodPayload();
    p.acceptance.buyerTermsVersion = '0.0.1';
    const res = await request(app).post('/api/terms/contact-acceptance').send(p);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Buyer Terms version mismatch/);
  });

  it('accepted=false → 400', async () => {
    const p = goodPayload();
    p.acceptance.accepted = false;
    const res = await request(app).post('/api/terms/contact-acceptance').send(p);
    expect(res.status).toBe(400);
  });

  it('missing listingId → 400 (requires both acceptance and context)', async () => {
    const p = goodPayload();
    delete p.listingId;
    const res = await request(app).post('/api/terms/contact-acceptance').send(p);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/listingId required/);
  });
});
