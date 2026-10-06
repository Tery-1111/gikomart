/* FIX-5(f) — Orphan upload sweep + daily upload limiter tests. Cloudinary and
 * the Upload model are faked; the real cleanupService.destroyOrphanUploads and
 * the real uploadDailyLimiter middleware are exercised. */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const h = {
  uploads: [],
  destroyed: [],
  nextId: 0,
};

function makeDoc(obj) {
  const doc = { ...obj, _id: `upl-${++h.nextId}` };
  return doc;
}

const fakeUploadModel = {
  create: async (data) => {
    const doc = makeDoc({ attached: false, createdAt: new Date(), ...data });
    h.uploads.push(doc);
    return doc;
  },
  find: (filter = {}) => {
    const cutoff = filter.createdAt && filter.createdAt.$lt;
    const hits = h.uploads.filter(u =>
      (filter.attached === undefined || u.attached === filter.attached)
      && (!cutoff || u.createdAt < cutoff));
    let limit = Infinity;
    const builder = {
      limit: (n) => { limit = n; return builder; },
      then: (res) => Promise.resolve(hits.slice(0, limit)).then(res),
    };
    return builder;
  },
  deleteOne: async ({ _id }) => {
    const i = h.uploads.findIndex(u => u._id === _id);
    if (i === -1) return { deletedCount: 0 };
    h.uploads.splice(i, 1);
    return { deletedCount: 1 };
  },
  updateMany: async (filter, update) => {
    const urls = filter.url && filter.url.$in;
    let modifiedCount = 0;
    for (const u of h.uploads) {
      if (urls && urls.includes(u.url) && !u.attached) {
        u.attached = update.attached;
        modifiedCount += 1;
      }
    }
    return { modifiedCount };
  },
};

const destroyImpl = vi.fn(async (publicId) => { h.destroyed.push(publicId); return { result: 'ok' }; });
const fakeCloudinary = { api: { ping: async () => ({ status: 'ok' }) }, uploader: { upload: vi.fn(), destroy: destroyImpl } };
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function injectModule(relPath, exportsObj) {
  const resolved = resolveFromTests(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

injectModule('../src/models/Upload.js', fakeUploadModel);
injectModule('../src/config/cloudinary.js', fakeCloudinary);
injectModule('../src/config/logger.js', fakeLogger);

// Import AFTER injection so cleanupService picks up the fakes
const { destroyOrphanUploads } = await import('../src/services/cleanupService.js');

function makeUpload({ ageHours, attached, url, publicId }) {
  return fakeUploadModel.create({
    publicId,
    url,
    attached,
    createdAt: new Date(Date.now() - ageHours * 60 * 60 * 1000),
  });
}

describe('FIX-5: orphan upload sweep', () => {
  it('unattached upload older than 24h is destroyed and its record deleted', async () => {
    h.uploads.length = 0; h.destroyed.length = 0; destroyImpl.mockClear();
    await makeUpload({ ageHours: 25, attached: false, url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/orphan.jpg', publicId: 'gikomart/orphan' });
    await destroyOrphanUploads();
    expect(destroyImpl).toHaveBeenCalledWith('gikomart/orphan');
    expect(h.uploads.length).toBe(0);
  });

  it('attached upload is kept even when old', async () => {
    h.uploads.length = 0; h.destroyed.length = 0; destroyImpl.mockClear();
    await makeUpload({ ageHours: 48, attached: true, url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/kept.jpg', publicId: 'gikomart/kept' });
    await destroyOrphanUploads();
    expect(destroyImpl).not.toHaveBeenCalled();
    expect(h.uploads.length).toBe(1);
  });

  it('recent unattached upload is kept (before the 24h cutoff)', async () => {
    h.uploads.length = 0; h.destroyed.length = 0; destroyImpl.mockClear();
    await makeUpload({ ageHours: 2, attached: false, url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/fresh.jpg', publicId: 'gikomart/fresh' });
    await destroyOrphanUploads();
    expect(destroyImpl).not.toHaveBeenCalled();
    expect(h.uploads.length).toBe(1);
  });

  it('destroy failure keeps the record so the sweep can retry next run', async () => {
    h.uploads.length = 0; h.destroyed.length = 0;
    destroyImpl.mockImplementationOnce(async () => { throw new Error('cloudinary down'); });
    await makeUpload({ ageHours: 30, attached: false, url: 'https://res.cloudinary.com/demo/image/upload/v1/gikomart/broken.jpg', publicId: 'gikomart/broken' });
    await expect(destroyOrphanUploads()).resolves.toBeUndefined(); // never throws
    expect(h.uploads.length).toBe(1); // record survives for a later attempt
    expect(fakeLogger.warn).toHaveBeenCalled();
  });

  it('sweeps at most 100 orphans per run', async () => {
    h.uploads.length = 0; h.destroyed.length = 0; destroyImpl.mockClear();
    for (let i = 0; i < 105; i++) {
      await makeUpload({ ageHours: 30, attached: false, url: `https://res.cloudinary.com/demo/image/upload/v1/gikomart/bulk${i}.jpg`, publicId: `gikomart/bulk${i}` });
    }
    await destroyOrphanUploads();
    expect(destroyImpl).toHaveBeenCalledTimes(100);
    expect(h.uploads.length).toBe(5); // remainder waits for the next tick
  });
});

// --- uploadDailyLimiter: 101st request inside the 24h window gets 429 ---
describe('FIX-5: uploadDailyLimiter', () => {
  it('returns 429 on request 101', async () => {
    const { uploadDailyLimiter } = require('../src/middleware/rateLimiter');
    const app = express();
    app.use(uploadDailyLimiter);
    app.post('/x', (_req, res) => res.json({ ok: true }));

    let last;
    for (let i = 1; i <= 101; i++) {
      last = await request(app).post('/x');
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ success: false, error: 'Upload limit reached — please wait before trying again' });
  });
});
