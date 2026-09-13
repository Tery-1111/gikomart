// THROWAWAY probe for the delete-authorization audit.
// Reads connection + cloudinary config from .env; never prints secrets.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Admin = require('../src/models/Admin');
const Listing = require('../src/models/Listing');
const Store = require('../src/models/Store');
const cloudinary = require('../src/config/cloudinary');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('uri-host:', process.env.MONGO_URI.replace(/\/\/.*@/, '//***@'));

  const admins = await Admin.find({}).select('username totpEnabled').lean();
  console.log('admin 2FA state:', admins);

  console.log('listing count:', await Listing.countDocuments());
  console.log('store count:', await Store.countDocuments());

  // Probe: does cloudinary.uploader.destroy REJECT on a malformed public_id,
  // or just resolve not_found? Determines whether a partial-cascade-failure
  // test can force a throw through the store-delete loop.
  const probes = ['<bad>', 'does-not-exist-xyz', 'gikomart/..%2F..%2Fbad', ''];
  for (const pid of probes) {
    try {
      const r = await cloudinary.uploader.destroy(pid);
      console.log('destroy PROBE ok:', JSON.stringify(pid), '->', JSON.stringify(r));
    } catch (e) {
      console.log('destroy PROBE THREW:', JSON.stringify(pid), '->', e.error?.message || e.message);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });