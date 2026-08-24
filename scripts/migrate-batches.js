import { randomUUID } from "node:crypto";

import { connectDB, disconnectDB } from "../src/config/db.js";
import { Batch } from "../src/models/Batch.js";

// One-time migration of the legacy flat Batch shape to the nested "agreed
// schema" used by the frontend (dates / pricing / status / stock / warehouse).
// Idempotent: documents that already have a `dates` field are skipped.

const STATUS_STATE_MAP = {
  active: "ACTIVE",
  near_expiry: "ACTIVE",
  expired: "ACTIVE",
  quarantined: "QUARANTINED",
  recalled: "RECALLED",
  blocked: "BLOCKED",
  retired: "RETIRED",
};

function toMovement(m) {
  return {
    id: randomUUID(),
    type: m?.action ?? "updated",
    note: m?.reason ?? "",
    qty: 0,
    timestamp: m?.at ?? new Date(),
    from: m?.from,
    to: m?.to,
    by: m?.by,
  };
}

function mapDoc(doc) {
  const dates = { manufacturingDate: doc.mfgDate, expiryDate: doc.expiryDate };
  if (doc.quarantineUntil) dates.quarantineUntil = doc.quarantineUntil;

  const pricing = {
    purchasePrice: doc.purchasePrice ?? 0,
    mrp: doc.mrp ?? 0,
    sellingPrice: doc.sellingPrice ?? 0,
    gstRate: doc.gstRate ?? 0,
  };

  const state = STATUS_STATE_MAP[doc.status] ?? "ACTIVE";
  const status = { isRecalled: doc.isRecalled ?? false, state, quarantineReason: doc.quarantineReason ?? null };

  const stock = {
    uom: doc.uom ?? "Units",
    quantityOnHand: doc.currentStock ?? 0,
    reservedQuantity: doc.reservedQuantity ?? 0,
    quarantined: doc.quarantined ?? 0,
  };

  const warehouse = {
    locationType: doc.locationType ?? "Front Shelf",
    rackCode: doc.rackCode ?? "",
  };

  const update = {
    $set: {
      dates,
      pricing,
      status,
      stock,
      warehouse,
      batchType: doc.batchType ?? "C",
    },
    $unset: {
      mfgDate: "",
      expiryDate: "",
      mrp: "",
      purchasePrice: "",
      sellingPrice: "",
      gstRate: "",
      currentStock: "",
      reservedQuantity: "",
      locationType: "",
      rackCode: "",
      status: "",
      isRecalled: "",
      quarantineUntil: "",
      quarantineReason: "",
      uom: "",
      quarantined: "",
    },
  };

  const movements = doc.movements;
  if (Array.isArray(movements) && movements.length > 0) {
    const hasNewShape = movements.some((m) => m.id !== undefined || m.type !== undefined);
    if (!hasNewShape) {
      update.$set.movements = movements.map(toMovement);
    }
  }

  return update;
}

async function run() {
  await connectDB();

  const docs = await Batch.find({}).lean();
  const todo = docs.filter((d) => !d.dates);
  let migrated = 0;

  for (const doc of todo) {
    await Batch.collection.updateOne({ _id: doc._id }, mapDoc(doc));
    migrated += 1;
  }

  console.log(`[migrate:batches] ${migrated} of ${docs.length} batches migrated`);
  await disconnectDB();
}

run().catch((err) => {
  console.error("[migrate:batches] failed:", err);
  process.exit(1);
});
