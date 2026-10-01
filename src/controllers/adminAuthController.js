const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const Admin = require('../models/Admin');
const logger = require('../config/logger');
const { emit, adminActor } = require('../services/auditService');
const { signSession, SESSION_TTL_MS } = require('../middleware/adminAuth');
const {
  check: checkLockout,
  recordFailure: recordAuthFailure,
  clear: clearLockout,
} = require('../middleware/adminLockout');

/**
 * Admin 2FA Controller
 *
 * Flow:
 *  1. POST /api/admin/setup-2fa  (X-Admin-Key) → generates TOTP secret + QR URI
 *  2. POST /api/admin/verify-2fa (X-Admin-Key + code) → enables 2FA
 *  3. POST /api/admin/login      (X-Admin-Key + TOTP code) → returns session token
 *
 * Phase 2C — Security Hardening
 */

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function adminKeyValid(req) {
  const adminKey = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_KEY;
  if (!adminKey || !expected) return false;
  if (adminKey.length !== expected.length) return false;
  return safeEqual(adminKey, expected);
}

// FIX A2 — structured failed-auth log. Never log the key, token, code, or body.
function logAuthFailure(req, reason) {
  logger.warn('admin_auth_failed', {
    reason,
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });
}

// FIX A3 — per-IP lockout gate for admin endpoints. Returns false (and has
// already responded 429) when this IP is locked out.
function lockoutOk(req, res) {
  const status = checkLockout(req.ip);
  if (status.locked) {
    res.status(429).json({ error: 'Too many attempts', retryAfterSec: status.retryAfterSec });
    return false;
  }
  return true;
}

const ADMIN_USERNAME = 'owner';

// Step 1 — Generate a TOTP secret and QR code for the authenticator app.
exports.setup2FA = async (req, res) => {
  const AUDIT_ACTION = 'admin.setup_2fa';
  try {
    if (!lockoutOk(req, res)) return;
    if (!adminKeyValid(req)) {
      logAuthFailure(req, req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key');
      recordAuthFailure(req.ip);
      emit({
        actor: adminActor(req),
        action: AUDIT_ACTION,
        resource: 'admin',
        result: 'failure',
        metadata: { reason: req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key' },
      });
      return res.status(403).json({ success: false, error: 'Invalid admin key' });
    }

    // Enrollment gate: once an admin is enrolled (totpEnabled), resetting the
    // seed requires BOTH the key and a valid TOTP code — otherwise a leaked
    // key alone could silently replace the second factor. First-time setup
    // (no enrolled admin) stays key-only.
    const current = await Admin.findOne({ username: ADMIN_USERNAME }).select('+totpSecret');
    if (current && current.totpEnabled === true) {
      const { totpCode } = req.body || {};
      if (!totpCode || typeof totpCode !== 'string') {
        logAuthFailure(req, 'missing_totp');
        return res.status(400).json({ success: false, error: 'TOTP code required' });
      }
      const seedOk = speakeasy.totp.verify({
        secret: current.totpSecret,
        encoding: 'base32',
        token: totpCode,
        window: 1, // ±1 time-step drift — same config as verify2FA
      });
      if (!seedOk) {
        logAuthFailure(req, 'invalid_totp');
        recordAuthFailure(req.ip);
        emit({
          actor: adminActor(req),
          action: AUDIT_ACTION,
          resource: 'admin',
          result: 'failure',
          metadata: { reason: 'invalid_totp' },
        });
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }
    }

    const secret = speakeasy.generateSecret({
      name: `GikoMart Admin`,
    });

    // Upserting the secret before verification means a partial setup can't
    // lock out the single admin — verification just overwrites it.
    await Admin.findOneAndUpdate(
      { username: ADMIN_USERNAME },
      {
        username: ADMIN_USERNAME,
        totpSecret: secret.base32,
        totpEnabled: false,
        lastUsedCounter: 0,
        updatedAt: new Date(),
      },
      { upsert: true }
    );

    const otpauthUrl = speakeasy.otpauthURL({
      secret: secret.ascii,
      label: 'GikoMart Admin',
      issuer: 'GikoMart',
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });

    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

    emit({
      actor: adminActor(req),
      action: AUDIT_ACTION,
      resource: 'admin',
      result: 'success',
      metadata: { step: 'seed_issued' },
    });

    res.json({
      success: true,
      message: 'Scan the QR with your authenticator app, then call /verify-2fa',
      qrDataUrl,
      secret: secret.base32,
    });
  } catch (err) {
    logger.error('2FA setup error', { error: err.message });
    res.status(500).json({ success: false, error: '2FA setup failed' });
  }
};

// Step 2 — Verify an initial TOTP code and enable 2FA.
exports.verify2FA = async (req, res) => {
  const AUDIT_ACTION = 'admin.verify_2fa';
  try {
    if (!lockoutOk(req, res)) return;
    if (!adminKeyValid(req)) {
      logAuthFailure(req, req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key');
      recordAuthFailure(req.ip);
      emit({
        actor: adminActor(req),
        action: AUDIT_ACTION,
        resource: 'admin',
        result: 'failure',
        metadata: { reason: req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key' },
      });
      return res.status(403).json({ success: false, error: 'Invalid admin key' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      logAuthFailure(req, 'missing_totp');
      return res.status(400).json({ success: false, error: 'TOTP code required' });
    }

    const admin = await Admin.findOne({ username: ADMIN_USERNAME }).select('+totpSecret');
    if (!admin) {
      return res.status(400).json({ success: false, error: 'Run /setup-2fa first' });
    }

    const verified = speakeasy.totp.verify({
      secret: admin.totpSecret,
      encoding: 'base32',
      token: code,
      window: 1, // allow ±1 time-step drift
    });

    if (!verified) {
      logAuthFailure(req, 'invalid_totp');
      recordAuthFailure(req.ip);
      emit({
        actor: adminActor(req),
        action: AUDIT_ACTION,
        resource: 'admin',
        result: 'failure',
        metadata: { reason: 'invalid_totp' },
      });
      return res.status(401).json({ success: false, error: 'Invalid verification code' });
    }

    admin.totpEnabled = true;
    await admin.save();

    emit({
      actor: adminActor(req),
      action: AUDIT_ACTION,
      resource: 'admin',
      result: 'success',
    });
    res.json({ success: true, message: '2FA enabled' });
  } catch (err) {
    logger.error('2FA verify error', { error: err.message });
    res.status(500).json({ success: false, error: '2FA verification failed' });
  }
};

// Step 3 — Authenticate: ADMIN_KEY + TOTP code → 24h session token.
exports.login = async (req, res) => {
  const AUDIT_ACTION = 'admin.login';
  try {
    if (!lockoutOk(req, res)) return;
    if (!adminKeyValid(req)) {
      logAuthFailure(req, req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key');
      recordAuthFailure(req.ip);
      emit({
        actor: adminActor(req),
        action: AUDIT_ACTION,
        resource: 'admin',
        result: 'failure',
        metadata: { reason: req.headers['x-admin-key'] ? 'invalid_key' : 'missing_key' },
      });
      return res.status(403).json({ success: false, error: 'Invalid admin key' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      logAuthFailure(req, 'missing_totp');
      return res.status(400).json({ success: false, error: 'TOTP code required' });
    }

    const admin = await Admin.findOne({ username: ADMIN_USERNAME }).select('+totpSecret');
    if (!admin) {
      return res.status(400).json({ success: false, error: '2FA not set up — run /setup-2fa' });
    }
    if (!admin.totpEnabled) {
      return res.status(400).json({ success: false, error: '2FA not enabled — run /verify-2fa' });
    }

    // Replay protection: verify with the previous window recorded so the same
    // code can't be reused after it expires.
    const verified = speakeasy.totp.verifyDelta({
      secret: admin.totpSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!verified || verified.delta < 0) {
      logAuthFailure(req, 'invalid_totp');
      recordAuthFailure(req.ip);
      emit({
        actor: adminActor(req),
        action: AUDIT_ACTION,
        resource: 'admin',
        result: 'failure',
        metadata: { reason: 'invalid_totp' },
      });
      return res.status(401).json({ success: false, error: 'Invalid TOTP code' });
    }

    // Compute the current window index and reject reuse within the same or an
    // earlier window (verifyDelta allows the previous period as drift tolerance).
    const now = Math.floor(Date.now() / 1000);
    const window = 30;
    const counter = Math.floor(now / window);
    if (admin.lastUsedCounter >= counter) {
      logAuthFailure(req, 'invalid_totp');
      recordAuthFailure(req.ip);
      emit({
        actor: adminActor(req),
        action: AUDIT_ACTION,
        resource: 'admin',
        result: 'failure',
        metadata: { reason: 'totp_replayed' },
      });
      return res.status(401).json({ success: false, error: 'TOTP code already used' });
    }

    admin.lastUsedCounter = counter;
    await admin.save();

    // Successful auth clears this IP's failure count (FIX A3).
    clearLockout(req.ip);

    const sessionToken = signSession({
      username: admin.username,
      role: 'admin',
      exp: Date.now() + SESSION_TTL_MS,
    });

    emit({
      actor: adminActor(req),
      action: AUDIT_ACTION,
      resource: 'admin',
      result: 'success',
    });
    res.json({ success: true, token: sessionToken });
  } catch (err) {
    logger.error('2FA login error', { error: err.message });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
};