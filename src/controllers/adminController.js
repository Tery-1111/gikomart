const mongoose = require('mongoose');
const AuditEvent = require('../models/AuditEvent');
const Payment = require('../models/Payment');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const Report = require('../models/Report');
const BlockedContact = require('../models/BlockedContact');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');
const { redact } = require('../utils/redact');
const { emit, adminActor } = require('../services/auditService');
const { computeMetrics } = require('../services/metricsService');

// Hard cap on any admin listing, regardless of ?limit.
const MAX_LIMIT = 50;

function parseLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return MAX_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

// GET /api/admin/audit-logs — read-only, session-gated.
// ?limit (<=50), ?action, ?resource, ?before (ISO date).
exports.getAuditLogs = async (req, res) => {
  try {
    const { action, resource } = req.query;
    const filter = {};
    if (action) filter.action = action;
    if (resource) filter.resource = resource;
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!Number.isNaN(before.getTime())) filter.timestamp = { $lt: before };
    }

    const logs = await AuditEvent.find(filter)
      .sort({ timestamp: -1 })
      .limit(parseLimit(req.query.limit))
      .lean();

    emit({
      actor: adminActor(req),
      action: 'admin.audit_logs_viewed',
      resource: 'admin',
      result: 'success',
      metadata: { count: logs.length },
    });

    // Defensive redaction on the way out: our writers already avoid secrets, but
    // this guarantees a future caller that stores a sensitive key in metadata
    // can never expose it through this endpoint.
    res.json({ success: true, count: logs.length, logs: logs.map((doc) => redact(doc)) });
  } catch (err) {
    logger.error('Audit log retrieval error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve audit logs' });
  }
};

// GET /api/admin/payments — read-only, session-gated.
// ?limit (<=50), ?status, ?type.
exports.listPayments = async (req, res) => {
  try {
    const { status, type } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseLimit(req.query.limit))
      .lean();

    // ownerTokenHash is a bearer secret — never leave the server. phoneNumber is
    // intentionally retained for dispute resolution.
    const safe = payments.map((payment) => {
      const copy = { ...payment };
      delete copy.ownerTokenHash;
      return copy;
    });

    // Record the view with the count; the filter values are echoed only when
    // they are one of the recognized values, never an arbitrary query string.
    emit({
      actor: adminActor(req),
      action: 'admin.payments_viewed',
      resource: 'admin',
      result: 'success',
      metadata: {
        count: safe.length,
        status: ['pending', 'completed', 'failed'].includes(status) ? status : null,
        type: ['listing', 'boost', 'store'].includes(type) ? type : null,
      },
    });

    res.json({ success: true, count: safe.length, payments: safe });
  } catch (err) {
    logger.error('Payment list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list payments' });
  }
};

// GET /api/admin/health — session-gated. Reports the dependency details the
// public /health endpoint deliberately omits. Always HTTP 200; the status field
// carries health so a caller never has to interpret the status code.
exports.getHealth = async (req, res) => {
  const checks = {
    mongodb: mongoose.connection.readyState === 1,
    cloudinary: false,
  };

  let timer;
  try {
    await Promise.race([
      cloudinary.api.ping(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 5000);
      }),
    ]);
    checks.cloudinary = true;
  } catch (err) {
    logger.warn('Admin health: cloudinary ping failed');
  } finally {
    clearTimeout(timer);
  }

  const status = !checks.mongodb ? 'unhealthy' : (checks.cloudinary ? 'healthy' : 'degraded');

  res.status(200).json({
    success: true,
    status,
    checks,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
};

// GET /api/admin/metrics — session-gated. Counts and sums only, no personal
// data, so no audit event is emitted.
exports.getMetrics = async (req, res) => {
  try {
    const result = await computeMetrics({ Listing, Store, Payment, Report, BlockedContact });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Admin metrics error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to compute metrics' });
  }
};
