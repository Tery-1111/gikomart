// Store FAQ — UI-only disclosure in the My Store empty state.
// Drives the REAL app.js against the REAL public/index.html in a manual JSDOM
// (the house pattern from storeListingsUi.test.mjs). Verifies the FAQ control
// renders, is initially collapsed, expands/collapses with correct aria state,
// carries the plan capacity lines derived from the real STORE_PLANS source of
// truth, includes the store-deletion warning, and that the existing Store CTA
// (open creation modal) still works.

/* eslint-disable no-undef -- document/window/Event/localStorage are provided by the JSDOM instance constructed below */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

beforeAll(async () => {
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

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

  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/terms/versions')) {
      return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
    }
    if (u.includes('/listings/categories')) {
      return jsonResponse({ success: true, categories: [{ id: 'electronics', name: 'Electronics', icon: '📱', legacyNames: [] }] });
    }
    if (u.includes('/support-contact')) {
      return jsonResponse({ success: true, support: { phoneLocal: '0776844298', phoneInternational: '254776844298' } });
    }
    if (u.includes('/listings')) return jsonResponse({ success: true, listings: [], total: 0, page: 1, totalPages: 0 });
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));

  // No store tokens in localStorage → My Store shows the empty state.
  document.querySelector('.nav-link[data-view="mystore"]').click();
  await new Promise((r) => setTimeout(r, 10));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('Store FAQ — My Store empty-state disclosure', () => {
  it('renders the empty state with heading, CTA, and the collapsed FAQ control', () => {
    const content = document.getElementById('mystoreContent');
    expect(content.textContent).toContain("You don't have a store yet.");
    expect(content.querySelector('[data-action="open-store-creation"]')).toBeTruthy();

    const btn = content.querySelector('[data-action="toggle-store-faq"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('How does the Store work?');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('storeFaq');

    const faq = document.getElementById('storeFaq');
    expect(faq).toBeTruthy();
    expect(faq.hasAttribute('hidden')).toBe(true);
  });

  it('FAQ content carries the plans from the real STORE_PLANS source of truth and the deletion warning', () => {
    const faq = document.getElementById('storeFaq');
    // STORE_PLANS: starter_weekly 5 / standard_monthly 10 / pro_monthly 15
    expect(faq.textContent).toContain('Starter Weekly');
    expect(faq.textContent).toContain('up to 5 listings');
    expect(faq.textContent).toContain('up to 10 listings');
    expect(faq.textContent).toContain('up to 15 listings');
    expect(faq.textContent).toContain('Deleting a Store');
    expect(faq.textContent).toContain('standalone');
  });

  it('expands on click with aria-expanded=true and collapses back on a second click', () => {
    const btn = document.querySelector('[data-action="toggle-store-faq"]');
    const faq = document.getElementById('storeFaq');

    btn.click();
    expect(faq.hasAttribute('hidden')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    btn.click();
    expect(faq.hasAttribute('hidden')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('the existing Store CTA still opens the creation modal with plans and the new explanatory line', () => {
    document.querySelector('[data-action="open-store-creation"]').click();
    const overlay = document.getElementById('storeModalOverlay');
    expect(overlay.classList.contains('open')).toBe(true);

    const card = document.getElementById('storeModalCard');
    expect(card.textContent).toContain('Open a Store');
    // Plan cards unchanged: three plans with prices.
    expect(card.querySelectorAll('[data-action="select-store-plan"]').length).toBe(3);
    expect(card.textContent).toContain('KSh 150');
    // The compact clarification added next to the plan picker.
    expect(card.textContent).toContain('Your Store plan determines how many listings');
    expect(card.textContent).toContain('without opening a Store');

    // Close still works.
    card.querySelector('[data-action="close-store-modal"]').click();
    expect(overlay.classList.contains('open')).toBe(false);
  });
});
