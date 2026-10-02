/**
 * Shared public-response serializer.
 *
 * Converts a listing/store document into a plain response object with the
 * sensitive fields removed:
 *   - ownerTokenHash is ALWAYS removed (it is a secret on every path).
 *   - sellerWhatsapp is removed unless `includeContact` is true.
 *   - store phone/whatsapp/email are removed unless `includeContact` is true.
 *
 * Only deletions are performed — no field is added, renamed or reordered — so
 * routing an existing endpoint through these helpers is byte-equivalent for
 * every caller that already applied the same deletions inline.
 */

// Mongoose documents expose toObject(); the fakes/lean results are plain
// objects. Shallow-copy plain objects so the caller's object is never mutated.
function toPlain(doc) {
  return typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
}

function listingView(doc, { includeContact } = {}) {
  const view = toPlain(doc);
  delete view.ownerTokenHash;
  if (includeContact !== true) delete view.sellerWhatsapp;
  return view;
}

function storeView(doc, { includeContact } = {}) {
  const view = toPlain(doc);
  delete view.ownerTokenHash;
  if (includeContact !== true) {
    delete view.phone;
    delete view.whatsapp;
    delete view.email;
  }
  return view;
}

module.exports = { listingView, storeView };
