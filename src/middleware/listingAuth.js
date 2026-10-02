const crypto = require('crypto');
const { authenticateAdmin } = require('./adminAuth');

// Constant-time string comparison. Both inputs are hashed to a fixed 32-byte
// digest first, so crypto.timingSafeEqual never throws on length mismatch and
// the comparison time reveals nothing about content or length.
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Authorization for mutating a listing. Returns { authorized, credential, required }:
//   - authorized: whether the request is authenticated
//   - credential: the factor that actually granted access (for logs)
//   - required:   the credential(s) that WOULD grant access under the current
//                 2FA state (used only to render accurate 403 messages)
//
// Two acceptable factors:
//  1) X-Owner-Token: sha256 of the provided raw token must equal the hash
//     stored on the listing (compared with crypto.timingSafeEqual, not ===), or
//  2) Admin auth — 2FA-aware logic consolidated in middleware/adminAuth.js
//     (authenticateAdmin) so each mode's rules live in exactly one place:
//     a) 2FA enabled: a valid X-Admin-Session HMAC token (issued by POST
//        /api/admin/login after ADMIN_KEY + TOTP code) is required. The raw
//        X-Admin-Key alone is rejected so a leaked key can't bypass 2FA.
//     b) 2FA not enabled: the legacy X-Admin-Key is accepted as before.
async function isOwnerOrAdmin(req, listing) {
  // Owner path — always available regardless of 2FA state. Unchanged.
  const ownerToken = req.get('X-Owner-Token');
  if (ownerToken && listing.ownerTokenHash) {
    const providedHash = crypto.createHash('sha256').update(ownerToken).digest('hex');
    if (safeEqual(providedHash, listing.ownerTokenHash)) {
      req.ownerTokenHash = listing.ownerTokenHash;
      return { authorized: true, credential: 'owner' };
    }
  }

  // Admin path — shared 2FA-aware logic from middleware/adminAuth.js.
  const admin = await authenticateAdmin(req);
  if (admin.payload) {
    return {
      authorized: true,
      credential: admin.needs2fa ? 'admin-session' : 'admin-key',
    };
  }
  return {
    authorized: false,
    credential: null,
    required: admin.needs2fa
      ? 'a valid X-Owner-Token or X-Admin-Session header.'
      : 'a valid X-Owner-Token or X-Admin-Key header.',
  };
}

module.exports = { safeEqual, isOwnerOrAdmin };
