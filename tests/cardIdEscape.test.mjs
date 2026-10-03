/* eslint-disable no-undef -- document/window/Event/localStorage are provided by the JSDOM instance constructed below */
// Phase 8 Step 5 — the listing card's data-id must be escaped so a hostile id
// round-trips exactly. Harness copied from tests/domTerms.test.mjs / reportModal.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const OK_LISTINGS = {
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    listings: [
      {
        _id: 'a"b<c', title: 'Tricky id listing', category: 'Electronics', condition: 'Good',
        price: 1000, description: 'A listing with a hostile id.', location: 'Njoro',
        sellerName: 'Seller', sellerWhatsapp: 'test-contact', views: 1, images: [], featured: false,
      },
    ],
  }),
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
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;
  dom.window.open = vi.fn();

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/terms/versions')) {
      return jsonResponse({
        success: true,
        versions: {
          GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0',
          SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0',
        },
      });
    }
    if (u.includes('/listings')) return OK_LISTINGS;
    return jsonResponse({ success: true });
  }));

  dom.window.addEventListener('error', (e) => console.log('WINDOW-ERROR:', e.error?.stack || e.message));
  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));
});

describe('Phase 8 Step 5 — listing card data-id escaping', () => {
  it('a hostile id renders a card whose dataset.id round-trips exactly, with no extra attributes', () => {
    const cards = [...document.querySelectorAll('.listing-card')];
    expect(cards).toHaveLength(1);
    const card = cards[0];

    // No hand-set dataset.id — the value must come from the template itself.
    expect(card.dataset.id).toBe('a"b<c');

    const attrs = [...card.attributes].map((a) => a.name).sort();
    expect(attrs).toEqual(['class', 'data-id']);
  });
});
