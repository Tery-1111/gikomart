// Step-1 verification fixtures: one listing with a known owner-token hash, and
// a freshly minted admin session from the :5050 instance.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const fs = require('fs');
const Listing = require('../src/models/Listing');

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

  // Two listings: one owned (owner-token tests), one for admin-session test.
  const ownerToken = 'fix-list-token-1-abc';
  const lOwned = await Listing.create({
    title: 'FIX-S1 owned listing', category: 'Electronics', condition: 'Good', price: 99,
    description: 'step1 fixture', sellerName: 'Audit', sellerWhatsapp: '0700000011',
    package: 'standard', expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    ownerTokenHash: H(ownerToken), images: [],
  });
  const lAdm = await Listing.create({
    title: 'FIX-S1 admin listing', category: 'Books', condition: 'New', price: 49,
    description: 'step1 fixture', sellerName: 'Audit', sellerWhatsapp: '0700000012',
    package: 'standard', expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    ownerTokenHash: H('fix-list-token-admin-2'), images: [],
  });

  fs.writeFileSync(require('path').join(__dirname, 'fix-s1.json'), JSON.stringify({
    listingOwned: { id: String(lOwned._id), token: ownerToken },
    listingAdm: { id: String(lAdm._id) },
    session: loginBody.token,
  }, null, 2));
  console.log('s1 fixtures ready; login status', login.status);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });