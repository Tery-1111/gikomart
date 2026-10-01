/**
 * Absolute-URL validation for user-supplied media links.
 *
 * These values are rendered by the frontend into <img src> / CSS url()
 * contexts, so only http(s) URLs may be stored. Schemes such as javascript:,
 * data:, and vbscript: are rejected outright rather than escaped at the sink.
 *
 * Deliberately narrow: an empty string or a non-string is invalid, so callers
 * that want to allow "clear this field" must treat null/'' before calling.
 */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isHttpUrl };
