const express = require('express');
const router = express.Router();
const {
  setup2FA,
  verify2FA,
  login,
} = require('../controllers/adminAuthController');

// Admin 2FA endpoints — warded by the raw ADMIN_KEY so a leaked key can
// configure 2FA but cannot act on listings without the TOTP code.
router.post('/setup-2fa', setup2FA);
router.post('/verify-2fa', verify2FA);
router.post('/login', login);

module.exports = router;