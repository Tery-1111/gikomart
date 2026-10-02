import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The status handler performs one DB read to answer; give it a fake Payment
// model so requests never buffer against an unconnected mongoose. The limiter,
// not the read, is what this suite exercises.
{
  const resolved = require.resolve('../src/models/Payment.js');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    path: resolved,
    exports: { findOne: async () => null },
  };
}

const paymentsRouter = require('../src/routes/payments.js');

// A dedicated app instance keeps this file's in-memory rate-limit bucket
// isolated from every other suite (vitest also isolates module registries per
// file, but the explicit instance makes that guarantee local and obvious).
const app = express();
app.use(express.json());
app.use('/api/payments', paymentsRouter);

describe('Payment status rate limit', () => {
  it('does not rate-limit requests 1 through 60', async () => {
    for (let i = 1; i <= 60; i++) {
      const res = await request(app).get('/api/payments/status/INV-LIMIT');
      expect(res.status, `request #${i} must not be rate-limited`).not.toBe(429);
    }
  });

  it('returns 429 on request 61', async () => {
    const res = await request(app).get('/api/payments/status/INV-LIMIT');
    expect(res.status).toBe(429);
  });
});
