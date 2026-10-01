const crypto = require('crypto');
const Store = require('../models/Store');
const logger = require('../config/logger');
const { authenticateAdmin } = require('./adminAuth');

// Constant-time comparison (same pattern as listingController.js safeEqual)
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Middleware factory: verifies X-Store-Owner-Token against the store's ownerTokenHash.
// Options:
//   requireActive — if true, rejects stores with status !== 'active' or expired plans
//   allowAdmin    — if true, additionally accepts a valid admin session
//                   (authenticateAdmin from middleware/adminAuth.js — the same
//                   consolidated 2FA-aware logic used everywhere else). Used for
//                   destructive operations like store deletion where an admin
//                   must be able to act on a store they don't own.
//
// On success sets:
//   req.store              — the fully-loaded store
//   req.storeCredentialType — 'owner' | 'admin' (used for audit logging)
//   req.admin              — the authenticated admin payload, when the admin
//                             override granted access
function storeAuth(options = {}) {
  return async (req, res, next) => {
    try {
      const storeId = req.params.id;
      if (!storeId) {
        return res.status(400).json({ success: false, error: 'Store ID required' });
      }

      const store = await Store.findById(storeId).select('+ownerTokenHash');
      if (!store) {
        return res.status(404).json({ success: false, error: 'Store not found' });
      }

      const token = req.get('X-Store-Owner-Token');
      let credentialType = null;

      if (token) {
        const providedHash = crypto.createHash('sha256').update(token).digest('hex');
        if (safeEqual(providedHash, store.ownerTokenHash)) credentialType = 'owner';
      }

      // Admin override (opt-in per route): a valid admin session can act on any store.
      if (!credentialType && options.allowAdmin) {
        const admin = await authenticateAdmin(req);
        if (admin.payload) {
          req.admin = admin.payload;
          credentialType = 'admin';
        }
      }

      if (!credentialType) {
        // Uniform ownership failure: never disclose whether the token was
        // present-but-wrong or absent, and never expose credential hints.
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }

      // Optional: reject expired/suspended stores for mutation operations
      if (options.requireActive) {
        if (store.status !== 'active') {
          return res.status(403).json({ success: false, error: 'Store is not active' });
        }
        if (store.expires_at < new Date()) {
          return res.status(403).json({ success: false, error: 'Store plan has expired' });
        }
      }

      req.store = store;
      req.storeCredentialType = credentialType;
      // Attach the owner hash ONLY when the owner token actually authenticated
      // this request. An admin override must not carry owner identity, or the
      // audit trail could later attribute an admin action to the owner hash.
      if (credentialType === 'owner' && store.ownerTokenHash) {
        req.ownerTokenHash = store.ownerTokenHash;
      }
      next();
    } catch (err) {
      // Log the detail server-side; never return the raw error text to a client
      // (it can carry driver/query internals). Mirrors the central handler.
      logger.error('storeAuth failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Store authorization failed' });
    }
  };
}

module.exports = storeAuth;