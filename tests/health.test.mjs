import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

// Public health is a plain router; admin health lives on the admin controller.
// Both must be exercised against their real source. The Cloudinary API is
// replaced via require.cache (the repo-standard CJS seam — vi.mock does not
// reach require() consumers here) so no network call is ever made and we can
// count pings to prove the public route never touches Cloudinary.
const require = createRequire(import.meta.url);

function injectModule(relPath, exportsObj) {
  const filename = require.resolve(relPath);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    path: filename,
    exports: exportsObj,
  };
}

const cloudinaryFake = { api: { ping: vi.fn() } };
injectModule('../src/config/cloudinary.js', cloudinaryFake);

const healthRouter = require('../src/routes/health.js');
const { getHealth } = require('../src/controllers/adminController');

const app = express();
app.use('/health', healthRouter);

let readyStateValue = 0;

function makeRes() {
  const res = { statusCode: 0, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

beforeAll(() => {
  // Nothing here should ever make a real network call.
  cloudinaryFake.api.ping.mockResolvedValue({ status: 'ok' });
});

beforeEach(() => {
  readyStateValue = 0;
  // Shadow the real prototype getter with a controllable own property; the
  // afterEach below removes it so no other code sees our value.
  Object.defineProperty(mongoose.connection, 'readyState', {
    get: () => readyStateValue,
    configurable: true,
  });
});

afterEach(() => {
  delete mongoose.connection.readyState;
  cloudinaryFake.api.ping.mockClear();
});

describe('Public /health — minimal, MongoDB only', () => {
  it('returns 200 with exactly { status: "healthy" } when MongoDB is up', async () => {
    readyStateValue = 1;

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'healthy' });
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  it('returns 503 with exactly { status: "unhealthy" } when MongoDB is down', async () => {
    readyStateValue = 0;

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unhealthy' });
    expect(Object.keys(res.body)).toEqual(['status']);
  });

  it('never pings Cloudinary and exposes no dependency details', async () => {
    readyStateValue = 1;
    await request(app).get('/health');
    readyStateValue = 0;
    await request(app).get('/health');

    expect(cloudinaryFake.api.ping).not.toHaveBeenCalled();
  });
});

describe('Admin getHealth — detailed, always HTTP 200', () => {
  it('reports healthy when MongoDB is up and the Cloudinary ping resolves', async () => {
    readyStateValue = 1;
    cloudinaryFake.api.ping.mockResolvedValueOnce({ status: 'ok' });

    const res = makeRes();
    await getHealth({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('healthy');
    expect(res.body.checks).toEqual({ mongodb: true, cloudinary: true });
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    expect(Number.isInteger(res.body.uptimeSec)).toBe(true);
  });

  it('reports degraded when MongoDB is up but the Cloudinary ping rejects', async () => {
    readyStateValue = 1;
    cloudinaryFake.api.ping.mockRejectedValueOnce(new Error('boom'));

    const res = makeRes();
    await getHealth({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toEqual({ mongodb: true, cloudinary: false });
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    expect(Number.isInteger(res.body.uptimeSec)).toBe(true);
  });

  it('reports unhealthy when MongoDB is down', async () => {
    readyStateValue = 0;
    cloudinaryFake.api.ping.mockResolvedValueOnce({ status: 'ok' });

    const res = makeRes();
    await getHealth({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.checks.mongodb).toBe(false);
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
    expect(Number.isInteger(res.body.uptimeSec)).toBe(true);
  });
});
