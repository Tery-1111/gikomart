const express = require('express');
const router = express.Router();
const { reportLimiter } = require('../middleware/rateLimiter');
const honeypot = require('../middleware/honeypot');
const { submitReport } = require('../controllers/reportController');

// Public report submission: hourly per-IP limit, then the shared honeypot, then
// the handler. The admin queue lives under /api/admin (session-gated).
router.post(
  '/',
  reportLimiter,
  honeypot,
  submitReport,
);

module.exports = router;
