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

// sha256 hex of the normalized number. Returns null when the value does not
// normalize. Callers must never store or return the hash as if it were a secret
// — it is a pseudonymous key, and the API intentionally never echoes it.
function contactHash(value) {
  const normalized = normalizeContactNumber(value);
  if (normalized === null) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { normalizeContactNumber, contactHash };
