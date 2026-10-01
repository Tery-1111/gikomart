const express = require('express');
const router = express.Router();
const { adminLimiter } = require('../middleware/rateLimiter');
const { verifySession } = require('../middleware/adminAuth');
const {
  setup2FA,
  verify2FA,
  login,
  replayPayment,
} = require('../controllers/adminAuthController');
const adminAuth = require('../middleware/adminAuth');
const { moderateStore, suspendStore } = require('../controllers/storeController');
const { getAuditLogs } = require('../controllers/adminController');

// FIX A4 — dedicated stricter limiter for admin endpoints (additive to the
// global limiter, which still applies at app level).
router.use(adminLimiter);

// Admin 2FA endpoints — warded by the raw ADMIN_KEY so a leaked key can
// configure 2FA but cannot act on listings without the TOTP code.
router.post('/setup-2fa', setup2FA);
router.post('/verify-2fa', verify2FA);
router.post('/login', login);

// Session-only gate for destructive recovery actions: the raw X-Admin-Key is
// deliberately NOT accepted here. A missing or invalid X-Admin-Session returns
// 401, matching the other session-gated admin paths.
function requireAdminSession(req, res, next) {
  const payload = verifySession(req.headers['x-admin-session']);
  if (!payload) {
    return res.status(401).json({ success: false, error: 'Admin 2FA required' });
  }
  req.admin = payload;
  next();
}

// Replay a payment whose webhook never completed, recreating the listing/store
// it should have produced. Rate-limited by the router-level adminLimiter.
router.post('/payments/:paymentReference/replay', requireAdminSession, replayPayment);

// Admin resource moderation for stores — full admin auth (a session once 2FA is
// enabled). Mirrors the listing moderation endpoint.
router.put('/stores/:id/moderate', adminAuth, moderateStore);
router.put('/stores/:id/suspend', adminAuth, suspendStore);

// Read-only admin views — session-only, matching the replay action.
router.get('/audit-logs', requireAdminSession, getAuditLogs);

module.exports = router;