// Step-2 verification fixtures: three stores with a known owner-token hash and
// freshly-minted admin session from the :5050 instance. Stores are created
// directly in Mongo (real creation path is the payment webhook, not reachable).
// All records are audit-scoped and deleted by the tests themselves.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const fs = require('fs');
const Listing = require('../src/models/Listing');
const Store = require('../src/models/Store');

const H = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const Admin = require('../src/models/Admin');
  const admin = await Admin.findOne({ username: 'owner' }).select('+totpSecret').lean();
  const code = speakeasy.totp({ secret: admin.totpSecret, encoding: 'base32' });

  const login = await fetch('http://localhost:5050/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_KEY },
    body: JSON.stringify({ code }),
  });
  const loginBody = await login.json();
  if (!loginBody.token) throw new Error('login failed: ' + JSON.stringify(loginBody));

  const now = Date.now();
  const manifest = {};

  // Helper: a store with N image-less listings owned by the given raw token.
  async function makeStore(slug, token, count) {
    const store = await Store.create({
      name: 'AUDIT S2 ' + slug,
      slug,
      description: 'step2 fixture', category: 'Books',
      phone: '0700000901', whatsapp: '0700000901',
      ownerTokenHash: H(token), plan: 'starter_weekly',
      plan_price: 150, plan_duration: 7 * 24 * 3600 * 1000, listing_limit: 5,
      started_at: new Date(now), expires_at: new Date(now + 7 * 24 * 3600 * 1000),
      status: 'active', logo_url: null, cover_url: null,
    });
    const listings = [];
    for (let i = 0; i < count; i++) {
      const l = await Listing.create({
        title: `AUDIT S2 ${slug} listing ${i}`,
        category: 'Books', condition: 'New', price: 10 + i,
        description: 'step2 fixture', sellerName: 'Audit',
        sellerWhatsapp: '0700000902', package: 'standard',
        expiresAt: new Date(now + 7 * 24 * 3600 * 1000),
        ownerTokenHash: H(`${token}-listing-${i}`), images: [],
        store_id: store._id,
      });
      listings.push({ id: String(l._id) });
    }
    return { id: String(store._id), listings };
  }

  // 1. Deleted by admin session (the new override). Admin does NOT own this token.
  const adminToken = 'audit-s2-token-admin-9x';
  manifest.adminTarget = await makeStore('s2-adm', adminToken, 2);
  manifest.adminTarget.rawToken = adminToken;

  // 2. Deleted by owner token (regression check that the legacy path is unchanged).
  const ownerToken = 'audit-s2-token-owner-7m';
  manifest.ownerTarget = await makeStore('s2-own', ownerToken, 2);
  manifest.ownerTarget.rawToken = ownerToken;

  // 3. Left intact for negative tests (no creds / wrong token / key-with-2fa).
  manifest.perma = await makeStore('s2-perma', 'audit-s2-token-perma-3k', 2);

  manifest.session = loginBody.token;
  fs.writeFileSync(require('path').join(__dirname, 'fix-s2.json'), JSON.stringify(manifest, null, 2));
  console.log('s2 fixtures ready; login status', login.status);
  console.log('adminTarget', manifest.adminTarget.id, '| ownerTarget', manifest.ownerTarget.id, '| perma', manifest.perma.id);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });