/* eslint-disable no-undef -- document/localStorage/Event/window come from the JSDOM instance built below */
// Deferred cover-loading: the REAL app.js is driven against the REAL
// public/index.html with the controllable IntersectionObserver stub installed
// BEFORE import, so initLazyBackgrounds takes the observer path instead of
// jsdom's usual immediate-apply fallback. Companion to
// tests/xssEscaping.test.mjs, which covers the fallback path and the escaping
// contract for hostile cover_url values.
//
// The stub never fires on its own; each test decides when an element
// "intersects", which is what makes the deferred behavior assertable.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { installIntersectionObserverStub } from './intersectionObserverStub.mjs';

const STORE = {
  _id: 'sto-lazy',
  name: 'Lazy Cover Store',
  slug: 'lazy-cover',
  category: 'Books',
  description: 'desc',
  location: 'Njoro',
  logo_url: 'https://res.cloudinary.com/gikomart/image/upload/v1690000000/logo.jpg',
  cover_url: 'https://res.cloudinary.com/gikomart/image/upload/v1690000000/cover.jpg',
  verification_status: 'unverified',
  whatsapp: '0700000000',
  opening_hours: '8am',
  closing_hours: '6pm',
  open_days: 'Mon-Fri',
  delivery_available: false,
  pickup_available: true,
};

let io; // { IntersectionObserver, instances } from the stub

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

  io = installIntersectionObserverStub(globalThis);

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
      return json({ success: true, store: STORE, listingCount: 0 });
    }
    if (u.includes('/listings')) {
      return json({ success: true, count: 0, total: 0, page: 1, totalPages: 1, listings: [] });
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  // Let the async init (terms fetch -> loadListings -> renderListings) settle.
  await new Promise((r) => setTimeout(r, 60));
});

// Drives the real delegated-action path (document click -> data-action ->
// openStorePage) exactly as a user click on a store badge would.
async function openStore() {
  const trigger = document.createElement('button');
  trigger.setAttribute('data-action', 'open-store-page');
  trigger.setAttribute('data-slug', STORE.slug);
  document.body.appendChild(trigger);
  trigger.click();
  // Let the store fetch -> innerHTML -> initLazyBackgrounds settle.
  await new Promise((r) => setTimeout(r, 80));
}

function cover() {
  return document.querySelector('#storePageContent .lazy-bg');
}

describe('Lazy background loading — observer path (deferred)', () => {
  it('store cover renders as a data-bg placeholder and is NOT applied at open', async () => {
    await openStore();
    const el = cover();
    expect(el).toBeTruthy();
    expect(el.getAttribute('data-bg')).toContain('res.cloudinary.com');
    expect(el.getAttribute('data-bg')).toContain('w_1200,h_400,c_fill');
    // The discriminator: the fallback path would have set backgroundImage
    // during initLazyBackgrounds; the deferred path must not.
    expect(el.style.backgroundImage).toBe('');
  });

  it('a single shared observer watches the cover with threshold 0.1', async () => {
    // One instance total: created at DOMContentLoaded init, reused since.
    expect(io.instances).toHaveLength(1);
    const observer = io.instances[0];
    expect(observer.threshold).toBe(0.1);
    expect(observer.observed.has(cover())).toBe(true);
  });

  it('a non-intersecting entry does not apply the background', () => {
    const observer = io.instances[0];
    expect(observer.trigger(cover(), false)).toBe(true);
    expect(cover().style.backgroundImage).toBe('');
  });

  it('an intersecting entry applies the URL once, swaps classes, and unobserves', () => {
    const observer = io.instances[0];
    const el = cover();
    expect(observer.trigger(el, true)).toBe(true);
    expect(el.style.backgroundImage).toContain('url(');
    expect(el.style.backgroundImage).toContain('res.cloudinary.com');
    expect(el.classList.contains('lazy-bg')).toBe(false);
    expect(el.classList.contains('bg-loaded')).toBe(true);
    // One-shot: stopped watching once the background was in place.
    expect(observer.observed.has(el)).toBe(false);
    expect(observer.trigger(el)).toBe(false); // no longer in the registry
  });

  it('re-renders reuse the same observer and start deferred again', async () => {
    await openStore();
    const el = cover();
    expect(io.instances).toHaveLength(1);
    expect(io.instances[0].observed.has(el)).toBe(true);
    expect(el.style.backgroundImage).toBe(''); // fresh render is unapplied
  });
});
