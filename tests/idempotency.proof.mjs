import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Deliberately load the REAL models — NOT the require.cache-injected fakes used
// by tests/wiring.test.mjs — so this reads the schema declarations that ship.
// (Mechanism A from the task: a fake cache would mask schema edits.)
const require = createRequire(import.meta.url);
const Listing = require('../src/models/Listing.js');
const Store = require('../src/models/Store.js');

// The webhook's side-effect idempotency relies on a UNIQUE SPARSE index on
// paymentId: unique so a second create for the same payment collides (E11000),
// sparse so the many listings/stores without a paymentId are unconstrained.
function paymentIdIndex(Model) {
  return (Model.schema.indexes() || []).find(
    ([keys, opts]) => keys.paymentId === 1 && opts && opts.unique === true && opts.sparse === true,
  );
}

describe('Idempotency proof — paymentId unique sparse index (Item 4)', () => {
  it('Listing schema declares the unique sparse index on paymentId', () => {
    expect(paymentIdIndex(Listing)).toBeTruthy();
  });

  it('Store schema declares the unique sparse index on paymentId', () => {
    expect(paymentIdIndex(Store)).toBeTruthy();
  });
});
