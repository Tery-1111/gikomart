const express = require('express');
const router = express.Router();
const { adminLimiter } = require('../middleware/rateLimiter');
const { verifySession } = require('../middleware/adminAuth');
const { listGrantRequests, approveGrant, rejectGrant } = require('../controllers/grantController');

// Session-only gate, matching src/routes/adminGrant.js and the replay endpoint:
// the raw X-Admin-Key is deliberately NOT accepted. The security-critical logic
// (signature, TTL, decode) lives in the shared verifySession.
function requireAdminSession(req, res, next) {
  const raw = req.headers['x-admin-session'];
  if (!raw) {
    return res.status(401).json({ success: false, error: 'Admin session required' });
  }
  const payload = verifySession(raw);
  if (!payload) {
    return res.status(401).json({ success: false, error: 'Invalid admin session' });
  }
  req.admin = payload;
  next();
}

router.use(adminLimiter);

router.get('/grants', requireAdminSession, listGrantRequests);
router.post('/grants/:id/approve', requireAdminSession, approveGrant);
router.post('/grants/:id/reject', requireAdminSession, rejectGrant);

module.exports = router;
