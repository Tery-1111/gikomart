/* eslint-disable no-undef -- document/localStorage/Event/window come from the JSDOM instance built below */
// Responsive images: the REAL app.js is driven against the REAL
// public/index.html (same harness as tests/xssEscaping.test.mjs) to assert
// the card and detail <img> emits srcset/sizes built from Cloudinary width
// rungs — and that non-Cloudinary URLs emit no srcset at all.
//
// srcset parsing fact the assertions rely on: Cloudinary transform lists
// contain commas with no trailing space (w_400,h_400,c_fill) while the srcset
// separator is comma+space, so splitting the attribute on ", " yields one
// chunk per rung, ending in its width descriptor.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const CLOUDINARY_IMG = 'https://res.cloudinary.com/gikomart/image/upload/v1690000000/cam.jpg';
const FOREIGN_IMG = 'https://example.com/pic.jpg';

const cloudinaryListing = {
  _id: 'lst-cloud',
  title: 'Cloudinary Camera',
  description: 'desc',
  category: 'Electronics',
  condition: 'Like New',
  price: 500,
  sellerName: 'Jane',
  sellerWhatsapp: '0711111111',
  location: 'Njoro',
  images: [CLOUDINARY_IMG],
  featured: false,
  views: 0,
};

const foreignListing = {
  ...cloudinaryListing,
  _id: 'lst-foreign',
  title: 'Foreign Radio',
  images: [FOREIGN_IMG],
};

beforeAll(async () => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;

  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/terms/versions')) {
      return json({
        success: true,
        versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' },
      });
    }
    if (u.includes('/listings') && !u.includes('/listings/categories')) {
      return json({ success: true, count: 2, total: 2, page: 1, totalPages: 1, listings: [cloudinaryListing, foreignListing] });
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  // Let the async init (terms fetch -> loadListings -> renderListings) settle.
  await new Promise((r) => setTimeout(r, 60));
});

function cardFor(titleFragment) {
  return [...document.querySelectorAll('#listingGrid .listing-card')]
    .find((c) => c.querySelector('.listing-title').textContent.includes(titleFragment));
}

describe('Responsive images — card render (listingCardHTML)', () => {
  it('Cloudinary card emits a 400/600/800 srcset with per-rung square crops', () => {
    const img = cardFor('Cloudinary Camera').querySelector('img');
    const srcset = img.getAttribute('srcset');
    expect(srcset).toBeTruthy();
    // One chunk per rung, each ending in its width descriptor.
    const descriptors = srcset.split(', ').map((chunk) => chunk.split(' ').pop());
    expect(descriptors).toEqual(['400w', '600w', '800w']);
    // Each rung is the same image with its own w/h pair (square c_fill crop).
    expect(srcset).toContain('w_400,h_400,c_fill,q_auto,f_auto');
    expect(srcset).toContain('w_600,h_600,c_fill,q_auto,f_auto');
    expect(srcset).toContain('w_800,h_800,c_fill,q_auto,f_auto');
    // All three rungs point at the same underlying public id.
    expect((srcset.match(/v1690000000\/cam\.jpg/g) || []).length).toBe(3);
  });

  it('Cloudinary card keeps the original w_400 src and gains a sizes hint', () => {
    const img = cardFor('Cloudinary Camera').querySelector('img');
    expect(img.getAttribute('src')).toContain('w_400,h_400,c_fill,q_auto,f_auto');
    expect(img.getAttribute('sizes')).toBe('(max-width: 520px) calc(100vw - 48px), 350px');
  });

  it('a non-Cloudinary image emits no srcset/sizes and an unchanged src', () => {
    const img = cardFor('Foreign Radio').querySelector('img');
    expect(img.getAttribute('srcset')).toBeNull();
    expect(img.getAttribute('sizes')).toBeNull();
    expect(img.getAttribute('src')).toBe(FOREIGN_IMG);
  });
});

describe('Responsive images — detail modal (openListingModal)', () => {
  it('detail image emits a 400/800/1280 srcset with the w_800 src as fallback', () => {
    cardFor('Cloudinary Camera').click();
    const img = document.querySelector('#modalCard .modal-image img');
    expect(img).toBeTruthy();
    const srcset = img.getAttribute('srcset');
    expect(srcset).toBeTruthy();
    const descriptors = srcset.split(', ').map((chunk) => chunk.split(' ').pop());
    expect(descriptors).toEqual(['400w', '800w', '1280w']);
    expect(srcset).toContain('w_400,q_auto,f_auto');
    expect(srcset).toContain('w_800,q_auto,f_auto');
    expect(srcset).toContain('w_1280,q_auto,f_auto');
    // The pre-existing src is untouched — fallback for srcset-less browsers.
    expect(img.getAttribute('src')).toContain('w_800,q_auto,f_auto');
    expect(img.getAttribute('sizes')).toBe('(max-width: 520px) calc(100vw - 88px), 404px');
  });
});
