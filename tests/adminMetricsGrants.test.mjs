import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Supersedes the query-shape assertions in tests/adminMetrics.test.mjs for the
// revenue pipeline and the Payment countDocuments filters, which gained the
// grantedAt exclusion and the granted30d count. The old file is left untouched.
const require = createRequire(import.meta.url);

const NOW = new Date('2026-10-02T12:00:00.000Z');
const SINCE24 = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
const SINCE7 = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
const SINCE30 = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

const { computeMetrics } = require('../src/services/metricsService');

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

describe('computeMetrics — grants excluded from revenue', () => {
  it('matches the aggregate on grantedAt: null and counts grants separately', async () => {
    const { models, Listing, Store, Payment, Report, BlockedContact } = makeModels();

    await computeMetrics(models, NOW);

    // The revenue aggregate must exclude admin grants.
    expect(Payment.aggCalls).toEqual([EXPECTED_PIPELINE]);

    // The four Payment count filters, including the new granted30d count.
    expect(Payment.countCalls).toEqual([
      { status: 'pending' },
      { status: 'completed', createdAt: { $gte: SINCE24 } },
      { status: 'failed', createdAt: { $gte: SINCE24 } },
      { status: 'completed', grantedAt: { $ne: null }, createdAt: { $gte: SINCE30 } },
    ]);

    // Every other model's filters are unchanged.
    expect(Listing.countCalls).toEqual([
      { status: 'active', moderationStatus: 'approved', expiresAt: { $gt: NOW } },
      { moderationStatus: 'flagged' },
    ]);
    expect(Store.countCalls).toEqual([
      { status: 'active', expires_at: { $gt: NOW } },
      { moderationStatus: 'flagged' },
      { status: 'suspended' },
    ]);
    expect(Report.countCalls).toEqual([{ status: 'open' }]);
    expect(BlockedContact.countCalls).toEqual([{}]);

    // Eleven countDocuments calls now run in the one Promise.all.
    const totalCountCalls = Listing.countCalls.length + Store.countCalls.length + Payment.countCalls.length
      + Report.countCalls.length + BlockedContact.countCalls.length;
    expect(totalCountCalls).toBe(11);
  });
});

describe('computeMetrics — payments.granted30d result shape', () => {
  it('exposes granted30d alongside the existing payment counts', async () => {
    const { models, Payment } = makeModels();
    Payment.countReturn = 3;

    const r = await computeMetrics(models, NOW);

    expect(Object.keys(r.payments)).toEqual(['pending', 'completed24h', 'failed24h', 'granted30d']);
    expect(r.payments.granted30d).toBe(3);
  });

  it('returns granted30d 0 when there are no grants', async () => {
    const { models, Payment } = makeModels();
    Payment.countReturn = 0;

    const r = await computeMetrics(models, NOW);

    expect(r.payments.granted30d).toBe(0);
  });

  it('still shapes revenue from the aggregate rows', async () => {
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
});
