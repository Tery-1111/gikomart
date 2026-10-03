/**
 * Content Moderation Service
 *
 * Lightweight keyword/pattern filter run at listing-creation time. A practical
 * first pass — not a full ML moderation pipeline. Flagged listings still get
 * created (payment already happened) but are hidden from public views until an
 * admin approves or removes them.
 *
 * Phase 3B — Security Hardening
 */

// Blocklist source: a curated set of terms appropriate for a student-to-student
// campus marketplace. Extend freely — this is configurable, not exhaustive.
const FLAGGED_PATTERNS = [
  /gambling|betting|casino/i,
  /marijuan|bhang|weed|weed\s*sale/i,
  /cocaine|heroin|meth\b/i,
  /weapon|gun\b|ammo|machete|knife\s*sale/i,
  /counterfeit|fake\s*(?:product|item)|replica\s*brand/i,
  /explicit|nsfw|porn|onlyfans/i,
  /stolen|hot\s*item|hacked\s*account/i,
  /kidney|organ\s*sale|blood\s*sale/i,
  /fireworks|explosive/i,
];

// Keywords that indicate a scam/phishing pattern regardless of category
const SCAM_PATTERNS = [
  /m-pesa\s*(?:code|pin)|send\s*money/i,
  // eslint-disable-next-line security/detect-unsafe-regex -- optional-tail match on bounded listing text; pattern semantics reviewed, keep as-is
  /pay\s*first(?:,\s*then\s*(?:deliver|ship))?/i,
  /no\s*refund|refund\s*not\s*guaranteed/i,
  /western\s*union|money\s*gram/i,
  /\bpaypal\s*gift/i,
];

// Look-alike digits and symbols mapped back to the letters they imitate. A
// character is only converted when it sits immediately next to a letter (see
// normalizeText), so numbers and prices are never altered.
const LOOKALIKE_MAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Produce a normalized copy of the text for matching: fold Unicode (NFKD) and
// drop combining marks, strip zero-width/joiner characters, lower-case, then
// map look-alike digits/symbols back to letters only where they touch a letter.
function normalizeText(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/(?<=[a-z])[013457@$]|[013457@$](?=[a-z])/g, (c) => LOOKALIKE_MAP[c]);
}

// Remove separators placed between single letters, e.g. "w e s t e r n" or
// "c.a.s.i.n.o" — the pattern only matches a separator flanked by lone letters.
function despace(text) {
  return text.replace(/(?<=\b[a-z])[\s._\-*]+(?=[a-z]\b)/g, '');
}

// The distinct text variants a haystack is tested against: as written, its
// normalized form, and its normalized-and-de-spaced form.
function patternVariants(haystack) {
  const normalized = normalizeText(haystack);
  return [...new Set([haystack, normalized, despace(normalized)])];
}

// Shared pattern runner: tests an already-built haystack against every flagged
// and scam pattern and returns the canonical moderation result shape. Both
// checkListing and checkStore funnel through here so the two never drift.
// Every variant is tested; approved only when no variant matches, and flaggedBy
// is the order-preserving union of the matches across variants.
function runPatterns(haystack) {
  const seen = new Set();
  const flaggedBy = [];
  for (const variant of patternVariants(haystack)) {
    for (const re of [...FLAGGED_PATTERNS, ...SCAM_PATTERNS]) {
      if (re.test(variant) && !seen.has(re.source)) {
        seen.add(re.source);
        flaggedBy.push({ pattern: re.source });
      }
    }
  }

  return {
    approved: flaggedBy.length === 0,
    flaggedBy,
  };
}

function checkListing(listingFields) {
  const haystack = [
    listingFields.title,
    listingFields.description,
    listingFields.sellerName,
    listingFields.category,
    listingFields.location,
  ].filter(Boolean).join(' ');

  return runPatterns(haystack);
}

// Store counterpart of checkListing: same normalization and runner, over the
// free-text store fields. Array fields (subcategories, payment_methods) are
// flattened with a single space; non-string and missing values are dropped so
// a malformed document can never throw here.
function checkStore(storeFields) {
  const fields = storeFields || {};
  const haystack = [
    fields.name,
    fields.description,
    fields.category,
    fields.subcategories,
    fields.location,
    fields.pickup_location,
    fields.opening_hours,
    fields.closing_hours,
    fields.open_days,
    fields.payment_methods,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => typeof value === 'string' && value)
    .join(' ');

  return runPatterns(haystack);
}

module.exports = { checkListing, checkStore, FLAGGED_PATTERNS, SCAM_PATTERNS };