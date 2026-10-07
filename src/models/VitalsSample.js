const mongoose = require('mongoose');

// Real-user vitals samples written by the frontend beacon
// (public/assets/js/vitals.js → POST /api/vitals). One document per sampled
// tab session that reaches page-hide. The collection is deliberately
// PII-free: no IP, no user agent, no identifiers of any kind — only the URL
// path and timing numbers, so whole-document expiry IS the retention policy.
const vitalsSampleSchema = new mongoose.Schema({
  // URL pathname only (never query/hash — those can carry one-time tokens
  // such as #grant=…). Shape and length are validated in the route.
  path: { type: String, required: true },
  lcp: { type: Number }, // Largest Contentful Paint, ms
  inp: { type: Number }, // Interaction to Next Paint, ms (worst observed interaction event)
  cls: { type: Number }, // Cumulative Layout Shift, unitless
  ttfb: { type: Number }, // Time to First Byte, ms
  conn: { type: String }, // navigator.connection.effectiveType ('slow-2g' … '4g')
  dpr: { type: Number }, // devicePixelRatio
  // Server clock at write time — NEVER taken from the payload. A client
  // could otherwise post a far-future ts and extend its own retention past
  // the TTL below.
  ts: { type: Date, required: true },
});

// Native TTL: MongoDB deletes each sample 30 days after `ts`. This REPLACES
// a cleanupService sweep for this collection — unlike store contacts or
// terms actors, these documents carry no PII fields that need in-place
// redaction, so expiry needs no application-side job. The TTL monitor runs
// roughly every 60s on every Atlas tier (M0 included). A deleteMany in
// cleanupService would just duplicate the deletion path.
vitalsSampleSchema.index({ ts: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('VitalsSample', vitalsSampleSchema);
