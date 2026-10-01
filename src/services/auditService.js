const AuditEvent = require('../models/AuditEvent');
const logger = require('../config/logger');

// No owner-token hash field is attached to req by the auth middleware (storeAuth
// exposes req.store / req.storeCredentialType; the listing owner path keeps the
// hash on the loaded document). So owner-credentialed actions record a stable
// sentinel actor rather than inventing a field that does not exist.
const OWNER_ACTOR = 'owner:unknown';
const SYSTEM_ACTOR = 'system';

// Admin actions: prefer the authenticated admin's username, fall back to the
// conventional single-admin name.
function adminActor(req) {
  const name = (req && (req.adminUsername || (req.admin && req.admin.username))) || 'owner';
  return `admin:${name}`;
}

/**
 * Fire-and-forget audit write. Callers never await it and it never throws: a
 * failed audit write must not fail the request it was recording. Failures are
 * logged (and themselves pass through the logger's redaction format).
 */
function emit(event) {
  Promise.resolve()
    .then(() => AuditEvent.create(event))
    .catch((err) => {
      logger.warn('Audit event write failed', {
        action: event && event.action,
        error: err && err.message,
      });
    });
}

// Same write, but returns the promise so tests can await it deterministically.
function emitSync(event) {
  return AuditEvent.create(event);
}

module.exports = { emit, emitSync, adminActor, OWNER_ACTOR, SYSTEM_ACTOR };
