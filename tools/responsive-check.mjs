#!/usr/bin/env node
/**
 * Standalone responsive overflow check (diagnostic tool, NOT a vitest test).
 *
 * PREREQUISITE — the UI rig must already be running:
 *
 *     npm run rig        (serves http://127.0.0.1:4173)
 *
 * This script never starts the rig itself, never installs dependencies,
 * and never modifies application source, CSS, fixtures, package manifests,
 * or the `npm test` workflow.
 *
 * What it does:
 *   1. Resolves playwright-core from the repository's normal node_modules;
 *      if absent, falls back to the known temporary installation location
 *      (C:/Users/oboch/AppData/Local/Temp/node_modules). Fails loudly when
 *      neither exists — no installs, no silent skips.
 *   2. Resolves the Chromium headless-shell executable from the local
 *      Playwright browser cache (%LOCALAPPDATA%\ms-playwright), trying the
 *      verified build directories in order.
 *   3. Opens the app at the rig origin and measures, at viewport widths
 *      360 / 390 / 768 / 1280, whether the document overflows horizontally:
 *
 *         PASS condition: document.documentElement.scrollWidth === window.innerWidth
 *
 *      across three real application states:
 *        a. home/browse view
 *        b. My Store panel (rig credentials seeded via localStorage, real
 *           .nav-link[data-view="mystore"] click)
 *        c. public Store page (real [data-action="open-store-page"] badge click)
 *
 *   12 state/width combinations are reported individually. Exit code 0 only
 *   if every check passes; 1 on any overflow, missing tooling, or rig outage.
 *
 * Usage: node tools/responsive-check.mjs
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const RIG_ORIGIN = 'http://127.0.0.1:4173';
const WIDTHS = [360, 390, 768, 1280];

// ── playwright-core resolution (repo-first, then the verified temp install) ──
function resolvePlaywright() {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return { pkg: require('playwright-core'), source: 'repo node_modules' };
  } catch (err) {
    // Recovery location documented by the responsive-check plan.
    const FALLBACK = 'C:/Users/oboch/AppData/Local/Temp/node_modules/playwright-core';
    if (existsSync(FALLBACK)) {
      return { pkg: require(FALLBACK), source: 'temporary installation fallback' };
    }
    return { pkg: null, source: null };
  }
}

// ── browser executable resolution (%LOCALAPPDATA% Playwright browser cache) ──
function resolveBrowserExecutable() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  const candidates = [
    path.win32.join(base, 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.win32.join(base, 'ms-playwright', 'chromium_headless_shell-1234', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.win32.join(base, 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe'),
    path.win32.join(base, 'ms-playwright', 'chromium-1243', 'chrome-win', 'chrome.exe'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

const FAILURES = [];
const RESULTS = [];

async function measure(page) {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
}

async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${RIG_ORIGIN}/`, { waitUntil: 'networkidle' });
  return page;
}

// ── State 1: home/browse ──────────────────────────────────────────────────────
async function stateHomeBrowse(ctx) {
  const page = await newPage(ctx);
  return { page, label: 'home/browse', close: async () => page.close() };
}

// ── State 2: My Store panel (seeded rig credentials → real nav click) ────────
async function stateMyStore(ctx) {
  const page = await newPage(ctx);
  // Existing rig seed values (tools/ui-rig/server.js conventions); no invented
  // credentials. Seeded BEFORE reload so app.js boot picks them up.
  await page.evaluate(() => {
    localStorage.setItem('gikomart_token', 'rig-token');
    localStorage.setItem('gikomart_ownerToken:rig-l-01', 'rig-token');
    localStorage.setItem('gikomart_storeToken:rig-s-1', 'rig-token');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const el = document.querySelector('.nav-link[data-view="mystore"]');
    if (el) el.click();
  });
  // Deterministic render signal: the real management panel's dashboard tile.
  await page.waitForSelector('#mystoreContent .dash-stats', { timeout: 10000 });
  return { page, label: 'my-store-panel', close: async () => page.close() };
}

// ── State 3: public Store page (real rig store-badge click) ──────────────────
async function statePublicStore(ctx) {
  const page = await newPage(ctx);
  await page.evaluate(() => {
    // Needs a buyer session token for the browse grid the badge lives in.
    localStorage.setItem('gikomart_token', 'rig-token');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const badge = document.querySelector('[data-action="open-store-page"]');
    if (badge) badge.click();
  });
  await page.waitForSelector('#view-storepage.active #storePageContent', { timeout: 10000 });
  return { page, label: 'public-store-page', close: async () => page.close() };
}

const STATES = [stateHomeBrowse, stateMyStore, statePublicStore];

(async () => {
  console.log(`responsive-check: rig origin ${RIG_ORIGIN}`);

  // Rig availability (read-only probe; never starts a server).
  let rigUp;
  try {
    const res = await fetch(`${RIG_ORIGIN}/__rig/state`, { signal: AbortSignal.timeout(4000) });
    rigUp = res.ok;
  } catch (_err) {
    rigUp = false;
  }
  if (!rigUp) {
    console.error('responsive-check: FAIL — UI rig not reachable at 127.0.0.1:4173.');
    console.error('responsive-check: start it first with: npm run rig');
    process.exit(1);
  }
  console.log('responsive-check: rig OK');

  const { pkg: playwright, source } = resolvePlaywright();
  if (!playwright) {
    console.error('responsive-check: FAIL — playwright-core could not be resolved.');
    console.error('responsive-check: expected in repo node_modules or the documented temporary installation (C:/Users/oboch/AppData/Local/Temp/node_modules). No install was attempted.');
    process.exit(1);
  }
  console.log(`responsive-check: playwright-core resolved (${source})`);

  const exe = resolveBrowserExecutable();
  if (!exe) {
    console.error('responsive-check: FAIL — no Chromium headless-shell executable found under %LOCALAPPDATA%\\ms-playwright.');
    process.exit(1);
  }
  console.log(`responsive-check: browser executable ${exe}`);

  const { chromium } = playwright;
  const browser = await chromium.launch({ executablePath: exe, headless: true });

  try {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: Math.round(width * 1.8) }, reducedMotion: 'no-preference' });
      for (const buildState of STATES) {
        const state = await buildState(ctx);
        try {
          const m = await measure(state.page);
          const pass = m.documentWidth === m.viewport;
          RESULTS.push({ state: state.label, width, ...m, pass, diff: Math.max(0, m.documentWidth - m.viewport) });
          if (!pass) {
            FAILURES.push({ state: state.label, width, ...m, diff: m.documentWidth - m.viewport });
          }
        } finally {
          await state.close();
        }
      }
      await ctx.close();
    }
  } finally {
    // Always close the browser.
    await browser.close();
  }

  const passed = RESULTS.filter((r) => r.pass).length;
  console.log(`\nresponsive-check: ${RESULTS.length} checks run, ${passed} passed, ${FAILURES.length} failed`);
  for (const r of RESULTS) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.state} @ ${r.width}px — innerWidth ${r.viewport}, scrollWidth ${r.documentWidth}${r.pass ? '' : ` (overflow +${r.diff}px)`}`);
  }
  if (FAILURES.length) {
    console.error('responsive-check: FAIL — horizontal overflow detected in the combinations listed above.');
    process.exit(1);
  }
  console.log('responsive-check: ALL PASS');
  process.exit(0);
})().catch((err) => {
  console.error(`responsive-check: ERROR ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
