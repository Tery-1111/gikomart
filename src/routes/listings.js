const express = require('express');
const router = express.Router();
const {
  getCategories,
  getListings,
  getListing,
  updateListing,
  deleteListing,
  moderateListing,
} = require('../controllers/listingController');
const adminAuth = require('../middleware/adminAuth');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.get('/', getListings);
// Declared BEFORE '/:id' so 'categories' is never captured as an id param.
router.get('/categories', getCategories);
router.get('/:id', getListing);
// Mutations are token-gated (X-Owner-Token / X-Admin-Key) AND rate-limited
// so an attacker can't brute-force tokens or hammer the endpoint.
router.put('/:id', paymentLimiter, updateListing);
router.delete('/:id', paymentLimiter, deleteListing);
// Admin-only moderation — requires full admin auth (2FA session once enabled).
router.put('/:id/moderate', adminAuth, moderateListing);

module.exports = router;