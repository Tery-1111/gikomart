const express = require('express');
const router = express.Router();
const { submitGrant, getGrantStatus, redeemGrant } = require('../controllers/grantController');
const { reportLimiter, statusLimiter, paymentLimiter } = require('../middleware/rateLimiter');
const honeypot = require('../middleware/honeypot');

// Free Grant requests never touch a payment provider, so they reuse the
// existing limiter instances rather than introducing new rate-limit config:
//   - submit: reportLimiter (10/hour) — a low-volume, admin-reviewed request
//   - status: statusLimiter (60/min) — polled, mirrors the payment status poll
//   - redeem: paymentLimiter (5/min) — a privileged, resource-producing action
router.post('/', reportLimiter, honeypot, submitGrant);
router.get('/status/:claimId', statusLimiter, getGrantStatus);
router.post('/:claimId/redeem', paymentLimiter, redeemGrant);

module.exports = router;
