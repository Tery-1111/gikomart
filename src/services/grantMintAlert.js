const AuditEvent = require('../models/AuditEvent');
const logger = require('../config/logger');

// Lightweight abuse alarm for Free Grant continuation-token minting.
//
// Every successful mint writes an admin.grant_continuation_minted audit event,
// so the audit trail itself is the evidence base: no new collection, no
// counters, no extra writes on the mint path. After a mint, the controller
// asks this service (fire-and-forget) to count that action's events in a
// one-hour window and raise a signal when the volume looks unusual — e.g. an
// admin session minting for far more grants than a lost-token ever justifies,
// which is the signature of credential-rotation abuse.
//
// Deliberately NOT a rate limiter: legitimate admins keep full minting access.
// The alert is an operational signal — a warn-level log line plus a
// admin.grant_mint_volume_alert audit event a human (or an external log
// watcher) can act on. Token material never appears in any of it.

const MINTED_ACTION = 'admin.grant_continuation_minted';
const ALERT_ACTION = 'admin.grant_mint_volume_alert';
const DEFAULT_THRESHOLD = 5;
const WINDOW_MINUTES = 60;

// Read at call time (never at module load) so tests and deployments can set
// the value after this module is required. A missing or non-positive value
// falls back to the default rather than disabling the check silently.
function readThreshold() {
  const raw = Number.parseInt(process.env.GRANT_MINT_ALERT_THRESHOLD, 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD;
}

// Count the mint events already persisted in the window and compare against
// the threshold. The mint that triggered this evaluation is emitted
// fire-and-forget, so it may or may not be included in the count — the alert
// can land one mint late, never early. Every failure path resolves (never
// throws) and returns a small status object so the caller can fire this and
// forget it safely.
async function evaluateGrantMintVolume() {
  const threshold = readThreshold();
  const windowMinutes = WINDOW_MINUTES;
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  let count;
  try {
    count = await AuditEvent.countDocuments({
      action: MINTED_ACTION,
      timestamp: { $gte: windowStart },
    });
  } catch (err) {
    logger.warn('Grant mint-volume check failed', { error: err && err.message });
    return { alerted: false, count: null, threshold, windowMinutes };
  }

  if (count < threshold) {
    return { alerted: false, count, threshold, windowMinutes };
  }

  logger.warn('Unusual Free Grant continuation-token minting volume', {
    count,
    windowMinutes,
    threshold,
    action: MINTED_ACTION,
  });

  try {
    await AuditEvent.create({
      actor: 'system',
      action: ALERT_ACTION,
      resource: 'grant',
      result: 'success',
      metadata: { count, windowMinutes, threshold },
    });
    return { alerted: true, count, threshold, windowMinutes };
  } catch (err) {
    // The log line already fired; a failed alert write must not bubble up.
    logger.warn('Grant mint-volume alert write failed', { error: err && err.message });
    return { alerted: false, count, threshold, windowMinutes };
  }
}

module.exports = {
  evaluateGrantMintVolume,
  MINTED_ACTION,
  ALERT_ACTION,
  DEFAULT_THRESHOLD,
  WINDOW_MINUTES,
};
