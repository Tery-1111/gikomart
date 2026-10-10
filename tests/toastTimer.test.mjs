/* eslint-disable no-undef -- document/localStorage/Event come from the JSDOM instance constructed below, matching the existing domTerms/storeSave pattern */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Regression coverage for showToast()'s dismissal timer (public/assets/js/app.js).
// Defect history: showToast scheduled a 3s dismissal without cancelling the
// previous handle, so consecutive notifications were cut short by stale timers.
// These tests drive the REAL app.js in jsdom with vitest fake timers
// (deterministic — no arbitrary sleeps).
describe('showToast dismissal timer', () => {
  let showToastFn;

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
    await import('../public/assets/js/app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 10));
    // app.js exposes the live function reference for the regression suite
    // (window.__showToastForTests = showToast): the module scope keeps function
    // declarations off globalThis when imported as ESM, so this alias is the
    // deterministic handle for driving the real implementation.
    showToastFn = window.__showToastForTests;
    if (typeof showToastFn !== 'function') throw new Error('window.__showToastForTests missing — app.js changed shape');
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const toast = () => document.getElementById('toast');

  it('1. shows a single toast with the expected message and stays visible before the deadline', () => {
    showToastFn('First message');
    expect(toast().textContent).toBe('First message');
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(2999);
    expect(toast().classList.contains('show')).toBe(true);
  });

  it('2. dismisses at the existing 3000ms deadline', () => {
    showToastFn('Timed message');
    vi.advanceTimersByTime(2999);
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast().classList.contains('show')).toBe(false);
  });

  it('3. toast B replaces toast A and survives past A\u0027s original deadline', () => {
    showToastFn('Message A');
    vi.advanceTimersByTime(800);
    showToastFn('Message B'); // B must cancel A\u0027s pending dismissal
    expect(toast().textContent).toBe('Message B');
    vi.advanceTimersByTime(2600); // well beyond A\u0027s 3000ms deadline
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(399); // just before B\u0027s own deadline
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast().classList.contains('show')).toBe(false);
  });

  it('4. advancing past A\u0027s original deadline alone never dismisses B', () => {
    showToastFn('A2');
    vi.advanceTimersByTime(800);
    showToastFn('B2');
    vi.advanceTimersByTime(2200); // exactly A\u0027s original deadline since B shown
    expect(toast().classList.contains('show')).toBe(true);
    expect(toast().textContent).toBe('B2');
  });

  it('5. a third toast replaces B and receives its own full window', () => {
    showToastFn('A3');
    vi.advanceTimersByTime(500);
    showToastFn('B3');
    vi.advanceTimersByTime(500);
    showToastFn('C3');
    expect(toast().textContent).toBe('C3');
    vi.advanceTimersByTime(1000); // past A\u0027s AND B\u0027s stale deadlines
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(1998);
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(2);
    expect(toast().classList.contains('show')).toBe(false);
  });

  it('6. many consecutive calls leave no stale timer able to hide the current toast', () => {
    for (const m of ['s1', 's2', 's3', 's4', 's5']) showToastFn(m);
    expect(toast().textContent).toBe('s5');
    vi.advanceTimersByTime(2999);
    expect(toast().classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(toast().classList.contains('show')).toBe(false);
  });

  it('7. existing caller behaviour is unchanged (element, classes, aria, single toast)', () => {
    showToastFn('⚠️ Warning stays a plain string call');
    expect(toast().textContent).toBe('⚠️ Warning stays a plain string call');
    expect(toast().id).toBe('toast');
    expect(toast().getAttribute('role')).toBe('status');
    expect(toast().getAttribute('aria-live')).toBe('polite');
    expect(toast().classList.contains('show')).toBe(true);
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
  });
});
