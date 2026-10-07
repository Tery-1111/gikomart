import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Env fixtures — set BEFORE any server import so the suite is self-contained
// (CI has no .env; same convention as wiring.test.mjs).
process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

// ─────────────────────────────────────────────────────────────────────────────
// Same seam as the other suites: inject an in-memory VitalsSample fake into
// Node's require.cache BEFORE server.js is imported (vi.mock does not reach
// CJS require() consumers in this vitest/Node setup — see wiring.test.mjs).
// The fake uses plain functions (not vi.fn) so vitest's mockReset cannot wipe
// its implementation between tests.
// ─────────────────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);

const vitalsDocs = [];
const fakeVitalsModel = {
  create: async (data) => {
    vitalsDocs.push(data);
    return { _id: 'vitals-fake', ...data };
  },
};

function injectModule(p, exportsObj) {
  const resolved = require.resolve(p);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/VitalsSample.js', fakeVitalsModel);

const app = require('../server.js');

// Distinct XFF IPs per test: app trusts 1 proxy hop, so this isolates the
// in-memory rate-limit buckets between tests deterministically.
const post = (ip, body) =>
  request(app).post('/api/vitals').set('Content-Type', 'application/json').set('X-Forwarded-For', ip).send(body);

describe('POST /api/vitals (RUM beacon ingestion)', () => {
  beforeEach(() => {
    vitalsDocs.length = 0;
  });

  it('accepts a well-formed payload, persists exactly the allowlisted fields, and stamps ts server-side', async () => {
    const res = await post('203.0.113.11', { path: '/', lcp: 1234.56, inp: 42, cls: 0.031, ttfb: 210, conn: '4g', dpr: 2 });

    expect(res.status).toBe(204);
    expect(vitalsDocs.length).toBe(1);
    const doc = vitalsDocs[0];
    expect(doc.path).toBe('/');
    expect(doc.lcp).toBe(1234.56);
    expect(doc.inp).toBe(42);
    expect(doc.cls).toBe(0.031);
    expect(doc.ttfb).toBe(210);
    expect(doc.conn).toBe('4g');
    expect(doc.dpr).toBe(2);
    expect(doc.ts).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - doc.ts.getTime())).toBeLessThan(5000);
    // Nothing outside the allowlist + ts is ever persisted.
    expect(Object.keys(doc).sort()).toEqual(['cls', 'conn', 'dpr', 'inp', 'lcp', 'path', 'ts', 'ttfb']);
  });

  it('accepts a path-only payload (all metrics optional)', async () => {
    const res = await post('203.0.113.12', { path: '/legal/privacy-policy.html' });

    expect(res.status).toBe(204);
    expect(vitalsDocs.length).toBe(1);
    expect(Object.keys(vitalsDocs[0]).sort()).toEqual(['path', 'ts']);
  });

  it('ignores a client-supplied ts (server clock decides the TTL)', async () => {
    const res = await post('203.0.113.13', { path: '/', ts: '9999-01-01T00:00:00.000Z' });

    expect(res.status).toBe(204);
    const doc = vitalsDocs[0];
    expect(doc.ts).toBeInstanceOf(Date);
    expect(doc.ts.getFullYear()).toBeLessThan(2100);
  });

  it('rejects paths that are not site pathnames', async () => {
    const res = await post('203.0.113.14', { path: 'http://evil.example/pwn' });

    expect(res.status).toBe(400);
    expect(vitalsDocs.length).toBe(0);
  });

  it('rejects out-of-range metric values', async () => {
    const res = await post('203.0.113.15', { path: '/', lcp: 999999 });

    expect(res.status).toBe(400);
    expect(vitalsDocs.length).toBe(0);
  });

  it('rejects unknown conn values', async () => {
    const res = await post('203.0.113.16', { path: '/', conn: '5g-turbo' });

    expect(res.status).toBe(400);
    expect(vitalsDocs.length).toBe(0);
  });

  it('rejects payloads over the 1 KB beacon budget with 413', async () => {
    const res = await post('203.0.113.17', { path: '/', lcp: 1, pad: 'x'.repeat(1100) });

    expect(res.status).toBe(413);
    expect(vitalsDocs.length).toBe(0);
  });

  it('rejects NoSQL operator injection (upstream sanitize middleware)', async () => {
    const res = await post('203.0.113.18', { path: '/', lcp: { $gt: 0 } });

    expect(res.status).toBe(400);
    expect(vitalsDocs.length).toBe(0);
  });

  it('enforces the dedicated vitalsLimiter (30/min/IP) on the beacon path', async () => {
    const ip = '203.0.113.19';
    for (let i = 0; i < 30; i += 1) {
      const res = await post(ip, { path: '/' });
      expect(res.status).toBe(204);
    }
    const res31 = await post(ip, { path: '/' });
    expect(res31.status).toBe(429);
    // The 429 must come from the DEDICATED limiter, not the global one.
    expect(res31.body.error).toBe('Too many vitals reports — please try again later');
  });

  it('global limiter skips /api/vitals: beacon hits do not consume the human budget', async () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < 30; i += 1) {
      await post(ip, { path: '/' });
    }
    // Same IP now makes 99 requests to /health (a globalLimiter-gated path).
    // If the 30 beacon hits had counted toward the global 100/min budget,
    // these would start failing at #71. Any non-429 response (200/503 — the
    // health route reports 503 when Mongo is not connected in tests) proves
    // the request passed the global limiter.
    for (let i = 0; i < 99; i += 1) {
      const res = await request(app).get('/health').set('X-Forwarded-For', ip);
      expect(res.status).not.toBe(429);
    }
  });

  it('global limiter also skips the trailing-slash /api/vitals/ path (pins the bounded regex)', async () => {
    const ip = '203.0.113.21';
    // Express non-strict routing serves /api/vitals/ identically to /api/vitals,
    // so the skip must accept the trailing slash too — without over-matching
    // future siblings (hence the bounded regex, not startsWith). Same
    // discriminator as above: 30 beacon hits + 99 /health GETs from one IP
    // would breach the global 100/min budget at /health #71 if the beacon
    // path were not skipped.
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).post('/api/vitals/').set('Content-Type', 'application/json').set('X-Forwarded-For', ip).send({ path: '/' });
      expect(res.status).toBe(204);
    }
    for (let i = 0; i < 99; i += 1) {
      const res = await request(app).get('/health').set('X-Forwarded-For', ip);
      expect(res.status).not.toBe(429);
    }
  });
});
