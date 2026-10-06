import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Fake models so the route never buffers against an unconnected mongoose. These
// requests are expected to fail validation (400/404) — the limiter, not the
// handler, is what this suite exercises.
{
  const listingResolved = require.resolve('../src/models/Listing.js');
  require.cache[listingResolved] = {
    id: listingResolved,
    filename: listingResolved,
    loaded: true,
    path: listingResolved,
    exports: { findOne: async () => null },
  };
  const termsResolved = require.resolve('../src/models/TermsAcceptance.js');
  require.cache[termsResolved] = {
    id: termsResolved,
    filename: termsResolved,
    loaded: true,
    path: termsResolved,
    exports: {
      create: async (data) => ({ _id: 'ta-limit', ...data }),
      // controller-level contact-release caps read counts through this;
      // 0 keeps them inactive so this suite exercises only the limiter
      countDocuments: async () => 0,
    },
  };
}

// Isolate the limiter under test: every other limiter passes through, while the
// real contactReleaseLimiter stays in place. Without this, the route's existing
// contactLimiter (20/min) would 429 before the 40-hour contact-release budget.
const pass = () => (req, _res, next) => next();
const realRateLimiter = require('../src/middleware/rateLimiter');
{
  const resolved = require.resolve('../src/middleware/rateLimiter.js');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    path: resolved,
    exports: {
      ...realRateLimiter,
      globalLimiter: pass(),
      uploadLimiter: pass(),
      paymentLimiter: pass(),
      listingCreateLimiter: pass(),
      contactLimiter: pass(),
      adminLimiter: pass(),
      // contactReleaseLimiter intentionally left real.
    },
  };
}

const termsRouter = require('../src/routes/terms.js');

// A dedicated app instance keeps this file's in-memory rate-limit bucket
// isolated from every other suite.
const app = express();
app.use(express.json());
app.use('/api/terms', termsRouter);

describe('Contact release rate limit', () => {
  // Default tightened from 40 to 20 per hour per IP (security hardening).
  it('does not rate-limit requests 1 through 20', async () => {
    for (let i = 1; i <= 20; i++) {
      const res = await request(app).post('/api/terms/contact-acceptance').send({});
      expect(res.status, `request #${i} must not be rate-limited`).not.toBe(429);
    }
  });

  it('returns 429 on request 21', async () => {
    const res = await request(app).post('/api/terms/contact-acceptance').send({});
    expect(res.status).toBe(429);
  });
});
