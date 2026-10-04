const crypto = require('crypto');

/**
 * Owner-token generator.
 *
 * The raw token is returned to the caller exactly once (the browser stores it
 * in localStorage) and is never persisted server-side — only its sha256 hash is
 * stored as `ownerTokenHash` on the producing record. This mirrors the token
 * that the paid initiate endpoints (initiateListing / initiateStorePlan) mint
 * inline; extracting it lets the Free Grant redeem path reuse the identical
 * convention without touching the paid flow.
 */
function generateOwnerToken() {
  const rawOwnerToken = crypto.randomBytes(24).toString('hex');
  const ownerTokenHash = crypto.createHash('sha256').update(rawOwnerToken).digest('hex');
  return { rawOwnerToken, ownerTokenHash };
}

module.exports = { generateOwnerToken };
