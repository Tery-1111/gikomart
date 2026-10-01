/* eslint-disable no-undef -- document/localStorage/Event/window come from the JSDOM instance built below */
// Stored-XSS regression: the REAL app.js is driven against the REAL
// public/index.html, with the listings API stubbed to return a hostile listing.
// Before the escaping fix, `condition` was interpolated unescaped and `title`
// into an attribute via escapeHTML (which does not encode quotes), letting an
// owner inject markup/attributes that execute on every visitor's page.
//
// A manual JSDOM instance on the default node environment is used (same pattern
// as domTerms.test.mjs) so no jsdom vitest environment is needed.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const PAYLOAD = '<img src=x onerror="window.__XSS=1">';

const MALICIOUS = {
  _id: 'lst-evil',
  title: 'Evil " ' + PAYLOAD,
  description: 'desc',
  category: 'Electronics',
  condition: PAYLOAD,
  price: 10,
  sellerName: 'Attacker',
  sellerWhatsapp: '0700000000',
  location: 'Egerton',
  images: ['" ' + PAYLOAD],
  featured: false,
  views: 0,
};

const BENIGN = {
  _id: 'lst-good',
  title: 'Genuine Camera',
  description: 'A perfectly normal listing',
  category: 'Books',
  condition: 'Like New',
  price: 500,
  sellerName: 'Jane',
  sellerWhatsapp: '0711111111',
  location: 'Egerton',
  images: [],
  featured: false,
  views: 3,
};

// Store fields the public store page feeds into an <img src> (logo_url) and a
// CSS url('…') (cover_url) — both attribute-style contexts.
const MALICIOUS_STORE = {
  _id: 'sto-evil',
  name: 'Evil Store',
  slug: 'evil-store',
  category: 'Books',
  description: 'desc',
  location: 'Egerton',
  // Well-formed attribute-injection probes: no angle brackets, so an unescaped
  // interpolation injects an attribute on the existing <img>/style rather than
  // breaking the document structure (which would render an error state and mask
  // the discriminator). A leading quote is all it takes to break out.
  logo_url: 'x" onload="window.__XSS=1',
  cover_url: "x' ) ; background:red ; /*",
  verification_status: 'unverified',
  whatsapp: '0700000000',
  opening_hours: '8am',
  closing_hours: '6pm',
  open_days: 'Mon-Fri',
  delivery_available: false,
  pickup_available: true,
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
    if (u.includes('/stores/slug/')) {
      return json({ success: true, store: MALICIOUS_STORE, listingCount: 0 });
    }
    if (u.includes('/listings')) {
      if (u.includes('store_id=')) {
        return json({ success: true, count: 0, total: 0, page: 1, totalPages: 1, listings: [] });
      }
      return json({ success: true, count: 2, total: 2, page: 1, totalPages: 1, listings: [MALICIOUS, BENIGN] });
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  // Let the async init (terms fetch → loadListings → renderListings) settle.
  await new Promise((r) => setTimeout(r, 60));
});

function cards() {
  return [...document.querySelectorAll('#listingGrid .listing-card')];
}
function cardFor(titleFragment) {
  return cards().find((c) => c.querySelector('.listing-title').textContent.includes(titleFragment));
}

describe('Stored-XSS regression — listing fields render inert', () => {
  it('the hostile listing rendered (test is exercising the real render path)', () => {
    expect(cardFor('Evil')).toBeTruthy();
  });

  it('a malicious attribute payload creates no injected elements', () => {
    const injected = document.querySelectorAll('#listingGrid img[onerror], #listingGrid img[onload]');
    expect(injected).toHaveLength(0);
    expect(window.__XSS).toBeUndefined();
  });

  it('malicious HTML in text fields stays inert (rendered as text, not parsed)', () => {
    const card = cardFor('Evil');
    // Title is literal text containing the payload source, not an element.
    expect(card.querySelector('.listing-title').textContent).toContain('<img');
    const badge = card.querySelector('.condition-badge');
    expect(badge.textContent).toBe(PAYLOAD);
    // The payload never becomes a child element.
    expect(badge.querySelector('img')).toBeNull();
  });

  it('legitimate content still renders correctly', () => {
    const card = cardFor('Genuine Camera');
    expect(card).toBeTruthy();
    const badge = card.querySelector('.condition-badge');
    expect(badge.textContent).toBe('Like New');
    expect(badge.className).toContain('cond-Like-New');
  });
});

describe('Stored-XSS regression — store media (logo/cover) render inert', () => {
  it('a hostile logo_url/cover_url creates no injected elements on the public store page', async () => {
    // Drive the REAL delegated action → openStorePage() → its template literals.
    const trigger = document.createElement('button');
    trigger.setAttribute('data-action', 'open-store-page');
    trigger.setAttribute('data-slug', 'evil-store');
    document.body.appendChild(trigger);
    trigger.click();
    // openStorePage is async (two fetches) and not awaited by the click handler.
    await new Promise((r) => setTimeout(r, 80));

    const container = document.getElementById('storePageContent');
    expect(container.textContent).toContain('Evil Store');
    // logo_url (img src) and cover_url (CSS url()) must not break out.
    expect(container.querySelectorAll('img[onerror], img[onload]')).toHaveLength(0);
    expect(window.__XSS).toBeUndefined();
    trigger.remove();
  });
});
