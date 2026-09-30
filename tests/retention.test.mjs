import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

// The cleanup service is CommonJS and resolves its own models via require().
// vi.mock does not propagate into CJS require() consumers in this codebase, so
// we use the repo-standard require.cache injection BEFORE importing the service.
const require = createRequire(import.meta.url);

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

function matchesClause(clause, row) {
  for (const key of Object.keys(clause)) {
    if (key === '$or') {
      if (!clause.$or.some((sub) => matchesClause(sub, row))) return false;
      continue;
    }
    const cond = clause[key];
    const isOperator = cond && typeof cond === 'object' && !Array.isArray(cond);
    if (isOperator && cond.$lte !== undefined) {
      if (!(row[key] <= cond.$lte)) return false;
    } else if (isOperator && cond.$ne !== undefined) {
      if (!(row[key] !== cond.$ne)) return false;
    } else if (isOperator && cond.$nin !== undefined) {
      if (cond.$nin.some((v) => row[key] === v)) return false;
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

function makeFakeModel() {
  const rows = [];
  return {
    rows,
    find(query) {
      return rows.filter((row) => matchesClause(query, row));
    },
  };
}

const StoreFake = makeFakeModel();
const TermsAcceptanceFake = makeFakeModel();
const loggerFake = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const cloudinaryFake = { uploader: { destroy: vi.fn() } };

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

injectModule('../src/models/Store.js', StoreFake);
injectModule('../src/models/TermsAcceptance.js', TermsAcceptanceFake);
injectModule('../src/config/logger.js', loggerFake);
injectModule('../src/config/cloudinary.js', cloudinaryFake);

const { stripExpiredStoreContacts, stripOldAcceptancePII } = require('../src/services/cleanupService');

// Seed data
const oldStore = {
  _id: 'store-old',
  name: 'Old Shop',
  slug: 'old-shop',
  expires_at: new Date(now - 40 * DAY_MS), // expired >30d ago
  phone: '+254700000001',
  whatsapp: '+254700000001',
  email: 'old@example.com',
  location: 'Old Town',
  pickup_location: 'Gate B',
};
const recentStore = {
  _id: 'store-recent',
  name: 'Fresh Shop',
  slug: 'fresh-shop',
  expires_at: new Date(now - 10 * DAY_MS), // recently expired, inside 30d window
  phone: '+254700000002',
  whatsapp: '+254700000002',
  email: 'fresh@example.com',
  location: 'New Town',
  pickup_location: 'Gate C',
};
const oldTA = {
  _id: 'ta-old',
  timestamp: new Date(now - 40 * DAY_MS),
  actor: { ip: '203.0.113.10', userAgent: 'UA-old', phoneHash: 'hash-1' },
};
const recentTA = {
  _id: 'ta-recent',
  timestamp: new Date(now - 5 * DAY_MS),
  actor: { ip: '198.51.100.20', userAgent: 'UA-recent' },
};

const CONTACT_FIELDS = ['phone', 'whatsapp', 'email', 'location', 'pickup_location'];

beforeAll(() => {
  for (const doc of [oldStore, recentStore]) StoreFake.rows.push({ ...doc, async save() { return this; } });
  for (const doc of [oldTA, recentTA]) TermsAcceptanceFake.rows.push({ ...doc, async save() { return this; } });
});

describe('30-day PII retention (cleanupService)', () => {
  it('strips contact PII from stores expired >30d, keeps recent ones, deletes nothing', async () => {
    const countBefore = StoreFake.rows.length;

    await stripExpiredStoreContacts();

    const oldRow = StoreFake.rows.find((r) => r._id === 'store-old');
    const recentRow = StoreFake.rows.find((r) => r._id === 'store-recent');

    // old store: every contact PII field nulled
    for (const f of CONTACT_FIELDS) expect(oldRow[f], `oldStore.${f}`).toBeNull();

    // recent store: untouched
    for (const f of CONTACT_FIELDS) expect(recentRow[f], `recentStore.${f}`).toBe(recentStore[f]);

    // nothing deleted
    expect(StoreFake.rows.length).toBe(countBefore);
    expect(StoreFake.rows.length).toBe(2);
  });

  it('strips actor PII (ip, phoneHash, userAgent) from TermsAcceptance records older than 30d, keeps recent ones, deletes nothing', async () => {
    const countBefore = TermsAcceptanceFake.rows.length;

    await stripOldAcceptancePII();

    const oldRow = TermsAcceptanceFake.rows.find((r) => r._id === 'ta-old');
    const recentRow = TermsAcceptanceFake.rows.find((r) => r._id === 'ta-recent');

    // All three PII fields nulled on old records
    expect(oldRow.actor.ip).toBeNull();
    expect(oldRow.actor.phoneHash).toBeNull();
    expect(oldRow.actor.userAgent).toBeNull();

    expect(recentRow.actor.ip).toBe('198.51.100.20');

    // nothing deleted
    expect(TermsAcceptanceFake.rows.length).toBe(countBefore);
    expect(TermsAcceptanceFake.rows.length).toBe(2);
  });
});
