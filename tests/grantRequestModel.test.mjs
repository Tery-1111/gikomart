import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Exercises the REAL GrantRequest schema and its pre('validate') hook with the
// real Mongoose — no fakes and no database connection (validate() never touches
// the network). The API tests in grantRequest.test.mjs inject fake models, so
// schema-level breakage is invisible there: the callback-style hook threw
// "next is not a function" under Mongoose 9 on every create/save, which 500'd
// every production POST /api/grants while CI stayed green. This file is the
// regression guard for the model's own validation contract.
const require = createRequire(import.meta.url);
const GrantRequest = require('../src/models/GrantRequest');

// Production-shaped request body (same shape submitGrant persists).
const baseDoc = {
  whatsapp: '254712345678',
  contactHash: 'a'.repeat(64),
  claimTokenHash: 'b'.repeat(64),
  type: 'listing',
  package: 'quick',
};

describe('GrantRequest model (real schema, no DB)', () => {
  it('accepts a production-shaped listing request', async () => {
    await new GrantRequest(baseDoc).validate();
  });

  it('accepts a production-shaped store request', async () => {
    const doc = new GrantRequest({
      ...baseDoc,
      type: 'store',
      package: null,
      storePlan: 'starter_weekly',
    });
    await doc.validate();
  });

  it('rejects a listing request without a package', async () => {
    const doc = new GrantRequest({ ...baseDoc, package: null });
    await expect(doc.validate()).rejects.toThrow('package is required for a listing grant');
  });

  it('rejects a store request without a store plan', async () => {
    const doc = new GrantRequest({ ...baseDoc, type: 'store', package: null });
    await expect(doc.validate()).rejects.toThrow('storePlan is required for a store grant');
  });
});
