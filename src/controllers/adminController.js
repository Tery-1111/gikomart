const AuditEvent = require('../models/AuditEvent');
const logger = require('../config/logger');
const { redact } = require('../utils/redact');
const { emit, adminActor } = require('../services/auditService');

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
