// The access log must record req.ip — the same address the rate limiters and the
// admin lockout enforce — not the raw X-Forwarded-For header, which a client can
// set itself. server.js builds the REAL app; a fake logger is injected into
// require.cache BEFORE server.js is imported (the seam used by
// tests/wiring.test.mjs and tests/statusLimiter.test.mjs), so every
// logger.info('request', …) call is observable.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// TRUST_PROXY must be set BEFORE server.js is imported: trust proxy is read at
// module load. The other fixtures keep startup assertions quiet (CI has no .env).
process.env.TRUST_PROXY = '3';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';

// Capture only the access-log calls; everything else is a no-op.
const requestLogs = [];
const fakeLogger = {
  info: (message, meta) => { if (message === 'request') requestLogs.push(meta); },
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function injectModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    path: resolved,
    exports: exportsObj,
  };
}
injectModule('../src/config/logger.js', fakeLogger);

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

// Issue a request that reaches the access logger but touches no database or
// route logic: an unmatched path returns Express's default 404 and still runs
// the middleware that logs on response finish. Returns the captured request
// log entries for that single request.
async function hit(path, forwardedFor) {
  requestLogs.length = 0;
  let req = request(app).get(path);
  if (forwardedFor !== undefined) req = req.set('X-Forwarded-For', forwardedFor);
  await req;
  // res.on('finish') fires after the response is flushed; let it run.
  await new Promise((resolve) => setImmediate(resolve));
  return requestLogs.slice();
}

describe('Access log records req.ip (trust proxy = 3)', () => {
  it('confirms the app trust proxy setting is 3', () => {
    expect(app.get('trust proxy')).toBe(3);
  });

  it('logs the client address from a three-hop chain, not the raw header', async () => {
    const logs = await hit('/__log-ip-probe__', '198.51.100.7, 172.0.0.1, 10.0.0.1');
    expect(logs.length).toBeGreaterThan(0);
    // req.ip walks the trusted chain back to the client; the raw header would
    // have logged the whole comma-separated string instead.
    expect(logs[logs.length - 1].ip).toBe('198.51.100.7');
  });

  it('logs a single address for a spoofed one-entry chain', async () => {
    const logs = await hit('/__log-ip-probe__', '203.0.113.9');
    const ip = logs[logs.length - 1].ip;
    expect(ip).toBe('203.0.113.9');
    // The raw multi-value form "203.0.113.9, <anything>" must never be logged.
    expect(ip).not.toMatch(/^203\.0\.113\.9, /);
  });

  it('never logs a comma in the ip field', async () => {
    const logs = await hit('/__log-ip-probe__', '198.51.100.7, 172.0.0.1, 10.0.0.1');
    expect(logs[logs.length - 1].ip).not.toContain(',');
  });
});
