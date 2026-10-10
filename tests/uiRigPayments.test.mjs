import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// Focused tests for the UI rig's payment-scenario endpoints
// (tools/ui-rig/server.js). The rig is started as an ephemeral child process
// on a dedicated RIG_PORT (same invocation shape as `npm run rig`), probed
// over real HTTP, and killed afterwards — no test framework seam was added to
// the rig itself (smallest maintainable approach; the rig is run-booked as a
// standalone process, not a module, so importing it would side-effect listen).
//
// Contract under test (established this task):
//   - initiate-store-plan pays are tracked as type:'store' BY THE ROUTE
//     (the real route is store-plan-specific; no body.type is sent).
//   - pay-success second+ status poll for a store payment returns
//     { success:true, type:'store', status:'completed', listingId:null,
//       storeId:<rig store id> } — the shape app.js:2457's adoption gate keys on.
//   - pay-success for LISTING payments is unchanged ({listingId:'rig-l-01',
//       storeId:null, type:'listing'}).
//   - pay-pending / pay-failed / pay-cancelled / untracked behave as designed.

const PORT = 4311; // rig-adjacent, not 4173, to avoid colliding with the run-rig
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;

const waitReady = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${BASE}/__rig/state`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
};

const post = (url, body) => fetch(`${BASE}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});
const setState = (scenario) => post('/__rig/state', { scenario, latencyMs: 0 });

beforeAll(async () => {
  child = spawn(process.execPath, [path.join(process.cwd(), 'tools', 'ui-rig', 'server.js')], {
    env: { ...process.env, RIG_PORT: String(PORT) },
    stdio: 'ignore',
  });
  expect(await waitReady(), 'ephemeral rig must come up on its dedicated port').toBe(true);
}, 20000);

afterAll(() => {
  if (child && child.exitCode === null) child.kill();
});

async function initiateStorePayment() {
  const res = await post('/api/payments/initiate-store-plan', {
    phoneNumber: '0712345678',
    storePlan: 'starter_weekly',
    storeData: { name: 'Rig Store', category: 'Electronics', phone: '0712345678', whatsapp: '0712345678' },
    acceptance: { accepted: true },
  });
  return res.json();
}

async function initiateListingPayment() {
  const res = await post('/api/payments/initiate-listing', {});
  return res.json();
}

describe('UI rig payment scenarios — store-type-aware status simulation', () => {
  it('store plan under pay-success: first poll pending, second poll completed WITH the rig Store id and listingId null', async () => {
    await setState('pay-success');
    const init = await initiateStorePayment();
    expect(init.success).toBe(true);
    expect(init.invoiceId).toMatch(/^rig-inv-/);

    const first = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(first.status).toBe('pending');   // realistic STK wait
    expect(first.storeId).toBeNull();       // not yet known to the client

    const second = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(second.success).toBe(true);
    expect(second.status).toBe('completed');
    expect(second.type).toBe('store');
    expect(second.storeId).toBe('rig-s-1');  // deterministic rig Store fixture id
    expect(second.listingId).toBeNull();     // store payments create no listing
  });

  it('listing payment under pay-success stays unchanged: completed with listingId, storeId null', async () => {
    await setState('pay-success');
    const init = await initiateListingPayment();
    const first = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(first.status).toBe('pending');
    const second = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(second.success).toBe(true);
    expect(second.status).toBe('completed');
    expect(second.type).toBe('listing');
    expect(second.listingId).toBe('rig-l-01');
    expect(second.storeId).toBeNull();        // the regression guard: no store material
  });

  it('pay-pending / pay-failed / pay-cancelled retain their designed outcomes for store payments', async () => {
    await setState('pay-pending');
    let init = await initiateStorePayment();
    let s = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(s.status).toBe('pending');
    expect(s.storeId).toBeNull();

    await setState('pay-failed');
    init = await initiateStorePayment();
    s = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(s.status).toBe('failed');
    expect(s.failedCode).toBeNull();

    await setState('pay-cancelled');
    init = await initiateStorePayment();
    s = await (await fetch(`${BASE}/api/payments/status/${init.invoiceId}`)).json();
    expect(s.status).toBe('failed');
    expect(s.failedCode).toBe('1032'); // provider-confirmed user cancellation
  });

  it('untracked invoice under normal scenario remains a plain pending probe', async () => {
    await setState('normal');
    const s = await (await fetch(`${BASE}/api/payments/status/unknown-invoice`)).json();
    expect(s.success).toBe(true);
    expect(s.status).toBe('pending');
    expect(s.storeId).toBeNull();
  });

  it('initiate-store-plan carries the real contract fields (invoiceId, amount 150, ownerToken) without leaking provider material', async () => {
    await setState('normal');
    const init = await initiateStorePayment();
    expect(Object.keys(init).sort()).toEqual(['amount', 'invoiceId', 'message', 'ownerToken', 'success']);
    expect(init.amount).toBe(150);
  });
});
