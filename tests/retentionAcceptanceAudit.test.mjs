import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

// Same seam as tests/retention.test.mjs and tests/retentionReportsPayments.test.mjs:
// the cleanup service is CommonJS and resolves its models via require(), which
// vi.mock cannot intercept here, so we preload fakes into require.cache BEFORE
// importing the service.
const require = createRequire(import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function toTime(v) {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

// Bounded in-memory matcher: plain equality, $ne, $lte, $lt, $or and dotted
// paths. A MISSING field passes $ne (as in the other retention fakes). Mirrors
// the exact query shapes cleanupService uses.
function matchesFilter(row, query = {}) {
  for (const key of Object.keys(query)) {
    if (key === '$or') {
      if (!query.$or.some((sub) => matchesFilter(row, sub))) return false;
      continue;
    }
    const cond = query[key];
    const value = getPath(row, key);
    const isOperator = cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date);
    if (isOperator) {
      if (cond.$lte !== undefined && !(toTime(value) <= toTime(cond.$lte))) return false;
      if (cond.$lt !== undefined && !(toTime(value) < toTime(cond.$lt))) return false;
      if (cond.$ne !== undefined && value === cond.$ne) return false;
    } else if ((value ?? null) !== cond) {
      return false;
    }
  }
  return true;
}

const TermsAcceptanceFake = {
  rows: [],
  find: async (query) => TermsAcceptanceFake.rows.filter((r) => matchesFilter(r, query)),
};

const auditDeleteCalls = [];
const AuditEventFake = {
  deleteMany: vi.fn(async (filter) => {
    auditDeleteCalls.push(filter);
    return { deletedCount: 2 };
  }),
};

const loggerFake = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cloudinaryFake = { uploader: { destroy: vi.fn() } };

function injectModule(relPath, exportsObj) {
  const filename = require.resolve(relPath);
  require.cache[filename] = {
    id: filename, filename, loaded: true, path: filename, exports: exportsObj,
  };
}

injectModule('../src/models/TermsAcceptance.js', TermsAcceptanceFake);
injectModule('../src/models/AuditEvent.js', AuditEventFake);
injectModule('../src/config/logger.js', loggerFake);
injectModule('../src/config/cloudinary.js', cloudinaryFake);

const {
  stripOldAcceptanceHashes,
  pruneOldAuditEvents,
} = require('../src/services/cleanupService');

function seedAcceptance(overrides = {}) {
  const doc = {
    timestamp: new Date(),
    actor: { whatsappHash: 'hash-a', ownerTokenHash: 'owner-hash' },
    sellerContactTarget: { sellerWhatsappHash: 'hash-b', listingTitle: 'A title' },
    ...overrides,
  };
  doc.save = vi.fn(async function save() { return this; });
  TermsAcceptanceFake.rows.push(doc);
  return doc;
}

beforeEach(() => {
  TermsAcceptanceFake.rows.length = 0;
  auditDeleteCalls.length = 0;
  AuditEventFake.deleteMany.mockClear();
  loggerFake.info.mockClear();
  loggerFake.warn.mockClear();
  loggerFake.error.mockClear();
});

afterEach(() => {
  delete process.env.AUDIT_RETENTION_DAYS;
});

describe('Acceptance contact-hash retention (cleanupService)', () => {
  it('nulls the two contact hashes on a 31-day-old record and leaves a 29-day-old one unchanged', async () => {
    const old = seedAcceptance({ timestamp: new Date(Date.now() - 31 * DAY_MS) });
    const recent = seedAcceptance({ timestamp: new Date(Date.now() - 29 * DAY_MS) });

    await stripOldAcceptanceHashes();

    expect(old.actor.whatsappHash).toBeNull();
    expect(old.sellerContactTarget.sellerWhatsappHash).toBeNull();
    expect(old.save).toHaveBeenCalledTimes(1);

    expect(recent.actor.whatsappHash).toBe('hash-a');
    expect(recent.sellerContactTarget.sellerWhatsappHash).toBe('hash-b');
    expect(recent.save).not.toHaveBeenCalled();
  });

  it('leaves ownerTokenHash, listing/store ids, listingTitle and metadata untouched', async () => {
    const doc = seedAcceptance({
      timestamp: new Date(Date.now() - 40 * DAY_MS),
      actor: { whatsappHash: 'hash-a', ownerTokenHash: 'owner-hash' },
      listingId: 'l-1',
      storeId: 's-1',
      sellerContactTarget: { sellerWhatsappHash: 'hash-b', listingTitle: 'A title' },
      metadata: { source: 'keep-me' },
    });

    await stripOldAcceptanceHashes();

    expect(doc.actor.whatsappHash).toBeNull();
    expect(doc.sellerContactTarget.sellerWhatsappHash).toBeNull();
    expect(doc.actor.ownerTokenHash).toBe('owner-hash');
    expect(doc.listingId).toBe('l-1');
    expect(doc.storeId).toBe('s-1');
    expect(doc.sellerContactTarget.listingTitle).toBe('A title');
    expect(doc.metadata).toEqual({ source: 'keep-me' });
  });

  it('strips a 40-day-old record whose actor.ip is already null but whose whatsappHash is still set', async () => {
    const doc = seedAcceptance({
      timestamp: new Date(Date.now() - 40 * DAY_MS),
      actor: { ip: null, userAgent: null, phoneHash: null, whatsappHash: 'hash-a' },
    });

    await stripOldAcceptanceHashes();

    expect(doc.actor.whatsappHash).toBeNull();
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('does not throw for a record with no sellerContactTarget and still strips the actor hash', async () => {
    const doc = seedAcceptance({
      timestamp: new Date(Date.now() - 40 * DAY_MS),
      actor: { whatsappHash: 'hash-a' },
      sellerContactTarget: undefined,
    });

    await expect(stripOldAcceptanceHashes()).resolves.toBeUndefined();
    expect(doc.actor.whatsappHash).toBeNull();
  });

  it('does not save a record whose two contact hashes are already null', async () => {
    const doc = seedAcceptance({
      timestamp: new Date(Date.now() - 40 * DAY_MS),
      actor: { whatsappHash: null },
      sellerContactTarget: { sellerWhatsappHash: null },
    });

    await stripOldAcceptanceHashes();

    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('Audit event pruning (cleanupService)', () => {
  it('deletes events older than 365 days by default with a timestamp-only $lt filter', async () => {
    await pruneOldAuditEvents();

    expect(auditDeleteCalls).toHaveLength(1);
    const { filter } = { filter: auditDeleteCalls[0] };
    expect(Object.keys(filter)).toEqual(['timestamp']);
    expect(filter.timestamp.$lt).toBeInstanceOf(Date);
    const expected = Date.now() - 365 * DAY_MS;
    expect(Math.abs(filter.timestamp.$lt.getTime() - expected)).toBeLessThan(1000);
  });

  it('honours AUDIT_RETENTION_DAYS and falls back to 365 for invalid values', async () => {
    const cutoffDays = async () => {
      auditDeleteCalls.length = 0;
      await pruneOldAuditEvents();
      return Math.round((Date.now() - auditDeleteCalls[0].timestamp.$lt.getTime()) / DAY_MS);
    };

    process.env.AUDIT_RETENTION_DAYS = '30';
    expect(await cutoffDays()).toBe(30);

    for (const value of ['abc', '0', '-5']) {
      process.env.AUDIT_RETENTION_DAYS = value;
      expect(await cutoffDays()).toBe(365);
    }
  });
});

describe('Retention job hygiene (cleanupService)', () => {
  it('exports both functions and logs no phone number or hash', async () => {
    expect(typeof stripOldAcceptanceHashes).toBe('function');
    expect(typeof pruneOldAuditEvents).toBe('function');

    seedAcceptance({ timestamp: new Date(Date.now() - 40 * DAY_MS) });
    await stripOldAcceptanceHashes();
    await pruneOldAuditEvents();

    const logged = JSON.stringify([
      ...loggerFake.info.mock.calls,
      ...loggerFake.warn.mock.calls,
      ...loggerFake.error.mock.calls,
    ]);
    expect(logged).not.toMatch(/\d{9,}/);
    expect(logged).not.toMatch(/[0-9a-f]{64}/);
  });
});
