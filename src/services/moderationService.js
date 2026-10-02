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

// Shared pattern runner: tests one already-built haystack against every flagged
// and scam pattern and returns the canonical moderation result shape. Both
// checkListing and checkStore funnel through here so the two never drift.
function runPatterns(haystack) {
  const matches = [];
  for (const re of [...FLAGGED_PATTERNS, ...SCAM_PATTERNS]) {
    if (re.test(haystack)) {
      matches.push({ pattern: re.source });
    }
  }

  return {
    approved: matches.length === 0,
    flaggedBy: matches,
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