import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const NOW = new Date('2026-10-02T12:00:00.000Z');
const SINCE24 = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const SINCE7 = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
const SINCE30 = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

const { computeMetrics } = require('../src/services/metricsService');

// A model double that records every call and lets a test set the values it
// returns.
function makeModel() {
  const model = { countCalls: [], aggCalls: [], countReturn: 0, aggRows: [] };
  model.countDocuments = async (filter) => { model.countCalls.push(filter); return model.countReturn; };
  model.aggregate = async (pipeline) => { model.aggCalls.push(pipeline); return model.aggRows; };
  return model;
}

function makeModels() {
  const Listing = makeModel();
  const Store = makeModel();
  const Payment = makeModel();
  const Report = makeModel();
  const BlockedContact = makeModel();
  return { models: { Listing, Store, Payment, Report, BlockedContact }, Listing, Store, Payment, Report, BlockedContact };
}

const EXPECTED_PIPELINE = [
  { $match: { status: 'completed', grantedAt: null, createdAt: { $gte: SINCE30 } } },
  {
    $group: {
      _id: '$type',
      last24h: { $sum: { $cond: [{ $gte: ['$createdAt', SINCE24] }, '$amount', 0] } },
      last7d: { $sum: { $cond: [{ $gte: ['$createdAt', SINCE7] }, '$amount', 0] } },
      last30d: { $sum: '$amount' },
    },
  },
];

describe('computeMetrics — query shapes', () => {
  it('sends exactly the eleven countDocuments filters and the aggregate pipeline', async () => {
    const { models, Listing, Store, Payment, Report, BlockedContact } = makeModels();

    await computeMetrics(models, NOW);

    expect(Listing.countCalls).toEqual([
      { status: 'active', moderationStatus: 'approved', expiresAt: { $gt: NOW } },
      { moderationStatus: 'flagged' },
    ]);
    expect(Store.countCalls).toEqual([
      { status: 'active', expires_at: { $gt: NOW } },
      { moderationStatus: 'flagged' },
      { status: 'suspended' },
    ]);
    expect(Payment.countCalls).toEqual([
      { status: 'pending' },
      { status: 'completed', createdAt: { $gte: SINCE24 } },
      { status: 'failed', createdAt: { $gte: SINCE24 } },
      { status: 'completed', grantedAt: { $ne: null }, createdAt: { $gte: SINCE30 } },
    ]);
    expect(Report.countCalls).toEqual([{ status: 'open' }]);
    expect(BlockedContact.countCalls).toEqual([{}]);

    const totalCountCalls = Listing.countCalls.length + Store.countCalls.length + Payment.countCalls.length
      + Report.countCalls.length + BlockedContact.countCalls.length;
    expect(totalCountCalls).toBe(11);

    expect(Payment.aggCalls).toEqual([EXPECTED_PIPELINE]);
  });
});

describe('computeMetrics — revenue shaping', () => {
  it('sums the known types and ignores other rows', async () => {
    const { models, Payment } = makeModels();
    Payment.aggRows = [
      { _id: 'listing', last24h: 50, last7d: 200, last30d: 500 },
      { _id: 'boost', last24h: 0, last7d: 80, last30d: 130 },
      { _id: 'store', last24h: 150, last7d: 150, last30d: 450 },
      { _id: 'weird', last24h: 99, last7d: 99, last30d: 99 },
    ];

    const r = await computeMetrics(models, NOW);

    expect(r.revenue.last24h).toBe(200);
    expect(r.revenue.last7d).toBe(430);
    expect(r.revenue.last30d).toBe(1080);
    expect(r.revenue.byType30d).toEqual({ listing: 500, boost: 130, store: 450 });
  });

  it('returns all-zero revenue for an empty aggregate', async () => {
    const { models, Payment } = makeModels();
    Payment.aggRows = [];

    const r = await computeMetrics(models, NOW);

    expect(r.revenue.last24h).toBe(0);
    expect(r.revenue.last7d).toBe(0);
    expect(r.revenue.last30d).toBe(0);
    expect(r.revenue.byType30d).toEqual({ listing: 0, boost: 0, store: 0 });
  });

  it('coerces a numeric string, null and undefined to numbers', async () => {
    const { models, Payment } = makeModels();
    Payment.aggRows = [{ _id: 'listing', last24h: '25', last7d: null, last30d: undefined }];

    const r = await computeMetrics(models, NOW);

    expect(r.revenue.last24h).toBe(25);
    expect(r.revenue.last7d).toBe(0);
    expect(r.revenue.last30d).toBe(0);
  });
});

describe('computeMetrics — result shape', () => {
  it('returns exactly the specified keys and values', async () => {
    const { models, Listing, Store, Payment, Report, BlockedContact } = makeModels();
    Listing.countReturn = 11;
    Store.countReturn = 3;
    Payment.countReturn = 2;
    Report.countReturn = 4;
    BlockedContact.countReturn = 5;

    const r = await computeMetrics(models, NOW);

    expect(Object.keys(r)).toEqual(['generatedAt', 'listings', 'stores', 'payments', 'revenue', 'reports', 'blocks']);
    expect(Object.keys(r.listings)).toEqual(['active', 'flagged']);
    expect(Object.keys(r.stores)).toEqual(['active', 'flagged', 'suspended']);
    expect(Object.keys(r.payments)).toEqual(['pending', 'completed24h', 'failed24h', 'granted30d']);
    expect(Object.keys(r.revenue)).toEqual(['currency', 'last24h', 'last7d', 'last30d', 'byType30d']);
    expect(Object.keys(r.revenue.byType30d)).toEqual(['listing', 'boost', 'store']);
    expect(Object.keys(r.reports)).toEqual(['open']);
    expect(Object.keys(r.blocks)).toEqual(['total']);

    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r.revenue.currency).toBe('KSh');
    expect(r.listings).toEqual({ active: 11, flagged: 11 });
    expect(r.stores).toEqual({ active: 3, flagged: 3, suspended: 3 });
    expect(r.payments).toEqual({ pending: 2, completed24h: 2, failed24h: 2, granted30d: 2 });
    expect(r.reports).toEqual({ open: 4 });
    expect(r.blocks).toEqual({ total: 5 });
  });

  it('propagates a rejecting model call', async () => {
    const { models, Listing } = makeModels();
    Listing.countDocuments = async () => { throw new Error('db down'); };

    await expect(computeMetrics(models, NOW)).rejects.toThrow('db down');
  });
});

// ── getMetrics handler ──────────────────────────────────────────────────────
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

function makeRejectingModels() {
  const flat = { countDocuments: async () => 0 };
  return {
    Listing: { ...flat },
    Store: { ...flat },
    Report: { ...flat },
    BlockedContact: { ...flat },
    Payment: {
      countDocuments: async () => 0,
      aggregate: async () => { throw new Error('aggregate exploded'); },
    },
  };
}

const loggerFake = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const fake = makeRejectingModels();
injectModule('../src/models/Listing.js', fake.Listing);
injectModule('../src/models/Store.js', fake.Store);
injectModule('../src/models/Payment.js', fake.Payment);
injectModule('../src/models/Report.js', fake.Report);
injectModule('../src/models/BlockedContact.js', fake.BlockedContact);
injectModule('../src/config/logger.js', loggerFake);

const { getMetrics } = require('../src/controllers/adminController');

function makeRes() {
  const res = { statusCode: 0, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

describe('getMetrics handler', () => {
  it('returns 500 with the fixed error body when the aggregate rejects, logging no stack', async () => {
    loggerFake.error.mockClear();
    const res = makeRes();

    await getMetrics({}, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to compute metrics' });

    expect(loggerFake.error).toHaveBeenCalledTimes(1);
    const [message, meta] = loggerFake.error.mock.calls[0];
    expect(message).toBe('Admin metrics error');
    const logged = typeof meta.error === 'string' ? meta.error : JSON.stringify(meta.error || '');
    expect(logged).not.toContain('at ');
    expect(logged).not.toContain('\n');
  });
});
