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

function checkListing(listingFields) {
  const haystack = [
    listingFields.title,
    listingFields.description,
    listingFields.sellerName,
    listingFields.category,
    listingFields.location,
  ].filter(Boolean).join(' ');

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

module.exports = { checkListing, FLAGGED_PATTERNS, SCAM_PATTERNS };