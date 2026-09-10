const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const Admin = require('../models/Admin');
const logger = require('../config/logger');
const { signSession } = require('../middleware/adminAuth');

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

const ADMIN_USERNAME = 'owner';

// Step 1 — Generate a TOTP secret and QR code for the authenticator app.
exports.setup2FA = async (req, res) => {
  try {
    if (!adminKeyValid(req)) {
      return res.status(403).json({ success: false, error: 'Invalid admin key' });
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
  try {
    if (!adminKeyValid(req)) {
      return res.status(403).json({ success: false, error: 'Invalid admin key' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string') {
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
      return res.status(401).json({ success: false, error: 'Invalid verification code' });
    }

    admin.totpEnabled = true;
    await admin.save();

    res.json({ success: true, message: '2FA enabled' });
  } catch (err) {
    logger.error('2FA verify error', { error: err.message });
    res.status(500).json({ success: false, error: '2FA verification failed' });
  }
};

// Step 3 — Authenticate: ADMIN_KEY + TOTP code → 24h session token.
exports.login = async (req, res) => {
  try {
    if (!adminKeyValid(req)) {
      return res.status(403).json({ success: false, error: 'Invalid admin key' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string') {
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
      return res.status(401).json({ success: false, error: 'Invalid TOTP code' });
    }

    // Compute the current window index and reject reuse within the same or an
    // earlier window (verifyDelta allows the previous period as drift tolerance).
    const now = Math.floor(Date.now() / 1000);
    const window = 30;
    const counter = Math.floor(now / window);
    if (admin.lastUsedCounter >= counter) {
      return res.status(401).json({ success: false, error: 'TOTP code already used' });
    }

    admin.lastUsedCounter = counter;
    await admin.save();

    const sessionToken = signSession({
      username: admin.username,
      role: 'admin',
      exp: Date.now() + 24 * 60 * 60 * 1000,
    });

    res.json({ success: true, token: sessionToken });
  } catch (err) {
    logger.error('2FA login error', { error: err.message });
    res.status(500).json({ success: false, error: 'Login failed' });
  }
};