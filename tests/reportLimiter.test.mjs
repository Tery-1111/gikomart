import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The limiter, not the controller, is what this suite exercises: mount a trivial
// handler so no model or database is involved. The default window is 10 per hour
// per IP (REPORT_RATE_LIMIT unset).
const { reportLimiter } = require('../src/middleware/rateLimiter.js');

// A dedicated app instance keeps this file's in-memory rate-limit bucket
// isolated from every other suite.
const app = express();
app.use(express.json());
app.post('/api/reports', reportLimiter, (req, res) => res.json({ success: true }));

describe('Public report rate limit', () => {
  it('does not rate-limit requests 1 through 10', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await request(app).post('/api/reports').send({});
      expect(res.status, `request #${i} must not be rate-limited`).not.toBe(429);
    }
  });

  it('returns 429 on request 11', async () => {
    const res = await request(app).post('/api/reports').send({});
    expect(res.status).toBe(429);
  });
});
