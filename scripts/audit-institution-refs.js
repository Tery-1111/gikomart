#!/usr/bin/env node
/**
 * Institution-reference audit / migration for existing records.
 *
 * Finds Store.campus and Listing.location values that still contain a legacy
 * institution name and, ONLY when explicitly asked, rewrites them to the neutral
 * value 'Njoro'. This is the data-side companion to the code-side neutrality
 * change (see docs/DECISIONS.md 32); new records no longer receive an
 * institution default.
 *
 * The legacy name to match is supplied at run time through the
 * LEGACY_INSTITUTION_TOKEN environment variable, so no institution name is
 * hardcoded in this repository.
 *
 *   LEGACY_INSTITUTION_TOKEN=<legacy-name> node scripts/audit-institution-refs.js
 *   LEGACY_INSTITUTION_TOKEN=<legacy-name> node scripts/audit-institution-refs.js --apply
 *
 * Safety:
 *   - The default is READ-ONLY. Nothing is written unless `--apply` is passed.
 *   - The MONGO_URI and its credentials are never printed.
 *   - Run the audit, review the output, get operator approval, take a backup
 *     (`npm run backup`), and only then re-run with `--apply`.
 *   - See docs/runbook-institution-migration.md for the full procedure.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const NEUTRAL_LOCATION = 'Njoro';
const SAMPLE_LIMIT = 10;
const CONNECT_TIMEOUT_MS = 5000;

function buildPattern(rawToken) {
  // Escape any regex metacharacters so the token is matched literally.
  const escaped = rawToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // eslint-disable-next-line security/detect-non-literal-regexp -- operator-supplied token, escaped above
  return new RegExp(escaped, 'i');
}

async function run() {
  const apply = process.argv.slice(2).includes('--apply');

  const rawToken = process.env.LEGACY_INSTITUTION_TOKEN;
  if (!rawToken) {
    console.error('LEGACY_INSTITUTION_TOKEN not set — aborting institution audit');
    process.exit(1);
  }
  const pattern = buildPattern(rawToken);

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI not set — aborting institution audit');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS });
  } catch (err) {
    // Deliberately generic: never echo the connection string or its credentials.
    console.error('Could not connect to MongoDB — aborting institution audit');
    process.exit(1);
  }

  const db = mongoose.connection.db;
  const stores = db.collection('stores');
  const listings = db.collection('listings');

  const storeMatches = await stores.countDocuments({ campus: pattern });
  const listingMatches = await listings.countDocuments({ location: pattern });

  console.log(`[audit] stores.campus: ${storeMatches} record(s) contain the legacy name`);
  console.log(`[audit] listings.location: ${listingMatches} record(s) contain the legacy name`);

  const storeSamples = await stores
    .find({ campus: pattern }, { projection: { campus: 1 } })
    .limit(SAMPLE_LIMIT)
    .toArray();
  for (const doc of storeSamples) {
    console.log(`  - store ${doc._id}: campus=${JSON.stringify(doc.campus)}`);
  }

  const listingSamples = await listings
    .find({ location: pattern }, { projection: { location: 1 } })
    .limit(SAMPLE_LIMIT)
    .toArray();
  for (const doc of listingSamples) {
    console.log(`  - listing ${doc._id}: location=${JSON.stringify(doc.location)}`);
  }

  if (apply) {
    const storeResult = await stores.updateMany(
      { campus: pattern },
      { $set: { campus: NEUTRAL_LOCATION } }
    );
    const listingResult = await listings.updateMany(
      { location: pattern },
      { $set: { location: NEUTRAL_LOCATION } }
    );
    console.log(`[apply] stores.campus: ${storeResult.modifiedCount} record(s) set to '${NEUTRAL_LOCATION}'`);
    console.log(`[apply] listings.location: ${listingResult.modifiedCount} record(s) set to '${NEUTRAL_LOCATION}'`);
  } else if (storeMatches + listingMatches > 0) {
    console.log('Audit only — no records were changed. Re-run with --apply after approval.');
  } else {
    console.log('No matching records found.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(() => {
  console.error('Institution audit failed');
  process.exit(1);
});
