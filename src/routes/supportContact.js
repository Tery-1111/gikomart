const express = require('express');
const router = express.Router();
const SUPPORT_CONTACT = require('../config/supportContact');

// Public support-contact metadata for the frontend (e.g. the payment-recovery
// "contact support with reference" copy). SINGLE SOURCE OF TRUTH is
// src/config/supportContact.js — this endpoint exposes the PUBLIC-SAFE subset
// only: the support email must never be served publicly (see that module).
router.get('/', (req, res) => {
  res.json({
    success: true,
    support: {
      phoneLocal: SUPPORT_CONTACT.supportPhoneLocal,
      phoneInternational: SUPPORT_CONTACT.supportPhoneInternational,
    },
  });
});

module.exports = router;
