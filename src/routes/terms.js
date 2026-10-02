const express = require('express');
const router = express.Router();
const { getVersions, recordContactAcceptance } = require('../controllers/termsController');
const { contactLimiter, contactReleaseLimiter } = require('../middleware/rateLimiter');

router.get('/versions', getVersions);

router.post(
  '/contact-acceptance',
  contactLimiter,
  contactReleaseLimiter,
  recordContactAcceptance,
);

module.exports = router;
