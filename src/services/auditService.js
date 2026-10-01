const AuditEvent = require('../models/AuditEvent');
const logger = require('../config/logger');

// Owner-credentialed actions attribute to the sha256 hash of the owner token
// that authenticated the request (req.ownerTokenHash, attached by the storeAuth
// middleware and by the listing owner path). The hash is the same value already
// stored as ownerTokenHash on Store/Listing documents. When no hash is present
// (unexpected flow), fall back to a stable sentinel rather than inventing one.
const OWNER_ACTOR_FALLBACK = 'owner:unknown';

function ownerActor(req) {
  return req && req.ownerTokenHash ? req.ownerTokenHash : OWNER_ACTOR_FALLBACK;
}
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

module.exports = { emit, emitSync, adminActor, ownerActor, OWNER_ACTOR_FALLBACK, SYSTEM_ACTOR };
