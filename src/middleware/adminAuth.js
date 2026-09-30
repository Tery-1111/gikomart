const crypto = require('crypto');

/**
 * Admin Authorization Middleware
 *
 * Two-tier admin auth:
 *  1. Legacy: X-Admin-Key header compared constant-time against ADMIN_KEY env
 *     var — works until TOTP 2FA is enabled.
 *  2. 2FA: once an Admin record has totpEnabled=true, a valid short-lived
 *     session token (X-Admin-Session) is required INSTEAD, which was only
 *     issued after ADMIN_KEY + valid TOTP code.
 *
 * authenticateAdmin() is the single source of truth for whether a request is
 * admin-authorized. Both the middleware below and controllers that gate
 * mutations inline (listingController.isOwnerOrAdmin, the store-delete admin
 * override) call it, so the 2FA-aware rules live in exactly one place.
 *
 * Phase 2C — Security Hardening
 */
const Admin = require('../models/Admin');
const { check, recordFailure, clear } = require('./adminLockout');
const logger = require('../config/logger');

// FIX A2 — structured failed-auth log. Never log the key, token, code, or body.
function logAuthFailure(req, reason) {
  logger.warn('admin_auth_failed', {
    reason,
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });
}

// Short-lived HMAC session tokens — no DB lookup required to validate.
// Signature proves the token was minted by this server; expiry keeps it lean.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// Mint a signed session token: base64url(expiry-hmac).payload
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');
  return `${sig}.${body}`;
}

function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [sig, body] = token.split('.');
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(body)
    .digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Core admin authorization check. Shared by the middleware below and by
// controllers that gate mutations inline (listing ownership check, store-delete
// admin override). Returns { needs2fa, payload }:
//   - needs2fa: whether TOTP 2FA is currently active. Callers use it to pick
//     the right response status (401 when a session is required) and to name
//     the credential actually required in 403 error messages.
//   - payload:  the authenticated admin (truthy when authorized; this exact
//     value is what the middleware stores on req.admin), or null when not.
async function authenticateAdmin(req) {
  const admins = await Admin.find({ totpEnabled: true }).select('username').lean();
  const sessionToken = req.headers['x-admin-session'];
  const payload = sessionToken ? verifySession(sessionToken) : null;

  // 2FA active: the raw admin key is NOT enough — a valid session token only.
  if (admins.length > 0) {
    if (payload && payload.username === admins[0].username) {
      return { needs2fa: true, payload };
    }
    return { needs2fa: true, payload: null };
  }

  // 2FA not yet configured — fall back to the raw admin key.
  const adminKey = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_KEY;
  if (adminKey && expected && safeEqual(adminKey, expected)) {
    return { needs2fa: false, payload: { username: 'owner', method: 'admin-key' } };
  }
  return { needs2fa: false, payload: null };
}

async function adminAuth(req, res, next) {
  try {
    // FIX A3 — per-IP lockout gate.
    const lock = check(req.ip);
    if (lock.locked) {
      return res.status(429).json({ error: 'Too many attempts', retryAfterSec: lock.retryAfterSec });
    }

    const { needs2fa, payload } = await authenticateAdmin(req);
    if (payload) {
      req.admin = payload;
      clear(req.ip); // successful auth resets the failure counter
      return next();
    }
    // 2FA active but no valid session → 401; legacy key missing/mismatched → 403.
    if (needs2fa) {
      const reason = req.headers['x-admin-session'] ? 'invalid_session' : 'missing_session';
      logAuthFailure(req, reason);
      recordFailure(req.ip);
      return res.status(401).json({ success: false, error: 'Admin 2FA required' });
    }
    const reason = req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key';
    logAuthFailure(req, reason);
    recordFailure(req.ip);
    return res.status(403).json({ success: false, error: 'Admin authorization required' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Admin auth error' });
  }
}

module.exports = adminAuth;
module.exports.verifySession = verifySession;
module.exports.signSession = signSession;
module.exports.authenticateAdmin = authenticateAdmin;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;