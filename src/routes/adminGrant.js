const express = require('express');
const router = express.Router();
const { adminLimiter } = require('../middleware/rateLimiter');
const { verifySession } = require('../middleware/adminAuth');
const Payment = require('../models/Payment');
const { createResourceForPayment } = require('../controllers/paymentController');
const { emit, adminActor } = require('../services/auditService');
const logger = require('../config/logger');

// Session-only gate for this route: the raw X-Admin-Key is deliberately NOT
// accepted, matching the replay endpoint. Mirrors requireAdminSession in
// src/routes/adminAuth.js (which is not exported) and must be kept in sync with
// it. The security-critical logic (signature, TTL, decode) lives in the shared
// verifySession; only the header read and 401 response are duplicated here.
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

// Admin mock-payment: grant free access to a pending listing/store payment
// without a real IntaSend webhook. The payment must still be 'pending' and of a
// resource-producing type (boost has no resource and is excluded). The atomic
// status claim makes a double-submit idempotent: the second call finds nothing
// pending and returns 404 rather than creating a second resource.
router.use(adminLimiter);

router.post('/grant-free-access', requireAdminSession, async (req, res) => {
  const body = req.body || {};
  const paymentId = typeof body.paymentId === 'string' ? body.paymentId.trim() : '';
  const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId.trim() : '';
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : '';

  const provided = [paymentId, invoiceId, phoneNumber].filter(Boolean).length;
  if (provided === 0) {
    return res.status(400).json({
      success: false,
      error: 'Provide one of: paymentId, invoiceId, phoneNumber',
    });
  }
  // Exactly one selector: silently picking a winner from an ambiguous body could
  // grant access to a different payment than the caller intended.
  if (provided > 1) {
    return res.status(400).json({
      success: false,
      error: 'Provide exactly one of: paymentId, invoiceId, phoneNumber',
    });
  }

  const selector = {};
  if (paymentId) selector._id = paymentId;
  else if (invoiceId) selector.invoiceId = invoiceId;
  else selector.phoneNumber = phoneNumber;

  try {
    const query = {
      status: 'pending',
      type: { $in: ['listing', 'store'] },
      ...selector,
    };

    // Atomic claim: only the first request that observes 'pending' transitions
    // it, so concurrent/double submits cannot create two resources. The grant is
    // stamped in the same write so a granted payment is never mistaken for a
    // real (webhook-completed) one.
    const grantedAt = new Date();
    const payment = await Payment.findOneAndUpdate(
      query,
      { $set: { status: 'completed', grantedBy: adminActor(req), grantedAt } },
      { new: true, sort: { createdAt: -1 } },
    );

    if (!payment) {
      return res.status(404).json({ success: false, error: 'No matching pending payment found' });
    }

    const { type, doc } = await createResourceForPayment(payment);
    if (type === 'listing') payment.listingId = doc._id;
    else payment.storeId = doc._id;
    await payment.save();

    try {
      emit({
        actor: adminActor(req),
        action: 'admin.grant_free_access',
        resource: type === 'store' ? 'Store' : 'Listing',
        resourceId: String(doc._id),
        result: 'success',
        metadata: {
          paymentId: String(payment._id),
          invoiceId: payment.invoiceId || null,
          type: payment.type,
          package: payment.package || null,
          storePlan: payment.storePlan || null,
          grantedAt: grantedAt.toISOString(),
        },
      });
    } catch (auditErr) {
      logger.warn('Grant free access audit emit failed', { error: auditErr && auditErr.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Free access granted',
      paymentId: payment._id,
      resource: { type, id: doc._id },
    });
  } catch (err) {
    logger.error('Grant free access error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Grant free access failed' });
  }
});

module.exports = router;
