/**
 * NoSQL Injection Guard
 *
 * Deep-sanitizes request body, query, and params to prevent MongoDB operator
 * injection. Strips $-prefixed keys at all depths and rejects $where expressions.
 *
 * Phase 1A — Security Hardening
 */

// MongoDB operator keys that signal an injection attempt. Any of these as a
// key in user input → reject with 400 rather than silently stripping, so
// attackers learn nothing and legitimate traffic sees uniform errors.
const DANGEROUS_KEYS = [
  '$where', '$regex', '$ne', '$nin', '$in', '$gt', '$gte', '$lt', '$lte',
  '$all', '$exists', '$type', '$or', '$and', '$not', '$nor', '$elemMatch',
  '$size', '$mod', '$expr', '$jsonSchema', '$text', '$search', '$options',
  '$geoIntersects', '$near', '$nearSphere',
];

function containsDangerousKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  if (Array.isArray(obj)) return obj.some(containsDangerousKeys);
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.includes(key)) return true;
    if (containsDangerousKeys(obj[key])) return true;
  }
  return false;
}

function sanitizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    // Strip any $-prefixed keys (MongoDB operators) from user input
    if (key.startsWith('$')) continue;
    clean[key] = sanitizeObject(value);
  }
  return clean;
}

function sanitize(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    if (containsDangerousKeys(req.body)) {
      return res.status(400).json({ success: false, error: 'Invalid request payload' });
    }
    req.body = sanitizeObject(req.body);
  }

  if (req.query && typeof req.query === 'object') {
    if (containsDangerousKeys(req.query)) {
      return res.status(400).json({ success: false, error: 'Invalid query parameters' });
    }
    req.query = sanitizeObject(req.query);
  }

  if (req.params && typeof req.params === 'object') {
    if (containsDangerousKeys(req.params)) {
      return res.status(400).json({ success: false, error: 'Invalid route parameters' });
    }
    req.params = sanitizeObject(req.params);
  }

  next();
}

module.exports = sanitize;
