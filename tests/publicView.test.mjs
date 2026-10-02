import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listingView, storeView } = require('../src/utils/publicView.js');

describe('publicView — listingView', () => {
  const listing = {
    _id: 'lst-1',
    title: 'Widget',
    sellerWhatsapp: '0712222222',
    ownerTokenHash: 'a'.repeat(64),
    price: 100,
  };

  it('never contains ownerTokenHash, even with includeContact true', () => {
    expect(listingView(listing, { includeContact: true })).not.toHaveProperty('ownerTokenHash');
  });

  it('removes sellerWhatsapp when includeContact is false and keeps it when true', () => {
    expect(listingView(listing, { includeContact: false })).not.toHaveProperty('sellerWhatsapp');
    expect(listingView(listing, { includeContact: true }).sellerWhatsapp).toBe('0712222222');
  });

  it('does not mutate its input object', () => {
    const input = { _id: 'lst-2', title: 'Widget', sellerWhatsapp: '0712222222', ownerTokenHash: 'b'.repeat(64) };
    const snapshot = { ...input };
    listingView(input, { includeContact: false });
    expect(input).toEqual(snapshot);
  });

  it('preserves other fields unchanged', () => {
    const view = listingView(listing, { includeContact: true });
    expect(view._id).toBe('lst-1');
    expect(view.title).toBe('Widget');
    expect(view.price).toBe(100);
  });

  it('uses toObject() when the doc provides one', () => {
    const doc = { toObject: () => ({ _id: 'lst-3', title: 'FromDoc', sellerWhatsapp: '0700000000', ownerTokenHash: 'c'.repeat(64) }) };
    const view = listingView(doc, { includeContact: false });
    expect(view).toEqual({ _id: 'lst-3', title: 'FromDoc' });
  });
});

describe('publicView — storeView', () => {
  const store = {
    _id: 'sto-1',
    name: 'Shop',
    phone: '0700000000',
    whatsapp: '0711111111',
    email: 'shop@example.com',
    ownerTokenHash: 'd'.repeat(64),
  };

  it('removes phone, whatsapp and email when includeContact is false', () => {
    const view = storeView(store, { includeContact: false });
    expect(view).not.toHaveProperty('phone');
    expect(view).not.toHaveProperty('whatsapp');
    expect(view).not.toHaveProperty('email');
  });

  it('keeps phone, whatsapp and email when includeContact is true, and still removes ownerTokenHash', () => {
    const view = storeView(store, { includeContact: true });
    expect(view.phone).toBe('0700000000');
    expect(view.whatsapp).toBe('0711111111');
    expect(view.email).toBe('shop@example.com');
    expect(view).not.toHaveProperty('ownerTokenHash');
  });

  it('does not mutate its input object', () => {
    const input = { _id: 'sto-2', name: 'Shop', phone: '0700000000', whatsapp: '0711111111', email: 's@e.com', ownerTokenHash: 'e'.repeat(64) };
    const snapshot = { ...input };
    storeView(input, { includeContact: false });
    expect(input).toEqual(snapshot);
  });
});
