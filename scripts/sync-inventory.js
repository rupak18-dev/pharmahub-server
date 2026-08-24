import { connectDB, disconnectDB } from "../src/config/db.js";
import { Batch } from "../src/models/Batch.js";
import { Medicine } from "../src/models/Medicine.js";
import { sweepExpiredBatches } from "../src/services/inventory.service.js";

// One-time global sync of derived stock figures:
//  1. Retires ACTIVE batches past their expiry date and writes off their
//     remaining quantity from medicine totals (ledger entry per batch).
//  2. Recomputes every Medicine.totalStock from its sellable batches
//     (not expired, not retired/recalled/blocked/quarantined).
// Idempotent — safe to run repeatedly.

const SELLABLE_STATES = ["ACTIVE"];

async function recomputeMedicineTotals() {
  const medicines = await Medicine.find({}).select("_id").lean();
  const batches = await Batch.find({}).select("medicineId dates.expiryDate status.state stock.quantityOnHand").lean();

  const totals = new Map();
  for (const b of batches) {
    const sellable =
      SELLABLE_STATES.includes(b.status?.state) &&
      new Date(b.dates?.expiryDate).getTime() > Date.now();
    if (!sellable) continue;
    const key = String(b.medicineId);
    totals.set(key, (totals.get(key) ?? 0) + (b.stock?.quantityOnHand ?? 0));
  }

  let updated = 0;
  for (const m of medicines) {
    const total = totals.get(String(m._id)) ?? 0;
    const res = await Medicine.updateOne({ _id: m._id }, { $set: { totalStock: total } });
    if (res.modifiedCount > 0) updated += 1;
  }
  return { medicines: medicines.length, updated };
}

async function main() {
  await connectDB();

  const sweep = await sweepExpiredBatches({ force: true });
  console.log(`Expiry sweep: ${sweep.retired} batch(es) retired`);

  const totals = await recomputeMedicineTotals();
  console.log(`Medicine totals recomputed: ${totals.updated}/${totals.medicines} document(s) changed`);

  await disconnectDB();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
