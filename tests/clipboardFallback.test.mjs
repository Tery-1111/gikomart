/* eslint-disable no-undef -- document/navigator/document.execCommand come from the JSDOM instance constructed below, matching the existing domTerms/storeSave pattern */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Regression coverage for copyTextToClipboard()'s legacy fallback textarea
// (public/assets/js/app.js). Defect history: the fallback textarea was
// position:fixed but had NO explicit coordinates, so it rendered at its static
// document position, deep in the page — and select() (focus-on-select) scrolled
// the viewport to it, producing a visible scroll jump when the async clipboard
// API was unavailable (older browsers, some embedders). The fix pins the
// temporary textarea to the viewport origin (top:0; left:0) so the copy never
// scrolls. These tests drive the REAL app.js in jsdom, mirroring the
// toastTimer/grantUx driver pattern.
describe('copyTextToClipboard fallback textarea', () => {
  let copyFn;

  beforeAll(async () => {
    const { JSDOM } = await import('jsdom');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'https://gikomart.test/' });
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.Event = dom.window.Event;
    globalThis.localStorage = dom.window.localStorage;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: false }) })));
    // jsdom implements no async clipboard API, so the helper always takes the
    // fallback path here — exactly the environment the bug lives in.
    await import('../public/assets/js/app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 10));
    copyFn = window.__copyTextToClipboardForTests;
    if (typeof copyFn !== 'function') throw new Error('window.__copyTextToClipboardForTests missing — app.js changed shape');
  });

  beforeEach(() => {
    // execCommand is jsdom-missing; stub a controllable one. Each test sets
    // its own return value, restoring the throwing original afterwards.
    vi.stubGlobal('Error_old', Error);
    document.execCommand = vi.fn(() => true);
  });
  afterEach(() => {
    delete document.execCommand;
    vi.unstubAllGlobals();
  });

  it('1. pins the temporary textarea to the viewport origin (top:0 / left:0)', async () => {
    let styles = null;
    const orig = document.body.appendChild.bind(document.body);
    document.body.appendChild = (el) => {
      if (el.tagName === 'TEXTAREA' && el.value) {
        styles = { position: el.style.position, top: el.style.top, left: el.style.left, opacity: el.style.opacity };
      }
      return orig(el);
    };
    try {
      await copyFn('probe text');
    } finally {
      document.body.appendChild = orig;
    }
    expect(styles).not.toBeNull();
    expect(styles.position).toBe('fixed');
    // jsdom serializes unitless 0 as "0px" — same value, canonical form.
    expect(styles.top).toBe('0px');
    expect(styles.left).toBe('0px');
    expect(styles.opacity).toBe('0');
  });

  it('2. fallback succeeds and the textarea is removed after use (no residue)', async () => {
    const value = 'grant continuation link https://gikomart.test/#gr-claim/token';
    const ok = await copyFn(value);
    expect(ok).toBe(true);
    const residue = [...document.querySelectorAll('textarea')].filter((t) => t.value === value);
    expect(residue.length).toBe(0);
  });

  it('3. does not scroll the document when selecting (the reported bug)', async () => {
    // Reproduce the defect geometry: page content taller than the viewport so
    // a document-positioned textarea would force scrollTo on select().
    const spacer = document.createElement('div');
    spacer.style.height = '4000px';
    document.body.appendChild(spacer);
    window.scrollTo(0, 0);
    // Without the fix the textarea would be positioned at its static slot
    // ~4000px down; jsdom's textarea select() would try to focus/scroll to it.
    const ok = await copyFn('scroll probe');
    const afterY = window.scrollY;
    spacer.remove();
    expect(ok).toBe(true);
    // The viewport origin pinning must leave the scroll position untouched.
    expect(afterY).toBe(0);
  });

  it('4. returns false when execCommand fails (error handling intact)', async () => {
    document.execCommand = vi.fn(() => false);
    const ok = await copyFn('will fail');
    expect(ok).toBe(false);
    // Failed copies must still clean up their temporary textarea.
    const residue = [...document.querySelectorAll('textarea')].filter((t) => t.value === 'will fail');
    expect(residue.length).toBe(0);
  });
});
