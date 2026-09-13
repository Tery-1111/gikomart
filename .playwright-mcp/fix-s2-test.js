// Step-2 live test matrix for the store-delete admin override.
// S2-1 admin session on a store the admin does not own -> 200 (was 403 before)
// S2-2 owner token on an owned store -> 200 (unchanged)
// S2-3 no credentials -> 403
// S2-4 X-Admin-Key with 2FA on -> 403 (raw key alone must NOT bypass 2FA)
// S2-5 wrong owner token -> 403
// The two successful deletes MUST cascade (listings removed) and the two
// negative ones must leave `perma` and its listings untouched.
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'fix-s2.json'), 'utf8'));
const mongoose = require('mongoose');
const Listing = require('../src/models/Listing');
const Store = require('../src/models/Store');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = 'http://localhost:5050';
const results = [];
async function test(name, { creds, id }, expect) {
  const headers = {};
  if (creds.session) headers['X-Admin-Session'] = creds.session;
  if (creds.key) headers['X-Admin-Key'] = creds.key;
  if (creds.owner) headers['X-Store-Owner-Token'] = creds.owner;
  const res = await fetch(`${BASE}/api/stores/${id}`, { method: 'DELETE', headers });
  const body = await res.json().catch(() => ({}));
  const pass = res.status === expect;
  results.push({ name, status: res.status, expected: expect, pass, msg: body.message || body.error });
  return res.status;
}

async function countStore(id) {
  return Store.findById(id).lean();
}
async function countListings(id) {
  return Listing.countDocuments({ store_id: id });
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const session = { session: m.session };

  // S2-1 admin override (admin does NOT own this store)
  await test('S2-1 admin-session delete (new override)', { creds: session, id: m.adminTarget.id }, 200);
  // S2-2 owner path unchanged
  await test('S2-2 owner-token delete (unchanged)', { creds: { owner: m.ownerTarget.rawToken }, id: m.ownerTarget.id }, 200);
  // S2-3 no creds
  await test('S2-3 no credentials', { creds: {}, id: m.perma.id }, 403);
  // S2-4 raw admin key with 2FA on
  await test('S2-4 X-Admin-Key with 2FA', { creds: { key: process.env.ADMIN_KEY }, id: m.perma.id }, 403);
  // S2-5 wrong owner token
  await test('S2-5 wrong owner token', { creds: { owner: 'totally-wrong-token-zzz' }, id: m.perma.id }, 403);

  // Cascade checks (listings gone on deleted stores; perma untouched).
  const [adminStore, ownerStore, permaStore] = await Promise.all([
    countStore(m.adminTarget.id), countStore(m.ownerTarget.id), countStore(m.perma.id),
  ]);
  const adminList = await countListings(m.adminTarget.id);
  const ownerList = await countListings(m.ownerTarget.id);
  const permaList = await countListings(m.perma.id);

  results.push({ name: 'CASCADE adminTarget store gone', status: adminStore ? 'exists' : 'gone', pass: !adminStore });
  results.push({ name: 'CASCADE adminTarget listings gone', status: adminList, pass: adminList === 0 });
  results.push({ name: 'CASCADE ownerTarget store gone', status: ownerStore ? 'exists' : 'gone', pass: !ownerStore });
  results.push({ name: 'CASCADE ownerTarget listings gone', status: ownerList, pass: ownerList === 0 });
  results.push({ name: 'NEGATIVE perma store kept', status: permaStore ? 'exists' : 'gone', pass: !!permaStore });
  results.push({ name: 'NEGATIVE perma listings kept', status: permaList, pass: permaList === 2 });

  let allPass = true;
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (status=${r.status}${r.msg ? ', ' + r.msg : ''}${r.expected !== undefined ? ', expected=' + r.expected : ''})`);
  }
  console.log(allPass ? 'ALL PASS' : 'SOME FAILED');
  // Clean up the perma store so nothing survives.
  if (permaStore) {
    await Listing.deleteMany({ store_id: m.perma.id });
    await Store.deleteOne({ _id: m.perma.id });
  }
  await mongoose.disconnect();
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });