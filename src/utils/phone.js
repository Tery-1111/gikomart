const crypto = require('crypto');

// Normalize a Kenyan contact number to 254[17]XXXXXXXX. Returns null for any
// non-string value and for anything that does not reduce to a valid number, so
// callers can treat "no usable number" uniformly.
function normalizeContactNumber(value) {
  if (typeof value !== 'string') return null;
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '254' + digits.slice(1);
  else if (digits.startsWith('7') || digits.startsWith('1')) digits = '254' + digits;
  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

const DEV_BLOCK_HASH_SECRET = 'gikomart-dev-only-block-hash-secret';
const MIN_BLOCK_SECRET_LENGTH = 16;

// Read at call time (never at module load) so tests and deployments can set the
// secret after this module is required. In production a missing or too-short
// secret is a hard error rather than a silent fallback; other environments use a
// fixed development secret so hashes stay stable for local runs and CI.
function getBlockSecret() {
  const secret = process.env.BLOCK_HASH_SECRET;
  if (typeof secret === 'string' && secret.length >= MIN_BLOCK_SECRET_LENGTH) {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BLOCK_HASH_SECRET is not configured');
  }
  return DEV_BLOCK_HASH_SECRET;
}

// HMAC-SHA256 hex of the normalized number, keyed by the block secret. Returns
// null when the value does not normalize. Callers must never store or return the
// hash as if it were a secret — it is a pseudonymous key, and the API
// intentionally never echoes it.
function contactHash(value) {
  const normalized = normalizeContactNumber(value);
  if (normalized === null) return null;
  return crypto.createHmac('sha256', getBlockSecret()).update(normalized).digest('hex');
}

module.exports = { normalizeContactNumber, contactHash };
