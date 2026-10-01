const mongoose = require('mongoose');

/**
 * Audit events for privileged and payment-affecting actions.
 *
 * Deliberately separate from TermsAcceptance (which records legal consent):
 * this is an operational trail of WHO did WHAT to WHICH resource and whether it
 * succeeded. metadata must never carry emails, phone numbers, raw tokens, IP
 * addresses, passwords, or other secrets — only id/plan/slug/status/reason codes.
 */
const auditEventSchema = new mongoose.Schema({
  actor: { type: String, required: true, index: true },
  action: { type: String, required: true, index: true },
  resource: { type: String, required: true, index: true },
  resourceId: { type: String, index: true },
  result: { type: String, enum: ['success', 'failure'], required: true },
  metadata: { type: Object, default: {} },
  timestamp: { type: Date, default: Date.now, index: true },
});

// Primary access pattern: "what happened, most recent first" for one action.
auditEventSchema.index({ action: 1, timestamp: -1 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
