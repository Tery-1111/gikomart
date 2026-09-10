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
 * Phase 2C — Security Hardening
 */
const Admin = require('../models/Admin');

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

async function adminAuth(req, res, next) {
  try {
    // If an admin record with 2FA enabled exists, demand the session token.
    const admins = await Admin.find({ totpEnabled: true }).select('username').lean();
    if (admins.length > 0) {
      const sessionToken = req.headers['x-admin-session'];
      const payload = sessionToken ? verifySession(sessionToken) : null;
      if (payload && payload.username === admins[0].username) {
        req.admin = payload;
        return next();
      }
      return res.status(401).json({ success: false, error: 'Admin 2FA required' });
    }

    // 2FA not yet configured — fall back to the raw admin key.
    const adminKey = req.headers['x-admin-key'];
    const expected = process.env.ADMIN_KEY;
    if (adminKey && expected && safeEqual(adminKey, expected)) {
      req.admin = { username: 'owner', method: 'admin-key' };
      return next();
    }

    return res.status(403).json({ success: false, error: 'Admin authorization required' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Admin auth error' });
  }
}

module.exports = adminAuth;
module.exports.verifySession = verifySession;
module.exports.signSession = signSession;