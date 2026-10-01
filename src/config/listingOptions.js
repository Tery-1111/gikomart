// Finite option sets for listing/store inputs, kept in one place so the
// payment-initiated create path and the owner update path validate against the
// exact same values. These are the only conditions the UI ever produces.
const VALID_CONDITIONS = Object.freeze([
  'New',
  'Like New',
  'Excellent',
  'Good',
  'Fair',
  'Poor',
]);

module.exports = { VALID_CONDITIONS };
