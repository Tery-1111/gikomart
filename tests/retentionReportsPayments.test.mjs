import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

// Same seam as tests/retention.test.mjs: the cleanup service is CommonJS and
// resolves its models via require(), which vi.mock cannot intercept here, so we
// preload fakes into require.cache BEFORE importing the service.
const require = createRequire(import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;

// Bounded in-memory matcher: plain equality (a MISSING field matches null), $in,
// $lte and $ne. Mirrors the query shapes cleanupService uses.
function matchesFilter(doc, filter = {}) {
  for (const key of Object.keys(filter)) {
    const cond = filter[key];
    const isOperator = cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date);
    if (isOperator) {
      if (cond.$in !== undefined && !cond.$in.includes(doc[key])) return false;
      if (cond.$lte !== undefined && !(doc[key] instanceof Date && doc[key] <= cond.$lte)) return false;
      if (cond.$ne !== undefined && doc[key] === cond.$ne) return false;
    } else if ((doc[key] ?? null) !== cond) {
      return false;
    }
  }
  return true;
}

const ReportFake = {
  rows: [],
  find: async (query) => ReportFake.rows.filter((r) => matchesFilter(r, query)),
};

const paymentCalls = [];
const PaymentFake = {
  rows: [],
  updateMany: async (filter, update) => {
    paymentCalls.push({ filter, update });
    let modifiedCount = 0;
    for (const doc of PaymentFake.rows) {
      if (!matchesFilter(doc, filter)) continue;
      Object.assign(doc, update.$set || {});
      for (const path of Object.keys(update.$unset || {})) {
        const parts = path.split('.');
        let obj = doc;
        for (let i = 0; i < parts.length - 1; i += 1) obj = obj[parts[i]];
        if (obj) delete obj[parts[parts.length - 1]];
      }
      modifiedCount += 1;
    }
    return { modifiedCount };
  },
};

const loggerFake = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cloudinaryFake = { uploader: { destroy: vi.fn() } };

function injectModule(relPath, exportsObj) {
  const filename = require.resolve(relPath);
  require.cache[filename] = {
    id: filename, filename, loaded: true, path: filename, exports: exportsObj,
  };
}

injectModule('../src/models/Report.js', ReportFake);
injectModule('../src/models/Payment.js', PaymentFake);
injectModule('../src/config/logger.js', loggerFake);
injectModule('../src/config/cloudinary.js', cloudinaryFake);

const {
  stripOldReportPII,
  stripOldPaymentPII,
} = require('../src/services/cleanupService');

function seedReport(overrides = {}) {
  const doc = { reporterIp: '203.0.113.9', createdAt: new Date(), ...overrides };
  doc.save = vi.fn(async function save() { return this; });
  ReportFake.rows.push(doc);
  return doc;
}

function seedPayment(overrides = {}) {
  const doc = {
    phoneNumber: '0700000000',
    status: 'completed',
    createdAt: new Date(),
    piiStrippedAt: null,
    listingData: { sellerWhatsapp: '0711111111' },
    storeData: { phone: '0722222222', whatsapp: '0733333333', email: 's@example.com' },
    ...overrides,
  };
  PaymentFake.rows.push(doc);
  return doc;
}

beforeEach(() => {
  ReportFake.rows.length = 0;
  PaymentFake.rows.length = 0;
  paymentCalls.length = 0;
  loggerFake.info.mockClear();
  loggerFake.warn.mockClear();
  loggerFake.error.mockClear();
});

describe('Report IP retention (cleanupService)', () => {
  it('nulls the reporter IP on a 31-day-old report and leaves a 29-day-old one unchanged', async () => {
    const old = seedReport({ createdAt: new Date(Date.now() - 31 * DAY_MS), reporterIp: '203.0.113.9' });
    const recent = seedReport({ createdAt: new Date(Date.now() - 29 * DAY_MS), reporterIp: '198.51.100.4' });

    await stripOldReportPII();

    expect(old.reporterIp).toBeNull();
    expect(old.save).toHaveBeenCalledTimes(1);
    expect(recent.reporterIp).toBe('198.51.100.4');
    expect(recent.save).not.toHaveBeenCalled();
  });

  it('does nothing for a report whose reporter IP is already null', async () => {
    const alreadyStripped = seedReport({ createdAt: new Date(Date.now() - 40 * DAY_MS), reporterIp: null });

    await stripOldReportPII();

    expect(alreadyStripped.reporterIp).toBeNull();
    expect(alreadyStripped.save).not.toHaveBeenCalled();
  });
});

describe('Payment PII retention (cleanupService)', () => {
  it('filters completed/failed older than 90 days that are not yet stripped', async () => {
    await stripOldPaymentPII();

    expect(paymentCalls).toHaveLength(1);
    const { filter } = paymentCalls[0];
    expect(filter.status).toEqual({ $in: ['completed', 'failed'] });
    expect(filter.status.$in).not.toContain('pending');
    expect(filter.piiStrippedAt).toBeNull();
    expect(filter.createdAt.$lte).toBeInstanceOf(Date);
    const expectedCutoff = Date.now() - 90 * DAY_MS;
    expect(Math.abs(filter.createdAt.$lte.getTime() - expectedCutoff)).toBeLessThan(60_000);
  });

  it('strips a 91-day completed payment but not an 89-day one, a pending one, or an already-stripped one', async () => {
    const old = seedPayment({ createdAt: new Date(Date.now() - 91 * DAY_MS), status: 'completed' });
    const fresh = seedPayment({ createdAt: new Date(Date.now() - 89 * DAY_MS), status: 'completed' });
    const pending = seedPayment({ createdAt: new Date(Date.now() - 200 * DAY_MS), status: 'pending' });
    const stripped = seedPayment({ createdAt: new Date(Date.now() - 200 * DAY_MS), status: 'completed', piiStrippedAt: new Date(Date.now() - DAY_MS) });

    await stripOldPaymentPII();

    expect(old.phoneNumber).toBe('redacted');
    expect(old.piiStrippedAt).toBeInstanceOf(Date);
    expect(old.listingData.sellerWhatsapp).toBeUndefined();
    expect(old.storeData.phone).toBeUndefined();
    expect(old.storeData.whatsapp).toBeUndefined();
    expect(old.storeData.email).toBeUndefined();

    expect(fresh.phoneNumber).toBe('0700000000');
    expect(fresh.piiStrippedAt).toBeNull();

    expect(pending.phoneNumber).toBe('0700000000');
    expect(pending.piiStrippedAt).toBeNull();

    expect(stripped.phoneNumber).toBe('0700000000');
  });

  it('sets only phoneNumber and piiStrippedAt, and unsets exactly the four named paths', async () => {
    seedPayment({ createdAt: new Date(Date.now() - 120 * DAY_MS) });
    await stripOldPaymentPII();

    const { update } = paymentCalls[0];
    expect(Object.keys(update.$set).sort()).toEqual(['phoneNumber', 'piiStrippedAt']);
    expect(update.$set.phoneNumber).toBe('redacted');
    expect(Object.keys(update.$unset).sort()).toEqual([
      'listingData.sellerWhatsapp', 'storeData.email', 'storeData.phone', 'storeData.whatsapp',
    ].sort());
  });

  it('exports both strip functions and logs no phone number', async () => {
    expect(typeof stripOldReportPII).toBe('function');
    expect(typeof stripOldPaymentPII).toBe('function');

    seedReport({ createdAt: new Date(Date.now() - 40 * DAY_MS) });
    seedPayment({ createdAt: new Date(Date.now() - 120 * DAY_MS) });
    await stripOldReportPII();
    await stripOldPaymentPII();

    const logged = JSON.stringify([
      ...loggerFake.info.mock.calls,
      ...loggerFake.warn.mock.calls,
      ...loggerFake.error.mock.calls,
    ]);
    expect(logged).not.toMatch(/\d{9,}/);
  });
});
