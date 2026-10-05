const express = require('express');
const router = express.Router();
const { adminLimiter } = require('../middleware/rateLimiter');
const { verifySession } = require('../middleware/adminAuth');
const { listGrantRequests, approveGrant, rejectGrant, mintGrantContinuation, setGrantTestFlag } = require('../controllers/grantController');

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
// Decisions are terminal and one-way (both match `pending` only) — there is
// deliberately NO unapprove endpoint; docs/DECISIONS.md #36 holds the
// rationale. This file is where such a route would be added, so the guard
// lives here: do not add a route that writes `status: 'pending'`.
router.post('/grants/:id/approve', requireAdminSession, approveGrant);
router.post('/grants/:id/reject', requireAdminSession, rejectGrant);
// Continuation-credential rotation: same session gate as every other grant
// action (raw X-Admin-Key deliberately not accepted).
router.post('/grants/:id/continuation-token', requireAdminSession, mintGrantContinuation);
// QA marker toggle: flags an agent-submitted test request so the queue can
// separate it from real sellers. Same session gate as every other grant action.
router.post('/grants/:id/qa-flag', requireAdminSession, setGrantTestFlag);

module.exports = router;
