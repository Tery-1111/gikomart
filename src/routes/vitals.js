const express = require('express');
const router = express.Router();
const { vitalsLimiter } = require('../middleware/rateLimiter');
const VitalsSample = require('../models/VitalsSample');

// The global body parser (server.js) accepts up to 1 MB and has already
// consumed and parsed the stream by the time this router runs, so a nested
// express.json({ limit }) cannot enforce a smaller cap here. Enforce the
// 1 KB beacon budget explicitly on the parsed object instead.
const MAX_BODY_BYTES = 1024;

// Field allowlist bounds. Generous ceilings (a real LCP/TTFB is < 60s; CLS is
// almost always < 10) so legitimate slow connections are kept while hostile
// garbage is rejected before it reaches the database.
const MAX_PATH_LENGTH = 256;
const MAX_MS = 600000; // 10 minutes
const MAX_INP_MS = 60000;
const MAX_CLS = 100;
const MAX_DPR = 10;
const EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g', '4g']);

// Percent-encoded pathnames from location.pathname: printable ASCII, no
// whitespace, no '?' or '#' (the beacon strips query/hash and they must never
// be persisted — they can carry one-time tokens such as #grant=…).
const PATH_RE = /^\/[\x21-\x7e]*$/;

function validNumber(v, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
}

function validPath(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_PATH_LENGTH && PATH_RE.test(v);
}

router.post('/', vitalsLimiter, async (req, res, next) => {
  try {
    const body = req.body;
    // Express 5 leaves req.body undefined when no parser ran (e.g. wrong
    // Content-Type); only plain JSON objects are accepted.
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
    }

    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ success: false, error: 'Vitals payload too large' });
    }

    if (!validPath(body.path)) {
      return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
    }

    // Strict allowlist: only fields the beacon may send, only within bounds.
    // Wrong types, out-of-range values, or extra keys are rejected rather
    // than coerced or silently dropped, so the collection can never drift
    // from its schema. (NoSQL operator keys were already rejected upstream by
    // the sanitize middleware with the same 400.)
    const sample = { path: body.path };

    if (body.lcp !== undefined) {
      if (!validNumber(body.lcp, MAX_MS)) {
        return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
      }
      sample.lcp = body.lcp;
    }
    if (body.inp !== undefined) {
      if (!validNumber(body.inp, MAX_INP_MS)) {
        return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
      }
      sample.inp = body.inp;
    }
    if (body.cls !== undefined) {
      if (!validNumber(body.cls, MAX_CLS)) {
        return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
      }
      sample.cls = body.cls;
    }
    if (body.ttfb !== undefined) {
      if (!validNumber(body.ttfb, MAX_MS)) {
        return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
      }
      sample.ttfb = body.ttfb;
    }
    if (body.conn !== undefined) {
      if (typeof body.conn !== 'string' || !EFFECTIVE_TYPES.has(body.conn)) {
        return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
      }
      sample.conn = body.conn;
    }
    if (body.dpr !== undefined) {
      if (!validNumber(body.dpr, MAX_DPR)) {
        return res.status(400).json({ success: false, error: 'Invalid vitals payload' });
      }
      sample.dpr = body.dpr;
    }

    // ts is server-authoritative (see model comment): the 30-day TTL
    // guarantee must not depend on client clocks.
    sample.ts = new Date();

    await VitalsSample.create(sample);
    // 204: the beacon is fire-and-forget and reads nothing back.
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
