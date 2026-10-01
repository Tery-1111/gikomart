/**
 * Key-based log redaction.
 *
 * Returns a NEW value with sensitive keys replaced by '[REDACTED]'. The input
 * is never mutated. Recurses through plain objects and arrays only; other
 * object types (Date, Buffer, Error, class instances) pass through unchanged so
 * a log line never has its structured values corrupted.
 *
 * The key set is intentionally explicit and case-sensitive: it covers the
 * shapes this codebase actually logs (auth material, payer contact details,
 * and raw request bodies) rather than attempting to guess at anything else.
 */

const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'challenge',
  'phone',
  'phoneNumber',
  'msisdn',
  'email',
  'requestBody',
  'req.body',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = SENSITIVE_KEYS.has(key) ? REDACTED : redact(value[key]);
    }
    return out;
  }

  // Non-object, non-array, or non-plain object: return as-is.
  return value;
}

module.exports = { redact, SENSITIVE_KEYS, REDACTED };
