/**
 * Honeypot Bot Detection
 *
 * A hidden "website" field is rendered in the sell form (CSS-hidden, off-screen)
 * that human users cannot see or fill. Automated spam bots that fill every
 * form field will populate it — those submissions are silently rejected.
 *
 * Phase 1C — Security Hardening
 */
function honeypot(req, res, next) {
  const websiteValue = req.body && (req.body.website || req.body.honeypot);
  if (websiteValue && String(websiteValue).trim() !== '') {
    // Silently accept the request but drop it — bots get a harmless-looking 200
    // so they don't learn the trap's behavior by probing for error responses.
    return res.status(200).json({ success: true, message: 'OK' });
  }
  next();
}

module.exports = honeypot;