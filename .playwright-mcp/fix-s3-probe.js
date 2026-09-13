// Step-3 preflight: does the Atlas cluster support multi-document transactions?
// Requires a replica set (or sharded cluster). Atlas M0+ are replica sets, but
// confirm rather than assume. Uses a THROWAWAY collection, cleaned up after.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // 1. Topology evidence
  const hello = await db.command({ hello: 1 });
  console.log('setName (replica set):', hello.setName || '(none)');
  console.log('isWritablePrimary:', hello.isWritablePrimary);
  console.log('readOnly:', hello.readOnly);

  // 2. Real transaction round-trip on a throwaway collection
  const conn = mongoose.connection;
  const session = await conn.startSession();
  const coll = db.collection('__s3_txn_probe__');
  try {
    session.startTransaction();
    await coll.insertOne({ marker: 'txn-probe', n: 1 }, { session });
    await coll.insertOne({ marker: 'txn-probe', n: 2 }, { session });
    await session.commitTransaction();
    const inTxn = await coll.countDocuments({ marker: 'txn-probe' });
    console.log('INSERTED within transaction; visible rows:', inTxn);
  } catch (e) {
    console.log('TRANSACTION COMMIT FAILED:', e.message);
    try { await session.abortTransaction(); } catch {}
    process.exit(1);
  } finally {
    session.endSession();
  }

  // 3. Rollback proof: a deliberately-aborted transaction must leave nothing.
  const s2 = await conn.startSession();
  try {
    s2.startTransaction();
    await coll.insertOne({ marker: 'txn-probe', n: 999 }, { session: s2 });
    await s2.abortTransaction();
  } finally {
    s2.endSession();
  }
  const afterAbort = await coll.countDocuments({ marker: 'txn-probe', n: 999 });
  console.log('after ABORT, aborted row count (expect 0):', afterAbort);

  // Cleanup the throwaway collection
  await coll.drop().catch(() => {});
  await mongoose.disconnect();
  if (afterAbort !== 0) process.exit(1);
  console.log('TRANSACTIONS SUPPORTED');
}
main().catch((e) => { console.error(e); process.exit(1); });