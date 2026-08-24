import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Batch } from "../models/Batch.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryLedger } from "../models/InventoryLedger.js";
import { Medicine } from "../models/Medicine.js";
import { StockMovement } from "../models/StockMovement.js";

export async function ensureInventoryRecord({ batchId, locationType, rackCode }) {
  const existing = await InventoryItem.findOne({ batchId, locationType, rackCode });
  if (existing) return existing;
  return InventoryItem.create({ batchId, locationType, rackCode, quantityOnHand: 0 });
}

/**
 * Propagates a stock delta to the medicine-level global total. Sellable stock
 * only — expired batches are excluded (their quantity is written off by the
 * expiry sweep instead).
 */
async function applyMedicineDelta(batch, delta, session) {
  if (!delta) return;
  const expired = new Date(batch.dates?.expiryDate).getTime() <= Date.now();
  if (expired) return;
  await Medicine.updateOne({ _id: batch.medicineId }, { $inc: { totalStock: delta } }, { session });
}

export async function addStock({ batchId, locationType, rackCode, quantity, referenceDocId, userId, userName, note }) {
  if (quantity <= 0) throw ApiError.badRequest("Quantity must be positive");
  const session = await mongoose.startSession();
  try {
    let item;
    await session.withTransaction(async () => {
      const batch = await Batch.findById(batchId).session(session);
      if (!batch) throw ApiError.notFound("Batch not found");

      const record = await ensureInventoryRecord({ batchId, locationType, rackCode });
      item = await InventoryItem.findByIdAndUpdate(
        record._id,
        { $inc: { quantityOnHand: quantity } },
        { new: true, session },
      );

      batch.stock.quantityOnHand += quantity;
      await batch.save({ session });
      await applyMedicineDelta(batch, quantity, session);

      await InventoryLedger.create(
        [{ batchId, movementType: "Purchase Inward", quantityChange: quantity, userId, userName, referenceDocId, note }],
        { session },
      );
      await StockMovement.create(
        [{ medicineId: batch.medicineId, batchId, movementType: "in", quantity, reason: note ?? "Stock added", referenceDocId, createdBy: userId, createdByName: userName }],
        { session },
      );
    });
    return item;
  } finally {
    session.endSession();
  }
}

export async function removeStock({ batchId, locationType, rackCode, quantity, movementType, referenceDocId, userId, userName, note }) {
  if (quantity <= 0) throw ApiError.badRequest("Quantity must be positive");
  const session = await mongoose.startSession();
  try {
    let item;
    await session.withTransaction(async () => {
      const record = await ensureInventoryRecord({ batchId, locationType, rackCode });
      if (record.quantityOnHand < quantity) {
        throw ApiError.badRequest("Insufficient stock at the selected location");
      }

      item = await InventoryItem.findByIdAndUpdate(
        record._id,
        { $inc: { quantityOnHand: -quantity } },
        { new: true, session },
      );

      const batch = await Batch.findByIdAndUpdate(batchId, { $inc: { "stock.quantityOnHand": -quantity } }, { session });
      if (batch) await applyMedicineDelta(batch, -quantity, session);

      await InventoryLedger.create(
        [{ batchId, movementType, quantityChange: -quantity, userId, userName, referenceDocId, note }],
        { session },
      );
      await StockMovement.create(
        [{ medicineId: (await Batch.findById(batchId).session(session))?.medicineId, batchId, movementType: "out", quantity, reason: note ?? movementType, referenceDocId, createdBy: userId, createdByName: userName }],
        { session },
      );
    });
    return item;
  } finally {
    session.endSession();
  }
}

export async function adjustStock({ batchId, newQuantity, reason, userId, userName }) {
  const session = await mongoose.startSession();
  try {
    let item;
    await session.withTransaction(async () => {
      const batch = await Batch.findById(batchId).session(session);
      if (!batch) throw ApiError.notFound("Batch not found");
      const record = await InventoryItem.findOne({ batchId }).session(session);
      if (!record) throw ApiError.notFound("No inventory record for this batch");

      const oldQuantity = record.quantityOnHand;
      const delta = newQuantity - oldQuantity;
      item = await InventoryItem.findByIdAndUpdate(record._id, { quantityOnHand: newQuantity }, { new: true, session });

      batch.stock.quantityOnHand = Math.max(0, batch.stock.quantityOnHand + delta);
      await batch.save({ session });
      await applyMedicineDelta(batch, delta, session);

      await InventoryLedger.create(
        [{ batchId, movementType: "Stock Adjustment", quantityChange: delta, userId, userName, note: reason }],
        { session },
      );
      if (delta !== 0) {
        await StockMovement.create(
          [{ medicineId: batch.medicineId, batchId, movementType: "adjustment", quantity: Math.abs(delta), reason: reason ?? "Stock adjustment", createdBy: userId, createdByName: userName }],
          { session },
        );
      }
    });
    return item;
  } finally {
    session.endSession();
  }
}

let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Global expiry sweep. Retires ACTIVE batches whose expiry date has passed and
 * writes their remaining quantity off the medicine-level sellable total.
 * Throttled so it can be called opportunistically on read-heavy endpoints.
 */
export async function sweepExpiredBatches({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return { skipped: true, retired: 0 };
  lastSweepAt = now;

  const expired = await Batch.find({
    "status.state": "ACTIVE",
    "dates.expiryDate": { $lte: new Date() },
  })
    .limit(500)
    .lean();

  let retired = 0;
  for (const batch of expired) {
    const qty = batch.stock?.quantityOnHand ?? 0;
    await Batch.updateOne(
      { _id: batch._id, "status.state": "ACTIVE" },
      { $set: { "status.state": "RETIRED", "audit.updatedAt": new Date(), "audit.updatedBy": "Expiry Sweep" } },
    );
    if (qty > 0) {
      await Medicine.updateOne({ _id: batch.medicineId }, { $inc: { totalStock: -Math.max(0, qty) } });
      await InventoryLedger.create([
        {
          batchId: batch._id,
          movementType: "Write Off",
          quantityChange: -qty,
          userName: "System",
          note: `Batch ${batch.batchNumber} expired — removed from sellable stock`,
        },
      ]);
    }
    retired += 1;
  }
  return { skipped: false, retired };
}
