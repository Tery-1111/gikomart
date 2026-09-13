// THROWAWAY fixture creator for the delete-authorization audit.
// Creates records directly in Mongo (the payment webhook is the only real
// creator, but M-Pesa can't be exercised here). All records are audit-scoped
// and deleted by the tests themselves. Nothing is touched that pre-existed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const Listing = require('../src/models/Listing');
const Store = require('../src/models/Store');

const H = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const images = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'audit-images.json'), 'utf8'));

const manifest = {};

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const now = Date.now();

  // A) Standalone listing — for listing-delete auth tests.
  const tokenA = 'audit-list-token-alpha-9a1b2c';
  const la = await Listing.create({
    title: 'AUDIT listing A (delete tests)',
    category: 'Electronics', condition: 'Good', price: 100,
    description: 'throwaway audit record', sellerName: 'Audit',
    sellerWhatsapp: '0700000001', package: 'standard',
    expiresAt: new Date(now + 7 * 24 * 3600 * 1000),
    ownerTokenHash: H(tokenA), images: [images.img1],
  });
  manifest.listingA = { id: String(la._id), token: tokenA, image: images.img1 };

  // B) Standalone listing — for admin (session) delete test.
  const tokenAdm = 'audit-list-token-admin-77';
  const ladm = await Listing.create({
    title: 'AUDIT listing ADM (admin delete test)',
    category: 'Books', condition: 'New', price: 50,
    description: 'throwaway audit record', sellerName: 'Audit',
    sellerWhatsapp: '0700000002', package: 'standard',
    expiresAt: new Date(now + 7 * 24 * 3600 * 1000),
    ownerTokenHash: H(tokenAdm), images: [images.img2],
  });
  manifest.listingAdm = { id: String(ladm._id), token: tokenAdm, image: images.img2 };

  // C) Store + 5 listings — for store-delete auth + cascade tests.
  const tokenS5 = 'audit-store-token-s5-44';
  const store = await Store.create({
    name: 'AUDIT Store S5', slug: 'audit-store-s5',
    description: 'throwaway', category: 'Electronics',
    phone: '0700000003', whatsapp: '0700000003',
    ownerTokenHash: H(tokenS5), plan: 'starter_weekly',
    plan_price: 150, plan_duration: 7 * 24 * 3600 * 1000, listing_limit: 5,
    started_at: new Date(now), expires_at: new Date(now + 7 * 24 * 3600 * 1000),
    status: 'active', logo_url: images.img3, cover_url: images.img4,
  });
  manifest.store5 = { id: String(store._id), token: tokenS5, logo: images.img3, cover: images.img4 };

  const lts = ['a','b','c','d','e'];
  manifest.store5.listings = [];
  for (let i = 0; i < 5; i++) {
    const imgs = [images.img5].concat(i === 1 ? [images.img3] : []); // L2 carries an extra image
    const l = await Listing.create({
      title: `AUDIT store listing ${lts[i]}`,
      category: 'Electronics', condition: 'Good', price: 10 + i,
      description: 'throwaway audit record', sellerName: 'Audit',
      sellerWhatsapp: '0700000004', package: 'standard',
      expiresAt: new Date(now + 7 * 24 * 3600 * 1000),
      ownerTokenHash: H(`audit-store-listing-token-${i}`), images: imgs,
      store_id: store._id,
    });
    manifest.store5.listings.push({ id: String(l._id), images: imgs });
  }

  fs.writeFileSync(require('path').join(__dirname, 'audit-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('created listingA', manifest.listingA.id);
  console.log('created listingAdm', manifest.listingAdm.id);
  console.log('created store5', manifest.store5.id, 'with', manifest.store5.listings.length, 'listings');
  console.log('manifest written');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });